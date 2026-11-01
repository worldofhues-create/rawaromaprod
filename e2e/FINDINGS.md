# Browser suite findings

Found by walking the consoles on the real stack. Fixed ones name their commit message; open ones need the
owner, because each is a role grant or a product decision rather than a defect with one right answer.

| ID | Status | What |
|---|---|---|
| F1 | FIXED | Number inputs in the create, edit and document forms had no `step`, so the browser refused any decimal (a QC reading of 1.47, a 2.5 kg line, a rate of 118.75) with no message from the app. |
| F2 | FIXED | "New production order" needs a formula version, its list reads `/v1/formula-versions`, and that route lives only on the Vault API since the isolation. The required list is always empty, so the form can never be submitted. Orders are raised by Produce next -> Plan run, which works. |
| F3 | FIXED | Receiving, Packaging and Compounding hold no `platform:uom_master:read`, so the Unit list on their forms (GRN, package order, oil batch) is empty. The server accepts the row with no unit. Not widened here: RBAC changes need the owner. |
| F4 | FIXED | Warehouse's rail has Stock counts but the role holds neither `inventory:stock_audit:read` nor `:write` (the screen says not part of your role); only Owner does, and Owner's rail has no such screen. No person can raise or read a count from a screen. |
| F5 | FIXED | "New finished-goods batch" did not ask for the manufacturing date, and a label refuses a batch without one. Every batch made on this form could never be labelled, and no screen could add the date. |
| F6 | FIXED | Factory's Organizations form writes `iam.organizations`; Platform's Organizations lists `iam.org_master`. A company added on the form never appears on Platform. Which table is right is the owner's call. |
| F7 | NOT A BUG | Feature switches: a fresh system has no switch registered, and no screen registers one, so the Change flow cannot be walked. Matches production (`flag_states` 0). |
| F8 | OPEN | No console screen posts `/v1/material-issues`; the floor can read an issue but not make one. |
| F9 | OPEN | Corrective actions is a read-only list: raise, start, close and verify have routes but no buttons. |
| F10 | OPEN | The Product form and Link formula still read `/v1/formulas` on the main box, the same dead route as F2. |
| F11 | OPEN | The document letterhead still reads `/v1/organizations` (left alone to keep the address fields). |
| F12 | OPEN | Production holds no `platform:uom_master:read` either, so the Unit list on New production order is empty. Not in the decision that granted F3. |
| F13 | FIXED | `PUT /v1/admin/flags/:key` ran its schema over the key as well as the body, so every feature switch change answered 422. Nobody had ever pressed it (production `flag_states` 0). |
