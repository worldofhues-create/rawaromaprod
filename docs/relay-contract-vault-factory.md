# Relay contract: the RAC OS Vault and Factory consoles over RawProd (RP-BE-1)

RESUME NOTE (keep at the top): all 52 rows have their status; see "State" at the end for what is built, the suite result and what is left.

Branch `fd/vault-factory-api`. The work list is ALEMBIC `docs/plan/program/rp-relay.md` Part 4.3 (on
`origin/st5/consoles-f`): 24 reads (6 Vault + 18 Factory) and 28 writes (7 Vault + 21 Factory). Each of the
52 is one row below, numbered, with its status:

- BUILT: a new RawProd route in this branch, tested.
- REUSED: RawProd already serves it, under the real path given (the console's path or body differs where said).
- NOT BUILT: with the reason.

## How every route here behaves (RawProd's own rules, not new ones)

- Envelope `{data, meta:{requestId, cursor?, total?}, error}`. A list answers `data: [...]`, `meta.cursor`
  (the next page, null at the end) and, where counted, `meta.total`. Pass `cursor` and `limit` (at most 100).
  In the new lists `cursor` is an offset (a decimal string), as `formula-access-audit` pages.
- Main box writes: the global `IdempotencyInterceptor` honours `Idempotency-Key` (one key = one intent; same
  key + same body replays the stored answer; same key + another body is 422; in flight is 409), and the
  global `WriteAuditInterceptor` writes one `<schema>.audit_events` row per successful write, in the schema
  the route's permission names. A route marked `NoStoredReply` keeps no copy of its answer.
- Vault box writes: `VaultIdempotencyInterceptor` and the hash-chained `formula.audit_events` (VaultService).
- Step-up "yes" = `@FreshAuth()` (300 s): RawProd refuses with 403 `AUTH_STEP_UP_REQUIRED` when the token's
  `authTime` is older; through the relay that is the RAC OS step-up time in the assertion's `auth_time`.
  The relay maps that 403 to 428 (rp-relay.md 2.1 step 6).
- Coded, never named: no Factory read selects a material's name or code. Where `materialId` appears, the
  global masking interceptor nulls it for a caller without `masterdata:material:reveal`.
- Units as held: masses in integer milligrams (`...Mg`) only where the unit is a mass; otherwise null with
  `unconverted: true`. Nothing absent is filled: a figure RawProd does not hold is null with the reason.
- Role column = RawProd's permission (RawProd resolves the person's permissions from ITS OWN tables;
  the assertion's roles grant nothing). Roles that hold it today are named where it matters.

## Factory reads (18)

| # | Console call | Method + RawProd path | Permission | Step-up | Idem. | Request | Response (`data`) | Status |
|---|---|---|---|---|---|---|---|---|
| F1 | readToday | GET `/v1/factory/today` | production:production_order:read | no | n/a | none | `{day, tiles:{onTheFloor, macerating, qcWaiting:{batches, rmLots}, shortStock}, needsAPerson:{openAlerts, poAwaitingApproval, openProblems, belowReorder}, stationsToday:[{station, done}], planned:null, history:null, batchesMoving:[board row]}` (planned per station and the seven-day bars are not held: null) | BUILT |
| F2 | readBoard | GET `/v1/floor/board` | production:floor_queue:read | no | n/a | none | `[{floorJobId, jobNo, batchNo, oilBatchId, stage (PICK, VERIFY, MIX, MACERATION, QC, APPROVED), expedite, orderRef, promiseDt, lines, macerationDay, macerationNeedDays, qcRound, createdDt, output}]` (`output` as F3, LD-272b), `meta.total`; stage counts in the body's `counts` are not lifted by the envelope (count the rows). Packed and Shipped are not derived (no oil-batch link on a finished-good batch) | BUILT |
| F3 | readBatch | GET `/v1/floor/batches/:ref` (ref = batch no, job no, or either uuid) | production:floor_queue:read | no | n/a | none | `{floorJobId, jobNo, batchNo, oilBatchId, stage, expedite, orderRef, promiseDt, batch:{batchNumber, status, producedQty, producedDt}, hold, qcRounds:[{roundNo, proposal, decision, overridesProposal, decisionReason, decidedBy, decidedDt, bookedBy, bookedDt, checkpoints:[{seq, name, checkType, min, max, critical, pass, value, note}]}]` (RELAY-W2: the round's own checkpoint set beside what was booked; nothing booked = nulls), lines:[{seq, code, familyCode, colourName, colourHex, targetMg, tolerancePpm, pickedMg, actualMg, pickedLot, bin, state, by, at}]}`. For a RELAY token (`via: "relay"`, LD-272) `targetMg`, `tolerancePpm`, `pickedMg`, `actualMg` and `batch.producedQty` are absent: each line is its code, state, `by` and `at`. LD-272b: every caller gets `output:{productCode, productName, grade, plannedMg, producedMg, unconverted, productNote}`: the one product made from the order's formula and its catalogue grade (name, code and grade only with `formula:actual:read`, RawProd's own product-label rule; else null and `productNote` says so), planned mass = the production order's quantity, produced mass = the oil batch's, integer mg, null when not held (never 0) | BUILT (LD-272, RELAY-W; LD-272b, RELAY-W2) |
| F4 | readBatchRoute | GET `/v1/floor/batches/:ref/route` | production:floor_queue:read | no | n/a | none | `{floorJobId, batchNo, steps:[{station, state (DONE, CURRENT, WAITING, BOOKED), by, at, note}]}` station by station: PICK, VERIFY, MIX, MACERATION (each run), QC ROUND n | BUILT |
| F5 | readStockCover | GET `/v1/floor/stock-cover` | procurement:stock_requirement:read | no | n/a | `q` (code, colour or bin), `state` (all, low, covered), `cursor`, `limit` | `[{code, materialId, familyCode, colourName, colourHex, bins[], onHandMg, unconverted, reorderAtMg, belowReorder (null when either figure is missing), requestOpen, coverDays:null}]`, `meta.total`; body `coverNote` says why cover is null | BUILT |
| F6 | readCode | GET `/v1/floor/codes/:code/summary` (code like `YELLOW-0417`) | masterdata:floor_code:read | no | n/a | none | one stock-cover row + `lots` (count) + `coverNote` | BUILT at a DIFFERENT PATH: `GET /v1/floor/codes/:materialId` already exists (write permission, by material id), so the console's `floor/codes/:code` becomes `floor/codes/:code/summary` |
| F7 | readCodeLots | GET `/v1/floor/codes/:code/lots` | masterdata:floor_code:read | no | n/a | none | `[{inventoryBatchId, lot, onHandMg, manufacturedOn, expiresOn, lotStatus, bin, held}]` first to expire first; body `code` | BUILT |
| F8 | readQcQueue | GET `/v1/factory/qc-queue` | quality:qc_inspections:read | no | n/a | `kind` (batch, rm, all), `cursor`, `limit` | `[{kind (BATCH, RM_LOT), id, ref, since, lastRound, lastProposal, code}]` oldest first, `meta.total`. A batch is listed while no maceration is open and its last round does not propose APPROVE; a raw lot while `QUARANTINE` | BUILT |
| F9 | readTraceBatches | GET `/v1/trace/batches` | production:production_order:read | no | n/a | `q` (batch or job no), `cursor`, `limit` | `[{oilBatchId, batchNumber, status, producedDt, jobNo, orderRef, rawLots, fills:[{lot, filledOn}]}]`, `meta.total` (RELAY-W2: `fills` = the finished-good lots made from this batch through `package_order.oil_batch_id`, the system's own numbers; none = `[]`). One batch's full trace stays `GET /v1/trace/finished-good/:id` and `GET /v1/floor/lots/:code/genealogy` (exist) | BUILT |
| F10 | readRecalls | GET `/v1/recalls` | inventory:rm_batch_master:read | no | n/a | `cursor`, `limit` | `[{recallReviewId, recallNo, subjectType, subjectId, lot, lotHoldId, state, reason, startedBy, startedDt, decidedBy, decidedDt, decision, decisionReason, ordersReached:[{soNumber, dispatchedOn}]}]`, `meta.total` (RELAY-W2: the factory system's own sales orders reached, from dispatch records: raw lot -> the batches it was picked into (or the oil batch itself) -> their fills -> dispatch items. RAC OS orders are not known here) | BUILT |
| F11 | readFloorCodes | GET `/v1/floor/codes` | masterdata:floor_code:read | no | n/a | none | `[{code, materialId, familyCode, familyName, colourName, colourHex, number, createdBy, createdDt}]`, `meta.total`; families stay `GET /v1/floor/families` | BUILT (same route as V4) |
| F12 | readRacks | GET `/v1/floor/racks` | location:rack_master:read | no | n/a | none | `[{rackId, rackCode, status, walkSeq, bins:[{binCode, status, families[]}]}]` + body `families:[{familyCode, colourName, colourHex}]` (a bin's families = the floor codes with stock in a storage location of the same code) | BUILT |
| F13 | readOperatingRules | GET `/v1/operating-rules?site=` | platform:policy:read | no | n/a | `site` (required, e.g. INDORE) | `[{key, value, reason, setBy, setDt, versions}]` the newest row per key; body `site` | BUILT (see note G1) |
| F14 | readMacerationDefaults | GET `/v1/maceration/defaults?site=` | production:maceration:read | no | n/a | `site` (required) | `[{productClass, minDays, maxDays, reason, setBy, setDt}]` newest per class; a formula's own `/v1/maceration/settings` still wins | BUILT |
| F15 | readFactoryPeople | GET `/v1/role-change-requests/people` | iam:user_master:read | no | n/a | `q` (name or employee code), `cursor`, `limit` | `[{userId, name, employeeCode, roles[], pendingChange:{roleChangeRequestId, toRole, station, requestedBy, requestedDt} or null}]`; station of a person is not held (no `iam.user_station`) | BUILT |
| F16 | readJob | GET `/v1/floor/jobs/:id/pick`, `/verify`, `/mix` | production:floor_pick:write / floor_verify:write / floor_mix:write | no | n/a | none | the station's own coded lines | REUSED (no single "one job" read: the kiosk reads its station's view) |
| F17 | readMixSteps | GET `/v1/floor/jobs/:id/mix` | production:floor_mix:write | no | n/a | none | the mixer's coded steps | REUSED (console path `floor/jobs/:id/mix/steps` becomes `floor/jobs/:id/mix`) |
| F18 | deviceTest | GET `/v1/devices/:id/test` | platform:device:read | no | n/a | none | `{deviceId, kind, station, name, status, pairedAt, lastSeenAt, revokedAt, paired, test:{deviceTestId, state (REQUESTED, PASSED, FAILED), result, requestedBy, requestedAt, testedAt} or null}` | BUILT (the device's own report route is NOT BUILT: see the note under Factory writes) |

Note L1, RULED (LD-272): the relay never carries target grams per floor code. F3 strips every quantity for a
relay token (RawProd side, `FactoryDeskService.batch(ref, {relay})`) and ALEMBIC's relay strips them again (second
lock). A person signed in on RawProd itself still gets the floor's batch sheet with grams. F16 and F17 (the
stations' own views, which carry target grams) are NOT relayed for the same reason: the console says they are
read in the factory system.

Note G1: the values are stored and served; NOTHING in RawProd reads them yet (FAC-BE-03's money rule and
contract are an owner gate). A saved rule changes no behaviour until a consumer is built and approved.

Note G2 (RELAY-W4): F13 and F14 answer rows, never a `{ruleKey: value}` map, and carry NO permission flag.
Who may save is `platform:policy:write` (W-F11, @FreshAuth: a fresh code on EVERY save) and
`production:maceration_setting:write` (W-F12, no step-up), decided by these routes on the save; a caller
without it gets the 403 naming the permission, which the console shows in these words. W-F12's body is
`{values:[{productClass, minDays, maxDays}], reason}`; there are no fixed product classes here (the console
draws the prototype's two, `FRAGRANCE_OIL` and `ATTAR`, plus any class already held).

## Factory writes (21)

| # | Console call | Method + RawProd path | Permission | Step-up | Idem. | Request | Response (`data`) | Status |
|---|---|---|---|---|---|---|---|---|
| W-F1 | approvePo | POST `/v1/purchase-orders/:id/approve` | procurement:purchase_order:write | no | yes | `{remarks?}` (console sends `reason`: map to `remarks`) | the PO | REUSED (SoD: creator never approves) |
| W-F2 | rejectPo | POST `/v1/purchase-orders/:id/reject` | procurement:purchase_order:write | no | yes | `{reason}` (3-500 chars) | `{purchaseOrderId, poNumber, status:'RETURNED', rejectedBy, rejectedReason, rejectedDt}`; only from DRAFT, PENDING, PENDING_L2_APPROVAL, else 409 | BUILT |
| W-F3 | disposeGrn | POST `/v1/qc-inspections/:id/disposition` | quality:qc_inspections:write | no | yes | `{dispositionCode: ACCEPT, REJECT, REWORK, HOLD, dispositionReason?}` (console sends `decision, reason`: map) | the disposition | REUSED |
| W-F4 | decideQc | POST `/v1/prodfloor/qc/batches/:id/rounds/:round/decision` (`:id` = oil batch uuid) | quality:qc_inspections:write | yes | yes | `{decision: CONFIRM, APPROVE, REWORK, HOLD_RETEST, REJECT, HOLD_CAPA, reason?}`; reason required when the call differs from the proposal | `{batchQcRoundId, roundNo, proposal, decision, overridesProposal, decisionReason, decidedBy, decidedDt}`; one call per round (409 after); CONFIRM on a REVIEW round is 409 | BUILT (records the person's call; releases, labels and re-queues NOTHING: release stays on the CoA path, so no second "passed" reaches ALEMBIC. Those effects are FAC-BE-28's owner gate) |
| W-F5 | startRecall | POST `/v1/recalls` | inventory:rm_batch_master:write | yes | yes | `{lot (raw lot number or oil batch number), reason}` | `{recallReviewId, recallNo ('RCL-00001', from a sequence), subjectType, lot, lotHoldId, state:'OPEN', reason, startedBy, startedDt}`; the lot goes on `inventory.lot_hold` (source RECALL) in the same transaction; one open recall per lot (409) | BUILT (the decision route and the `LotRecallDecided` bridge event are NOT BUILT: owner gate, bridge contract) |
| W-F6 | queueLabel | POST `/v1/print-jobs` | platform:print_job:write | no | yes | `{station, labelKind, subjectRef?, content?, size?}` (console sends `kind, subject`: map) | the job | REUSED |
| W-F7 | reprintJob | POST `/v1/print-jobs/:id/reprint` | platform:print_job:write | no | yes | `{reason}` | the new job | REUSED |
| W-F8 | cancelJob | POST `/v1/print-jobs/:id/cancel` | platform:print_job:write | no | yes | none | `{printJobId, status:'cancelled'}`; only queued, failed, parked (else 409 naming the state) | BUILT |
| W-F9 | createDevice | POST `/v1/devices` | platform:device:write | no | yes | as RawProd's create (answer carries the pairing code) | the device | REUSED |
| W-F10 | runDeviceTest | POST `/v1/devices/:id/test` | platform:device:write | no | yes | none | `{deviceTestId, deviceId, state:'REQUESTED', requestedBy, requestedAt}`; revoked device 409 | BUILT (the result comes from the device: see the note under this table) |
| W-F11 | saveOperatingRules | POST `/v1/operating-rules` | platform:policy:write | yes | yes | `{site, values:{ruleKey: number, boolean, short text or null}, reason}`; keys `^[a-z][a-z0-9_.]{1,79}$`, 1-50 | as F13 | BUILT (note G1) |
| W-F12 | saveMacerationDefaults | PUT `/v1/maceration/defaults?site=` | production:maceration_setting:write | no | yes | `{values:[{productClass, minDays, maxDays}], reason}` | as F14 | BUILT |
| W-F13 | testPolicy | POST `/v1/policies/:key/test` | platform:policy:read | no | n/a (saves nothing) | `{body?, ctx}` (console sends `sample`: map to `ctx`) | the evaluation | REUSED (Part 4.3 listed it as missing; it exists) |
| W-F14 | publishPolicy | POST `/v1/policies/:key/versions` | platform:policy:write | no | yes | `{body, reason}` | the version | REUSED |
| W-F15 | requestRoleChange | POST `/v1/role-change-requests` | iam:user_master:read | yes | yes | `{person (user uuid), toRole (an existing role code), station?, reason}` (console sends `person, reason` only: it must add `toRole`) | `{roleChangeRequestId, userId, toRole, station, reason, state:'REQUESTED', requestedBy, requestedDt}`; one open per person (409) | BUILT (records only; approving it changes RBAC and is an owner gate, NOT BUILT) |
| W-F16 | floorStep | POST `/v1/floor/jobs/:id/pick/lines/:line`, `/pick/complete`, `/verify/lines/:line`, `/verify/complete`, `/mix/steps/:seq`, `/mix/complete` | production:floor_pick/verify/mix:write | no | yes | each station's body | each step | REUSED (the steps that consume raw stock and close the batch are these existing routes, each one transaction) |
| W-F17 | floorScan | GET `/v1/floor/scan?code=` (resolve) | inventory:lot_barcode:resolve | no | n/a | `code` | what the code names | REUSED as a GET (the check against a line happens inside the line's POST in W-F16) |
| W-F18 | recordReading | POST `/v1/temperature/zones/:id/readings` | quality:temperature:write | no | yes | `{tempC, note?}` (console sends `zone, hundredths`: zone goes in the path, hundredths/100 as tempC) | the reading | REUSED |
| W-F19 | raiseProblem | POST `/v1/floor/problems` | production:floor_queue:read | no | yes | `{station, kind: WRONG_IDENTITY, SHORT_QUANTITY, CONTAINER_DAMAGED, SCALE_NOT_READING, LABEL_WILL_NOT_SCAN, OTHER, job? (job no or uuid), note? (required for OTHER)}` | `{floorProblemId, station, floorJobId, kind, note, floorAlertId, raisedBy, raisedDt, alertRaised}`; "the supervisor is on the way" only when `alertRaised` | BUILT |
| W-F20 | ackAlert | POST `/v1/floor/alerts/:id/ack` | any signed-in person | no | yes | none | the alert | REUSED |
| W-F21 | planRequirement | POST `/v1/produce/requirements/:id/plan` | production:production_plan_items:write + production_order:write | no | yes | as RawProd's | the plan | REUSED (Part 4.3 listed it as missing; it exists) |

Not relayed (device credentials, never a person): `pairDevice`, `stationSignOn`, `selfTest`, `readKioskDevice`.
The device's test report (`POST /v1/device-agent/self-test`) is NOT BUILT here: a device-token route, outside the relay.

## Vault reads (6)

V = Vault box (the relay's `/api/v1/vault/rp/<path>`), M = main box (`/api/v1/vault/rp/main/<path>`).
LD-261: every Vault read for the relay is METADATA ONLY (code, name, version, status, who, when, counts). The
decrypted recipe is `POST /v1/formula-versions/:id/actual`, now `@NoRelay` (see "Relay mark" below).

| # | Console call | Method + RawProd path | Permission | Step-up | Idem. | Request | Response (`data`) | Status |
|---|---|---|---|---|---|---|---|---|
| V1 | readOverview | V GET `/v1/vault/overview` | formula:formula_version:read | no (the relay asks a fresh RAC OS step-up for every Vault call) | n/a | none | `{tiles:{approved, waiting, drafts, needed:null}, neededNote, waiting:[{formulaVersionId, formulaId, formulaCode, formulaName, versionNumber, status, submittedBy, submittedDt, createdBy, sealedLines}], formulas:[{formulaId, formulaCode, formulaName, status, latestVersionNumber, latestVersionStatus, latestVersionUpdatedDt, approvedVersionId, approvedVersionNumber}]}`; `needed` is main-box data (`GET /v1/produce/formula-needs`, M) and stays null here. Writes one `formula.audit_events` row (`formula.vault.overview_read`) before answering | BUILT |
| V2 | readDraftStart | V GET `/v1/vault/version-draft?base=` | formula:formula_version:write | no | n/a | `base` (a version uuid, optional) | `{bases:[{formulaVersionId, formulaId, formulaCode, formulaName, versionNumber, status, approvedBy, approvedDt}], materials:null, materialsNote}` (materials are searched at `GET /v1/vault/materials?q=`). Audited (`formula.vault.version_draft_read`, entity = base) | BUILT |
| V3 | readRoute | (V GET `/v1/vault/route`) | | | | | | NOT BUILT: LD-261. Its answer is each line's floor code with milligrams for a batch size, i.e. the recipe's quantities; that is the decrypted formula and never goes to ALEMBIC. The drawer's line and step COUNTS come from V1's `sealedLines`; the route itself is read in the Vault (hand-off) |
| V4 | readCodes | M GET `/v1/floor/codes` | masterdata:floor_code:read | no | n/a | none | as F11 | BUILT (same route as F11) |
| V5 | readMaterial | V GET `/v1/compliance/materials/:materialId` | vault:rm_compliance:read | no | n/a | none | `{allergenComplete, ifraComplete, ifraAmendment, sourceRef, allergens[], ifra:[{category, restrictionType, maxPct, amendment}], ...}`: per-material and sourced; `ifraComplete:false` means NOT KNOWN, never "unrestricted". Name and code come from the search row (`GET /v1/vault/materials?q=`) | REUSED (console path `vault/materials/:id` becomes `compliance/materials/:id`) |
| V6 | readImpact | (M GET `/v1/vault/impact`) | | | | | | NOT BUILT: LD-261. Need per floor code for a batch size is the recipe's quantities by another name, and the main box cannot compute it without the decrypt. Nearest held figure: `GET /v1/reorder-suggestions` (M) and F5 |

## Vault writes (7)

| # | Console call | Method + RawProd path | Permission | Step-up | Idem. | Request | Response | Status |
|---|---|---|---|---|---|---|---|---|
| W-V1 | createVersion | V POST `/v1/formula-versions` | formula:formula_version:write | no | yes (Vault) | as RawProd's | the version | REUSED on RawProd's own Vault only: now `@NoRelay` (its body carries recipe lines; LD-261). A relay token gets 403. The console sends the person to the Vault (hand-off) to write a version |
| W-V2 | submitForReview | V POST `/v1/formula-versions/:id/submit-for-review` | formula:formula_version:write | no | yes (Vault) | `{remarks?}` | the version | REUSED |
| W-V3 | approveVersion | V POST `/v1/formula-versions/:id/approve` | formula:formula_approval:write | yes | yes (Vault) | `{remarks?, approvalLevel?}` (console sends `reason`: map to `remarks`) | the version | REUSED (SoD: the author never approves) |
| W-V4 | sendBack | V POST `/v1/formula-versions/:id/reject` | formula:formula_approval:write | yes | yes (Vault) | `{remarks}` (3-2000 chars, required) | the version | REUSED |
| W-V5 | issueCode | M POST `/v1/floor/codes` | masterdata:floor_code:write | no | yes | `{materialId, familyCode}` (console sends `family`: rename to `familyCode`) | the floor code | REUSED |
| W-V6 | revealCode | M POST `/v1/floor/codes/:code/reveal` | masterdata:material:reveal | yes | yes, with no stored reply (the answer names a material) | `{reason}` (3-500 chars) | `{code, materialId, materialCode, materialName, revealedBy}`; a `masterdata.floor_code_reveal` row (who, why, when) is written before the name is returned. Identity only, no formula | BUILT |
| W-V7 | raisePurchaseRequest | M POST `/v1/purchase-requests` then POST `/v1/purchase-request-items` | procurement:purchase_request:write / purchase_request_items:write | no | yes | header `{priority?, expectedDeliveryDate?, ...}`, then items `{purchaseRequestId, materialId, requiredQty, uomId}` | the request | REUSED (Part 4.3 listed it as missing; it exists, in two steps) |

## Relay mark (LD-261): what the next unit must send

The relay must add `via: "relay"` to every assertion it mints (rp-relay.md 2.1 step 4). RawProd then:
- refuses an unknown `via` value (401 `AUTH_ASSERTION_INVALID`); absent or `"handoff"` = the browser hand-off, as before;
- marks the access token `via: "relay"` and returns `refreshToken: ""` (a relay session is never refreshed);
- refuses that token with 403 on every `@NoRelay` route, whatever its permissions and step-up:
  `POST /v1/formula-versions/:id/actual` (the decrypt), `POST /v1/formula-versions`, `POST /v1/formula-versions/:id/ingredients`,
  `POST /v1/formula-stages/:id/ingredients`, `POST /v1/formula-recipes/import`, `POST /v1/imports/:kind/preview`,
  `POST /v1/imports/jobs/:id/commit`, `POST /v1/imports/jobs/:id/problems` (Vault box), `GET /v1/compliance/preview/:formulaId`,
  `GET /v1/compliance/missing`.
Until the relay sends the mark, its token is indistinguishable from a hand-off and only Alembic's own allow-list
keeps the decrypt out; with the mark, RawProd refuses it as well (two independent checks).

## RELAY-W2 (16 Nov)

- LD-272b: F2 and F3 carry `output` (see F3). F3 rounds carry `checkpoints`; F9 rows `fills`; F10 rows `ordersReached`.
- NOT RECORDED in the factory system (screens say "Not recorded" or show no series; never 0, never a sample):
  cover in days (no planned daily use), a person's station (no `iam.user_station`), Today's seven-day series
  and planned-per-station (point-in-time counts with no daily history kept).
- DEPLOY ORDER: the factory system first. Its live verifier (`release/stage-2-rp` 7751d6d,
  `backend/cluster-org/src/auth/alembic-assertion.ts`) ACCEPTS an assertion carrying `via: "relay"` and drops the
  claim (proved with ALEMBIC's real signer against the old file byte-for-byte: `ok: true`, no `via` in the claims),
  so against it a relay token is an ordinary hand-off session (refresh token issued, `@NoRelay` not enforced, the
  LD-272 strip RawProd-side absent; only ALEMBIC's allow-list and strip hold) and every new route here 404s. The new
  verifier accepts today's ALEMBIC unchanged (no `via` = hand-off).

## Verified by RELAY-W (15 Nov)

- Migration `2026-11-28-vault-factory-api.sql` through `pnpm db:migrate` on an EMPTY database (Postgres 17.11 with
  PostGIS; the local 14 has no PostGIS, which `0000_prerequisites.sql` needs): exit 0, 68 blocks applied. Its
  rollback (`psql -v ON_ERROR_STOP=1 -f scripts/migrations/rollback/2026-11-28-vault-factory-api.down.sql`): exit 0;
  the schema difference is exactly the migration's objects (7 tables, 1 sequence, their indexes and grants to
  `DB_APP_ROLE`, 3 `purchase_order` columns, 5 `batch_qc_round` columns, its ledger row), nothing added. Forward
  again: exit 0, 1 block applied, and the schema (columns, indexes, sequences, grants, ledger) is IDENTICAL to the
  first forward.
- LIVE HTTP (real `src/main.ts` on :4671 and `src/vault-main.ts` on :4672, fresh databases, dev key pair): the
  assertion exchange (main box `POST /auth/alembic-assertion`) with `via: "relay"` answers 201 with
  `refreshToken: ""`; an unknown `via` is 401 `AUTH_ASSERTION_INVALID`. As `formulator` (holds every permission
  the ten routes name) with a fresh `auth_time`, the relay token gets 403 "This is opened only on the Vault
  itself, never through RAC OS." on all ten `@NoRelay` routes, the decrypt included; the same person's own
  RawProd session (the hand-off; password sign-in is retired) passes the guard on every one (404 no such
  version, 422 validation, 200 for `compliance/missing`). Password sign-in answers 403 "Password sign-in is
  retired", so the hand-off is the only RawProd session there is.

## State

Built and tested: F1-F15, F18, W-F2, W-F4, W-F5, W-F8, W-F10, W-F11, W-F12, W-F15, W-F19, V1, V2, V4 (=F11), W-V6,
and the relay mark (LD-261). Code: `backend/api/src/factory-desk/`, `backend/cluster-formula/src/vault-desk/`,
`backend/backend-kernel/src/decorators/no-relay.decorator.ts`; migration `scripts/migrations/2026-11-28-vault-factory-api.sql`
+ rollback. Tests: `backend/api/src/__tests__/factory-desk.test.ts`, `backend/cluster-formula/src/__tests__/vault-desk.test.ts`,
4 LD-261 tests at the end of `backend/cluster-org/src/__tests__/auth-service-assertion.test.ts`.
Totals over the 52 rows: 29 BUILT (19 reads + 10 writes; F11 and V4 are one route, so 28 new routes),
21 REUSED (F16, F17, 12 Factory writes, V5, 6 Vault writes), 2 NOT BUILT (V3, V6: LD-261).

Whole suite (`node backend/test-support/run-tests.mjs`, one run, fresh database `zrp_suite`, since dropped):
5,129 tests, 5,099 pass, 29 fail, 1 skipped. 28 of the 29 are four files that need PostGIS and refuse the local
Postgres on 5432 by design ("use the Docker PostGIS (127.0.0.1:5433)"; no Docker on this machine):
automation-app-role-grants, formula-setup-e2e, vault-isolation-harness, auto-draft-list-order. The 29th is STK-7 in
stk-9-reserve-at-planning: it passes 9/9 alone on a fresh database and fails only after other files have left an
upper-case `G` unit row (planning.service.ts picks the gram unit `order by uom_code limit 1`, so `G` wins over `g`).
This branch adds no `G` row; it is an order-dependence that predates it.

Left for the next unit (ALEMBIC side): allow-list rows and adapters for the BUILT and REUSED paths above (note the
path and field renames: F6, F17, V5, W-F1, W-F3, W-F6, W-F13, W-F15 `toRole`, W-F18, W-V3, W-V5), the write relay,
and `via: "relay"` on every relay assertion.

