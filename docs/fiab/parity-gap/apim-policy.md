# Parity gap — `apim-policy`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure portal → API Management service → APIs/Products → Policies (XML editor) — or the rich Form-based policy editor in the latest Azure portal.
> Loom route: `https://<your-console-hostname>/items/apim-policy/new`.
> Editor source: `apps/fiab-console/lib/editors/apim-editors.tsx` (lines 447-566).

## Phase 3 — gap matrix vs Azure portal APIM Policy editor

| # | Azure portal Policy editor element | Loom present? | Severity |
|---|---|---|---|
| 1 | XML editor with Monaco + APIM-policy XSD schema validation + autocomplete for `<inbound>` / `<outbound>` / `<on-error>` / `<backend>` / `<validate-jwt>` / `<rate-limit>` / `<cors>` / `<set-header>` / `<set-body>` / `<choose>` / `<find-and-replace>` etc. + error squiggles | **MISSING** — plain `<textarea>` (lines 556-562). Only client-side check is `DOMParser.parseFromString(xml, 'application/xml')` for well-formedness (lines 435-445). No XSD validation, no schema, no completion, no error squiggles. | **BLOCKER** |
| 2 | Form-based view (drag-and-drop policy snippets, parameter forms) | MISSING — Azure portal has Form view alongside Code view | MAJOR |
| 3 | Scope selector (Global / API / Product / Operation) | Present — 4 scopes (lines 519-524). v3.27 added `operation` scope — covered. | OK |
| 4 | API ID + Operation ID + Product ID inputs surfaced per scope | Present (lines 526-540) — correct conditional rendering | OK |
| 5 | Save button | Present (line 541-543) — real PUT with well-formed XML check first | OK |
| 6 | Reload | Present (line 544) | OK |
| 7 | Validate XML ribbon action | Ribbon vapor (line 424) but Save calls `isWellFormedXml` (line 489) so validation IS run on save — just not on demand | MINOR |
| 8 | Default policy template (`<policies><inbound>...<outbound>...`) on new policy | Present (line 432-433) — sensible default with commented-out `validate-jwt` + `rate-limit` examples | OK |
| 9 | Status bar | MISSING | MINOR |
| 10 | Policy expression `@(...)` autocomplete and runtime test | MISSING | MAJOR |
| 11 | Trace inbound / outbound for testing | MISSING (lives on the apim-api Test console which Loom doesn't have) | MAJOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| Scope dropdown | `setScopeKind` (lines 515-525) — triggers `useEffect` to load policy for that scope (lines 479-486) | Real |
| API ID input | `setApiId` local state | Real |
| Operation ID input | `setOperationId` local state | Real |
| Product ID input | `setProductId` local state | Real |
| **Save policy** | `save()` (line 488-507) — validates XML well-formedness then `PUT /api/items/apim-policy/{id}` with `{scope, apiId, productId, operationId, value}` | Real |
| **Reload** | `load()` (line 465-477) | Real |
| Ribbon "Save" / "Reload" / "Validate XML" / "Global" / "API" / "Product" / "Operation" | No handlers; scope selector replicates the scope-switch part. Save / Reload have working top-bar duplicates. | DEAD ribbon (7) |

## Grade

**C** — scope routing is the strongest part (4 scopes including the v3.27 operation scope addition, correct conditional inputs, real PUT). XML well-formedness check on save is good defensive coding.

But the policy editor is a `<textarea>` (BLOCKER per Monaco contract — XML policies are literally what Monaco's `xml` language mode + custom XSD schema validation was designed for), no form view, no expression autocomplete, no trace / test, 7 dead ribbon buttons.

For "I know the policy XML I want to paste in" use case, this is a B. For "I want to compose an APIM policy from scratch with help" (the actual job of a policy editor), it's a C.

Remediation: `@monaco-editor/react language="xml"`, load the APIM policy XSD from `https://raw.githubusercontent.com/Azure/api-management-policy-snippets/master/...` (or vendor it into the repo), wire `monaco.languages.registerCompletionItemProvider('xml', ...)` with the standard APIM policy element list (inbound / outbound / on-error / backend / validate-jwt / rate-limit / cors / set-header / etc.).

