# govern-admin — parity with the Microsoft Purview / Fabric admin "Govern" monitoring view

Source UI: Microsoft Purview Unified Catalog → Health management / Reporting, and the
Microsoft Fabric admin monitoring "Govern" surface.
Learn: https://learn.microsoft.com/purview/unified-catalog · https://learn.microsoft.com/purview/data-estate-health

Loom route: `/governance/govern?view=admin` (tenant-admin gated, F2).

## Azure/Fabric feature inventory

| # | Capability (source UI) | What it does |
|---|------------------------|--------------|
| 1 | Sub-tab: Manage estate | Inventory of the data estate — workspaces, items, capacities, domains — plus feature/usage telemetry. |
| 2 | Sub-tab: Protect, secure, comply | Sensitivity-label (IP) coverage %, DLP violations + last scan, scan freshness; trigger a scan. |
| 3 | Sub-tab: Discover, trust, reuse | Freshness, description completeness, endorsement coverage, sharing/reuse signals; recommended actions. |
| 4 | Copilot over the report | Natural-language Q&A grounded on the on-screen chart data. |
| 5 | "View more" → full report | Drill into the full Power BI report / dashboard behind the summary tiles. |
| 6 | Recommended actions | Prioritised remediation cards generated from the posture. |

## Loom coverage

| Inventory row | Status | Loom surface |
|---|---|---|
| 1 Manage estate | ✅ built | `ManageEstateTab` — workspace/item/capacity/domain tiles (Cosmos) + Log Analytics KQL feature-usage table. |
| 2 Protect, secure, comply | ✅ built (⚠️ honest-gate per source) | `ProtectSecureComplyTab` — MIP coverage % (Graph), DLP violations + last violation (Graph), Purview last-scan (Purview), real **trigger-scan** control. Each source honest-gates when unprovisioned. |
| 3 Discover, trust, reuse | ✅ built | `DiscoverTrustReuseTab` — freshness/description/endorsement % (Cosmos) + 30-day sharing (Audit) + recommended-action cards (Cosmos). |
| 4 Copilot | ✅ built (⚠️ honest-gate) | `PostureCopilotBar` — streams Azure OpenAI GPT-4o, posture JSON injected as grounding. Gates when no AOAI deployment. |
| 5 View more | ✅ built (⚠️ honest-gate) | `ViewMorePanel` — Power BI Embedded (Commercial/GCC) or Managed Grafana (GCC-High/IL5). Opt-in env-gated; honest gate when neither configured. |
| 6 Recommended actions | ✅ built | Cards from the `recommended-actions` Cosmos container; honest empty state when none. |

Zero ❌. Non-functional states are all honest infra-gates (named env var + bicep module + role + follow-up), never blank tabs.

## Backend per control

| Control | BFF route | Real backend |
|---|---|---|
| Estate tiles | `GET /api/governance/govern/posture` | Cosmos `workspaces` + `items` aggregate (live). |
| Feature usage | same | Azure Monitor Log Analytics KQL (`AppRequests`). |
| MIP coverage % | same | Microsoft Graph `sensitivityLabels` × labeled items. |
| DLP violations | same | Microsoft Graph `security/alerts_v2` (DLP, 30d). |
| Purview last scan | same | Classic Purview Data Map scan-runs. |
| Trust/reuse tiles | same | Cosmos `items` state + `audit-log` shares. |
| Trigger scan | `GET/POST /api/governance/govern/trigger-scan` | Purview Data Map `PUT …/scans/{scan}/runs/{runId}` (real async scan, HTTP 202). |
| Copilot | `POST /api/governance/govern/copilot` | Azure OpenAI chat-completions (streamed), posture JSON as RAG. |
| View more | `GET /api/governance/govern/embed` | Power BI GenerateToken / Managed Grafana kiosk iframe. |
| Recommended actions | `GET /api/governance/govern/actions` | Cosmos `recommended-actions`. |

## No-Fabric note

The default path uses only Cosmos + Azure Monitor + Microsoft Graph + classic Purview — no Microsoft
Fabric / Power BI workspace required. Power BI Embedded is an **opt-in** "View more" backend selected
via `LOOM_REPORT_KIND=powerbi`; Managed Grafana (`LOOM_REPORT_KIND=grafana`) is the Gov-cloud
alternative. With neither set, the surface renders the honest gate and every other tile still works.

## Pre-compute

`azure-functions/posture-refresh` (Python v2, timer every 5 min) pre-warms the
`posture-aggregates` Cosmos container. The BFF still computes live values; the
pre-computed `updatedAt` is surfaced as "Background refresh last ran …".
