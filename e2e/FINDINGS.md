# Browser suite findings

Found by walking the consoles on the real stack. Fixed ones name their commit message; open ones need the
owner, because each is a role grant or a product decision rather than a defect with one right answer.

| ID | Status | What |
|---|---|---|
| F1 | FIXED | Number inputs in the create, edit and document forms had no `step`, so the browser refused any decimal (a QC reading of 1.47, a 2.5 kg line, a rate of 118.75) with no message from the app. |
| F2 | OPEN | "New production order" needs a formula version, its list reads `/v1/formula-versions`, and that route lives only on the Vault API since the isolation. The required list is always empty, so the form can never be submitted. Orders are raised by Produce next -> Plan run, which works. |
| F3 | OPEN | Receiving, Packaging and Compounding hold no `platform:uom_master:read`, so the Unit list on their forms (GRN, package order, oil batch) is empty. The server accepts the row with no unit. Not widened here: RBAC changes need the owner. |
| F4 | OPEN | Warehouse's rail has Stock counts but the role holds neither `inventory:stock_audit:read` nor `:write` (the screen says not part of your role); only Owner does, and Owner's rail has no such screen. No person can raise or read a count from a screen. |
| F5 | FIXED | "New finished-goods batch" did not ask for the manufacturing date, and a label refuses a batch without one. Every batch made on this form could never be labelled, and no screen could add the date. |
| F6 | OPEN | Factory's Organizations form writes `iam.organizations`; Platform's Organizations lists `iam.org_master`. A company added on the form never appears on Platform. Which table is right is the owner's call. |
| F7 | OPEN | Feature switches: a fresh system has no switch registered, and no screen registers one, so the Change flow cannot be walked. Matches production (`flag_states` 0). |
