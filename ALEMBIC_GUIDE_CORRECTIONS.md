# Corrections to release/ui/PORTING_GUIDE.md + COMPONENT_PARITY_MATRIX.json

Lane U6 (RawProd UI shell). For P0 to apply to the guide/matrix directly — this worktree only
touches `web/`, `web-platform/`, `web-vault/` presentation code, not ALEMBIC or the release docs.

## The error

Both documents' "Nav rail / sidebar" + "Topbar" entries read (and RawProd's three consoles were
built against) a **permanently visible left rail + topbar** shell — i.e. `.rail` always on screen
as a grid column, `.bar` beside it. That is not what ALEMBIC's admin/agent/rac-app consoles
actually render. The rail is **collapsed by default at every width** (1440/1024/768/375 alike);
what is actually always on screen is a **top bar + a floating/docked bottom command dock**, and
the dock — not the rail — is the default way a signed-in user navigates. See:

- `release/ui/reference/admin-shell-*.png` (all four widths)
- `release/ui/evidence/alembic-{admin,agent,content-studio}/*.png`

No visible rail appears in any of those, at any width, on first paint.

## The ALEMBIC source, cited

- `apps/web/lib/console/admin-console.jsx:932` — `const [rail, setRail] = useState(false);   //
  collapsed by default`. Same in `apps/web/lib/console/agent-console.jsx:5116`.
- `apps/web/lib/console/admin-console.jsx:985-989` — the effect that mirrors `rail` onto
  `document.body`: `document.body.classList.toggle('rail-off', !mobile && !rail);
  document.body.classList.toggle('rail-open', mobile && rail);`. `rail-off` is therefore the
  **default class at every desktop/tablet width** (>=1024), because `rail` starts `false`.
- `apps/web/lib/console/rac-console.jsx:18-51` — `useRailToggle()`: desktop collapses the rail IN
  PLACE (`rail-off`); below 1024 it becomes an off-canvas drawer (`rail-open`). Same file,
  `function QuickDock(...)` at line 559, is the dock component both consoles render.
- `apps/web/lib/console/admin-console.jsx:1215-1300` — the actual JSX: `<nav className="rail" ...
  inert={rail?undefined:''} aria-hidden={rail?undefined:'true'}>`, then `<div className="main">` >
  `<div className="bar">` (brand + `h1` + toolbar), then `<QuickDock items={dock} ... railOpen=
  {rail} onRail={setRail} .../>` — the dock is a sibling of `.main`, not inside the rail.
- `apps/web/app/console.css:422-540` — "THE SHELL GRID HAS TWO TRACKS", `body.rail-off .app{grid-
  template-columns:0 1fr !important}`, `body.rail-off .rail{width:0 !important; ... visibility:
  hidden; pointer-events:none}`, `body.rail-off .qdock{display:flex !important}`. The header
  comment on this block states the measured DOM at 1024/1440/1920 with a **real** staff session
  (not `ALEMBIC_DEV_AUTH`): `.rail` is `0` wide at every one of those three widths.
- `apps/web/app/console.css:230-285` — `.qdock` (floating pill, `position:fixed;bottom:18px`),
  `.qb` (40x40 icon buttons), phone-only chrome (`.dk-lab` labels) gated to `max-width:1023px`.
- `apps/web/app/console.css:780-830` — `@media (max-width:1023px){ .app{grid-template-columns:
  minmax(0,1fr)!important} .rail{position:fixed;...} }` — "tablet and below → a five-segment tab
  bar, and the rail as a sheet". This is the SAME regime at 768 and 375 (verified against
  `release/ui/evidence/alembic-admin/{768,375}-shell.png` — both show a full-width bottom tab bar
  with labels: Sections / Dashboard / Orders / Products / Review, not a rail).

## What to change in the two documents

1. **PORTING_GUIDE.md §Shell**: replace "rail + topbar" as the literal target shape with: "top bar
   (`.bar`) + a bottom command dock (`.qdock`), rail off-canvas and CLOSED by default at every
   width; the dock — not the rail — is what a first paint shows for navigation. The rail exists
   and carries the complete, grouped nav (with counts/sub-panes where applicable) but is reached
   by opening it, never shown unprompted." Cite `admin-console.jsx:932` and `console.css:422-540`
   for "collapsed by default", and `console.css:780-830` for the <1024 tab-bar regime.
2. **COMPONENT_PARITY_MATRIX.json** "Nav rail / sidebar": note it renders CLOSED by default; add a
   new row "Quick-access dock (`.qdock`/`.qb`)" as the actual default navigation surface at every
   width, with the phone variant (`DOCK_HOT`, labelled tab bar) called out separately from the
   >=1024 compact icon-pill variant.
3. Workspace switcher: ALEMBIC has no directly-cited multi-tenant/multi-role switcher chrome in
   the consoles audited here (each of admin/agent/rac-app is a single role) — RawProd's `.wsw`
   `<select>` in the topbar is a bespoke composition from ALEMBIC primitives, not a port of a named
   ALEMBIC control. Suggest the matrix say so explicitly instead of implying a source location.

## What this lane did in `web/`, `web-platform/`, `web-vault/`

Rebuilt all three shells (`web/shell.js` + `web/ui-contract/shell.css`, `web-platform/platform.js`
+ `.css`, `web-vault/vault.js` + `.css`) to the corrected structure: `.rail` is now `position:
fixed`, off-canvas, closed by default at every width (`body`/`.rail`'s own `.open`/`rail-open`
class opens it); a new `.qdock` floating pill (>=1024) / full-width tab bar (<1024, labelled "hot"
segments only + a "Sections" opener) carries the same nav set the rail does, via the same
`data-nav` click wiring already in `wireShell()`. Views, permissions and routes are unchanged —
only the chrome that reaches them moved. Verified visually at 1440/1024/768/375 against ALEMBIC's
own reference/evidence PNGs; see this lane's report for the screenshot comparison.

## Unrelated, larger bug found and fixed in the same pass

`web/shell.js` and `web/ws-mfg.js` both declared a **top-level global `function openSheet(...)`**.
These are plain classic `<script>` tags sharing one global scope (no module, no IIFE — see
`web/index.html`'s own load-order comment), so `ws-mfg.js`'s later declaration (3 positional args:
`title, bodyHtml, maxWidth`) silently overwrote `shell.js`'s (1 object arg: `{id,tag,style,cls,
title,body}`) for the whole app, on every load. Every one of `shell.js`'s own `openSheet({...})`
call sites — `raConfirm`, `openEdit`, `openCreate` (this is what broke "Bins → + New": title
"[object Object]", body "undefined"), `openCreateDoc`, `openTrace` — was affected, not only Bins.
Fixed by renaming `ws-mfg.js`'s function to `openMfgSheet` and updating its 3 internal call sites;
`CREATE['/v1/bins']` and every other CREATE/EDIT/CREATE_DOC map entry in `shell.js` were already
correct (verified by evaluating all 66+43+3 entries programmatically — none had a non-string
`.title`), so no data/config changes were needed, only the name collision.
