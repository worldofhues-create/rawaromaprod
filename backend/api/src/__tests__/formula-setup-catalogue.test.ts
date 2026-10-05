/**
 * RC 2026-10-05 — the two lanes wired: the ALEMBIC catalogue's single_chemical/blend classification
 * (lane catalogue-rp, bridge.catalogue_item) drives the factory's "Draft formula shells" (lane
 * vaultsetup, FormulaSetupService via PRODUCT_KIND_SOURCE = CatalogueProductKindSource).
 *
 * Real Postgres; the products and materials are made by the REAL signed catalogue sync
 * (FactoryCatalogueService), the Vault and the Ruh token are stubs (formula-setup.test.ts' idiom).
 *
 *   classification   a catalogue product carries the catalogue's kind + basis; a product the
 *                    catalogue does not hold has none (the owner chooses); catalogue rows that
 *                    disagree on one product give none.
 *   material         a single chemical is sealed from the catalogue's material for it, ahead of
 *                    the code match.
 *   default          shells with no kind take the catalogue's; an unknown product with no kind is
 *                    refused and never reaches the Vault.
 *   blend            a catalogue blend is NEVER sealed as a single chemical on a plain request; only
 *                    the owner's explicit override does it, and the audit says so.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ensureSchema, testClient, bridgeDb, principal, closeTestClient } from '../../../test-support/db.js';
import { productWithSku } from '../../../test-support/produce-fixtures.js';
import { sealSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';
import { shelfDb } from '../shelf/shelf.tokens.js';
import { PickLightService } from '../shelf/pick-light.service.js';
import { FactoryCatalogueService, type ItemResult } from '../factory-setup/catalogue.service.js';
import { SetupStatusService } from '../factory-setup/setup-status.service.js';
import type { CatalogueItem } from '../factory-setup/catalogue.contract.js';
import { FormulaSetupService } from '../formula-setup/formula-setup.service.js';
import { CatalogueProductKindSource } from '../formula-setup/catalogue-kind.source.js';

const SECRET = 'formula-setup-catalogue-secret';
const TENANT = '0190f0a1-0000-7000-8000-00000000c47b';
const kekPrior = process.env.BRIDGE_HMAC_KEK;

/** The stub Vault: shells it drafts (and every call), and which formulas are approved. */
const approved = new Set<string>();
const shells = new Map<string, string>();
const calls: Array<Array<{ productId: string; kind: string; materialId: string | null }>> = [];
const vault = {
  async formulaLabels(q: { formulaIds: string[] }) {
    const known = new Set(shells.values());
    return {
      versions: [],
      formulas: q.formulaIds.filter((id) => known.has(id)).map((id) => ({
        formulaId: id, formulaCode: `F-${id.slice(0, 6)}`,
        approvedVersion: approved.has(id) ? { formulaVersionId: randomUUID(), versionNumber: 1 } : null,
      })),
      recent: null,
    };
  },
  async formulaDirectory() { return { items: [], nextCursor: null }; },
  async createFormulaShellsAs(_bearer: string, body: { products: Array<{ productId: string; productCode: string; kind: string; materialId: string | null }> }) {
    calls.push(body.products.map((p) => ({ productId: p.productId, kind: p.kind, materialId: p.materialId })));
    return {
      results: body.products.map((p) => {
        const existing = shells.get(p.productId);
        const formulaId = existing ?? randomUUID();
        shells.set(p.productId, formulaId);
        return { productId: p.productId, productCode: p.productCode, outcome: existing ? 'existing' : 'created', formulaId,
          formulaCode: `F-${p.productCode}`, kind: p.kind, state: p.kind === 'blend' ? 'recipe_needed' : 'in_review' };
      }),
    };
  },
};
const principals = { async mintVaultToken() { return { token: 'ruh-token', userId: randomUUID() }; } };
const owner = principal({ userId: randomUUID(), roles: ['owner'] });

let catalogue: FactoryCatalogueService;
let lights: PickLightService;
let svc: FormulaSetupService;
let status: SetupStatusService;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = Buffer.alloc(32, 7).toString('base64');
  const sql = testClient();
  await sql`
    insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed, configured_by)
    values ('default', true, 'https://alembic.example.test/api/v1/bridge/rawprod/events', ${sealSecret(SECRET)}, 'test')
    on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url, hmac_secret_sealed = excluded.hmac_secret_sealed`;
  lights = new PickLightService(shelfDb(sql));
  status = new SetupStatusService(sql, vault as never);
  const config = { get: (k: string) => (k === 'ALEMBIC_ASSERTION_TENANT_ID' ? TENANT : undefined) } as never;
  catalogue = new FactoryCatalogueService(sql, bridgeDb(), config, lights, status);
  const db = drizzle(sql);
  svc = new FormulaSetupService(db as never, principals as never, vault as never, new CatalogueProductKindSource(db as never));
});

after(async () => {
  await lights.onModuleDestroy?.();
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK; else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await closeTestClient();
});

function item(over: Partial<CatalogueItem> = {}): CatalogueItem {
  const id = randomUUID();
  return {
    alembic_sku_id: id, sku_code: `FSC-${id.slice(0, 8).toUpperCase()}`, name: 'Hedione Test', category: 'molecule',
    classification: 'single_chemical', classification_basis: 'CAS number 24851-98-7 on file', grade: null,
    cas_number: '24851-98-7', cas_source: 'ALEMBIC catalogue (product record)', density_mg_per_ml: null, density_source: null,
    hazmat: { is_hazmat: false, un_number: null, hazard_class: null, packing_group: null, flash_point_c: null, source: null, verified_at: null },
    pack_sizes: [{ label: '100 g', dimension: 'MASS', kg: 0.1, status: 'ok' }],
    on_hand_kg: 10, ...over,
  };
}
const blendItem = (over: Partial<CatalogueItem> = {}) =>
  item({ classification: 'blend', classification_basis: 'fragrance grade Klone', grade: 'Klone', cas_number: null, cas_source: null, ...over });

/** Sync items through the real signed endpoint; returns each item's result. */
async function sync(items: CatalogueItem[]): Promise<ItemResult[]> {
  const raw = JSON.stringify({ tenantId: TENANT, subject: null, op: 'upsert', items });
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const r = await catalogue.handle(raw, signBody(`${ts}.${nonce}.${raw}`, SECRET), ts, nonce);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body as { results: ItemResult[] }).results;
}
async function formulaOf(productId: string) {
  return (await testClient()`select formula_id::text from packaging.product_master where product_id = ${productId}`)[0]!.formula_id as string | null;
}

test('classification: catalogue products carry the catalogue kind, basis and own material; others have none', async () => {
  const [single, blend] = await sync([item(), blendItem()]);
  const loose = await productWithSku({ formulaId: null }); // made by hand, never in the catalogue
  const { items } = await svc.listProducts({ reveal: true });
  const by = (id: string) => items.find((i) => i.productId === id)!;
  assert.equal(by(single!.product_id!).catalogueKind, 'single_chemical');
  assert.equal(by(single!.product_id!).catalogueBasis, 'CAS number 24851-98-7 on file');
  assert.equal(by(single!.product_id!).material?.materialId, single!.material_id);
  assert.equal(by(blend!.product_id!).catalogueKind, 'blend');
  assert.equal(by(blend!.product_id!).catalogueBasis, 'fragrance grade Klone');
  assert.equal(by(loose.productId).catalogueKind, null, 'not in the catalogue: the owner chooses');
  assert.equal(by(loose.productId).catalogueBasis, null);
});

test('classification: catalogue rows that disagree on one product give no classification (never a guess)', async () => {
  const [first] = await sync([item()]);
  // A second ALEMBIC SKU landing on the same factory product, classified the other way.
  await testClient()`
    insert into bridge.catalogue_item (alembic_sku_id, sku_code, name, classification, classification_basis, product_id, synced_by)
    values (${randomUUID()}, ${'FSX-' + randomUUID().slice(0, 8)}, 'Other pack', 'blend', 'fragrance grade Economy', ${first!.product_id}, 'test')`;
  const source = new CatalogueProductKindSource(drizzle(testClient()) as never);
  const got = await source.classify([first!.product_id!, randomUUID()]);
  assert.equal(got.has(first!.product_id!), false);
  assert.equal(got.size, 0, 'an unknown product id has no entry either');
  const r = await svc.createShells({ products: [{ productId: first!.product_id! }] }, owner);
  assert.equal(r.results[0]!.outcome, 'error');
  assert.match(r.results[0]!.error!, /no classification/);
});

test('material: a single chemical is sealed from the catalogue\'s material ahead of the code match', async () => {
  const sql = testClient();
  const p = await productWithSku({ formulaId: null });
  const byCode = randomUUID();
  const catalogueMat = randomUUID();
  await sql`insert into masterdata.material (material_id, material_code, material_name, status) values (${byCode}, ${p.productCode}, 'Same code', 'ACTIVE')`;
  await sql`insert into masterdata.material (material_id, material_code, material_name, status) values (${catalogueMat}, ${'CM-' + catalogueMat.slice(0, 8)}, 'Catalogue material', 'ACTIVE')`;
  await sql`
    insert into bridge.catalogue_item (alembic_sku_id, sku_code, name, classification, classification_basis, material_id, product_id, synced_by)
    values (${randomUUID()}, ${'FSM-' + randomUUID().slice(0, 8)}, 'Repack', 'single_chemical', 'CAS number on file', ${catalogueMat}, ${p.productId}, 'test')`;
  const listed = (await svc.listProducts({ reveal: true })).items.find((i) => i.productId === p.productId)!;
  assert.deepEqual(listed.material, { materialId: catalogueMat, materialCode: 'CM-' + catalogueMat.slice(0, 8), materialName: 'Catalogue material' });
  calls.length = 0;
  const r = await svc.createShells({ products: [{ productId: p.productId }] }, owner);
  assert.equal(r.results[0]!.outcome, 'created');
  assert.deepEqual(calls[0], [{ productId: p.productId, kind: 'single_chemical', materialId: catalogueMat }]);
});

test('default: shells with no kind take the catalogue\'s; an unknown product with no kind is refused before the Vault', async () => {
  const [single, blend] = await sync([item(), blendItem()]);
  const loose = await productWithSku({ formulaId: null });
  calls.length = 0;
  const { results } = await svc.createShells({
    products: [{ productId: single!.product_id! }, { productId: blend!.product_id! }, { productId: loose.productId }],
  }, owner);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { productId: single!.product_id!, kind: 'single_chemical', materialId: single!.material_id },
    { productId: blend!.product_id!, kind: 'blend', materialId: null },
  ]);
  const by = (id: string) => results.find((r) => r.productId === id)!;
  assert.equal(by(loose.productId).outcome, 'error');
  assert.match(by(loose.productId).error!, /no classification for .* choose single chemical or blend/);
  assert.equal(await formulaOf(loose.productId), null);
  for (const p of [single!, blend!]) {
    assert.equal(by(p.product_id!).linked, true);
    const [a] = await testClient()`select after from packaging.audit_events where entity_id = ${p.product_id} and action = 'packaging.product.formula_linked'`;
    assert.match((a!.after as { reason: string }).reason, /from the catalogue/);
  }
  // The owner may still classify a product the catalogue lacks.
  const chosen = await svc.createShells({ products: [{ productId: loose.productId, kind: 'blend' }] }, owner);
  assert.equal(chosen.results[0]!.outcome, 'created');
});

test('blend: a catalogue blend is never sealed as a single chemical without the owner\'s explicit override', async () => {
  const [blend] = await sync([blendItem()]);
  calls.length = 0;
  const plain = await svc.createShells({ products: [{ productId: blend!.product_id!, kind: 'single_chemical' }] }, owner);
  assert.equal(plain.results[0]!.outcome, 'error');
  assert.match(plain.results[0]!.error!, /classifies .* as a blend \(fragrance grade Klone\)/);
  assert.equal(calls.length, 0, 'nothing reached the Vault');
  assert.equal(await formulaOf(blend!.product_id!), null);
  // Not even with its material named.
  const named = await svc.createShells({ products: [{ productId: blend!.product_id!, kind: 'single_chemical', materialId: blend!.material_id }] }, owner);
  assert.equal(named.results[0]!.outcome, 'error');
  assert.equal(calls.length, 0);
  // The listing never offers a blend's material as a single chemical's either: the kind stays blend.
  const listed = (await svc.listProducts({ reveal: true })).items.find((i) => i.productId === blend!.product_id)!;
  assert.equal(listed.catalogueKind, 'blend');

  // The owner's explicit override (the screen sends it after saying so) seals it, and the audit says so.
  const over = await svc.createShells({ products: [{ productId: blend!.product_id!, kind: 'single_chemical', overrideCatalogue: true }] }, owner);
  assert.equal(over.results[0]!.outcome, 'created');
  assert.deepEqual(calls[0], [{ productId: blend!.product_id!, kind: 'single_chemical', materialId: blend!.material_id }]);
  const [a] = await testClient()`select after from packaging.audit_events where entity_id = ${blend!.product_id} and action = 'packaging.product.formula_linked'`;
  assert.match((a!.after as { reason: string }).reason, /owner override of the catalogue's blend/);
});

test('a catalogue single chemical may be drafted as a blend (the safe direction) with no override', async () => {
  const [single] = await sync([item()]);
  calls.length = 0;
  const r = await svc.createShells({ products: [{ productId: single!.product_id!, kind: 'blend' }] }, owner);
  assert.equal(r.results[0]!.outcome, 'created');
  assert.deepEqual(calls[0], [{ productId: single!.product_id!, kind: 'blend', materialId: null }]);
});
