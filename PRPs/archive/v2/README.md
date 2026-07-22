# CSA Loom v2 — PRP backlog

> **ARCHIVED 2026-07-14** — moved from `PRPs/v2/` to `PRPs/archive/v2/`. The mapping
> below records where each v2 stub actually landed.
>
> **SUPERSEDED (2026-07-12).** This backlog predates the `PRPs/active/*` program
> structure and never became the delivery vehicle — the v2 scope was delivered
> (or re-planned) through the active programs instead. Kept for historical
> traceability. See the mapping table below for where each stub landed; new
> work is planned in `PRPs/active/` (see `PRPs/active/OPEN-REGISTER-2026-07-12.md`).

## Where the v2 scope actually landed (mapping note)

| v2 stub | Landed as / tracked in |
|---|---|
| PRP-26 Data Marketplace + catalog | Shipped — unified `/marketplace` (API + Data, PR #1578) + catalog consolidation |
| PRP-27 OneLake-equivalent unified namespace | Shipped — `apps/loom-onelake` sibling service + OneLake parity workload (`docs/fiab/workloads/onelake-parity.md`) |
| PRP-28 APIM API builder for data sharing | Shipped — `publish-as-api` Weave edge + APIM (`apim.bicep`); AI-gateway via model-strategy M5/M6 |
| PRP-29 Function App management Console pane | Shipped — service-navigator program (typed resource navigators on real REST) |
| PRP-30 AI/ML API management Console pane | Shipped — Foundry hub editor + AIF-12 model tier router + APIM AI-gateway (`PRPs/completed/model-strategy/PRP.md`) |
| PRP-31 Developer portal + dev tools | Shipped — Learning Hub `/learn` + `apps/loom-cli` |
| PRP-32 Metadata-driven data source onboarding | Shipped — mirrored-database CDC + Copy Job + connector catalog + Get-data Loom-item source (#1927) |
| PRP-33 Domain management | Shipped — multi-library domain designer (#1924: Federal Civilian, Defense & Intel, State & Local, Commercial) + domain→Unity Catalog governance sync (#1926/#1930) |
| PRP-34 dbt builder + integration | Shipped — `apps/fiab-dbt-runner` + dbt Job editor (`docs/fiab/workloads/dbt-job.md`) |
| PRP-35 Complete shortcut builder | Shipped — lakehouse shortcut engines (ADLS/S3/GCS/SharePoint routes) |
| PRP-36 Data virtualization builder + manager | Shipped — Synapse Serverless `OPENROWSET` surfaces (warehouse/lakehouse/Direct-Lake fallback) |
| PRP-37 Complete observability (DMLZ + DLZ rollup) | Shipped — Spark→Log Analytics telemetry + compute tiers (#1931, `docs/fiab/compute-tiers-and-telemetry.md`) + chargeback |
| PRP-38 Power BI report suite (mgmt + ops) | Shipped — Loom-native report designer + Weave→Power BI W1–W6 (#1902–#1913, `PRPs/active/weave-powerbi/PRP.md`) |
| PRP-39 Loom Copilot in every Console pane | Shipped — per-surface Copilot standard (`docs/fiab/ux-standards.md`) + AIF-12 tier routing day-one |

---

Stub PRPs for the v2 scope captured in
[v2-scope-expansion.md](../../../docs/fiab/archive/v2-scope-expansion.md).
Each was to get a full PRP file before any code began, matching the v1
PRP format (Context / Goal / Acceptance criteria / PRD ref / Risks).

**Original status: BACKLOG.** No code work until:
1. v1 completes end-to-end (apps deployed + UAT'd)
2. Build 2026 freshness rescan (auto Jun 8)
3. v2 walkthrough analogous to 2026-05-22 v1 walkthrough
4. Brand legal sign-off

## v2 PRP list

| # | Title | Sizing | Depends on |
|---|---|---|---|
| PRP-26 | Data Marketplace + catalog | L (8 weeks) | v1 complete; PRP-12 Purview/Atlas wiring |
| PRP-27 | OneLake-equivalent unified namespace | XL (12 weeks) | PRP-02 platform Bicep |
| PRP-28 | APIM API builder for data sharing | L | apimEnabled live |
| PRP-29 | Function App management Console pane | M (4 weeks) | PRP-03 Console |
| PRP-30 | AI/ML API management Console pane | L | PRP-29 |
| PRP-31 | Developer portal + dev tools | XL | PRP-03 Console |
| PRP-32 | Metadata-driven data source onboarding | XL | PRP-07 Mirroring; PRP-12 catalog |
| PRP-33 | Domain management | L | PRP-15 governance |
| PRP-34 | dbt builder + integration | L | PRP-02 Databricks/Synapse |
| PRP-35 | Complete shortcut builder | XL | PRP-27 OneLake-equivalent |
| PRP-36 | Data virtualization builder + manager | L | PRP-27 |
| PRP-37 | Complete observability (DMLZ + DLZ rollup) | L | telemetry-everywhere (done) |
| PRP-38 | Power BI report suite (mgmt + ops) | M | PRP-37 |
| PRP-39 | Loom Copilot in every Console pane | XL | PRP-09 Data Agents; PRP-03 Console |

## Sizing legend

- **M**: ~4 weeks, 1 engineer
- **L**: ~8 weeks, 1-2 engineers
- **XL**: ~12 weeks, 2-3 engineers

Total: ~80-100 engineering weeks at 1-3 engineers each. Calendar:
6-9 months sustained pace assuming 4-engineer team and minimal blockers.

## Per-PRP stub status

Each PRP starts as a stub doc; this README will be updated as stubs
are authored.

- [ ] PRP-26 data-marketplace.md
- [ ] PRP-27 onelake-namespace.md
- [ ] PRP-28 apim-api-builder.md
- [ ] PRP-29 function-mgmt-pane.md
- [ ] PRP-30 ai-ml-api-mgmt.md
- [ ] PRP-31 developer-portal.md
- [ ] PRP-32 metadata-driven-onboarding.md
- [ ] PRP-33 domain-management.md
- [ ] PRP-34 dbt-builder.md
- [ ] PRP-35 shortcut-builder.md
- [ ] PRP-36 data-virtualization.md
- [ ] PRP-37 observability-rollup.md
- [ ] PRP-38 powerbi-report-suite.md
- [ ] PRP-39 copilot-every-pane.md

Stubs will be authored in priority order after v2 walkthrough decides
phasing.

## Related

- [v2 scope expansion doc](../../../docs/fiab/archive/v2-scope-expansion.md)
- [v1 PRP audit](../../../docs/fiab/archive/prp-audit.md)
- v1 PRPs: see `PRP-00-README.md` through `PRP-25-*`
