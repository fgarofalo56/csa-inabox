# App tutorials — from an empty workspace to a working result

Every entry below is a **from-scratch deep dive** for one CSA Loom *app* (a
curated content bundle you install from **/apps**). Each one starts with an
empty workspace and ends with something that actually works: a real Azure-native
backend responding, seeded rows you can query, and a stated way to verify it.

!!! info "What an app is (and is not)"
    An app is a **bundle of workspace items** plus their starter content. Installing it
    (a) creates each item in the workspace you pick, and (b) — when **Deploy artifacts
    to live Azure services** is ON — runs each item's real Phase-2 provisioner against
    ADLS Gen2 / Synapse / ADX / AI Search / Azure Monitor / Event Hubs. Item types with
    no provisioner install as Cosmos-only starter content (still fully editable; the
    editor pushes them to the backend on Save). Microsoft Fabric is **never** required:
    every provisioner's default path is Azure-native, and a Fabric backend is opt-in
    behind an explicit `LOOM_<ITEM>_BACKEND=fabric` plus a bound workspace.

## The tutorials

| Tutorial | App | You end up with |
| --- | --- | --- |
| [RAG Builder](rag-builder.md) | `app-rag-builder` | A live hybrid AI Search index answering a grounded question through a prompt flow, with an evaluation suite |
| [FedRAMP Compliance Tracker](fedramp-tracker.md) | `app-fedramp-tracker` | A 13-family NIST 800-53 scorecard with worst-child rollup + an ADX compliance-events dashboard |
| [FinOps Cost Optimizer](finops-cost.md) | `app-finops-cost` | A seeded cost lakehouse, a semantic model, and a 5-page executive report rendering real spend |
| [Data Steward Console](data-steward.md) | `app-data-steward` | Four Purview data products (Promoted → your Certified sign-off) + a 17-term glossary + a star-schema model |
| [Pipeline Designer](pipeline-designer.md) | `app-pipeline-designer` | The same medallion ETL on three orchestrators (Synapse, ADF, Databricks) landing a gold star schema |
| [Lakehouse Inspector](lakehouse-inspector.md) | `app-lakehouse-inspector` | A bronze/silver/gold Delta lakehouse with 10 seeded tables + a profiling notebook |
| [Mirror Onboarding](fabric-mirror-onboard.md) | `app-fabric-mirror-onboard` | An Azure SQL source replicated into Bronze via ADF CDC, with a row-count parity notebook |
| [Workspace Monitoring](workspace-monitoring.md) | `app-workspace-monitoring` | A read-only ADX telemetry database fed by Azure Monitor + a six-tile dashboard |
| [Supercharge medallion journey](supercharge-medallion.md) | the 7 `app-supercharge-*` packs | 117 Azure-native Spark notebooks, one representative bronze → silver → gold chain proven green |

## The shape every tutorial follows

1. **Prerequisites** — what must exist before you start (an account, a workspace,
   and the specific Azure backends this app touches).
2. **Install** — the exact `/apps` walk, and what each wizard control does.
3. **What gets provisioned** — item by item, which provisioner runs, which real
   Azure surface it hits, and the honest gate it shows when a backend is absent.
4. **Seeded data** — what rows exist the moment install returns.
5. **First meaningful task** — one real end-to-end action, not a tour.
6. **Verify it worked** — the check that proves the backend actually responded.
7. **Troubleshooting / cleanup**.

## Related

- [Tutorial 01 — First workspace](../01-first-workspace.md) — do this first if you
  have never created a Loom workspace.
- [App install & provisioning (operations)](../../operations/app-install-provisioning.md)
  — the request/response shapes, async job polling, and provisioner coverage table.
- [Editor tutorials (per item type)](../README.md) — once an app has provisioned an
  item, its editor guide is the next stop.
