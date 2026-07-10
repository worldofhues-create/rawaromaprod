# Offline Console — Runbook (Step 3)

How to stand up the **factory (offline / air-gapped) console** as a second deployment of this same
codebase. The two consoles never share a database; only signed relay packages cross the gap (see
`TARGET_ARCHITECTURE.md` + `OFFLINE_TWO_CONSOLE.md`). Nothing here changes the current unified
deployment — the split only activates when `CONSOLE` is explicitly set.

## The two consoles at a glance

| | **online** (cloud/public) | **factory** (offline/air-gapped) |
|---|---|---|
| `CONSOLE` | `online` | `factory` |
| Owns | orders, sales, customers, sealed formula blobs | production, QC, inventory, dispatch, **the vault + unseal** |
| Login roles | owner, admin, sales, procurement | owner, admin, receiving, qc, warehouse, compounding, filling, packaging |
| Master key | `FORMULA_KEK` env (or none — serves ciphertext) | **`FORMULA_KEK_FILE`** on removable/encrypted media → `FileKmsAdapter` |
| Outbound email | Resend (if `RESEND_API_KEY`) | **none** — always LOGGED (air gap) |
| Internet | yes | no |

`CONSOLE` **unset** = the current single unified console: no role gate, normal email — unchanged.

## Stand up a factory console

1. **Database (its own, never the online one).** Point `DATABASE_URL` at the in-house Postgres and
   provision in one command:
   ```
   DATABASE_URL=postgres://…/factory  [FORMULA_DATABASE_URL=…]  pnpm db:provision
   ```
   `db:provision` runs `db:push` → all standalone CREATE scripts → RBAC seed → demo data, in order
   and idempotently (this is the reproducibility fix — a fresh console boots without hand-running DDL).

2. **Key ceremony (the physically-offline master key).**
   - To keep formulas sealed on the online console readable here, put the **same** 32-byte KEK the
     online console used into a file on removable/encrypted media:
     `printf '%s' "$FORMULA_KEK" > /media/keys/formula.kek && chmod 0400 /media/keys/formula.kek`
   - Or mint a fresh key for a console that is the sole sealer/unsealer of its own vault:
     `node scripts/formula-kek-keygen.cjs /media/keys/formula.kek`
   - Set `FORMULA_KEK_FILE=/media/keys/formula.kek`. The vault now binds `FileKmsAdapter`: the key is
     read **per operation** and never cached — mount the media only during unseal windows; unmounted =
     the vault fails closed (no plaintext recipe can be produced). Do **not** set `FORMULA_KEK`.

3. **Console + air gap.**
   - `CONSOLE=factory` — gates login to factory roles and forces **zero outbound email** (the notifier
     still records to `notification_log`; nothing is dispatched). For in-plant email, point a local SMTP
     relay at `EmailTransport` instead.
   - Leave `RESEND_API_KEY` **unset**. Serve the static `web/` portal same-origin behind local TLS
     (`infra/Caddyfile` is the seed); use a local CA. Custom IAM + the in-proc event bus already make
     the request/event path fully outbound-free.

4. **Relay (the only thing that crosses).** Set `RELAY_SIGNING_KEY` / `RELAY_VERIFY_KEY`
   (`node scripts/relay-keygen.cjs`) on each side, then carry packages by USB/diode:
   ```
   # factory: export production/QC/dispatch results
   RELAY_BASE=http://factory.local node scripts/relay-cli.cjs export offline-to-online out.json
   # online: import them (verifies signature + hash-chain, then materializes the rows)
   RELAY_BASE=https://…onrender.com node scripts/relay-cli.cjs import out.json
   ```
   Only allow-listed events cross; `formula.*` (recipe/vault) never does.

## The online console

Same image, `CONSOLE=online`: login gated to online roles, keeps `FORMULA_KEK` (or no key at all — it
only ever serves ciphertext, never unseals). It imports factory results and exports orders + masters.

## Notes / current limits

- `CONSOLE` unset today (unified) → **the running production deployment is unaffected** by all of the above.
- Relay export/import over HTTP requires the `RELAY_*` keys set (like `FORMULA_KEK`); logic is verified.
- Owner + admin are cross-console governance (allowed on both) by design.
