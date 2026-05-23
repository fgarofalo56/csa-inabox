# CSA Loom v2 — PRP backlog

Stub PRPs for the v2 scope captured in
[v2-scope-expansion.md](../../docs/fiab/v2-scope-expansion.md).
Each gets a full PRP file before any code begins, matching the v1
PRP format (Context / Goal / Acceptance criteria / PRD ref / Risks).

**Status: BACKLOG.** No code work until:
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

- [v2 scope expansion doc](../../docs/fiab/v2-scope-expansion.md)
- [v1 PRP audit](../../docs/fiab/prp-audit.md)
- v1 PRPs: see `PRP-00-README.md` through `PRP-25-*`
