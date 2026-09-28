# Console sign-in hand-off (`?open=`)

Each RawProd console's **Sign in via ALEMBIC** link opens ALEMBIC's admin console with the console named in the query string:

```
<ALEMBIC_CONSOLE_URL>?open=factory    (rawfactory)
<ALEMBIC_CONSOLE_URL>?open=platform   (rawplatform)
<ALEMBIC_CONSOLE_URL>?open=vault      (rawvault, also the Vault's "confirm a new code" step-up)
```

`ALEMBIC_CONSOLE_URL` comes from each deployment's `console-config.js` / `vault-config.js` (`infra/aws/nginx/static-config/`). For production it is `https://rawadmin.huecycle.in/admin`. The consoles add `open` to it with `URL.searchParams`, so they don't depend on the URL's exact shape.

**ALEMBIC's side.** When `open` is `factory`, `platform` or `vault`, and the person is signed in (straight away, or after they sign in on that page), ALEMBIC runs the same assertion hand-off as its **Open Factory / Open Platform / Open Vault** button, in the same tab. That means the same eligibility check, the same fresh step-up for `vault`, and the same redirect to the console with `#assertion=<token>` in the fragment. ALEMBIC ignores any other value, removes `open` from its own URL once it has acted on it, and never acts on it for a signed-out visitor.

**RawProd's side.** RawProd changes nothing about the assertion. The console consumes `#assertion=` exactly as it does today (`POST /auth/alembic-assertion` through the tunnel), and the sign-in is recorded in `iam.login_history`.

**After sign-in:**
- **Factory and Platform** keep the session across reloads. The refresh token is held in the tunnel's HttpOnly `__Secure-rawprod_rt` cookie (`Path=/rpc`, `SameSite=Strict`, used only for same-origin requests; see `backend/api/src/crypto/session-cookie.ts`). Page script never sees it.
- **The Vault** keeps no session across a reload. By design (§109.4), a reload means a new ALEMBIC step-up, which `?open=vault` brings straight back to the Vault.
