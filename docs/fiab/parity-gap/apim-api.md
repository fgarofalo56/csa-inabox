# Parity gap — `apim-api`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure portal → API Management service → APIs → API → Settings + Design + Test.
> Loom route: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/apim-api/new`.
> Editor source: `apps/fiab-console/lib/editors/apim-editors.tsx` (lines 112-293).

## Phase 3 — gap matrix vs Azure portal APIM API blade

| # | Azure portal APIM element | Loom present? | Severity |
|---|---|---|---|
| 1 | Settings form (display name / path / protocols / service URL / subscription required) | Present (lines 254-274) — real fields with proper validation, save via PUT | OK |
| 2 | Protocols multi-toggle (https / http / ws / wss) | Present (lines 267-273) — switch per protocol | OK |
| 3 | Operations list (tree of GET / POST / PUT / DELETE + URL template + display name) | Present (lines 208-234) — real `/operations` fetch, rendered in Tree | OK |
| 4 | Operation editor (click an operation → request / response / parameters / policy tabs) | **MISSING** — operations are read-only leaves in the tree, no onClick handler on Operation items | MAJOR |
| 5 | OpenAPI spec viewer with syntax highlighting + Monaco JSON | Read-only `<div>` with `white-space: pre` (lines 284-288). No Monaco, no JSON folding, no syntax highlighting. | MAJOR |
| 6 | Import API (from OpenAPI URL / WSDL / GraphQL / WebSocket / Function App) | MISSING | MAJOR |
| 7 | Test console (invoke an operation with parameters + Authorization header) | MISSING — Azure portal has a built-in test client | MAJOR |
| 8 | Revisions + Versions | MISSING | MAJOR |
| 9 | Inline API policy editor | MISSING — separate `apim-policy` editor handles it | OK (split is reasonable) |
| 10 | Frontend (HTTP) and Backend tabs | MISSING — Loom has serviceUrl input only | MAJOR |
| 11 | Tags / Products / Subscriptions cross-refs | MISSING | MAJOR |
| 12 | Settings: subscriptionRequired + approvalRequired + headerName + queryName | Partial — only `subscriptionRequired` toggle. No approvalRequired or header/query name. | MAJOR |
| 13 | Save / Reload buttons | Present (lines 242-247) | OK |
| 14 | Copy spec button | Present (line 279) — real `navigator.clipboard.writeText` | OK |
| 15 | Status bar | MISSING | MINOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| **Save** | `save()` (line 173-193) — real `PUT /api/items/apim-api/{id}` with all fields | Real |
| **Reload** | Triggers `load + loadOps + loadSpec` | Real |
| **Copy** spec | `navigator.clipboard.writeText(spec.data.value)` (line 199-201) | Real |
| Refresh spec | `loadSpec` (line 158-169) | Real |
| Operations tree leaf | No `onClick` — dead | **DEAD** (per gap row 4) |
| Protocol switches | `toggleProtocol(p)` (line 195-197) | Real |
| `subscriptionRequired` switch | `setSubscriptionRequired(...)` | Real |
| Ribbon "Save" / "Reload" / "Edit OpenAPI" / "Copy spec" / "Open policy editor" | No handlers | **DEAD** — 5 ribbon vapor (Save / Reload / Copy duplicated as top-bar buttons that ARE real) |

## Grade

**C** — Settings form (the headline of this surface) is real-REST and persists correctly via PUT. Operations list is real. OpenAPI spec export is real.

But operations are read-only leaves (BLOCKER for a real API editor — you can't edit an operation's params / responses / policies), no test console, no import flows, no revisions, no Backend tab. The OpenAPI viewer is just a `<div>` with monospace text — no Monaco, no folding.

For a "view an existing API and tweak its top-level settings" use case, this is a B. For "manage the lifecycle of an API end-to-end" (which is what APIM is for), it's a C at best.

