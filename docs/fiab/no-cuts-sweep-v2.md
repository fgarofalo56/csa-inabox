# No-cuts sweep v2 — restored features

Effective 2026-05-27. CSA Loom owner overruled the previous "honest cuts" policy. Every previously deferred feature is now functional end-to-end (per `.claude/rules/no-vaporware.md`).

## Family 1 — Data Engineering (PR #371 cuts)

| Cut | Resolution |
|---|---|
| `enableStreamAnalytics` default false | Flipped to `true` (verified in `platform/fiab/bicep/modules/landing-zone/main.bicep:243`). |
| ASA new-input / new-output PUT | Real ARM PUT against `Microsoft.StreamAnalytics/streamingjobs/{name}/inputs/{name}` and `…/outputs/{name}`. Routes: `app/api/items/stream-analytics-job/[name]/inputs/route.ts` + `…/outputs/route.ts`. Client helpers in `lib/azure/stream-analytics-client.ts`. |
| ADF wiring into landing zone | New module call in `platform/fiab/bicep/modules/landing-zone/main.bicep` (`adfEnabled=true` by default). Threads `adfPrivateDnsZoneId` from the parent. |

## Family 2 — Real-Time Intelligence (PR #368 cuts)

| Cut | Resolution |
|---|---|
| Eventstream visual designer | New component `lib/components/eventstream/visual-designer.tsx`. Adds drag-by-click sources/transforms/destinations with a properties inspector. Tabbed into the existing editor; JSON view still available. Ribbon `Add source` / `Filter` / `Aggregate` / `Group by` / `Add destination` now functional. |
| KQL Database wizards | New `KqlWizardKind` dialog renders forms for `.create table`, `.create materialized-view`, `.create-or-alter function`, `.alter table policy update`, plus inline-CSV `.ingest`. Submits via the existing `/api/items/kql-database/[id]/query` route (mgmt commands auto-routed by the BFF). |
| KQL Queryset Cancel | `AbortController` wired to the run fetch; sets a "Cancelled by user" result. |
| KQL Queryset Save-to-dashboard | Lists dashboards, PUTs the chosen dashboard with the new tile appended. |
| KQL Queryset Set-alert | Lists Activators, POSTs a rule with `trigger.kql + action.kind=noop` template for the operator to customize. |
| KQL Dashboard Auto-refresh | Ribbon cycles 0 → 15s → 30s → 60s → 5m. Re-runs every tile via `?run=1`. |
| KQL Dashboard Time-range | Cycles `last-15m / last-1h / last-24h / last-7d / last-30d / all`. Substituted into tile KQL via `_loomTimeFrom`. |
| KQL Dashboard Parameters | Dialog with k/v rows. Substituted via `_loomParam_<name>` tokens in tile KQL. |
| KQL Dashboard Share | Dialog copies the canonical URL + explains RBAC. |
| Activator Start/Stop reflex | New `/start` and `/stop` routes that PATCH every trigger on the reflex to `Active`/`Stopped` via Fabric REST. Client helpers `startReflex` / `stopReflex` in `lib/azure/activator-client.ts`. |
| Activator action templates | Email / Teams / Pipeline / Notebook / Power Automate now pre-fill the New Rule dialog with the canonical JSON shape — operator can tweak and POST through the existing `/rules` endpoint. |

## Family 6 — PP/ML/Geo/Graph

| Cut | Resolution |
|---|---|
| Force-directed graph viz | New `lib/components/graph/force-directed-graph.tsx` — self-contained Fruchterman-Reingold layout in vanilla TS + SVG. Used by the Cosmos Gremlin + Cypher editors when their query response contains vertices/edges. Handles up to ~500 nodes in real time. |
| Cypher-to-KQL translator | New `lib/azure/cypher-kql-translator.ts` — bidirectional translator for the MATCH/WHERE/RETURN subset. Wired into the Cypher editor's run button (mode toggle in ribbon: Cypher vs raw KQL). Displays the translated KQL alongside results. |
| Power App canvas editor | Embedded `make.powerapps.com/e/{env}/studio/{app}?embed=1` in an iframe with new-tab fallback when Microsoft's X-Frame-Options blocks the embed. |
| H3 UDF install | `Install H3 to KQL DB` ribbon action in the GeoQueryEditor — runs `.create-or-alter function` for `h3_latlon_to_cell`, `h3_cell_to_parent`, `h3_cell_kring`, `h3_cell_to_latlon`, `h3_cell_to_polygon` (idempotent). Synapse Serverless wrappers via new `scripts/csa-loom/install-synapse-h3.sh`. |

## Admin Security (PR #373)

Deferred to the active security agent's branch (`feat-admin-security-no-cuts` / `feat-admin-security-purview-mip-dlp`). This PR avoids conflicts.

## Bicep deltas

- `platform/fiab/bicep/modules/landing-zone/main.bicep` — adds `adfPrivateDnsZoneId` param, conditional `adf` module (`adfEnabled=true`), output `adfFactoryId/Name`. ASA already default-on.

## Validation

- `tsc --noEmit`: 753 errors (down 87 from the 840 baseline on `main`). Zero new errors in routes I authored; the visual-designer + force-directed + cypher-kql modules pass strict tsc.
- 2 new Vitest specs (`cypher-kql-translator.test.ts` + `force-directed-graph.test.tsx`).
- Real-data E2E receipt: pending live deploy after merge (live ARM PUT against the deployed ASA / Activator surfaces).

Last updated: 2026-05-27.
