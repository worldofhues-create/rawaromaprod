/**
 * Ruh's detectors — PURE: facts in, insights out, no clock but the one passed in, no database, no
 * model. The watch engine (RuhWatchService) gathers the facts (RuhFactsService) and hands each group
 * here; RuhInsightsService opens, updates and clears the insights. Tested with a fixed clock
 * (ruh-detectors.test.ts).
 *
 * Deterministic findings say what is wrong and the exact fix. Predictions are plain statistics and
 * always carry their basis and a confidence that reflects how much history they rest on:
 *
 *   predicted late       queue position × recent output: the kilograms still to make for this
 *                        requirement and everything ranked ahead of it, divided by the kilograms of
 *                        oil batches produced per day over the last N days (setting).
 *   raw-material run-out on-hand available ÷ the average daily issue of that material over the last
 *                        N days (setting) → days of cover and the run-out date.
 *
 * Words on screen are operator words. Vault findings are counts only. Factory deep links are
 * `#/go/<section>[|<section>…][/<record id>]` (the first section the person's role has opens);
 * Platform and Vault links are their own `#/<section>`.
 */
import {
  hoursBetween, plural, round1, ymd,
  type InsightDraft, type RuhPrediction, type RuhSeverity,
} from './ruh.contract.js';
import type { RuhSettings } from './ruh-settings.service.js';

/* ── facts ─────────────────────────────────────────────────────────────────────────────── */

export interface QueueFact {
  id: string;
  position: number;
  orderRef: string;
  sku: string;
  productCode: string | null;
  qtyKg: number | null;
  uom: string;
  neededBy: string;
  priorityRank: number | null;
  highValue: boolean;
  stage: string;
  blockReason: string | null;
}

export interface ProductionFacts {
  queue: QueueFact[];
  throughput: { kg: number; batches: number; windowDays: number };
}

export interface QcFacts {
  coaMissing: Array<{ oilBatchId: string; batchNumber: string | null; ageHours: number }>;
  releaseWaiting: Array<{ batchCoaId: string; batchNumber: string | null; ageHours: number }>;
  noSpec: Array<{ productId: string; productCode: string | null; pendingBatches: number; openRequirements: number }>;
  proposals: { qcSpec: number; rackLayout: number };
}

export interface SetupFacts {
  catalogueProducts: number;
  packsNeedingDensity: number;
  qcSpecsMissing: number;
  bins: number;
  rackProposed: boolean;
  pickLightMode: string;
  formulasUnlinked: number;
}

export interface VaultFacts {
  /** From the Vault over the signed channel; null when it did not answer. */
  counts: { awaitingApproval: number; recipesNeeded: number; complianceWarnings: number } | null;
  /** Requirements this box cannot plan for want of an approved formula / a formula link. */
  formulaBlocked: number;
  ruhGrantPending: boolean;
}

export interface ShelfFacts {
  overdue: Array<{ kind: 'PUTAWAY' | 'PICK'; count: number; oldestHours: number; oldestTaskId: string }>;
  bins: Array<{ binId: string; label: string; batches: number; qty: number }>;
  quarantine: { count: number; oldestHours: number };
  pickLightParked: number;
}

export interface StockFact {
  materialId: string;
  code: string | null;
  name: string | null;
  available: number;
  /** Average daily issue over the window (same unit as `available`). */
  dailyUse: number;
  /** Open production runs still need more of it than is available (no quantity is reported). */
  shortForPlannedRuns: boolean;
  uom: string | null;
  issueDays: number;
}

export interface MaterialFacts {
  noFloorCode: { count: number; sample: string[] };
  stock: StockFact[];
}

export interface BridgeFacts {
  connector: { configured: boolean; enabled: boolean };
  outbound: { waiting: number; parked: number; oldestWaitingAt: string | null };
  catalogue: { items: number; lastSyncedAt: string | null };
  ruhQueue: { waiting: number; parked: number; oldestWaitingAt: string | null };
}

/* ── groups: the kinds each detector owns (a failed group keeps its insights) ────────────── */

export const DETECTOR_KINDS = {
  production: ['production.blocked', 'production.priority_waiting', 'production.late'],
  qc: ['qc.coa_missing', 'qc.release_waiting', 'qc.no_spec', 'qc.proposals_waiting', 'shelf.rack_proposal_waiting'],
  setup: ['setup.incomplete'],
  vault: ['vault.recipes_awaiting_approval', 'vault.recipes_needed', 'vault.compliance_warnings', 'vault.formula_needed', 'vault.ruh_grant_pending'],
  shelf: ['shelf.tasks_overdue', 'shelf.bin_full', 'inventory.quarantine', 'shelf.pick_light_parked'],
  materials: ['masterdata.no_floor_code', 'inventory.low_stock'],
  bridge: ['bridge.failing', 'bridge.not_connected', 'bridge.catalogue_stale', 'ruh.signals_stuck'],
} as const;
export type DetectorGroup = keyof typeof DETECTOR_KINDS;

const OPS = ['production'];
const VAULT_ROLES = ['formulator', 'vault_approver'];
const PLATFORM_ROLES = ['owner', 'platform_super_admin'];

const BLOCK_FIX: Record<string, { title: (n: number) => string; fix: string; roles: string[]; link: (id: string) => string }> = {
  UNKNOWN_SKU: {
    title: (n) => `${plural(n, 'order')} for a SKU the factory does not know`,
    fix: 'Add the SKU on the Product SKUs screen and link it to its product; ALEMBIC\'s next update of the order is then accepted.',
    roles: ['production', 'packaging'], link: (id) => `#/go/skus|produce/${id}`,
  },
  NO_FORMULA_LINK: {
    title: (n) => `${plural(n, 'order')} waiting: the product has no formula linked`,
    fix: 'Link the product to its Vault formula on Formula setup (or let Ruh draft a shell for it), then a formulator seals and approves the recipe.',
    roles: ['production'], link: () => '#/go/formulasetup',
  },
  NO_APPROVED_FORMULA: {
    title: (n) => `${plural(n, 'order')} waiting for an approved formula`,
    fix: 'A formulator seals the recipe in the Vault and a different approver approves it; then press Plan run again.',
    roles: ['production'], link: (id) => `#/go/produce/${id}`,
  },
  QTY_NOT_IN_KG: {
    title: (n) => `${plural(n, 'order')} with a quantity that is not in kilograms`,
    fix: 'Ask ALEMBIC to resend the requirement in kg (or a unit of mass), so the run size can be worked out.',
    roles: ['production'], link: (id) => `#/go/produce/${id}`,
  },
};

const NOT_YET_MADE = new Set(['TO_PLAN', 'BLOCKED', 'UNKNOWN_SKU', 'PLANNED', 'IN_PRODUCTION']);
const DONE_STAGES = new Set(['QC_RELEASED', 'READY_FOR_PUTAWAY', 'ON_SHELF']);

function confidenceFor(samples: number): number {
  return samples >= 10 ? 0.8 : samples >= 5 ? 0.65 : samples >= 2 ? 0.5 : 0.3;
}

/* ── production ─────────────────────────────────────────────────────────────────────────── */

export function detectProduction(f: ProductionFacts, now: Date): InsightDraft[] {
  const out: InsightDraft[] = [];
  const q = [...f.queue].sort((a, b) => a.position - b.position);

  // Blocked, one insight per reason, with the exact fix.
  const byReason = new Map<string, QueueFact[]>();
  for (const r of q) {
    const reason = r.stage === 'UNKNOWN_SKU' ? 'UNKNOWN_SKU' : r.stage === 'BLOCKED' ? r.blockReason : null;
    if (!reason || !BLOCK_FIX[reason]) continue;
    byReason.set(reason, [...(byReason.get(reason) ?? []), r]);
  }
  for (const [reason, rows] of byReason) {
    const fx = BLOCK_FIX[reason]!;
    const first = rows[0]!;
    const urgent = rows.some((r) => r.highValue || Date.parse(r.neededBy) < now.getTime());
    out.push({
      kind: 'production.blocked', severity: urgent ? 'urgent' : 'warn', audienceRoles: fx.roles, console: 'factory',
      subject: { type: 'production_requirement', id: first.id, code: first.orderRef },
      title: fx.title(rows.length),
      body: `${rows.slice(0, 3).map((r) => `${r.orderRef} (${r.sku})`).join(', ')}${rows.length > 3 ? ` and ${rows.length - 3} more` : ''}. Fix: ${fx.fix}`,
      deepLink: fx.link(first.id), prediction: null, dedupeKey: `production.blocked:${reason}`, mirror: true,
    });
  }

  // A higher-ranked requirement still waiting while lower-ranked ones are already being made.
  const started = q.filter((r) => r.stage === 'PLANNED' || r.stage === 'IN_PRODUCTION');
  for (const r of q) {
    if (r.stage !== 'TO_PLAN') continue;
    const behind = started.filter((x) => x.position > r.position);
    if (behind.length === 0) continue;
    out.push({
      kind: 'production.priority_waiting', severity: r.highValue ? 'urgent' : 'warn', audienceRoles: OPS, console: 'factory',
      subject: { type: 'production_requirement', id: r.id, code: r.orderRef },
      title: `${r.highValue ? 'High-value order' : 'Higher-priority order'} ${r.orderRef} is waiting while lower-ranked orders are in production`,
      body: `${r.orderRef} (${r.sku}${r.qtyKg !== null ? `, ${round1(r.qtyKg)} kg` : ''}) is number ${r.position} in the queue and not planned, while ${behind.slice(0, 3).map((x) => x.orderRef).join(', ')}${behind.length > 3 ? ` and ${behind.length - 3} more` : ''} ranked below it are already planned or running. Plan it next on Produce next.`,
      deepLink: `#/go/produce/${r.id}`, prediction: null, dedupeKey: `production.priority_waiting:${r.id}`, mirror: true,
    });
  }

  // Late: already past the need-by date, or predicted to finish after it at the recent output rate.
  const perDay = f.throughput.windowDays > 0 ? f.throughput.kg / f.throughput.windowDays : 0;
  let aheadKg = 0;
  for (const r of q) {
    const due = Date.parse(r.neededBy);
    const notMade = NOT_YET_MADE.has(r.stage);
    if (notMade && r.qtyKg !== null) aheadKg += r.qtyKg;
    if (DONE_STAGES.has(r.stage)) continue;
    if (due < now.getTime()) {
      out.push({
        kind: 'production.late', severity: 'urgent', audienceRoles: OPS, console: 'factory',
        subject: { type: 'production_requirement', id: r.id, code: r.orderRef },
        title: `Overdue: ${r.orderRef} (${r.sku}) was needed by ${ymd(new Date(due))}`,
        body: `It is ${Math.max(1, Math.round(hoursBetween(new Date(due), now) / 24))} day(s) late and ${stageWords(r.stage)}. Move it up or tell the customer's team in ALEMBIC.`,
        deepLink: `#/go/produce/${r.id}`, prediction: null, dedupeKey: `production.late:${r.id}`, mirror: true,
      });
      continue;
    }
    if (!notMade || perDay <= 0 || r.qtyKg === null) continue;
    const days = aheadKg / perDay;
    const finish = new Date(now.getTime() + days * 86_400_000);
    if (finish.getTime() <= due) continue;
    const prediction: RuhPrediction = {
      metric: 'production_finish', value: finish.toISOString(), unit: 'datetime', at: now.toISOString(),
      confidence: confidenceFor(f.throughput.batches),
      basis: `${round1(aheadKg)} kg still to make for this order and those ranked ahead of it, at ${round1(perDay)} kg a day (the oil batches made in the last ${f.throughput.windowDays} days, ${plural(f.throughput.batches, 'batch', 'batches')}).`,
    };
    out.push({
      kind: 'production.late', severity: r.highValue ? 'urgent' : 'warn', audienceRoles: OPS, console: 'factory',
      subject: { type: 'production_requirement', id: r.id, code: r.orderRef },
      title: `${r.orderRef} (${r.sku}) is likely to be late: about ${ymd(finish)}, needed by ${ymd(new Date(due))}`,
      body: `At the current pace it finishes about ${round1((finish.getTime() - due) / 86_400_000)} day(s) after it is needed. Plan it sooner, add a run, or agree a new date in ALEMBIC.`,
      deepLink: `#/go/produce/${r.id}`, prediction, dedupeKey: `production.late:${r.id}`, mirror: true,
    });
  }
  return out;
}

function stageWords(stage: string): string {
  switch (stage) {
    case 'TO_PLAN': return 'not planned yet';
    case 'BLOCKED': case 'UNKNOWN_SKU': return 'blocked';
    case 'PLANNED': return 'planned but not started';
    case 'IN_PRODUCTION': return 'in production';
    case 'QC_PENDING': return 'waiting for QC';
    case 'QC_PASSED': return 'passed QC but not released';
    case 'QC_FAILED': return 'failed QC';
    default: return 'not on the shelf yet';
  }
}

/* ── QC ─────────────────────────────────────────────────────────────────────────────────── */

export function detectQc(f: QcFacts, s: RuhSettings): InsightDraft[] {
  const out: InsightDraft[] = [];
  const waitH = s['qc.coaWaitHours'];
  const missing = f.coaMissing.filter((b) => b.ageHours >= waitH).sort((a, b) => b.ageHours - a.ageHours);
  if (missing.length) {
    const oldest = missing[0]!;
    out.push({
      kind: 'qc.coa_missing', severity: oldest.ageHours >= waitH * 3 ? 'urgent' : 'warn', audienceRoles: ['qc', 'production'], console: 'factory',
      subject: { type: 'oil_batch', id: oldest.oilBatchId, code: oldest.batchNumber },
      title: `${plural(missing.length, 'batch', 'batches')} waiting for COA results for more than ${waitH} h`,
      body: `Oldest: ${oldest.batchNumber ?? 'unnumbered batch'}, ${Math.round(oldest.ageHours)} h since it was made. Record its results on Batch COA so it can be released and shelved.`,
      deepLink: '#/go/coa', prediction: null, dedupeKey: 'qc.coa_missing', mirror: true,
    });
  }
  const relH = s['qc.releaseWaitHours'];
  const waiting = f.releaseWaiting.filter((c) => c.ageHours >= relH).sort((a, b) => b.ageHours - a.ageHours);
  if (waiting.length) {
    const oldest = waiting[0]!;
    out.push({
      kind: 'qc.release_waiting', severity: oldest.ageHours >= relH * 3 ? 'urgent' : 'warn', audienceRoles: ['qc'], console: 'factory',
      subject: { type: 'batch_coa', id: oldest.batchCoaId, code: oldest.batchNumber },
      title: `${plural(waiting.length, 'batch', 'batches')} passed QC but ${waiting.length === 1 ? 'is' : 'are'} not released`,
      body: `Oldest: ${oldest.batchNumber ?? 'unnumbered batch'}, passed ${Math.round(oldest.ageHours)} h ago. Release it on Batch COA so ALEMBIC hears and the warehouse can shelve it.`,
      deepLink: `#/go/coa/${oldest.batchCoaId}`, prediction: null, dedupeKey: 'qc.release_waiting', mirror: true,
    });
  }
  for (const p of f.noSpec) {
    if (p.pendingBatches === 0 && p.openRequirements === 0) continue;
    out.push({
      kind: 'qc.no_spec', severity: p.pendingBatches > 0 ? 'warn' : 'suggest', audienceRoles: ['qc'], console: 'factory',
      subject: { type: 'product', id: p.productId, code: p.productCode },
      title: `No QC spec for ${p.productCode ?? 'a product'} in production`,
      body: `${p.pendingBatches ? `${plural(p.pendingBatches, 'batch', 'batches')} of it ${p.pendingBatches === 1 ? 'needs' : 'need'} COA results, ` : ''}${p.openRequirements ? `${plural(p.openRequirements, 'open order')}, ` : ''}and a COA cannot be recorded without the spec. Enter it on QC specs (COA), or approve Ruh's draft on Factory setup.`,
      deepLink: `#/go/coaspec/${p.productId}`, prediction: null, dedupeKey: `qc.no_spec:${p.productId}`, mirror: false,
    });
  }
  if (f.proposals.qcSpec > 0) {
    out.push({
      kind: 'qc.proposals_waiting', severity: 'suggest', audienceRoles: ['qc'], console: 'factory',
      subject: { type: 'setup_proposal' },
      title: `Ruh drafted ${plural(f.proposals.qcSpec, 'QC spec')} for you to check`,
      body: 'Each draft shows where its figures came from. Approve or reject them on Factory setup; nothing is used until a person approves it.',
      deepLink: '#/go/factorysetup', prediction: null, dedupeKey: 'qc.proposals_waiting', mirror: false,
    });
  }
  if (f.proposals.rackLayout > 0) {
    out.push({
      kind: 'shelf.rack_proposal_waiting', severity: 'suggest', audienceRoles: ['warehouse'], console: 'factory',
      subject: { type: 'setup_proposal' },
      title: 'Ruh drafted a rack layout for you to check',
      body: 'Adjust the counts if the shelves differ, then approve it on Factory setup to create the racks, shelves and bins.',
      deepLink: '#/go/factorysetup', prediction: null, dedupeKey: 'shelf.rack_proposal_waiting', mirror: false,
    });
  }
  return out;
}

/* ── factory setup ──────────────────────────────────────────────────────────────────────── */

export function detectSetup(f: SetupFacts): InsightDraft[] {
  const steps: string[] = [];
  if (f.catalogueProducts === 0) steps.push('send the catalogue from ALEMBIC');
  if (f.packsNeedingDensity > 0) steps.push(`give a density for ${plural(f.packsNeedingDensity, 'product')} sold by volume`);
  if (f.qcSpecsMissing > 0) steps.push(`QC specs for ${plural(f.qcSpecsMissing, 'product')}`);
  if (f.bins === 0) steps.push(f.rackProposed ? 'approve the rack layout' : 'enter the racks');
  if (f.pickLightMode === 'unset') steps.push('choose how bins are lit (or off)');
  if (f.formulasUnlinked > 0) steps.push(`link ${plural(f.formulasUnlinked, 'product')} to a formula`);
  if (steps.length === 0) return [];
  return [{
    kind: 'setup.incomplete', severity: steps.length >= 3 ? 'suggest' : 'info', audienceRoles: ['production'], console: 'factory',
    subject: { type: 'factory_setup' },
    title: `Factory setup: ${plural(steps.length, 'step')} left`,
    body: `Still to do: ${steps.join('; ')}. Factory setup lists each step with its button.`,
    deepLink: '#/go/factorysetup', prediction: null, dedupeKey: 'setup.incomplete', mirror: false,
  }];
}

/* ── the Vault (counts only) ────────────────────────────────────────────────────────────── */

export function detectVault(f: VaultFacts): InsightDraft[] {
  const out: InsightDraft[] = [];
  const pressing = f.formulaBlocked > 0;
  if (f.formulaBlocked > 0) {
    out.push({
      kind: 'vault.formula_needed', severity: 'warn', audienceRoles: VAULT_ROLES, console: 'vault', subject: { type: 'vault' },
      title: `${plural(f.formulaBlocked, 'factory order')} cannot start without an approved formula`,
      body: 'Formula needed lists the products. Seal each recipe, then a different approver approves it.',
      deepLink: '#/needed', prediction: null, dedupeKey: 'vault.formula_needed', mirror: true,
    });
  }
  if (f.counts && f.counts.awaitingApproval > 0) {
    out.push({
      kind: 'vault.recipes_awaiting_approval', severity: pressing ? 'warn' : 'suggest', audienceRoles: ['vault_approver'], console: 'vault', subject: { type: 'vault' },
      title: `${plural(f.counts.awaitingApproval, 'recipe')} waiting for approval`,
      body: 'Approve recipes lists them. You cannot approve a version you drafted or sealed.',
      deepLink: '#/review', prediction: null, dedupeKey: 'vault.recipes_awaiting_approval', mirror: true,
    });
  }
  if (f.counts && f.counts.recipesNeeded > 0) {
    out.push({
      kind: 'vault.recipes_needed', severity: pressing ? 'warn' : 'suggest', audienceRoles: ['formulator'], console: 'vault', subject: { type: 'vault' },
      title: `${plural(f.counts.recipesNeeded, 'formula')} still need${f.counts.recipesNeeded === 1 ? 's' : ''} a recipe`,
      body: 'Recipes needed lists them. Enter the recipe or upload the file, then submit it for approval.',
      deepLink: '#/recipes', prediction: null, dedupeKey: 'vault.recipes_needed', mirror: true,
    });
  }
  if (f.counts && f.counts.complianceWarnings > 0) {
    out.push({
      kind: 'vault.compliance_warnings', severity: 'suggest', audienceRoles: VAULT_ROLES, console: 'vault', subject: { type: 'vault' },
      title: `IFRA/allergen calculation incomplete for ${plural(f.counts.complianceWarnings, 'formula')}`,
      body: 'Missing data lists the raw materials without compliance data. Add it so the certificates can be calculated.',
      deepLink: '#/missing', prediction: null, dedupeKey: 'vault.compliance_warnings', mirror: false,
    });
  }
  if (f.ruhGrantPending) {
    out.push({
      kind: 'vault.ruh_grant_pending', severity: 'suggest', audienceRoles: ['owner', 'admin'], console: 'factory', subject: { type: 'vault' },
      title: 'Letting Ruh draft formulas is waiting for a second owner',
      body: 'One owner asked; a different owner or admin approves it on Formula setup. Ruh only drafts shells; people seal and approve recipes.',
      deepLink: '#/go/formulasetup', prediction: null, dedupeKey: 'vault.ruh_grant_pending', mirror: true,
    });
  }
  return out;
}

/* ── shelves and stock on hold ──────────────────────────────────────────────────────────── */

export function detectShelf(f: ShelfFacts, s: RuhSettings): InsightDraft[] {
  const out: InsightDraft[] = [];
  const overdueH = s['shelf.taskOverdueHours'];
  for (const t of f.overdue) {
    if (t.count === 0 || t.oldestHours < overdueH) continue;
    const what = t.kind === 'PICK' ? 'pick' : 'put-away';
    out.push({
      kind: 'shelf.tasks_overdue', severity: t.oldestHours >= overdueH * 3 ? 'urgent' : 'warn', audienceRoles: ['warehouse'], console: 'factory',
      subject: { type: 'shelf_task', id: t.oldestTaskId },
      title: `${plural(t.count, `${what} task`)} open for more than ${overdueH} h`,
      body: `The oldest has waited ${Math.round(t.oldestHours)} h. Open Put-away & pick${t.kind === 'PICK' ? ': orders are waiting to be dispatched' : ': released goods are not on a shelf yet'}.`,
      deepLink: '#/go/shelftasks', prediction: null, dedupeKey: `shelf.tasks_overdue:${t.kind}`, mirror: true,
    });
  }
  const maxB = s['shelf.binMaxBatches'];
  const maxQ = s['shelf.binMaxQty'];
  const near = s['shelf.binNearPct'] / 100;
  for (const b of f.bins) {
    const shareB = b.batches / maxB;
    const shareQ = maxQ ? b.qty / maxQ : 0;
    const share = Math.max(shareB, shareQ);
    if (share < near) continue;
    const over = shareB > 1 || shareQ > 1;
    out.push({
      kind: 'shelf.bin_full', severity: over ? 'warn' : 'suggest', audienceRoles: ['warehouse'], console: 'factory',
      subject: { type: 'bin', id: b.binId, code: b.label },
      title: over ? `Bin ${b.label} is over its limit` : `Bin ${b.label} is nearly full`,
      body: `It holds ${plural(b.batches, 'batch', 'batches')} (limit ${maxB})${maxQ ? ` and ${round1(b.qty)} units (limit ${maxQ})` : ''}. Put new stock elsewhere or move some.`,
      deepLink: `#/go/bins|shelftasks/${b.binId}`, prediction: null, dedupeKey: `shelf.bin_full:${b.binId}`, mirror: false,
    });
  }
  if (f.quarantine.count > 0) {
    out.push({
      kind: 'inventory.quarantine', severity: f.quarantine.oldestHours >= 72 ? 'warn' : 'suggest', audienceRoles: ['qc', 'warehouse'], console: 'factory',
      subject: { type: 'rm_batch' },
      title: `${plural(f.quarantine.count, 'raw-material batch', 'raw-material batches')} held in quarantine`,
      body: `The oldest has been held ${Math.round(f.quarantine.oldestHours)} h. QC tests and decides each one; until then it cannot be issued.`,
      deepLink: '#/go/queue|rm', prediction: null, dedupeKey: 'inventory.quarantine', mirror: false,
    });
  }
  if (f.pickLightParked > 0) {
    out.push({
      kind: 'shelf.pick_light_parked', severity: 'warn', audienceRoles: [...PLATFORM_ROLES, 'warehouse'], console: 'platform',
      subject: { type: 'pick_light' },
      title: `${plural(f.pickLightParked, 'pick-to-light command')} could not be delivered`,
      body: 'The lights did not get them, so bins may not be lit. Check the controller on Pick-to-light and send a test.',
      deepLink: '#/picklight', prediction: null, dedupeKey: 'shelf.pick_light_parked', mirror: false,
    });
  }
  return out;
}

/* ── materials ──────────────────────────────────────────────────────────────────────────── */

export function detectMaterials(f: MaterialFacts, s: RuhSettings, now: Date): InsightDraft[] {
  const out: InsightDraft[] = [];
  if (f.noFloorCode.count > 0) {
    out.push({
      kind: 'masterdata.no_floor_code', severity: 'suggest', audienceRoles: ['procurement', 'production'], console: 'factory',
      subject: { type: 'material' },
      title: `${plural(f.noFloorCode.count, 'raw material')} without a floor code`,
      body: `The floor only sees materials by floor code, so ${f.noFloorCode.count === 1 ? 'it' : 'these'} cannot be weighed or picked by code${f.noFloorCode.sample.length ? ` (${f.noFloorCode.sample.join(', ')}${f.noFloorCode.count > f.noFloorCode.sample.length ? ', …' : ''})` : ''}. Add an RM alias of type floor code.`,
      deepLink: '#/go/maliases|materials', prediction: null, dedupeKey: 'masterdata.no_floor_code', mirror: false,
    });
  }
  const warnDays = s['stock.runoutWarnDays'];
  for (const m of f.stock) {
    const label = m.code ?? m.name ?? 'a raw material';
    const daysLeft = m.dailyUse > 0 ? m.available / m.dailyUse : Infinity;
    if (!m.shortForPlannedRuns && !(daysLeft < warnDays)) continue;
    const runOut = Number.isFinite(daysLeft) ? new Date(now.getTime() + Math.max(0, daysLeft) * 86_400_000) : null;
    const prediction: RuhPrediction | null = runOut ? {
      metric: 'stock_run_out', value: runOut.toISOString(), unit: 'datetime', at: now.toISOString(),
      confidence: confidenceFor(m.issueDays),
      basis: `${round1(m.available)} ${m.uom ?? ''} available ÷ ${round1(m.dailyUse)} ${m.uom ?? ''} a day (average issue over the last ${s['stock.consumptionWindowDays']} days, ${plural(m.issueDays, 'day')} with issues).`.replace(/\s+/g, ' '),
    } : null;
    const severity: RuhSeverity = m.shortForPlannedRuns || daysLeft < 2 ? 'urgent' : 'warn';
    out.push({
      kind: 'inventory.low_stock', severity, audienceRoles: ['procurement', 'warehouse'], console: 'factory',
      subject: { type: 'material', id: m.materialId, code: m.code },
      title: m.shortForPlannedRuns ? `${label}: not enough on hand for the runs already planned`
        : `${label} runs out in about ${Math.max(0, Math.round(daysLeft))} day(s)`,
      body: `${round1(m.available)} ${m.uom ?? ''} available${runOut ? `; at recent use it lasts until about ${ymd(runOut)}` : ''}. Raise a purchase request or check open purchase orders.`.replace(/\s+/g, ' '),
      deepLink: `#/go/reorder|stock|materials`, prediction, dedupeKey: `inventory.low_stock:${m.materialId}`, mirror: true,
    });
  }
  return out;
}

/* ── the ALEMBIC bridge and Ruh's own queue ─────────────────────────────────────────────── */

export function detectBridge(f: BridgeFacts, s: RuhSettings, now: Date): InsightDraft[] {
  const out: InsightDraft[] = [];
  const staleMin = s['bridge.staleMinutes'];
  if (!f.connector.configured || !f.connector.enabled) {
    out.push({
      kind: 'bridge.not_connected', severity: 'warn', audienceRoles: PLATFORM_ROLES, console: 'platform', subject: { type: 'bridge' },
      title: 'The factory is not connected to ALEMBIC',
      body: 'Orders, QC releases and Ruh\'s notes cannot reach ALEMBIC until an administrator enters the bridge address and secret.',
      deepLink: '#/bridge', prediction: null, dedupeKey: 'bridge.not_connected', mirror: false,
    });
  } else {
    const oldestMin = f.outbound.oldestWaitingAt ? hoursBetween(new Date(f.outbound.oldestWaitingAt), now) * 60 : 0;
    if (f.outbound.parked > 0 || oldestMin >= staleMin) {
      out.push({
        kind: 'bridge.failing', severity: f.outbound.parked > 0 || oldestMin >= staleMin * 4 ? 'urgent' : 'warn', audienceRoles: PLATFORM_ROLES, console: 'platform',
        subject: { type: 'bridge' },
        title: f.outbound.parked > 0 ? `${plural(f.outbound.parked, 'update')} to ALEMBIC stopped and need${f.outbound.parked === 1 ? 's' : ''} a decision` : 'Updates to ALEMBIC are not getting through',
        body: `${plural(f.outbound.waiting, 'update')} waiting${oldestMin >= 1 ? `, the oldest for ${Math.round(oldestMin)} min` : ''}${f.outbound.parked ? `; ${f.outbound.parked} stopped` : ''}. Open ALEMBIC bridge to see why, then replay or discard.`,
        deepLink: '#/bridge', prediction: null, dedupeKey: 'bridge.failing', mirror: true,
      });
    }
  }
  const staleH = s['catalogue.staleHours'];
  if (f.catalogue.items > 0 && f.catalogue.lastSyncedAt && hoursBetween(new Date(f.catalogue.lastSyncedAt), now) >= staleH) {
    const h = hoursBetween(new Date(f.catalogue.lastSyncedAt), now);
    out.push({
      kind: 'bridge.catalogue_stale', severity: h >= staleH * 2 ? 'warn' : 'suggest', audienceRoles: PLATFORM_ROLES, console: 'platform', subject: { type: 'catalogue' },
      title: `ALEMBIC's catalogue was last sent ${Math.round(h / 24)} day(s) ago`,
      body: 'New products, pack sizes and stock in ALEMBIC have not reached the factory since. Send the catalogue again from ALEMBIC Admin.',
      deepLink: '#/bridge', prediction: null, dedupeKey: 'bridge.catalogue_stale', mirror: true,
    });
  }
  const ruhMin = f.ruhQueue.oldestWaitingAt ? hoursBetween(new Date(f.ruhQueue.oldestWaitingAt), now) * 60 : 0;
  if (f.ruhQueue.parked > 0 || (f.ruhQueue.waiting > 0 && ruhMin >= staleMin)) {
    out.push({
      kind: 'ruh.signals_stuck', severity: 'warn', audienceRoles: PLATFORM_ROLES, console: 'platform', subject: { type: 'bridge' },
      title: 'Ruh\'s notes to ALEMBIC are queued',
      body: `${plural(f.ruhQueue.waiting, 'note')} waiting${ruhMin >= 1 ? ` (oldest ${Math.round(ruhMin)} min)` : ''}${f.ruhQueue.parked ? `, ${f.ruhQueue.parked} refused by ALEMBIC` : ''}. They are kept and sent as soon as ALEMBIC answers; admins in ALEMBIC will not see them until then.`,
      deepLink: '#/bridge', prediction: null, dedupeKey: 'ruh.signals_stuck', mirror: false,
    });
  }
  return out;
}
