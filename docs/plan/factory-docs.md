# FACTORY-DOCS — resume note (round 2, 2026-11-15)

**State:** branch `fd/factory-docs`, worktree `/Users/apple/Downloads/rawprod-lanes/factory-docs`. Round 1
(`eb0c5c3`, pushed by the lead) built `qc.gcms.attached` and the ALEMBIC-parser checks. Round 2 commit (this
note's commit) does lead items 1 and 2. Items 3, 4 and 5 are NOT done: the context budget stopped here.

## Green (with evidence in the round-2 commit message)
1. **Body limit (item 1).** The GC-MS PDF no longer rides `/rpc`. It is the raw body of
   `POST /v1/batch-coas/:id/gcms` (application/pdf, details in the query, bearer token). An `onRequest`
   hook verifies the token with `JwtService.verifyAccess` before the body is read (401 otherwise); only that
   route has a larger limit (8 MiB); `/rpc` and everything else are back on Fastify's 1 MiB.
   The console uploads with `uploadFile` (web/shell.js), not the tunnel. SW cache v146.
2. **Ran what round 1 did not (item 2).** Full stack via `node e2e/harness/up.mjs` (ports 3600-3602/4600/4601,
   private pg 5600, dbs fdocs_main/fdocs_vault, migrations incl. 2026-11-27 applied): a released batch made
   by `e2e/harness/chain.ts` (`releasedOil`, `releasedCoa`); QC uploaded 5 MB -> 201 and one outbox row with
   no `file` key; same file -> no second row; 6 MB -> 400 "That file is 6.0 MB. A GC-MS report can be at most
   5 MB; ask the lab for a smaller PDF."; not a PDF -> 400; unauthenticated -> 401 before the body;
   `sales` -> 403; the public file route answers 404 to a bad link. Infra tests 82/82 after the render-env
   revert. Vault DB-backed calculation: `cluster-formula/src/__tests__/compliance-vault.test.ts` +
   `compliance-calc.test.ts` 20/20 on a fresh formula-schema database.

## Left, worst first
1. **Item 4: `BRIDGE_FILE_BASE_URL` on the box.** Own commit: add
   `BRIDGE_FILE_BASE_URL=https://rawfactory.huecycle.in` to the api.env heredoc in
   `infra/aws/env/render-env.sh` AND add `'BRIDGE_FILE_BASE_URL'` to the `rawprodApi` list in
   `backend/api/src/__tests__/infra-live-capture.test.ts` (around line 110) plus the captured live env it
   compares with; message: must ship with the deploy that sets it. nginx: `infra/aws/nginx/huecycle-hosts.conf`
   rawfactory server has `location ~ ^/(rpc|crypto/|v1/|auth/|health$) { proxy_pass http://rawprod_api_cf; }`,
   so `/v1/bridge/files/gcms/:id` IS proxied today (read, not exercised); confirm no per-path auth/limit there
   and write that under a lead heading in docs/bridge/COMPLIANCE_FACTS.md.
2. **Item 3: the screen in a browser** (Playwright, `--workers 1`, the e2e stack above): batch certificates
   screen, "Attach GC-MS" on a RELEASED row, not on REJECTED, not for a role without
   `production:batch_coa:write`; form fields; non-PDF / over-size messages; the result listed. Note: the
   screen does not yet LIST attached reports on the row (only the API `GET /v1/batch-coas/:id/gcms`); the
   lead asked for "the result listed against the batch", so a small list in the action's sheet is needed.
3. **Item 5 (answer from code, not production):** nothing in the release step blocks a QC person; release
   needs a batch COA, which needs an oil batch, which needs a production order. With 0 orders and 0 batches
   on production there is nothing to release yet: "nobody has made a batch", not "they cannot release".
4. `/rpc` over 1 MiB answers **500 INTERNAL_ERROR** (AllExceptionsFilter wraps Fastify's
   FST_ERR_CTP_BODY_TOO_LARGE) rather than 413. Refused either way; pre-existing; mapping a FastifyError's
   4xx `statusCode` in the filter is a one-line fix but touches every route's error path.

## Rules carried
No sub-agents, no `git stash`, no pkill, no production access, ports 3600/4600, dbs `fdocs_*` dropped at the end,
commit locally, the lead pushes.
