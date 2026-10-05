/**
 * FACTORY-SETUP (lane catalogue, owner decisions 2026-10-05) — the pure half of the factory
 * catalogue endpoint and the setup proposals. No I/O; every function here is unit-tested.
 *
 * THE WIRE (ALEMBIC → RawProd), `POST /v1/bridge/catalogue/sync`, signed exactly like the Facts
 * API (`x-bridge-timestamp`, `x-bridge-nonce`, `x-bridge-signature` = HMAC-SHA256 over
 * `${timestamp}.${nonce}.${rawBody}` with the bridge's shared secret — bridge/signed-request.ts):
 *
 *   { tenantId: <ALEMBIC tenant uuid — must equal this box's ALEMBIC_ASSERTION_TENANT_ID>,
 *     subject:  <ALEMBIC staff uuid | null — who pressed the button; matched to a RawProd user
 *                through user_master.alembic_subject for the audit row only, never authority>,
 *     op:       'upsert' | 'status',
 *     items:    CatalogueItem[]  (upsert: 1..200; status: []) }
 *
 * One CatalogueItem per ALEMBIC SKU — see docs/bridge/FACTORY_CATALOGUE.md for every field. The
 * factory SKU code IS the ALEMBIC SKU code: requirements name it (`mapped_sku`) and
 * `fg.batch.received` comes back with it, and ALEMBIC finds its SKU by that code.
 *
 * NOTHING IS INFERRED. The CAS number and the dangerous-goods facts arrive only as values ALEMBIC
 * holds, each with its source, and they are kept as facts with their source in
 * bridge.catalogue_item; this box does not turn them into a label's DG block (that is
 * packaging.product_dg_info, entered from the product's SDS by a person).
 */
import { createHash } from 'node:crypto';

export const CLASSIFICATIONS = ['single_chemical', 'blend'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const PACK_STATUSES = ['ok', 'needs_density', 'counted', 'unreadable'] as const;

export interface PackSize {
  label: string;
  dimension: 'MASS' | 'VOLUME' | 'COUNT' | null;
  kg: number | null;
  status: (typeof PACK_STATUSES)[number];
}

export interface HazmatFacts {
  is_hazmat: boolean;
  un_number: string | null;
  hazard_class: string | null;
  packing_group: string | null;
  flash_point_c: number | null;
  source: string | null;
  verified_at: string | null;
}

export interface CatalogueItem {
  alembic_sku_id: string;
  sku_code: string;
  name: string;
  category: string;
  classification: Classification;
  classification_basis: string;
  grade: string | null;
  cas_number: string | null;
  cas_source: string | null;
  density_mg_per_ml: number | null;
  density_source: string | null;
  hazmat: HazmatFacts;
  pack_sizes: PackSize[];
  on_hand_kg: number;
}

export interface CatalogueRequest {
  tenantId: string;
  subject: string | null;
  op: 'upsert' | 'status';
  items: CatalogueItem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A code the factory can hold (varchar 50) and print on a label. */
const CODE = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
export const MAX_ITEMS = 200;

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const optStr = (v: unknown, max: number): boolean => v === null || v === undefined || (typeof v === 'string' && v.length <= max);
const optNum = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

/** Problems with one item ([] = valid). Field names only — never the value back. */
export function itemProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['item'];
  const i = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof i.alembic_sku_id !== 'string' || !UUID.test(i.alembic_sku_id)) out.push('alembic_sku_id');
  if (!str(i.sku_code, 50) || !CODE.test(i.sku_code as string)) out.push('sku_code');
  if (!str(i.name, 200)) out.push('name');
  if (!optStr(i.category, 100)) out.push('category');
  if (!(CLASSIFICATIONS as readonly unknown[]).includes(i.classification)) out.push('classification');
  if (!str(i.classification_basis, 300)) out.push('classification_basis');
  if (!optStr(i.grade, 50)) out.push('grade');
  if (!optStr(i.cas_number, 60)) out.push('cas_number');
  if (!optStr(i.cas_source, 300)) out.push('cas_source');
  if (typeof i.cas_number === 'string' && i.cas_number.trim() !== '' && !str(i.cas_source, 300)) out.push('cas_source (a CAS number needs its source)');
  if (!(i.density_mg_per_ml === null || i.density_mg_per_ml === undefined
    || (Number.isInteger(i.density_mg_per_ml) && (i.density_mg_per_ml as number) > 0 && (i.density_mg_per_ml as number) < 5000))) out.push('density_mg_per_ml');
  if (!optStr(i.density_source, 600)) out.push('density_source');
  const h = i.hazmat as Record<string, unknown> | undefined;
  if (!h || typeof h !== 'object' || typeof h.is_hazmat !== 'boolean' || !optStr(h.un_number, 20) || !optStr(h.hazard_class, 40)
    || !optStr(h.packing_group, 5) || !optNum(h.flash_point_c) || !optStr(h.source, 600) || !optStr(h.verified_at, 40)) out.push('hazmat');
  if (!Array.isArray(i.pack_sizes) || i.pack_sizes.length > 60 || !i.pack_sizes.every((p) => {
    const q = p as Record<string, unknown>;
    return q && typeof q === 'object' && str(q.label, 50) && (PACK_STATUSES as readonly unknown[]).includes(q.status)
      && (q.kg === null || (typeof q.kg === 'number' && Number.isFinite(q.kg) && q.kg >= 0));
  })) out.push('pack_sizes');
  if (typeof i.on_hand_kg !== 'number' || !Number.isFinite(i.on_hand_kg) || i.on_hand_kg < 0) out.push('on_hand_kg');
  /* Belt and braces with ALEMBIC's own shape: nothing recipe-shaped is ever accepted here. */
  for (const k of Object.keys(i)) if (/formula|recipe|ingredient|composition|bom/i.test(k)) out.push(`unexpected:${k}`);
  return out;
}

/** The envelope's problems ([] = valid); items are checked one by one so a bad one refuses only itself. */
export function requestProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['body'];
  const r = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof r.tenantId !== 'string' || !UUID.test(r.tenantId)) out.push('tenantId');
  if (!(r.subject === null || r.subject === undefined || (typeof r.subject === 'string' && UUID.test(r.subject)))) out.push('subject');
  if (r.op !== 'upsert' && r.op !== 'status') out.push('op');
  if (!Array.isArray(r.items) || r.items.length > MAX_ITEMS || (r.op === 'upsert' && r.items.length === 0)) out.push('items');
  return out;
}

/**
 * The floor code (rm_alias) for a product's material — deterministic from the SKU code, and
 * opaque: a floor that reads "ISO-E-SUPER" on a pick list knows what it is weighing, which is
 * the identity the alias exists to mask. `RM-` + the first characters of the code's SHA-256 in
 * Crockford base32 (no I, L, O, U — nothing a floor misreads). `attempt` lengthens it on the
 * astronomically rare clash with another material's code.
 */
export function floorCodeFor(skuCode: string, attempt = 0): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const digest = createHash('sha256').update(skuCode.trim().toUpperCase(), 'utf8').digest();
  let bits = 0, value = 0, out = '';
  for (const byte of digest) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return `RM-${out.slice(0, 6 + attempt * 2)}`;
}

/* ── the proposals' lifecycle (the same rule ALEMBIC's density drafts follow) ──────────── */

export const PROPOSAL_SOURCES = ['document', 'catalogue fact', 'estimate'] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];
export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';
export const PROPOSER = 'Ruh';

export function decide(status: ProposalStatus, decision: 'approve' | 'reject'):
  { ok: true; next: ProposalStatus } | { ok: false; reason: string } {
  if (status !== 'proposed') return { ok: false, reason: `this proposal is already ${status}` };
  return { ok: true, next: decision === 'approve' ? 'approved' : 'rejected' };
}

const STRENGTH: Record<ProposalSource, number> = { document: 0, 'catalogue fact': 1, estimate: 2 };
export function weakest(sources: readonly ProposalSource[]): ProposalSource {
  return sources.reduce<ProposalSource>((w, s) => (STRENGTH[s] > STRENGTH[w] ? s : w), 'document');
}

/* ── a QC draft as ALEMBIC returns it ─────────────────────────────────────────────────── */

export interface DraftField<T> { value: T; source: ProposalSource; evidence: string }
export interface QcDraft {
  sg_min: DraftField<number>; sg_max: DraftField<number>;
  flash_point_min_c: DraftField<number>; flash_point_max_c: DraftField<number>;
  shelf_life_months: DraftField<number>;
  colour_appearance?: DraftField<string>; odour?: DraftField<string>;
}

function field<T>(v: unknown, kind: 'number' | 'string'): DraftField<T> | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  if (typeof f.value !== kind || (kind === 'number' && !Number.isFinite(f.value as number))) return null;
  if (!(PROPOSAL_SOURCES as readonly unknown[]).includes(f.source)) return null;
  if (typeof f.evidence !== 'string' || !f.evidence.trim()) return null;
  return { value: (kind === 'string' ? String(f.value).slice(0, 2000) : f.value) as T, source: f.source as ProposalSource, evidence: f.evidence.slice(0, 1000) };
}

/** A draft ALEMBIC sent, re-checked against the same rules the QC spec route applies; null when unusable. */
export function readQcDraft(raw: unknown): QcDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const sgMin = field<number>(d.sg_min, 'number'), sgMax = field<number>(d.sg_max, 'number');
  const fpMin = field<number>(d.flash_point_min_c, 'number'), fpMax = field<number>(d.flash_point_max_c, 'number');
  const shelf = field<number>(d.shelf_life_months, 'number');
  if (!sgMin || !sgMax || !fpMin || !fpMax || !shelf) return null;
  if (!(sgMin.value > 0 && sgMin.value <= sgMax.value && sgMax.value <= 9999)) return null;
  if (!(fpMin.value >= -273 && fpMin.value <= fpMax.value && fpMax.value <= 9999)) return null;
  if (!(Number.isInteger(shelf.value) && shelf.value >= 1 && shelf.value <= 240)) return null;
  const colour = d.colour_appearance === undefined ? null : field<string>(d.colour_appearance, 'string');
  const odour = d.odour === undefined ? null : field<string>(d.odour, 'string');
  return {
    sg_min: sgMin, sg_max: sgMax, flash_point_min_c: fpMin, flash_point_max_c: fpMax, shelf_life_months: shelf,
    ...(colour ? { colour_appearance: colour } : {}), ...(odour ? { odour } : {}),
  };
}

export function qcSource(d: QcDraft): ProposalSource {
  return weakest(Object.values(d).map((f) => (f as DraftField<unknown>).source));
}

/* ── the rack layout Ruh proposes ─────────────────────────────────────────────────────── */

export interface RackZone {
  /** Zone code: letters/digits, up to 12 — it becomes the rack-code prefix too. */
  zone: string;
  label: string;
  products: number;
  onHandKg: number;
  racks: number;
  shelvesPerRack: number;
  binsPerShelf: number;
}

export interface RackLayout { zones: RackZone[]; walkStart: number }

/** Sizing rules, stated where the evidence repeats them. */
export const KG_PER_BIN = 25;
export const DEFAULT_SHELVES = 5;
export const DEFAULT_BINS = 4;

const ZONE_OF_GRADE: Record<string, { zone: string; label: string }> = {
  identical: { zone: 'IDN', label: 'Identical grade' },
  klone: { zone: 'KLN', label: 'Klone grade' },
  economy: { zone: 'ECO', label: 'Economy grade' },
  inspired: { zone: 'INS', label: 'Inspired grade' },
  agarbatti: { zone: 'AGB', label: 'Agarbatti grade' },
};

/**
 * Zones by product family (the fragrance grade for blends; aroma chemicals together; other
 * blends together), each sized from its products and the stock ALEMBIC holds for them: one bin
 * per product, plus one more for every 25 kg on hand (about one drum a bin), on racks of 5
 * shelves × 4 bins, walked zone by zone. An ESTIMATE — the approver edits the counts.
 */
export function planRackLayout(items: ReadonlyArray<{ classification: Classification; grade: string | null; onHandKg: number }>): RackLayout {
  const zones = new Map<string, RackZone & { bins: number }>();
  for (const it of items) {
    const g = it.grade ? ZONE_OF_GRADE[it.grade.trim().toLowerCase()] : undefined;
    const z = g ?? (it.classification === 'single_chemical' ? { zone: 'CHM', label: 'Aroma chemicals' } : { zone: 'BLD', label: 'Other blends' });
    const cur = zones.get(z.zone) ?? { zone: z.zone, label: z.label, products: 0, onHandKg: 0, racks: 0, shelvesPerRack: DEFAULT_SHELVES, binsPerShelf: DEFAULT_BINS, bins: 0 };
    cur.products += 1;
    cur.onHandKg += Math.max(0, it.onHandKg);
    cur.bins += 1 + Math.floor(Math.max(0, it.onHandKg) / KG_PER_BIN);
    zones.set(z.zone, cur);
  }
  const order = ['CHM', 'IDN', 'KLN', 'ECO', 'INS', 'AGB', 'BLD'];
  const out = [...zones.values()].sort((a, b) => order.indexOf(a.zone) - order.indexOf(b.zone)).map(({ bins, ...z }) => ({
    ...z, onHandKg: Math.round(z.onHandKg * 10) / 10, racks: Math.max(1, Math.ceil(bins / (DEFAULT_SHELVES * DEFAULT_BINS))),
  }));
  return { zones: out, walkStart: 10 };
}

const ZONE_CODE = /^[A-Z0-9]{1,12}$/;

/** Problems with an (edited) layout before it is applied ([] = valid). */
export function layoutProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['layout'];
  const l = raw as Record<string, unknown>;
  if (!Array.isArray(l.zones) || l.zones.length === 0 || l.zones.length > 30) return ['zones'];
  const out: string[] = [];
  const seen = new Set<string>();
  let racks = 0;
  for (const [i, z] of (l.zones as Array<Record<string, unknown>>).entries()) {
    if (!z || typeof z !== 'object') { out.push(`zones[${i}]`); continue; }
    if (typeof z.zone !== 'string' || !ZONE_CODE.test(z.zone) || seen.has(z.zone)) out.push(`zones[${i}].zone`);
    else seen.add(z.zone);
    if (!Number.isInteger(z.racks) || (z.racks as number) < 0 || (z.racks as number) > 99) out.push(`zones[${i}].racks`);
    if (!Number.isInteger(z.shelvesPerRack) || (z.shelvesPerRack as number) < 1 || (z.shelvesPerRack as number) > 30) out.push(`zones[${i}].shelvesPerRack`);
    if (!Number.isInteger(z.binsPerShelf) || (z.binsPerShelf as number) < 1 || (z.binsPerShelf as number) > 50) out.push(`zones[${i}].binsPerShelf`);
    racks += Number(z.racks) || 0;
  }
  if (racks === 0) out.push('a layout needs at least one rack');
  return out;
}

/**
 * The layout as the CSV the existing rack import takes (`zone,rack,shelf,bin,walk`): rack codes
 * are the zone code + a two-digit number (CHM01…), shelves S1…, bins B1…, so the bins read
 * CHM01-S1-B1 exactly as a quick-added rack's do. Walk order runs zone by zone in steps of 10.
 */
export function layoutCsv(layout: RackLayout): string {
  const lines = ['zone,rack,shelf,bin,walk'];
  let walk = Number.isInteger(layout.walkStart) && layout.walkStart > 0 ? layout.walkStart : 10;
  for (const z of layout.zones) {
    for (let r = 1; r <= z.racks; r++) {
      const rack = `${z.zone}${String(r).padStart(2, '0')}`;
      for (let s = 1; s <= z.shelvesPerRack; s++) {
        for (let b = 1; b <= z.binsPerShelf; b++) lines.push(`${z.zone},${rack},S${s},B${b},${walk}`);
      }
      walk += 10;
    }
  }
  return lines.join('\n');
}

export const layoutBins = (layout: RackLayout): number =>
  layout.zones.reduce((n, z) => n + z.racks * z.shelvesPerRack * z.binsPerShelf, 0);
