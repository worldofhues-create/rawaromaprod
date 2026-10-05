/**
 * Lane vaultsetup — the factory's formula setup (backend/api/src/formula-setup). Real Postgres for
 * products, materials and the link/audit rows; the Vault and the Ruh token are stubs here (the
 * two-process harness, formula-setup-e2e.test.ts, runs them for real).
 *
 *   list       products with their formula state and the single-chemical material candidate.
 *   shells     a Ruh token is minted for the ONE Vault call; products already linked are skipped;
 *              a single chemical with no resolvable material is refused before the Vault is asked;
 *              each drafted shell's formula is linked where the product still has none, with an
 *              audit row; a re-run links nothing twice.
 *   link       set/replace an existing product's formula: the formula must exist in the Vault, the
 *              before/after/reason is audited, a no-op changes nothing; the generic edit route still
 *              cannot touch formula_id.
 *   guards     link + shells need packaging:product_formula_link:write (owner, production), reading
 *              needs :read; floor roles are refused; GET /v1/formulas exists on the main box now.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { FormulaSetupService } from '../formula-setup/formula-setup.service.js';
import { FormulaSetupController } from '../formula-setup/formula-setup.controller.js';
import { EditService } from '../edit/edit.service.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { productWithSku } from '../../../test-support/produce-fixtures.js';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

/** The stub Vault: formulas it knows, shells it drafts, and every call it received. */
const vaultFormulas = new Map<string, { formulaCode: string; approved: number | null }>();
const calls: Array<{ bearer: string; products: Array<{ productId: string; kind: string; materialId: string | null }> }> = [];
const vault = {
  async formulaLabels(q: { formulaIds: string[] }) {
    return {
      versions: [],
      formulas: q.formulaIds.filter((id) => vaultFormulas.has(id)).map((id) => ({
        formulaId: id,
        formulaCode: vaultFormulas.get(id)!.formulaCode,
        approvedVersion: vaultFormulas.get(id)!.approved ? { formulaVersionId: randomUUID(), versionNumber: vaultFormulas.get(id)!.approved } : null,
      })),
      recent: null,
    };
  },
  async formulaDirectory(limit: number) {
    return { items: [...vaultFormulas].slice(0, limit).map(([formulaId, f]) => ({ formulaId, formulaCode: f.formulaCode, status: 'ACTIVE', approvedVersion: null, latestVersionNumber: 1, latestVersionStatus: 'DRAFT' })), nextCursor: null };
  },
  /** Drafts (or returns the existing) shell per product, like the real Vault. */
  shells: new Map<string, string>(),
  async createFormulaShellsAs(bearer: string, body: { products: Array<{ productId: string; productCode: string; kind: string; materialId: string | null }> }) {
    calls.push({ bearer, products: body.products.map((p) => ({ productId: p.productId, kind: p.kind, materialId: p.materialId })) });
    return {
      results: body.products.map((p) => {
        const existing = this.shells.get(p.productId);
        const formulaId = existing ?? randomUUID();
        if (!existing) {
          this.shells.set(p.productId, formulaId);
          vaultFormulas.set(formulaId, { formulaCode: `F-${p.productCode}`, approved: null });
        }
        return { productId: p.productId, productCode: p.productCode, outcome: existing ? 'existing' : 'created', formulaId, formulaCode: `F-${p.productCode}`, kind: p.kind, state: p.kind === 'blend' ? 'recipe_needed' : 'in_review' };
      }),
    };
  },
};
let minted = 0;
let ruhAllowed = true;
const principals = {
  async mintVaultToken(purpose: string) {
    if (!ruhAllowed) throw new Error('Ruh is not allowed to draft formulas yet');
    minted += 1;
    assert.match(purpose, /draft formula shells/);
    return { token: `ruh-token-${minted}`, userId: randomUUID() };
  },
};

let svc: FormulaSetupService;
const owner = principal({ userId: randomUUID(), roles: ['owner'] });

before(async () => {
  await ensureSchema();
  svc = new FormulaSetupService(drizzle(testClient()) as never, principals as never, vault as never);
});
after(async () => {
  await closeTestClient();
});

async function material(code: string) {
  const id = randomUUID();
  await testClient()`insert into masterdata.material (material_id, material_code, material_name, status) values (${id}, ${code}, ${'Material ' + code}, 'ACTIVE')`;
  return id;
}
async function formulaOf(productId: string) {
  return (await testClient()`select formula_id::text from packaging.product_master where product_id = ${productId}`)[0]!.formula_id as string | null;
}
async function linkAudits(productId: string) {
  return testClient()`select actor_id::text, action, before, after from packaging.audit_events where entity_id = ${productId} order by occurred_at`;
}

test('list: formula state per product and the single-chemical material (the one material whose code is the product code)', async () => {
  const none = await productWithSku({ formulaId: null });
  const matId = await material(none.productCode.toLowerCase()); // case-insensitive match
  const linked = await productWithSku();
  vaultFormulas.set(linked.formulaId, { formulaCode: 'F-LINKED', approved: null });
  const approved = await productWithSku();
  vaultFormulas.set(approved.formulaId, { formulaCode: 'F-APPROVED', approved: 3 });
  const { items, vaultError } = await svc.listProducts({ reveal: true });
  assert.equal(vaultError, null);
  const by = (id: string) => items.find((i) => i.productId === id)!;
  assert.equal(by(none.productId).state, 'none');
  assert.deepEqual(by(none.productId).material?.materialId, matId);
  assert.deepEqual(by(none.productId).skuCodes, [none.skuCode]);
  assert.equal(by(none.productId).catalogueKind, null, 'no classification source wired yet');
  assert.equal(by(linked.productId).state, 'linked');
  assert.deepEqual(by(linked.productId).formula, { formulaCode: 'F-LINKED', approvedVersionNumber: null });
  assert.equal(by(approved.productId).state, 'approved');
  assert.equal(by(approved.productId).formula?.approvedVersionNumber, 3);
  assert.ok(!JSON.stringify(items).match(/formulaName|percentage/), 'no formula name or content on this box');
  // A caller without masterdata:material:reveal learns THAT the material was found, never which.
  const masked = (await svc.listProducts({ reveal: false })).items.find((i) => i.productId === none.productId)!;
  assert.deepEqual(masked.material, { materialId: matId, materialCode: null, materialName: null });
});

test('shells: one Ruh token for one Vault call; linked products skipped; unresolvable single chemicals refused up front; links audited; a re-run links nothing twice', async () => {
  const blend = await productWithSku({ formulaId: null });
  const single = await productWithSku({ formulaId: null });
  const singleMat = await material(single.productCode);
  const orphan = await productWithSku({ formulaId: null }); // single chemical with no matching material
  const already = await productWithSku();
  calls.length = 0;
  const before = minted;

  const { results } = await svc.createShells({
    products: [
      { productId: blend.productId, kind: 'blend' },
      { productId: single.productId, kind: 'single_chemical' },
      { productId: orphan.productId, kind: 'single_chemical' },
      { productId: already.productId, kind: 'blend' },
      { productId: randomUUID(), kind: 'blend' },
    ],
  }, owner);
  assert.equal(minted, before + 1, 'exactly one token minted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bearer, `ruh-token-${minted}`);
  assert.deepEqual(calls[0]!.products.map((p) => [p.productId, p.kind, p.materialId]), [
    [blend.productId, 'blend', null],
    [single.productId, 'single_chemical', singleMat],
  ]);
  const by = (id: string) => results.find((r) => r.productId === id)!;
  assert.equal(by(orphan.productId).outcome, 'error');
  assert.match(by(orphan.productId).error!, /No material has the code/);
  assert.equal(by(already.productId).outcome, 'already_linked');
  assert.equal(results.filter((r) => r.outcome === 'error').length, 2);
  for (const p of [blend, single]) {
    assert.equal(by(p.productId).outcome, 'created');
    assert.equal(by(p.productId).linked, true);
    assert.equal(await formulaOf(p.productId), by(p.productId).formulaId);
    const audits = await linkAudits(p.productId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actor_id, owner.userId);
    assert.equal(audits[0]!.action, 'packaging.product.formula_linked');
    assert.deepEqual(audits[0]!.before, { formulaId: null });
    assert.equal((audits[0]!.after as { formulaId: string }).formulaId, by(p.productId).formulaId);
  }
  assert.equal(await formulaOf(already.productId), already.formulaId, 'an already-linked product is untouched');

  // Re-run: nothing left to draft for the two linked products; no second token, no second link.
  const again = await svc.createShells({ products: [{ productId: blend.productId, kind: 'blend' }] }, owner);
  assert.equal(again.results[0]!.outcome, 'already_linked');
  assert.equal(calls.length, 1);
  assert.equal((await linkAudits(blend.productId)).length, 1);

  // A product someone linked between the Vault call and the link keeps that link (never overwritten).
  const raced = await productWithSku({ formulaId: null });
  const someoneElse = randomUUID();
  const realShells = vault.createFormulaShellsAs.bind(vault);
  vault.createFormulaShellsAs = async (bearer, body) => {
    await testClient()`update packaging.product_master set formula_id = ${someoneElse} where product_id = ${raced.productId}`;
    return realShells(bearer, body);
  };
  try {
    const r = await svc.createShells({ products: [{ productId: raced.productId, kind: 'blend' }] }, owner);
    assert.equal(r.results[0]!.linked, false);
    assert.equal(await formulaOf(raced.productId), someoneElse);
  } finally {
    vault.createFormulaShellsAs = realShells;
  }
});

test('shells: refused as a whole when Ruh has no approved grant — nothing reaches the Vault, nothing is linked', async () => {
  const p = await productWithSku({ formulaId: null });
  ruhAllowed = false;
  calls.length = 0;
  try {
    await assert.rejects(() => svc.createShells({ products: [{ productId: p.productId, kind: 'blend' }] }, owner), /not allowed to draft formulas yet/);
  } finally {
    ruhAllowed = true;
  }
  assert.equal(calls.length, 0);
  assert.equal(await formulaOf(p.productId), null);
});

test('link: set or replace an existing product\'s formula — the formula must exist in the Vault; before/after/reason audited; a no-op changes nothing', async () => {
  const p = await productWithSku();
  const replacement = randomUUID();
  await assert.rejects(() => svc.linkFormula(p.productId, { formulaId: replacement, reason: 'switch to v2 recipe' }, owner), /No such formula in the Vault/);
  assert.equal(await formulaOf(p.productId), p.formulaId);

  vaultFormulas.set(replacement, { formulaCode: 'F-REPL', approved: 1 });
  const res = await svc.linkFormula(p.productId, { formulaId: replacement, reason: 'switch to the reformulated blend' }, owner);
  assert.equal(res.changed, true);
  assert.equal(res.formulaCode, 'F-REPL');
  assert.equal(await formulaOf(p.productId), replacement);
  const audits = await linkAudits(p.productId);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0]!.before, { formulaId: p.formulaId });
  assert.deepEqual(audits[0]!.after, { formulaId: replacement, reason: 'switch to the reformulated blend' });

  const same = await svc.linkFormula(p.productId, { formulaId: replacement, reason: 'again' }, owner);
  assert.equal(same.changed, false);
  assert.equal((await linkAudits(p.productId)).length, 1);
  await assert.rejects(() => svc.linkFormula(randomUUID(), { formulaId: replacement, reason: 'nope' }, owner), /No such product/);
});

test('the generic edit route still cannot change a product\'s formula (only the guarded link can)', async () => {
  const p = await productWithSku();
  const edit = new EditService(testClient());
  await assert.rejects(
    () => edit.update('products', p.productId, { formulaId: randomUUID() }, principal({ permissions: ['packaging:product_master:write'] })),
    /No editable fields supplied/,
  );
  assert.equal(await formulaOf(p.productId), p.formulaId);
});

test('directory: GET /v1/formulas now answers on the main box (code/status, no name)', async () => {
  const page = await svc.directory(100, null);
  assert.ok(page.items.length > 0);
  assert.ok(page.items.every((f) => !('formulaName' in f)));
});

/* ── guards ─────────────────────────────────────────────────────────────────────────────── */

const guard = new PermissionsGuard(new Reflector());
function ctx(method: string, user: unknown) {
  const handler = (FormulaSetupController.prototype as unknown as Record<string, unknown>)[method];
  return { getHandler: () => handler, getClass: () => FormulaSetupController, switchToHttp: () => ({ getRequest: () => ({ user }) }) } as never;
}
const grant = (code: string) => RA_PERMISSIONS.filter((p) => ROLES.find((r) => r.code === code)!.select(p));
const asRole = (code: string) => principal({ roles: [code], permissions: grant(code) });

test('guards: owner and production may draft shells and link; packaging too (its blanket packaging:* grant); floor/QC/sales/formula roles may not', () => {
  for (const role of ['owner', 'production', 'packaging']) {
    for (const m of ['products', 'shells', 'link', 'formulas']) assert.equal(guard.canActivate(ctx(m, asRole(role))), true, `${role} ${m}`);
  }
  for (const role of ['compounding', 'filling', 'qc', 'warehouse', 'sales', 'formulator', 'vault_approver', 'admin']) {
    for (const m of ['shells', 'link']) {
      assert.throws(() => guard.canActivate(ctx(m, asRole(role))), (e: unknown) => e instanceof DomainError && (e as DomainError).status === 403, `${role} ${m}`);
    }
  }
});

test('catalogue: both new permissions are in the seed catalogue; no Vault role and no admin holds them', () => {
  for (const p of ['packaging:product_formula_link:read', 'packaging:product_formula_link:write']) {
    assert.ok(RA_PERMISSIONS.includes(p), p);
    for (const role of ['formulator', 'vault_approver', 'admin', 'compounding']) assert.ok(!grant(role).includes(p), `${role} ${p}`);
  }
});
