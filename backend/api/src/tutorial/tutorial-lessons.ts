/**
 * TutorialLessons — the ONE registry of in-app tutorial content (ticket G4), ported from
 * ALEMBIC's `packages/domain/src/tutorial/schema.ts` (`Lesson = {id, console, featureId, title,
 * summary, version, steps}`, step union `info|target|action|verify`).
 *
 * This module is intentionally dependency-free (no NestJS, no DB client, no decorators) so it
 * can be imported from three completely different runtimes without ever being hand-duplicated:
 *   1. `tutorial.service.ts` (this package) — the SERVER-side source of truth: `totalSteps`/
 *      `version` are always read off `TUTORIAL_LESSONS` here, never trusted from the client
 *      (see that file).
 *   2. `scripts/access-catalog-export.ts` — imports this file directly (a plain relative
 *      import, not a workspace package) to emit the `tutorialLessons` field ALEMBIC's own
 *      access-catalog generator reads, so every action/verify permission this registry
 *      references is guaranteed to be a live string (drift-proof by construction).
 *   3. The BROWSER (`web/tutorial.js`, `web-platform/platform.js`) never imports this file
 *      directly — RawProd's consoles are bundler-free classic scripts, so they instead fetch
 *      this exact data over the wire via the self-service `GET /v1/tutorial/lessons` route
 *      (`TutorialController.lessons` → `TutorialService.lessons()` → this array, JSON-
 *      serialized as-is). That is "loading it appropriately" for a runtime that cannot statically
 *      import a TypeScript module — and it is also *more* correct than a static client copy:
 *      ALEMBIC's own `store.js` is described as "server-authoritative, re-fetched on load," and
 *      fetching this registry is exactly that, one level up.
 *
 * `target`/`action` steps locate a DOM element ONLY via `target`, a `data-tutorial-target`
 * attribute value the corresponding `ws-*.js`/`platform.js` view carries on a REAL element
 * (mirrors ALEMBIC's one-attribute convention, `data-tutorial-target` instead of ALEMBIC's own
 * name for the same idea). `verify` steps poll a real GET endpoint via the console's own
 * `tunnel()` and assert a real response change — there is no "click to continue" faking a
 * verification.
 *
 * PERMISSION FILTERING (the gap this port deliberately does NOT repeat — see ticket G4):
 * ALEMBIC gates a lesson only by its coarse `track` (admin/agent/content_editor). Every
 * `action`/`verify` step below instead carries the EXACT fine-grained permission string its
 * underlying route requires. Both `web/tutorial.js` and `web-platform/platform.js` collect every
 * step permission for a lesson and hide the WHOLE lesson (not just disable a button) unless the
 * signed-in session's own JWT permissions cover all of them (`can(perm)` / `hasPerm(perm)` — see
 * those files). The server independently double-checks the TRACK half of this (a caller may only
 * write progress against a track their own roles reach — `reachableTutorialTracks` below) but,
 * being self-service, does not re-derive the fine-grained UI gate itself (mirrors ALEMBIC's own
 * self-service progress routes, which have no fine-grained permission check either — the CONTENT
 * of `GET /v1/tutorial/lessons` is not sensitive, it is UI copy + already-public permission
 * strings + endpoint paths).
 */

export type TutorialStepKind = 'info' | 'target' | 'action' | 'verify';

export type TutorialActionSafety = 'safe' | 'confirm-required';

export type TutorialAssertOp = 'equals' | 'exists' | 'matches' | 'changed';

/**
 * `path` is a plain dot-path into the JSON response body the console's `tunnel()` returns
 * (i.e. into `{ data, meta, error }` — almost always `data...`). `changed` compares the value at
 * `path` between the FIRST poll (the baseline) and every subsequent poll; the others compare it
 * once, immediately.
 */
export interface TutorialAssert {
  op: TutorialAssertOp;
  path: string;
  /** required for `equals`; ignored otherwise. */
  value?: unknown;
  /** required for `matches`; ignored otherwise. */
  pattern?: string;
}

export interface TutorialVerifyCheck {
  kind: 'api';
  method: 'GET';
  /** relative path (may include a query string), passed straight to the console's `tunnel()`. */
  path: string;
  assert: TutorialAssert;
  /** default 1500 if omitted — see web/tutorial.js's poll loop. */
  pollMs?: number;
  /** default 30000 if omitted. */
  timeoutMs?: number;
}

interface TutorialStepBase {
  id: string;
  title: string;
  body: string;
}

export interface TutorialInfoStep extends TutorialStepBase {
  kind: 'info';
}

export interface TutorialTargetStep extends TutorialStepBase {
  kind: 'target';
  /** `data-tutorial-target` attribute value of the real element this step points at. */
  target: string;
}

export interface TutorialActionStep extends TutorialStepBase {
  kind: 'action';
  target: string;
  /** the exact `domain:resource:action` permission this action's underlying route requires. */
  permission: string;
  safety: TutorialActionSafety;
}

export interface TutorialVerifyStep extends TutorialStepBase {
  kind: 'verify';
  /**
   * permission needed to even READ the verify endpoint — omitted when the endpoint is
   * `@Public()` (e.g. the platform lesson's flag snapshot), in which case this step contributes
   * nothing to the lesson's permission-gate set.
   */
  permission?: string;
  check: TutorialVerifyCheck;
}

export type TutorialStep = TutorialInfoStep | TutorialTargetStep | TutorialActionStep | TutorialVerifyStep;

/** The workspace-group identity a lesson's progress is written against — the RawProd analogue
 * of ALEMBIC's coarse tutorial "track". Deliberately its OWN small vocabulary (not literally
 * `iam.role_master.role_code`): `dispatch` is the `sales` role's dispatch workflow and
 * `platform` is `platform_super_admin`'s console — see `TUTORIAL_TRACK_ROLES` below for the
 * mapping a caller's real backend roles must satisfy to write progress against each. */
export const TUTORIAL_TRACKS = [
  'procurement',
  'receiving',
  'warehouse',
  'qc',
  'production',
  'packaging',
  'dispatch',
  'platform',
] as const;

export type TutorialTrack = (typeof TUTORIAL_TRACKS)[number];

function isTutorialTrack(value: string): value is TutorialTrack {
  return (TUTORIAL_TRACKS as readonly string[]).includes(value);
}

/** Which of `scripts/ra-roles.ts`'s REAL backend role codes reach each tutorial track. A caller
 * needs at least one of the listed roles to write (`POST .../progress/:lessonId`) against that
 * track — the RawProd equivalent of ALEMBIC's `reachableTutorialTracks(roles)`. */
export const TUTORIAL_TRACK_ROLES: Record<TutorialTrack, readonly string[]> = {
  procurement: ['procurement'],
  receiving: ['receiving'],
  warehouse: ['warehouse'],
  qc: ['qc'],
  production: ['production'],
  packaging: ['packaging'],
  dispatch: ['sales'],
  platform: ['platform_super_admin'],
};

/** Every tutorial track a caller's real backend roles reach — mirrors ALEMBIC's
 * `reachableTutorialTracks(roles)`. `TutorialService.applyEvent` uses this to 403 a write
 * against a track the caller's own role assignment does not cover. */
export function reachableTutorialTracks(roles: readonly string[]): TutorialTrack[] {
  const roleSet = new Set(roles);
  return TUTORIAL_TRACKS.filter((track) => TUTORIAL_TRACK_ROLES[track].some((r) => roleSet.has(r)));
}

export interface TutorialLesson {
  id: string;
  track: TutorialTrack;
  /** the console/workspace this lesson's DOM targets live in — `web` (factory console: the
   * `ROLES` key from web/shell.js a signed-in user of this track lands on) or `web-platform`. */
  console: 'web' | 'web-platform';
  /** the `ROLES` key (web/shell.js) or NAV id (web-platform/platform.js) the lesson's steps
   * target — informational, read by scripts/access-catalog-export.ts's `tutorialLessons` export. */
  workspace: string;
  title: string;
  summary: string;
  /** bumped whenever `steps` changes shape — a client holding an older `tutorialVersion` on a
   * progress row gets 409 TUTORIAL_STALE_VERSION from `POST .../progress/:lessonId` and must
   * restart. */
  version: number;
  steps: TutorialStep[];
}

const POLL_MS = 1500;
const TIMEOUT_MS = 30_000;

export const TUTORIAL_LESSONS: TutorialLesson[] = [
  {
    id: 'procurement-reorder-to-requirement',
    track: 'procurement',
    console: 'web',
    workspace: 'procurement',
    title: 'Turn a shortage into a requirement',
    summary:
      'The reorder plan surfaces every material below its reorder level. Raise a stock ' +
      'requirement straight from a shortage row — the vendor is chosen later, at RFQ/quotation/PO.',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to Procurement',
        body:
          'This tour shows the shortest path from "we are short on a material" to a raised ' +
          'stock requirement, the first step of the RFQ → quotation → PO flow.',
      },
      {
        id: 'open-reorder-plan',
        kind: 'target',
        target: 'nav-reorder',
        title: 'Open the reorder plan',
        body: 'Every row here is a material currently below its configured reorder level.',
      },
      {
        id: 'raise-requirement',
        kind: 'action',
        target: 'procurement-raise-requirement-submit',
        permission: 'procurement:stock_requirement:write',
        safety: 'safe',
        title: 'Raise a requirement',
        body:
          'Pick a shortage row’s "Raise requirement" action, confirm the quantity and a ' +
          'required-by date, then submit this form.',
      },
      {
        id: 'requirement-created',
        kind: 'verify',
        permission: 'procurement:stock_requirement:read',
        title: 'Confirming',
        body: 'Watching Stock requirements for the new row you just raised…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/stock-requirements?limit=100',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
  {
    id: 'receiving-gate-to-grn',
    track: 'receiving',
    console: 'web',
    workspace: 'receiving',
    title: 'Record a goods receipt',
    summary: 'From a gate entry to a Goods Receipt Note (GRN) — the record that lets QC and Warehouse pick up a delivery.',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to Receiving',
        body: 'This tour records a Goods Receipt Note (GRN) for an incoming delivery.',
      },
      {
        id: 'open-grns',
        kind: 'target',
        target: 'nav-grns',
        title: 'Open Goods receipt',
        body: 'Every GRN raised against a gate entry or purchase order lives here.',
      },
      {
        id: 'create-grn',
        kind: 'action',
        target: 'ra-new-record',
        permission: 'inventory:grn_master:write',
        safety: 'safe',
        title: 'Record a new GRN',
        body: 'Click "+ New", link it to the gate entry / purchase order, add at least one line item, then submit.',
      },
      {
        id: 'grn-created',
        kind: 'verify',
        permission: 'inventory:grn_master:read',
        title: 'Confirming',
        body: 'Watching Goods receipt for the new GRN…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/grns?limit=100',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
  {
    id: 'warehouse-stock-adjustment',
    track: 'warehouse',
    console: 'web',
    workspace: 'warehouse',
    title: 'Record a stock adjustment',
    summary: 'Correct an on-hand quantity — a count discrepancy, damage, or a write-off — with an auditable adjustment record.',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to the Warehouse',
        body: 'This tour records a stock adjustment against a batch already in inventory.',
      },
      {
        id: 'open-adjustments',
        kind: 'target',
        target: 'nav-adjust',
        title: 'Open Adjustments',
        body: 'Every adjustment ever recorded against an inventory batch lives here.',
      },
      {
        id: 'create-adjustment',
        kind: 'action',
        target: 'ra-new-record',
        permission: 'inventory:stock_adjustment:write',
        safety: 'safe',
        title: 'Record an adjustment',
        body: 'Click "+ New", pick the batch and the corrected quantity, then submit.',
      },
      {
        id: 'adjustment-created',
        kind: 'verify',
        permission: 'inventory:stock_adjustment:read',
        title: 'Confirming',
        body: 'Watching Adjustments for the new record…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/stock-adjustments?limit=100',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
  {
    id: 'qc-record-results',
    track: 'qc',
    console: 'web',
    workspace: 'qc',
    title: 'Record an incoming QC result',
    summary: 'Work an inspection off the test queue and record a Pass/Fail result per parameter — masked context only, never a formula.',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to QC Laboratory',
        body: 'This tour records results for one inspection from the test queue.',
      },
      {
        id: 'open-queue',
        kind: 'target',
        target: 'nav-queue',
        title: 'Open the test queue',
        body: 'Every inspection waiting on a result sits here.',
      },
      {
        id: 'record-results',
        kind: 'action',
        target: 'qc-record-results-submit',
        permission: 'quality:qc_inspections:write',
        safety: 'safe',
        title: 'Record results',
        body: 'Open an inspection’s "Record results" action, add at least one parameter reading, then save.',
      },
      {
        id: 'results-recorded',
        kind: 'verify',
        permission: 'quality:qc_result_details:read',
        title: 'Confirming',
        body: 'Watching Results for the new parameter reading…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/qc-result-details?limit=100',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
  {
    id: 'production-plan-create',
    track: 'production',
    console: 'web',
    workspace: 'production',
    title: 'Create a production plan',
    summary: 'Production Manager’s one write surface no floor role held before this launch: schedule a production plan for the floor to run against.',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to Production',
        body: 'This tour creates a production plan — masked by alias, oversight without seeing the recipe.',
      },
      {
        id: 'open-plans',
        kind: 'target',
        target: 'nav-plans',
        title: 'Open Production plans',
        body: 'Every scheduled plan lives here.',
      },
      {
        id: 'create-plan',
        kind: 'action',
        target: 'ra-new-record',
        permission: 'production:production_plan:write',
        safety: 'safe',
        title: 'Create a plan',
        body: 'Click "+ New", fill in the plan dates, then submit.',
      },
      {
        id: 'plan-created',
        kind: 'verify',
        permission: 'production:production_plan:read',
        title: 'Confirming',
        body: 'Watching Production plans for the new plan…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/production-plans?limit=100',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
  {
    id: 'packaging-qc-record',
    track: 'packaging',
    console: 'web',
    workspace: 'packaging',
    title: 'Record a packaging QC check',
    summary: 'The finished-good packaging QC gate — leakage, label and carton checks — before a batch is releasable.',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to Packaging',
        body: 'This tour records a packaging QC check against a finished-good batch.',
      },
      {
        id: 'open-pkgqc',
        kind: 'target',
        target: 'nav-pkgqc',
        title: 'Open Packaging QC',
        body: 'Every packaging QC check ever recorded lives here.',
      },
      {
        id: 'record-pkgqc',
        kind: 'action',
        target: 'ra-new-record',
        permission: 'packaging:finished_good_batch_master:write',
        safety: 'safe',
        title: 'Record a check',
        body: 'Click "+ New", record the leakage / label / carton results, then submit.',
      },
      {
        id: 'pkgqc-created',
        kind: 'verify',
        permission: 'packaging:finished_good_batch_master:read',
        title: 'Confirming',
        body: 'Watching Packaging QC for the new record…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/packaging-qc?limit=100',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
  {
    id: 'dispatch-confirmed-order',
    track: 'dispatch',
    console: 'web',
    workspace: 'sales',
    title: 'Dispatch a confirmed sales order',
    summary: 'Ship finished goods against a confirmed sales order from a batch that actually has available stock (FEFO).',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to Sales & Dispatch',
        body: 'This tour dispatches a confirmed sales order against real finished-good stock.',
      },
      {
        id: 'open-dispatches',
        kind: 'target',
        target: 'nav-dispatch',
        title: 'Open Dispatches',
        body: 'Every dispatch ever recorded lives here.',
      },
      {
        id: 'dispatch-order',
        kind: 'action',
        target: 'dispatch-submit',
        permission: 'sales:dispatch_master:write',
        safety: 'confirm-required',
        title: 'Dispatch the order',
        body:
          'From a confirmed sales order, open "Dispatch", pick a finished-good batch with available ' +
          'stock and a quantity, then confirm — dispatching commits stock and cannot be undone.',
      },
      {
        id: 'dispatch-created',
        kind: 'verify',
        permission: 'sales:dispatch_master:read',
        title: 'Confirming',
        body: 'Watching Dispatches for the new dispatch…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/dispatches?limit=100',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
  {
    id: 'platform-ops-flag-change',
    track: 'platform',
    console: 'web-platform',
    workspace: 'platform_ops',
    title: 'Change a feature flag',
    summary: 'Platform Operations’ one write surface: flip a feature-flag kill-switch, with a mandatory audited reason.',
    version: 1,
    steps: [
      {
        id: 'welcome',
        kind: 'info',
        title: 'Welcome to Platform Operations',
        body:
          'This console never shows tenant business data or Formula Vault plaintext. This tour ' +
          'changes one feature flag’s state.',
      },
      {
        id: 'open-flags',
        kind: 'target',
        target: 'platform-nav-flags',
        title: 'Open Feature flags',
        body: 'Every flag this deployment knows about lives here.',
      },
      {
        id: 'change-flag',
        kind: 'action',
        target: 'platform-flag-save',
        permission: 'platform:flag:write',
        safety: 'confirm-required',
        title: 'Change a flag',
        body: 'Pick a flag’s "Change" action, choose an environment and new state, give a reason, then save.',
      },
      {
        id: 'flag-changed',
        // GET /v1/flags/snapshot is @Public() (backend/cluster-platform/src/flags) — no
        // permission required to read it, so this step contributes nothing to the lesson's
        // permission-gate set. See TutorialLessons's own header comment.
        kind: 'verify',
        title: 'Confirming',
        body: 'Watching the flag snapshot for your change…',
        check: {
          kind: 'api',
          method: 'GET',
          path: '/v1/flags/snapshot',
          assert: { op: 'changed', path: 'data' },
          pollMs: POLL_MS,
          timeoutMs: TIMEOUT_MS,
        },
      },
    ],
  },
];

export function getLesson(lessonId: string): TutorialLesson | undefined {
  return TUTORIAL_LESSONS.find((l) => l.id === lessonId);
}

/** Every permission string an action/verify step in this lesson references — de-duplicated,
 * sorted. Read by `scripts/access-catalog-export.ts` (the `tutorialLessons` export) and by
 * `TutorialService` for nothing beyond documentation (the fine-grained gate lives client-side —
 * see this module's header comment). */
export function lessonPermissions(lesson: TutorialLesson): string[] {
  const perms = new Set<string>();
  for (const step of lesson.steps) {
    if ((step.kind === 'action' || step.kind === 'verify') && step.permission) {
      perms.add(step.permission);
    }
  }
  return [...perms].sort();
}

export { isTutorialTrack };
