# Parity gap — `synapse-spark-pool`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure Synapse Studio → Manage → Apache Spark pools.
> Loom route: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/synapse-spark-pool/new`.
> Editor source: `apps/fiab-console/lib/editors/azure-services-editors.tsx` (lines 160-365).

## Phase 3 — gap matrix vs Synapse Studio Spark pool

| # | Fabric element | Loom present? | Severity |
|---|---|---|---|
| 1 | Pool list + config tab (node size, Spark version, autoscale min/max, auto-pause) | Present (lines 298-313) — real ARM list, read-only config form. Note: form is read-only (line 312 acknowledges "Edit via Synapse Studio for now; v2.2 wires inline PUT") | OK (honest gate) |
| 2 | Submit batch job form (file URI, class, args) | Present (lines 315-326) — real `POST .../submit` | OK |
| 3 | Recent batches table with state / result / app id / submitter | Present (lines 328-360) — real `/runs?size=20` from Livy | OK |
| 4 | Spark monitoring UI link (open in Synapse Studio) | MISSING | MINOR |
| 5 | Library mgmt (pip install / wheel upload) | MISSING — Fabric/Synapse has per-pool library mgmt | MAJOR |
| 6 | Status bar | MISSING | MINOR |
| 7 | "Scale" ribbon action — should open size dropdown | MISSING handler — ribbon vapor | MINOR |
| 8 | "Open notebook" ribbon action | MISSING handler | MINOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| **Force pause** | `setAutoPause('pause')` (line 235-248) — real `POST .../state {action: 'pause'}` | Real |
| **Reset auto-pause** | Same handler, action='resume' | Real |
| **Refresh** | `loadPool + loadBatches` | Real |
| **Submit batch** | `submit()` (line 213-233) — real Livy `POST` | Real |
| Pool selection in tree | `setSelected(name)` + triggers loadPool/loadBatches | Real |
| Ribbon "Scale" / "Pause" / "Auto-pause" / "Open notebook" / "Submit Spark job" | No handlers | **DEAD** (5 ribbon vapor) |

## Grade

**B** — primary actions (Submit, Pause, Resume, list runs) are real. No code editor in this surface (intentional — Spark pool is compute infra, code lives in notebooks). Honest read-only-form gate at line 312. Missing library management is MAJOR per Fabric parity but pool-edit-via-Studio is a defensible MVP. 5 dead ribbon buttons keep this from A.

