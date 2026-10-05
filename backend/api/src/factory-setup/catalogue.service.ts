/**
 * FactoryCatalogueService (FACTORY-SETUP, lane catalogue) — the signed endpoint ALEMBIC sends its
 * catalogue to, and the setup status it reads back.
 *
 *   op 'upsert'  per item, in ONE transaction each: a masterdata.material (code = the SKU code,
 *                name, and the CAS number / density only as ALEMBIC holds them) with its floor
 *                code (rm_alias, deterministic and opaque — catalogue.contract.ts floorCodeFor), a
 *                packaging.product_master with NO formula (linking a formula is the Vault's work,
 *                and product_master.formula_id is never touched here), and a packaging.product_sku
 *                whose sku_code IS the ALEMBIC code; then bridge.catalogue_item records it all,
 *                keyed by ALEMBIC's SKU id. A re-send is an update of what this endpoint wrote and
 *                nothing else; a product or material that already exists under the same code (made
 *                by hand before the bridge) is LINKED, not duplicated and not rewritten.
 *   op 'status'  the setup counts ALEMBIC's Admin summary card shows.
 *
 * The material and alias are written with the same outbox events MaterialService records
 * (`masterdata.material.created`, `masterdata.alias.created`), so every consumer — the Vault's
 * material catalogue push among them — sees a new material exactly as if a person had made it.
 *
 * Audited: one bridge.audit_events row per call (who asked, how many created / updated / linked /
 * refused). The actor is the RawProd user ALEMBIC's subject is bound to, when there is one.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { ConfigService, PG_CLIENT } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { BRIDGE_DB, type BridgeDb } from '../bridge/bridge.tokens.js';
import { verifySignedBridgeRequest } from '../bridge/signed-request.js';
import { PickLightService } from '../shelf/pick-light.service.js';
import { floorCodeFor, itemProblems, requestProblems, type CatalogueItem, type CatalogueRequest } from './catalogue.contract.js';
import { SetupStatusService } from './setup-status.service.js';

export interface ItemResult {
  sku_code: string;
  outcome: 'created' | 'updated' | 'linked' | 'unchanged' | 'refused';
  reason?: string;
  material_id: string | null;
  rm_alias_id: string | null;
  floor_code: string | null;
  product_id: string | null;
  product_sku_id: string | null;
}

export type CatalogueCallResult =
  | { status: 200; body: { ok: true; results?: ItemResult[]; status?: unknown } }
  | { status: 400 | 401 | 403; body: { ok: false; reason: string; problems?: string[] } };

const SYSTEM_ACTOR = 'alembic-catalogue-sync';

@Injectable()
export class FactoryCatalogueService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Inject(BRIDGE_DB) private readonly bridgeDb: BridgeDb,
    @Inject(ConfigService) private readonly config: Pick<ConfigService, 'get'>,
    private readonly lights: PickLightService,
    private readonly status: SetupStatusService,
  ) {}

  async handle(rawBody: string, signature: string | null, timestamp: string | null, nonce: string | null): Promise<CatalogueCallResult> {
    if (!(await verifySignedBridgeRequest(this.bridgeDb, rawBody, signature, timestamp, nonce))) {
      return { status: 401, body: { ok: false, reason: 'unauthenticated' } };
    }
    let parsed: unknown;
    try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { return { status: 400, body: { ok: false, reason: 'bad_request', problems: ['body'] } }; }
    const problems = requestProblems(parsed);
    if (problems.length) return { status: 400, body: { ok: false, reason: 'bad_request', problems } };
    const req = parsed as CatalogueRequest;
    /* TENANT-SCOPED: this box was commissioned against one ALEMBIC tenant; a validly signed call
       naming another is refused, whatever it carries. Unconfigured is not open. */
    const tenant = this.config.get('ALEMBIC_ASSERTION_TENANT_ID');
    if (!tenant || req.tenantId.toLowerCase() !== String(tenant).toLowerCase()) {
      return { status: 403, body: { ok: false, reason: 'wrong_tenant' } };
    }
    if (req.op === 'status') return { status: 200, body: { ok: true, status: await this.status.counts() } };

    const actor = await this.actorFor(req.subject ?? null);
    const results: ItemResult[] = [];
    for (const raw of req.items) {
      const bad = itemProblems(raw);
      const code = typeof (raw as { sku_code?: unknown })?.sku_code === 'string' ? (raw as { sku_code: string }).sku_code : '';
      if (bad.length) {
        results.push({ sku_code: code, outcome: 'refused', reason: `the item is malformed (${bad.join(', ')})`, material_id: null, rm_alias_id: null, floor_code: null, product_id: null, product_sku_id: null });
        continue;
      }
      try {
        results.push(await this.sql.begin((tx) => this.upsertItem(tx, raw as CatalogueItem, actor.name)));
      } catch (err) {
        results.push({ sku_code: code, outcome: 'refused', reason: `the factory could not save it (${(err as Error).message.slice(0, 160)})`, material_id: null, rm_alias_id: null, floor_code: null, product_id: null, product_sku_id: null });
      }
    }

    /* Setup default (owner, 2026-10-05): pick-to-light shows lit bins on screen until a hardware
       controller is entered. Only when nobody has set a mode — a configured one is never touched. */
    await this.defaultPickLight(actor.name);

    const count = (o: ItemResult['outcome']) => results.filter((r) => r.outcome === o).length;
    await this.sql`
      insert into bridge.audit_events (actor_id, action, entity_type, entity_id, after, occurred_at)
      values (${actor.userId}, 'bridge.catalogue_synced', 'catalogue_item', null,
              ${JSON.stringify({ subject: req.subject ?? null, items: results.length, created: count('created'), updated: count('updated'),
                linked: count('linked'), unchanged: count('unchanged'), refused: count('refused') })}::text::jsonb, now())`;
    return { status: 200, body: { ok: true, results } };
  }

  /** The RawProd user ALEMBIC's subject is bound to, for the audit trail only. */
  private async actorFor(subject: string | null): Promise<{ userId: string | null; name: string }> {
    if (!subject) return { userId: null, name: SYSTEM_ACTOR };
    const [u] = (await this.sql`select user_id::text as "userId" from iam.user_master where alembic_subject = ${subject} limit 1`) as Array<{ userId: string }>;
    return u ? { userId: u.userId, name: u.userId } : { userId: null, name: `${SYSTEM_ACTOR}:${subject}` };
  }

  private async defaultPickLight(actor: string): Promise<void> {
    const [row] = (await this.sql`select 1 from location.pick_light_config where id = 'default'`) as unknown as unknown[];
    if (row) return;
    try { await this.lights.configure({ mode: 'simulator' }, actor); } catch { /* the checklist shows it unset */ }
  }

  private async upsertItem(tx: TransactionSql, i: CatalogueItem, who: string): Promise<ItemResult> {
    const [existing] = (await tx`
      select alembic_sku_id::text, sku_code, material_id::text, material_owned, rm_alias_id::text, floor_code,
             product_id::text, product_sku_id::text, name, classification, classification_basis, grade, cas_number,
             cas_source, density_mg_per_ml, density_source, hazmat, pack_sizes, on_hand_kg::float as on_hand_kg, category
        from bridge.catalogue_item where alembic_sku_id = ${i.alembic_sku_id}::uuid for update`) as Array<Record<string, any>>;

    /* A factory SKU code belongs to one ALEMBIC SKU. */
    const [codeOwner] = (await tx`select alembic_sku_id::text from bridge.catalogue_item where sku_code = ${i.sku_code} and alembic_sku_id <> ${i.alembic_sku_id}::uuid`) as Array<{ alembic_sku_id: string }>;
    if (codeOwner) {
      return { sku_code: i.sku_code, outcome: 'refused', reason: 'another ALEMBIC product already holds this factory code', material_id: null, rm_alias_id: null, floor_code: null, product_id: null, product_sku_id: null };
    }

    const density = i.density_mg_per_ml !== null ? String(Math.round(i.density_mg_per_ml) / 1000) : null; // g/ml
    let outcome: ItemResult['outcome'] = existing ? 'updated' : 'created';

    /* ── material ── */
    let materialId: string | null = existing?.material_id ?? null;
    let owned: boolean = existing?.material_owned ?? false;
    if (!materialId) {
      const [m] = (await tx`select material_id::text from masterdata.material where material_code = ${i.sku_code} limit 1`) as Array<{ material_id: string }>;
      if (m) { materialId = m.material_id; owned = false; outcome = 'linked'; }
      else {
        materialId = uuidv7(); owned = true;
        await tx`
          insert into masterdata.material (material_id, material_code, material_name, description, density, cas_number, status, created_by, updated_by)
          values (${materialId}::uuid, ${i.sku_code}, ${i.name.slice(0, 200)}, ${`From the ALEMBIC catalogue — ${i.classification === 'single_chemical' ? 'single chemical' : 'blend'}: ${i.classification_basis}`},
                  ${density}, ${i.cas_number}, 'ACTIVE', ${who}, ${who})`;
        await tx`insert into masterdata.outbox (type, aggregate_id, payload) values ('masterdata.material.created', ${materialId}::uuid, ${JSON.stringify({ materialId })}::text::jsonb)`;
      }
    } else if (owned) {
      /* What this endpoint created, it keeps current with ALEMBIC's facts. */
      await tx`update masterdata.material set material_name = ${i.name.slice(0, 200)}, cas_number = ${i.cas_number}, density = ${density},
                 updated_by = ${who}, updated_dt = now() where material_id = ${materialId}::uuid`;
    } else {
      /* A material a person made: fill only what is empty, never overwrite. */
      await tx`update masterdata.material set cas_number = coalesce(cas_number, ${i.cas_number}), density = coalesce(density, ${density}::numeric),
                 updated_dt = now() where material_id = ${materialId}::uuid and (cas_number is null or density is null)`;
    }

    /* ── floor code ── */
    let rmAliasId: string | null = existing?.rm_alias_id ?? null;
    let floorCode: string | null = existing?.floor_code ?? null;
    if (!rmAliasId) {
      const [a] = (await tx`select rm_alias_id::text, alias_name from masterdata.rm_alias where material_id = ${materialId}::uuid and coalesce(status, 'ACTIVE') = 'ACTIVE' order by created_dt limit 1`) as Array<{ rm_alias_id: string; alias_name: string }>;
      if (a) { rmAliasId = a.rm_alias_id; floorCode = a.alias_name; }
      else {
        for (let attempt = 0; attempt < 4; attempt++) {
          const code = floorCodeFor(i.sku_code, attempt);
          const [clash] = (await tx`select 1 from masterdata.rm_alias where upper(alias_name) = upper(${code}) limit 1`) as unknown as unknown[];
          if (!clash) { floorCode = code; break; }
        }
        if (!floorCode) throw new Error('no free floor code');
        rmAliasId = uuidv7();
        await tx`insert into masterdata.rm_alias (rm_alias_id, material_id, alias_name, alias_type, status, created_by, updated_by)
                 values (${rmAliasId}::uuid, ${materialId}::uuid, ${floorCode}, 'FLOOR', 'ACTIVE', ${who}, ${who})`;
        await tx`insert into masterdata.outbox (type, aggregate_id, payload) values ('masterdata.alias.created', ${rmAliasId}::uuid, ${JSON.stringify({ rmAliasId, materialId })}::text::jsonb)`;
      }
    }

    /* ── product + factory SKU ── */
    let productId: string | null = existing?.product_id ?? null;
    let productSkuId: string | null = existing?.product_sku_id ?? null;
    if (!productSkuId) {
      const [s] = (await tx`select product_sku_id::text, product_id::text from packaging.product_sku where sku_code = ${i.sku_code} order by product_sku_id limit 1`) as Array<{ product_sku_id: string; product_id: string | null }>;
      if (s) { productSkuId = s.product_sku_id; productId = s.product_id; outcome = 'linked'; }
    }
    if (!productId) {
      const [p] = (await tx`select product_id::text from packaging.product_master where product_code = ${i.sku_code} limit 1`) as Array<{ product_id: string }>;
      if (p) { productId = p.product_id; outcome = 'linked'; }
      else {
        productId = uuidv7();
        await tx`insert into packaging.product_master (product_id, product_code, product_name, status, created_by, updated_by)
                 values (${productId}::uuid, ${i.sku_code}, ${i.name.slice(0, 200)}, 'ACTIVE', ${who}, ${who})`;
      }
    }
    if (!productSkuId) {
      productSkuId = uuidv7();
      /* pack_size stays empty: the factory SKU is the bulk product, made and stocked by WEIGHT
         (the requirement's qty_kg sizes the run); the commercial packs are ALEMBIC's, packed at
         dispatch. A finished-goods batch is recorded in a mass unit, which fg.batch.received
         converts without needing a pack size. */
      await tx`insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status, created_by, updated_by)
               values (${productSkuId}::uuid, ${productId}::uuid, ${i.sku_code}, null, 'ACTIVE', ${who}, ${who})`;
    }

    const before = existing ? JSON.stringify({
      n: existing.name, c: existing.classification, b: existing.classification_basis, g: existing.grade, cas: existing.cas_number,
      cs: existing.cas_source, d: existing.density_mg_per_ml, ds: existing.density_source, h: existing.hazmat, p: existing.pack_sizes, cat: existing.category,
    }) : null;
    const after = JSON.stringify({
      n: i.name, c: i.classification, b: i.classification_basis, g: i.grade, cas: i.cas_number, cs: i.cas_source,
      d: i.density_mg_per_ml, ds: i.density_source, h: i.hazmat, p: i.pack_sizes, cat: i.category,
    });
    if (existing && outcome === 'updated' && canonical(before) === canonical(after)) outcome = 'unchanged';

    await tx`
      insert into bridge.catalogue_item (alembic_sku_id, sku_code, name, category, classification, classification_basis, grade,
        cas_number, cas_source, density_mg_per_ml, density_source, hazmat, pack_sizes, on_hand_kg,
        material_id, material_owned, rm_alias_id, floor_code, product_id, product_sku_id, synced_at, synced_by)
      values (${i.alembic_sku_id}::uuid, ${i.sku_code}, ${i.name}, ${i.category ?? null}, ${i.classification}, ${i.classification_basis}, ${i.grade},
        ${i.cas_number}, ${i.cas_source}, ${i.density_mg_per_ml}, ${i.density_source}, ${JSON.stringify(i.hazmat)}::text::jsonb,
        ${JSON.stringify(i.pack_sizes)}::text::jsonb, ${i.on_hand_kg},
        ${materialId}::uuid, ${owned}, ${rmAliasId}::uuid, ${floorCode}, ${productId}::uuid, ${productSkuId}::uuid, now(), ${who})
      on conflict (alembic_sku_id) do update set sku_code = excluded.sku_code, name = excluded.name, category = excluded.category,
        classification = excluded.classification, classification_basis = excluded.classification_basis, grade = excluded.grade,
        cas_number = excluded.cas_number, cas_source = excluded.cas_source, density_mg_per_ml = excluded.density_mg_per_ml,
        density_source = excluded.density_source, hazmat = excluded.hazmat, pack_sizes = excluded.pack_sizes,
        on_hand_kg = excluded.on_hand_kg, material_id = excluded.material_id, material_owned = excluded.material_owned,
        rm_alias_id = excluded.rm_alias_id, floor_code = excluded.floor_code, product_id = excluded.product_id,
        product_sku_id = excluded.product_sku_id, synced_at = now(), synced_by = excluded.synced_by`;

    return { sku_code: i.sku_code, outcome, material_id: materialId, rm_alias_id: rmAliasId, floor_code: floorCode, product_id: productId, product_sku_id: productSkuId };
  }
}

function canonical(json: string | null): string {
  if (json === null) return '';
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(JSON.parse(json)));
}
