# Pick-to-light — device-agnostic command contract (v1)

Owner decision 2026-09-29: the shelves get alerts and counters three ways — the big-type **Shelf
display** (Factory → Shelf display, `#shelf=<zone>` opens it in TV mode), **printed put-away / pick
sheets** in rack walking order (A4 and 80 mm thermal, each line with its task QR), and
**pick-to-light hardware** through a device-agnostic adapter. ALEMBIC builds the generic
`pick_light` connector; RawProd's Factory side emits the same shape, documented here, to a
controller URL configured in the app (Platform → Pick-to-light), with a built-in simulator.

## When a light changes

| Moment | Command |
|---|---|
| A put-away task is given a bin (assigned, or re-assigned) | `colour: "blue"`, `qty` = units to put away |
| A pick task is created (FIFO allocation) | `colour: "green"`, `qty` = units to pick |
| The task is confirmed at the shelf, or cancelled | `colour: "off"`, `qty: 0` (same `task_id`, same bin) |
| "Send test light" in settings | `colour: "white"`, `qty: 1`, `task_id` = the zero task |

A put-away confirmed on a different bin than the one lit turns the lit bin off as well.

## Wire

```
POST <controller URL>                       (https; the SSRF guard of the bridge webhook applies)
Content-Type: application/json
X-PickLight-Signature: sha256=<hex HMAC-SHA256 of the RAW body, keyed by the shared secret>
X-PickLight-Task-Id: <task_id>

{"task_id":"<uuid>","rack":"R01","shelf":"R01-S2","bin":"R01-S2-B3","qty":4,"colour":"blue"}
```

Exactly six fields: `task_id` (uuid), `rack`, `shelf` (or null), `bin` (or null), `qty` (number),
`colour` (`blue` | `green` | `amber` | `white` | `off`). No product, batch, customer or formula
data goes to a controller. The signature is over the exact bytes sent (as the ALEMBIC bridge).

A controller answers 2xx when the light is set. Anything else is retried on backoff (2 s doubling,
capped at 5 min) and parked after 12 attempts (visible as "parked" in Platform → Pick-to-light and
Platform → ALEMBIC bridge). Commands are queued in the same transaction as the task they belong to
(`location.pick_light_command`) and delivered by the worker, in order.

## Modes (in-app, no `.env`, no redeploy)

| Mode | What happens |
|---|---|
| `off` | Commands are recorded and marked SKIPPED; nothing leaves the box. |
| `simulator` | Commands are signed (the configured secret, or the fixed simulator key) and verified exactly as a controller must, then applied to `location.pick_light_sim_state`; the Shelf display shows the lit bins in their colours. |
| `http` | Commands are POSTed to the controller URL. Needs the URL and a shared secret (≥ 16 characters); the secret is sealed at rest (AES-256-GCM under `BRIDGE_HMAC_KEK`, its own AAD) and never shown again. |

The hardware itself (which pick-to-light system, how it is wired, and how the factory network lets
the RawProd server reach it — a gateway or tunnel with an https endpoint) is the owner's device
choice; any controller that accepts this shape works, and the simulator proves the flow until then.

Code: `backend/api/src/shelf/pick-light.service.ts`; tests: `backend/api/src/__tests__/produce-shelf.test.ts`.
