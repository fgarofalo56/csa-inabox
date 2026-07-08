# ARCHIVED — CSA Loom Pillar-Era PRP Set

**Archived:** 2026-07-08
**Moved from:** `PRPs/active/csa-loom/`
**Moved to:** `PRPs/completed/csa-loom-pillar/`

This directory holds the original pillar-era Product Requirement Prompts (PRP-00
through PRP-25) that scoped the initial CSA Loom ("Fabric-in-a-Box") build-out.
A 2026-07-08 audit cross-checked all 25 files against the shipped codebase and
documentation. Result: **22 SHIPPED, 3 SUPERSEDED, 0 OPEN.** The set is closed,
so it is archived here rather than left under `active/`.

## Verdict per file

| PRP | Title | Verdict |
|-----|-------|---------|
| PRP-00-README.md | PRP Set — CSA Loom (repo-internal: fiab) | SHIPPED |
| PRP-01-pillar-foundation.md | CSA Loom Pillar Foundation | SHIPPED |
| PRP-02-platform-bicep.md | Platform Bicep + ESLZ Reuse + Per-Boundary Params | SHIPPED |
| PRP-03-loom-console.md | Loom Console (Next.js + Fluent UI v9) | SHIPPED |
| PRP-04-setup-wizard.md | Loom Setup Wizard (Two-Tier Orchestration) | SHIPPED |
| PRP-05-mcp-server.md | Self-Hosted Azure MCP Server | SHIPPED |
| PRP-06-activator-engine.md | Loom Activator Engine (Reflex/Data Activator Parity) | **SUPERSEDED** |
| PRP-07-mirroring-engine.md | Loom Mirroring Engine (Zero-ETL CDC Parity) | **SUPERSEDED** |
| PRP-08-direct-lake-shim.md | Loom Direct-Lake Shim (Direct Lake Parity Service) | **SUPERSEDED** |
| PRP-09-data-agents.md | Loom Data Agents (Extending apps/copilot) | SHIPPED |
| PRP-11-deploy-validation.md | Per-Boundary Deploy Validation Workflows | SHIPPED |
| PRP-12-catalog-wiring.md | Catalog Two-Track Wiring | SHIPPED |
| PRP-13-defender-ai-workaround.md | Defender AI Threat Protection Workaround (Sentinel Pipeline) | SHIPPED |
| PRP-14-examples-port-wave1.md | Industry Examples Port Wave 1 (8 of 25) | SHIPPED |
| PRP-15-workload-docs.md | Workload Parity Documentation | SHIPPED |
| PRP-16-deployment-docs.md | Deployment Documentation | SHIPPED |
| PRP-17-operations-docs.md | Operations Documentation + Runbooks | SHIPPED |
| PRP-18-compliance-docs.md | Compliance Documentation | SHIPPED |
| PRP-19-adrs.md | Architectural Decision Records (12 ADRs) | SHIPPED |
| PRP-20-tutorials.md | Tutorials (8 Step-By-Step Pieces) | SHIPPED |
| PRP-21-marketing-kit.md | Marketing Kit | SHIPPED |
| PRP-22-workshops.md | 5-Day Cloud CoE Workshops (Federal + Commercial Day-One) | SHIPPED |
| PRP-23-use-cases.md | Use-Case Pages (5 CSA Loom-Specific Use Cases) | SHIPPED |
| PRP-24-cross-link-updates.md | Existing-Content Cross-Link Updates | SHIPPED |
| PRP-25-solution-store-entry.md | Solution-Store Entry | SHIPPED |

> Note: there is no PRP-10 in this set — the number was deferred/skipped during
> planning, so the 25 files run PRP-00..09 and PRP-11..25.

## The three SUPERSEDED PRPs

Each of these originally specified a **standalone microservice**. All three were
delivered as functionality, but via a simpler shipped architecture than the
original standalone-service design — so the original PRP design is superseded,
not un-shipped:

- **PRP-06 — Activator Engine.** Original design: a standalone Reflex/Data
  Activator-parity microservice. Superseded by the shipped **ADX-native +
  Azure Monitor scheduled-query-alert** Activator path (no separate engine
  service required).
- **PRP-07 — Mirroring Engine.** Original design: a standalone zero-ETL CDC
  mirroring microservice. Superseded by the shipped **ADF-based CDC / Synapse
  Link copy → ADLS Bronze Delta** mirroring path.
- **PRP-08 — Direct-Lake Shim.** Original design: a standalone Direct Lake
  parity shim service. Superseded by the shipped **Loom-native AAS tabular
  layer** over the warehouse/lakehouse.

### Leftover unwired code (tracked for future deletion)

The three superseded standalone-microservice designs still exist as **unwired
scaffold code** in the repo. They are not on any live code path and are
candidates for future deletion (tracked separately, not by this archival):

- `apps/fiab-activator-engine`
- `apps/fiab-mirroring-engine`
- `apps/fiab-direct-lake-shim`
