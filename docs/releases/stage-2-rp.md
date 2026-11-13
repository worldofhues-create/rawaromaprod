# RawProd release: stage 2 (`release/stage-2-rp`)

Written 14 Nov 2026 by the release build (STAGE2-RP). Production runs `ee14722`. This branch is the
stock chain, the spreadsheet imports, the process promises and the release tooling, merged and
proved together. Nothing here has been deployed. Every figure below was produced by a command that
was run on this branch; the commands and their exit codes are in section 9.

**Read section 1 before deploying.** Two things in it need a decision by the lead or the owner.

---

## 1. Two decisions before this is deployed

### 1.1 The process promises are ON from the first minute. They are not behind a switch.

The promises lane was merged whole, as ruled. The ruling assumed its behaviour "stays behind its own
rules, which are off or unenforced by default". That is **not what the code does**. Each rule is
written into `platform.policy` by its migration with the owner's value (LD-85), and where no version
is published the kernel's registry default is the same value (`backend/backend-kernel/src/events/factory-rules.ts`
`FACTORY_RULE_DEFAULTS`). There is no environment flag.

| Rule (`platform.policy` key) | Value on day one | Can it be switched off? | What a person meets on day one |
|---|---|---|---|
| `maceration.rest` | 45 days, every batch, no maximum, early release by a second person | **No.** `minDays` is 1 to 365 and `appliesTo` must be `every_batch` (`restRuleProblems`). The Rules screen can shorten it, to 1 day at the least | Every oil batch rests after QC 1 before QC 2 can release it. Before this release only a formula with a maceration setting rested. A batch that needs to go sooner needs an early release: one person asks with a reason code, a different person approves, and QC 2 still gates. `HOLD -> RELEASED` and `REWORK -> RELEASED` with no open rest are refused |
| `qc.reference_required` | required | Yes: publish a version with `required: false` on the Rules screen | QC 1 and QC 2 are rounds on the product's pinned checkpoints, each compared with the product's retained reference (or recorded `NO_REFERENCE_YET`). **A typed QC PASS no longer moves a batch into rest or releases it.** QC 2 counts only when taken after the rest ended and with a retained sample of that batch on file. A product with no QC checkpoints set up cannot be taken through a round. **A checkpoint set can no longer be published without a REFERENCE checkpoint** ("add a REFERENCE checkpoint"); sets already published stay as they are |
| `fill.lot_server_assigned` | required | **No** (`lotRuleProblems`: one valid value) | The oil-batch form and the finished-goods form no longer ask for a batch or lot number. The server assigns it. This is the fix for STK-13 and STK-34 (two factory lots shared one typed number and Alembic received 100,000 mg less than the factory sent) |
| `continuity.supplier_change_is_material` | true | Yes: publish `isMaterial: false` | Nothing on the floor. At compounding the batch's continuity key is recorded; a change from the product's current key is recorded and sent to Alembic |

PROM-9 adds no rule: a requirement Alembic marks as held (`hold` on `ProductionRequirementChanged`) is
not planned or linked to a run. Alembic sends `hold` only from its `lane/prom`.

So if this branch is deployed as it stands, **from that minute no batch is released without a rest of
45 days or a two-person early release, and no batch is released on a typed QC result.** That is the
owner's decision LD-85 as the lane built it, and it was reviewed; whether it goes live tonight with the
stock chain is the decision. The choices:

1. Deploy as it stands, and tell the floor (section 6) before the first batch after the deploy.
2. Deploy as it stands and, the same hour, publish on the Rules screen a shorter `maceration.rest`
   and/or `qc.reference_required: false` for a stated period. Both are rules as data, versioned, with
   a reason, and `factory.rules.state` tells Alembic what is in force.
3. Ship without the promises: the release is then `5ae9be8` (the merge of ship and imports onto the
   stock lane) plus the release's own fix commits, with only PROM-4 brought across. That branch has
   not been built. The fix commits (section 2.5) touch no promises file except where noted, so they
   cherry-pick; the proof in section 9 would have to be run again on it.

### 1.2 Alembic must deploy first, and no single Alembic lane accepts everything this sends

RawProd's own builders were run and their output parsed by Alembic's real parsers at each lane
(`git archive` of `packages/domain/src`, 14 Nov):

| Alembic branch | `fg.batch.received` with packs and the promise block | `material.cost.recorded` | Types RawProd sends that it does not accept |
|---|---|---|---|
| `origin/lane/stock-e2e-2` `830e4f26` | accepted; pack 49 x 100,000 mg read; label time, lot origin and promise block **ignored, not recorded** | no parser | `batch.rest.recorded`, `qc.reference.established`, `product.continuity.current`, `product.material.changed`, `factory.rules.state`, `batch.rest.started`, `material.cost.recorded` |
| `origin/lane/imports` `3b7ed4d7` | accepted; **packs not read** (this lane lacks STK-21) | accepted, both shapes | the six promise types |
| `origin/lane/prom` `0c404d85` | accepted; label, lot origin and promise read; **packs not read** | no parser | `material.cost.recorded` |

What Alembic sends is accepted here in every case, and the fact kinds match in every case.

So Alembic's release must hold `lane/stock-e2e-2` **and** `lane/imports`, and `lane/prom` as well if the
promises ship here. If Alembic deploys without `lane/prom`:

- The six promise facts are refused by Alembic as an unknown type. RawProd parks each after one attempt
  (`bridge.outbox_delivery`, listed at `GET /v1/bridge/outbox/parked`) and they can be replayed under the
  same event id once Alembic accepts the type. They use their own aggregates (the rest run, the
  continuity row, the rules), so a parked one does not hold a stock fact behind it.
  `factory.rules.state` is sent at every API start and daily, so one parks on the first start.
- The stock facts flow. But the label time, the lot origin and the process record on each receipt are
  dropped by Alembic without a word, for every lot received until Alembic has `lane/prom`.

`material.cost.recorded` is sent only when someone records a purchase price (a sheet or the screen). If
Alembic lacks `lane/imports` it parks the same way.

---

## 2. What is in the release, by lane

| Lane | Head | Commits since `ee14722` | What it is |
|---|---|---|---|
| `lane/stock-e2e-2-rp` (the base) | `bacd51a` | 21 | STOCK-E2E-1, STOCK-FIX-RP, STOCK-E2E-2: the oil ledger (STK-10, STK-11), reservation at planning (STK-7 to STK-9), the mixer's name reveal (STK-15), raw materials (STK-16 to STK-19), packs on the receipt (STK-21), the typed weight's second person at Verify (STK-27), a name on file is that material (STK-30), pack SKUs from the catalogue (STK-31), a bulk lot's label (STK-33) |
| `lane/ship-rp` | `e27d24b` | 11 | `infra/aws/ship.sh` and its lock, the `fonts-only-two.test.ts:92` typecheck fix (`5069259`), and FAVICON-FLUKE (the Shell Fluke favicon and app icons on the three consoles) |
| `lane/imports-rp` | `cece644` | 19 | IMPORT-RP-1 to 7: spreadsheet templates and imports (ingredients, suppliers, supplier lots, dilutions, opening raw stock, stock adjustments, packaging; formulas on the Vault), purchase prices, `material.cost.recorded` |
| `lane/promises-rp` | `0e4ad39` | 15 | PROM-2 to PROM-12, **whole** (section 1.1) |

### 2.5 The release's own commits

| Commit | What |
|---|---|
| `0796ea5` | merge `lane/ship-rp` |
| `5ae9be8` | merge `lane/imports-rp` |
| `7ec0bec` | merge `lane/promises-rp` |
| `3aecb2d` | (a) `POST /v1/stock-adjustments` refuses a decrease that cuts into a reservation |
| `1e1dd16` | (b) the finished-goods label's net and lot quantity; Code 128 refuses what it cannot carry |
| `4016650` | (c) STK-38: Assign mixer and the one-name reveal; the reveal's answer is never stored; the grants file |
| `9cd3085` | a rollback dropped an older migration's index; the STK-38 browser walk |
| `2be25ae` | `pnpm boundaries`: two import cycles |
| `5311b31` | STK-44: the Packing station's typed-weight question, a floor button wider than a 375 card |
| `7f78ab0` | the walk harness brought up to the stock lane's rules (a real unit, planning's reservation, every page of a list); three walks follow the screen |
| `008f915` | 13 stock-lane tests typed a batch number PROM-4 refuses; one test still pinned cache v143 |
| `2417e6e` | four more walks red for the harness: the unit's old code, a repeated material name, the REFERENCE refusal met twice |

How each merge conflict was resolved is in section 8.

---

## 3. Migrations

Twelve are new since `ee14722`. `scripts/db-migrate.ts` orders by file name and keeps one ledger row per
file and block, so the order below is the order they run in. Each is additive and idempotent, and each
has a rollback in `scripts/migrations/rollback/`.

| File | Target | What it adds |
|---|---|---|
| `2026-11-16-prom-2-rest-rule.sql` | main | the rule `maceration.rest`; on `production.maceration_run` the rule a run was opened under, the early-release request and its approver (never the same person, by constraint), days rested |
| `2026-11-17-prom-3-reference.sql` | main | `quality.reference_standard`, the stage on `quality.batch_qc_round`, the rule `qc.reference_required` |
| `2026-11-18-prom-4-fill-lot.sql` | main | sequences `packaging.fg_lot_seq` and `production.oil_batch_no_seq`, `lot_assigned_at_fill`, the rule `fill.lot_server_assigned` |
| `2026-11-18-prom-5-material-change.sql` | main | `production.batch_continuity`, `production.product_continuity`, `production.material_change`, the rule `continuity.supplier_change_is_material` |
| `2026-11-19-prom-9-requirement-hold.sql` | main | the hold on a production requirement |
| `2026-11-20-stk-oil-ledger.sql` | main | the oil batch's ledger: made, packed, remnant, written off |
| `2026-11-21-stk-reserve-at-planning.sql` | main | `required_mg`, `reserved_mg`, `reserved_batch_id` on the order's ingredient lines |
| `2026-11-22-stk-mixer-reveal.sql` | main | `mixer_assigned_to` on a floor job, `production.floor_mix_reveal` (the reveal log) |
| `2026-11-23-stk-materials.sql` | main | the supplier's batch on a receipt, one material per name, the hazard class and its source, floor families |
| `2026-11-24-imports.sql` | main | `platform.import_job`, `platform.import_job_row`, `masterdata.material_dilution`, density source, certificate reference |
| `2026-11-25-material-purchase-price.sql` | main | `procurement.material_purchase_price`, `procurement.purchase_price_setting` |
| `2026-11-26-vault-imports.sql` | formula | the import job and its rows on the Vault's own database |

Two files are dated 2026-11-18. They are both the promises lane's, their order is by name (`prom-4`
before `prom-5`), and the ledger id is the whole file name, so they do not collide. Production already
holds three files dated 2026-11-05 and five dated 2026-11-07. Neither was renamed.

One migration was corrected on this branch (`9cd3085`): `2026-11-21-stk-reserve-at-planning.sql` ended
with a `create index if not exists stock_reservation_document_idx ... where released_dt is null` that
created nothing on any database (0006 already makes an index of that name), while its rollback dropped
that name. Nothing changes on a forward path. It has been applied only to scratch databases.

The Vault box has one migration (`2026-11-26-vault-imports.sql`), so the Vault is deployed too.

---

## 4. Deploy steps, in order

1. **Alembic first** (section 1.2). Its parsers must accept what this sends before this sends it.
2. Push `release/stage-2-rp` (the lead pushes), then the dry runs in section 7.
3. Main box: `infra/aws/ship.sh <sha> --apply`. It backs up, runs the commit's own `deploy.sh`
   (`db:migrate` with `SKIP_TARGETS=formula`), and publishes the consoles.
4. **Grants**, on the main database as the owner role, once, after the migration:
   `psql -v ON_ERROR_STOP=1 -f docs/releases/stage-2-rp-2026-11-14-permission-grants.sql`
   It is generated from `ee14722` to this branch (`scripts/gen-permission-grants.ts --since ee14722`):
   20 new permission codes, no new role, 62 grants. It contains everything in
   `stock-fix-rp-2026-11-13-permission-grants.sql`, `prom-2-...` and `prom-3-...`; applying those as
   well changes nothing (proved). **Production does not run `pnpm db:seed`**: the seed resets the
   owner's password hash. A person's permissions are resolved from their roles, so nobody is re-invited.
5. Vault box: `infra/aws/ship.sh <sha> --role vault --apply` (`db:migrate` with `SKIP_TARGETS=main`).
6. Never the two boxes' deploys together with an Alembic deploy on the main host (one deploy per host).
7. After both: in Alembic's admin, press **Set up factory catalogue** once. The background sync skips
   unchanged items, so only the button makes the pack SKUs (STK-31).
8. Installed kiosks and consoles take the new shell at their next load: the cache name is `ra-shell-v144`.

---

## 5. New environment and settings

**No new environment variable.** `git diff ee14722` adds no `process.env` name in `backend`, `packages`,
`scripts`, `infra/aws/env` or `web`.

Settings are data, on screens:

| Setting | Where | Default |
|---|---|---|
| `maceration.rest` | Rules | 45 days, every batch, no maximum, early release by a second person |
| `qc.reference_required` | Rules | required |
| `fill.lot_server_assigned` | Rules (read only: one valid value) | required |
| `continuity.supplier_change_is_material` | Rules | true |
| `large_change_pct` (`procurement.purchase_price_setting`) | purchase prices | 20 percent: a price that moves by more is flagged, never blocked |

`ship.sh` reads its own variables on the operator's laptop only: `SHIP_PG_BIN`, `SHIP_PG_PORT`,
`RAWPROD_DEPLOYED_SHA`.

---

## 6. What changes for a person on the floor on day one

**Compounding and QC (the promises, section 1.1)**
- Every batch rests 45 days between QC 1 and QC 2. An early release is asked for by one person with a
  reason and approved by another, on the Maceration screen.
- QC is done as rounds on the product's checkpoints, QC 1 and QC 2 by name. A typed PASS does not
  release a batch. Batch QC scans the retained reference's sample code.
- Nobody types a batch number or a lot number. The form no longer has the field, and the server refuses
  one that is sent ("The batch number is assigned by the server").
- A product's QC checkpoints need a "Compare to reference" checkpoint before a new version of them can
  be published.

**The mixer (STK-15, STK-38)**
- A supervisor gives each batch to one mixer: Floor queue, **Assign mixer**. Once assigned, only that
  mixer moves the batch's steps.
- On the Mix station the assigned mixer may press **Show the name** on the step they are doing and sees
  that one material's name beside its floor code, until they press Done. Each view is logged.
- A batch with no assigned mixer can still be mixed by any mixer, as today, by code only.

**Verify and Packing**
- A weight typed at Verify, instead of read from the scale, waits for a second person to sign it
  (Floor devices, Typed weights). Today only an admin can sign in the console (STK-39, open).
- The Packing station's "Why typed" question now opens with "Scale not reading" filled in. It opened
  empty and refused the first press.

**Planning and stock**
- Stock is reserved for a run when it is planned. A shortfall is said at planning, not at the shelf.
- A stock adjustment that would take stock a planned run has reserved is refused, on the screen as in
  the sheet. Release the reservation first, or adjust by less.
- The oil a batch made is drawn down as it is packed. Packing more than was made is refused; what is
  left is decided (kept as a remnant, or written off).
- A finished-goods batch cannot hold more than its package order filled.

**Labels**
- The finished-goods label reads `Net qty 100 g` and `Lot qty 49 PCS`. It read `100 g x 100 g`.
- A lot kept as bulk gets a label with its own mass.

**Receiving and master data**
- A second material with the same name is refused. A receipt records the supplier's own batch number.
- **Import from a sheet** on Materials, Suppliers, Goods receipt, Batches, Adjustments and Packaging
  BOM, for the roles that hold the import permission: download the template, fill it, upload, read
  the preview, commit. Purchase prices can be recorded on the screen or from a sheet.

**Everyone**
- The browser tab and the installed app icon are the Shell Fluke.

---

## 7. The ship tooling: exact commands for a dry run

From a clean checkout of the pushed commit, in bash, with Node 22 on `PATH`:

```bash
export PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH
git fetch origin && git status --porcelain            # nothing may print
infra/aws/ship.sh <sha> --base ee14722                 # main box, dry run: no AWS call of any kind
infra/aws/ship.sh <sha> --base ee14722 --role vault    # vault box, dry run
```

A dry run does every local step for real: the commit is on origin and descends from `--base`, a fresh
worktree, `pnpm install --frozen-lockfile`, `pnpm typecheck`, the build the box runs, the touched tests
(the whole suite here, because sensitive paths changed), and migrations forward from `ee14722` on a
throwaway PostgreSQL 17 (`/opt/homebrew/opt/postgresql@17/bin`, port 5417; `SHIP_PG_PORT` to move it).
It prints each thing it would do to production as `WOULD RUN`. Evidence is written to
`~/.rawprod/ship-evidence/<sha>/`.

**The dry run could not be completed by the release build**, because its first gate is that the commit
is on a branch of origin, and the release build cannot push RawProd. Its result on the unpushed head is
in section 9.

Then, to deploy: `infra/aws/ship.sh <sha> --apply`, and `infra/aws/ship.sh <sha> --role vault --apply`.

---

## 8. Rollback

**The application can go back. The database does not. And after this release the tooling will refuse
to put `ee14722` back.**

`infra/aws/ship.sh --rollback --apply` runs the box's own `deploy.sh --rollback`, which first asks
whether the previous commit can run against what the migration ledger says is applied. This release
adds eleven migrations to the main database and one to the Vault's that `ee14722` does not contain, so
that check answers no and `deploy.sh` exits 3 with "THIS IS NOT A ROLLBACK THAT IS SAFE TO DO"
(`infra/aws/deploy.sh` `compat_check`). Nothing in `ship.sh` or `deploy.sh` runs a down migration.

What is available after the deploy, in the order `deploy.sh` gives them:

1. **A forward fix.** Ship a new commit through `ship.sh`. The only path that loses no writes.
2. **A point-in-time restore** to just before the migration (RDS PITR on the Vault; the backup
   `ship.sh` takes before the deploy on the main box). Every write after that instant is gone. The
   owner's decision.
3. An application rollback to a commit the migrated schema can serve. After this release that is only
   this release itself or something later.

Before the migration step has run (a build that fails, a health check that fails before `db:migrate`),
`--rollback` works as usual.

What the schema would allow, if a person chose to run `ee14722` on the migrated database by hand:

- All twelve migrations are additive: new tables, new nullable columns, new sequences, new rules. One
  relaxes a column: `production.maceration_run.max_days` becomes nullable. `ee14722` reads and writes the
  tables it knows as before; a run opened by this release with no maximum holds a null `ee14722` does
  not expect.
- Rows written by this release stay: reservations made at planning, the oil ledger, mixer assignments,
  server-minted lot numbers, references, continuity keys, import jobs, purchase prices. `ee14722`
  ignores them. It does not draw the oil ledger down or honour a reservation made at planning, so stock
  figures written by the two versions would not agree for batches that straddle the change.
- The grants stay. `ee14722` has no route that asks for the new permissions, so they are inert.
- Facts already sent to Alembic are not unsent.

A full schema rollback is the twelve files in `scripts/migrations/rollback/`, newest first, each with
`psql -v ON_ERROR_STOP=1 -f`. They were run on scratch databases (section 9: down, then up, gives the
same schema as never having rolled back) and **they delete data**: the import history, the oil ledger,
the reveal log, the references, the continuity records. That is a decision for a person with a backup
in hand, not a deploy step.

---

## 9. How the merges were resolved, and what was proved

### Merge conflicts

| Merge | Conflicts | Resolution |
|---|---|---|
| `lane/ship-rp` | `web/sw.js` (the cache name) and seven tests that pin it | one name above every lane: `ra-shell-v144`. Each lane's history note is kept on the line |
| `lane/imports-rp` | the same eight, and `backend/api/src/floor/material-import.service.ts` | the service keeps both: the lane's `check` and `writeRow` split, and the rehearsal's STK-30 rule inside `check`, so the route and the bulk import both treat a material already on file as that material. The route lists it under `existing` and files a floor code when it has none; the bulk import calls the row a skip |
| `lane/promises-rp` | the same eight, and nine more | every one kept both sides. `token-permissions.test.ts`: the owner holds 329 permissions (310 + 4 promises + 5 stock + 8 imports + 2 purchase price), confirmed by the test. `produce-events.ts` and `shelf-task.service.ts`: the receipt carries the packs and the label, lot origin and promise block. Production `batch.service.ts`: the made mass (STK-10) and the continuity key (PROM-5). Packaging `batch.service.ts`: the filled-quantity check (STK-4) and the server-minted lot (PROM-4). `coa.service.ts`: both imports. `schema.sql`: both blocks, in migration order. `demo-seed.ts`: the unit from the stock lane, the server-assigned numbers from promises. `produce-shelf.test.ts`: both expectations |

### Proofs

All on this laptop, 14 Nov 2026, Node 22.22.2, a private PostgreSQL 17.11 with PostGIS 3.6.4 on
127.0.0.1:5463 (never the shared server), and for the walks the harness's own PostgreSQL on 5544.

| Proof | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` at `008f915` (the commits after it change walk specs only) | exit 0, no `error TS` (it was red on `ee14722` at `fonts-only-two.test.ts:92`) |
| Boundaries | `pnpm boundaries` | exit 0: 1,110 modules, 4,406 dependencies, no violation (two cycles on `ee14722`, fixed in `2be25ae`) |
| Whole suite | `pnpm test` on a fresh database, at `008f915` | exit 0: **4,957 tests, 4,957 passed, 0 failed, 0 skipped** (322 s). The first whole run, before `008f915`, was 4,943 of 4,957: the 14 are that commit |
| Every migration from empty | `pnpm db:migrate`, main shape (`SKIP_TARGETS=formula DB_APP_ROLE=...`) and vault shape (`SKIP_TARGETS=main`) | main: 56 blocks applied, ledger 56; vault: 10 and 10. A second run applies nothing in either |
| Each new migration down and up | the twelve `rollback/*.down.sql`, newest first, then `db:migrate` | each rollback exit 0 and its ledger rows gone (56 to 45 main, 10 to 9 vault); 11 + 1 blocks re-applied; `db:validate` exit 0. After `9cd3085`, down then up gives 4,584 columns, indexes, constraints and sequences **identical** to the database migrated forward from production (sorted `diff`, 0 lines) |
| Forward from production's schema | `ee14722`'s `db:migrate` and `db:seed`, then this branch's `db:migrate` | 11 blocks applied; ledger 45 to 56; tables 272 to 284; no ledger row lost, no seeded table with fewer rows, no table gone; second run applies nothing; `db:validate` exit 0. Columns (3,108), indexes, constraints and sequences (1,476) and the app role's 255 table privileges are identical to the from-empty database (sorted `diff`, 0 lines) |
| RBAC seed on top | this branch's `pnpm db:seed`, twice | 325 to 345 permissions, 1,127 to 1,189 grants, 21 roles; the second run changes no role, permission or grant |
| Grants after the seed | `stock-fix-rp-...`, `prom-2-...`, `prom-3-...`, `stage-2-rp-...-permission-grants.sql`, twice each | nothing changes on any of the eight runs |
| The deploy's real path | production's schema + `db:migrate` + **only** `stage-2-rp-2026-11-14-permission-grants.sql` (no seed) | 21 roles, 345 permissions, 1,189 grants: identical to a fresh seed of this branch. A second run changes nothing; the stock-fix file then adds nothing |
| Bridge, against Alembic's real parsers | RawProd's `buildFgBatchReceived` and `costFact` output, parsed by `packages/domain/src` at `origin/lane/stock-e2e-2`, `origin/lane/imports`, `origin/lane/prom` | section 1.2. The repository's own guards (`contract-guard-*.test.ts`, five files) pass in the whole suite; `contract-guard-alembic-mirror.test.ts` pins Alembic's lists by hand, and its pins for the six promise types and for `material.cost.recorded` match `lane/prom` and `lane/imports`, not `lane/stock-e2e-2` |
| The floor walks named for this release | `flow-raw-labels`, `stock2`, `floor-stations`, `imports` (factory and vault), `flow-finished-labels`, `stk38-mixer-screens`, at 1440 and 375 | all pass. `flow-finished-labels` stopped at the Packing station and two `stock2` padding checks failed at 375 before `5311b31` |
| The whole browser suite | `pnpm e2e:up`, then `playwright test -c e2e/playwright.config.ts`, fresh stack | exit 1: **278 walks, 260 passed, 18 failed** (7.4 min) at `2417e6e`. The 18 are nine walks at both widths, one cause ("Not done", item 2). The first whole run was 250 of 278; `7f78ab0` and the commit after it are the difference |

One correction to the record: the script that ran the migration proofs compared two schemas by a hash of
an unordered aggregate and reported two false differences (its exit code was 1 for that reason). Both
comparisons were redone as sorted `diff`s, which is what the table reports.

### Found while proving, and fixed

- The reveal's answer was being kept in `platform.idempotency_key`: the console sends an Idempotency-Key
  with every POST, so a re-send under the same key was answered from the stored copy with no check and
  no log line. The route is now `@NoStoredReply` (`4016650`).
- A rollback dropped an index an older migration owns (`9cd3085`).
- `pnpm boundaries` was red on `ee14722` (`2be25ae`).
- The form sheet dropped a textarea's given value (`5311b31`).

### Not done, or not green

1. **The ship tooling's dry run did not run.** `infra/aws/ship.sh d848c03b --base ee14722`
   was run on the commit before this note's last edit and stopped at its first gate, as designed, exit 1:
   `FATAL: commit d848c03b is on no branch of origin, so the box cannot fetch it. Push it first`. The
   release build cannot push RawProd, so gates (b) to (d) of the tool (its own install, typecheck, build,
   tests and migrations forward) have not run under the tool. Each was run by hand and is in the table
   above. After the push, run the two dry runs in section 7 before `--apply`. Evidence of the refusal:
   `~/.rawprod/ship-evidence/d848c03b9c5e25d0ef9fd97193dff27f7a9e07bb/20261113T202539Z-main-dry-run/ship.json`.
2. **Nine browser walks are red, at both widths** (18 of 278): `batch-coa`, `factory-defects:63`,
   `filling-packaging`, `finished-goods` (two), `mixing`, `production-qc-capa`, `sales-dispatch`,
   `traceability`. One cause: the walk harness (`e2e/harness/chain.ts` `releasedOil`,
   `releasedFinishedBatch`) and the `mixing` walk still drive the release as it was before the promises:
   a typed batch number, a typed QC pass, release with no rest. The server refuses the first step
   (`POST /v1/oil-batches -> 400 The batch number is assigned by the server: leave it out
   (fill.lot_server_assigned)`). They were red on `lane/promises-rp` itself; that lane did not touch the
   harness. Making them green means driving the promise process in the chain (a checkpoint set with a
   REFERENCE checkpoint, a QC 1 round, an early release asked by one person and approved by another, a
   retained sample, a QC 2 round) and having eight walks read the number the server assigned instead of
   one they typed. Not done: it is a rewrite of the chain, not a fix, and the screens these walks cover
   (finished goods, batch certificates, filling, dispatch, traceability) are therefore **not proved in a
   browser on this branch**. The services behind them pass in the unit suite; the screens are not walked.
3. **Neither Alembic lane named for this release accepts the six promise facts** (section 1.2). Not a
   defect on this side; a condition of deploying it.
4. Two answers that name a material are kept in an idempotency store, each for the person who made the
   request: the lot-label answer of `POST /v1/floor/lots/:id/barcode` (a role that may read names), and the
   Vault's allergen upload. Neither is the mixer's reveal (that one is now never stored). Not changed.
5. Open from the rehearsal and not in this release: STK-32 (a bulk lot needs a bill of packaging), STK-39
   (only an admin can sign a typed weight in the console), STK-41 (the product label is a preview).
6. The finished-goods label is corrected, not redesigned: real codes and the signed QR are a later unit.
