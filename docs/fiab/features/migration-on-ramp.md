# Migration on-ramp: assess, copy in, translate

> **Surface:** `/admin/migrate` — the **Assess**, **Copy in** and **Translate** tabs
> **Backend:** the `loom-migrate` estate-reader Container App (internal ingress), a real Azure Data Factory Copy pipeline, and in-boundary transpilers reusing Loom's own DAX parser and code-report parser
> **Kill-switch flags:** `n-m1-estate-assess`, `n-m2-copy-in`, `n-m3-translate` (all default ON)
> **Honest gate:** `LOOM_MIGRATE_URL` (gate id `svc-loom-migrate`), plus a per-connector connection prerequisite

Bringing an existing estate **in**. Point Loom at a Snowflake, Databricks Unity
Catalog, Microsoft Fabric or Power BI estate; get a readiness report; land the
data; translate the code. Three steps, three tabs, one shared report shape.

A Fabric or Power BI estate is only ever a migration **source** here. Loom itself
has no Fabric dependency, and the default path reaches no Fabric host.

## Why it exists

"Migrate to our platform" usually means a consulting engagement and a
spreadsheet. The on-ramp replaces the spreadsheet with a real enumeration: what
objects exist, which map one-to-one onto a Loom item type, and which genuinely
need a human. The honesty rule is the whole value — an object kind with no
confident target resolves to **needs-review with a reason**, never a fabricated
one-to-one.

## Step 1 — Assess (M1)

1. Open **Admin → Migrate → Assess**.
2. **Pick the source type**: Snowflake, Databricks Unity Catalog, Microsoft
   Fabric, or Power BI.
3. **Supply the connection** — account or workspace URL, the catalog or workspace
   id, and a token stored as a Key Vault secret reference.
4. **Run the assessment.** The `loom-migrate` reader enumerates the estate; the
   assessment engine maps each enumerated object onto a Loom item type
   (`lakehouse`, `warehouse`, `semantic-model`, `report`, `notebook`,
   `data-pipeline`, `kql-database`, `eventhouse`, `eventstream`,
   `mirrored-database`, `dataflow`, `paginated-report`, `dashboard`, `ml-model`,
   and so on).
5. **Read the readiness report.** Per object: the source kind, the target Loom
   item type, a **1:1** or **needs-review** effort flag, and a human-readable
   reason.

The engine **never invents inventory** — it maps only what the reader actually
enumerated.

## Step 2 — Copy in (M2)

1. Switch to the **Copy in** tab. The copy plan is built **from the M1 readiness
   report**, so you are landing exactly what was assessed.
2. **Review and adjust the plan** — which assessed tables to land.
3. **Run it.** Each table lands in **ADLS Bronze via a real Azure Data Factory
   Copy pipeline** — the mirroring substrate, in reverse.
4. **Watch the live monitor.** Per-object status through the copy job.
5. **Optionally materialize managed Delta** in the target Loom lakehouse, so the
   landed data is immediately queryable as a first-class table.

ADF runs in-boundary. Nothing about copy-in requires a Fabric capacity.

## Step 3 — Translate (M3)

1. Switch to the **Translate** tab and choose what to transpile:

   | Kind | Source | Lands as |
   |---|---|---|
   | SQL view | Snowflake or T-SQL / Fabric | Loom SQL |
   | Stored procedure / UDF | Snowflake or T-SQL / Fabric | Loom SQL |
   | DAX measure | Power BI / Fabric | a semantic-contract measure (and optionally into the [semantic contract](verified-queries.md) directly) |
   | Report | Power BI / Fabric | a Loom code-report |

2. **Paste or select the source** and pick the dialect.
3. **Review the side-by-side diff.** Source on the left, generated artifact on
   the right, with **per-construct supported / needs-review badges**. An
   unsupported construct is shown needs-review **with the exact reason** — never
   a fabricated translation.
4. **Accept.** A supported artifact lands as a **draft Loom item** through the
   normal item-create path, so nothing goes live without a human opening it.
5. **Run the translated asset** and compare against the source system.

The transpilers reuse machinery Loom already ships and tests: the DAX parser and
SQL-fold engine behind the semantic model's DAX query view, and the code-report
parser. They run fully in-boundary — pure parse and fold, no SaaS call — so
translation works in a disconnected enclave.

## What the backend actually does

| Control | Backend |
|---|---|
| Assess | `POST /api/migrate/assess` -> the internal-ingress `loom-migrate` reader, then the pure assessment engine |
| Copy in | `POST /api/migrate/copy` -> a real ADF Copy pipeline into ADLS Bronze, then optional managed-Delta materialization |
| Translate | `POST /api/migrate/translate` -> the in-boundary transpilers |
| Audit | Every enumeration is an audited BFF call; the reader is never public |

## Deployment (default ON) and honest gates

**`LOOM_MIGRATE_URL` is set by the deployment itself.** Since 2026-07-28
`admin-plane/main.bicep` deploys
`platform/fiab/bicep/modules/data-plane/loom-migrate-aca.bicep` on every
apps-enabled deploy, in **every Container Apps boundary — Commercial, GCC,
GCC-High and IL5** — and wires `https://<fqdn>` onto the Console, so a fresh
push-button deploy closes the `svc-loom-migrate` gate with no operator step. The
reader runs `minReplicas: 0`, so default-ON costs approximately **$0 at idle**:
it only spins up during an assessment, where a cold start is seconds against an
action that already takes minutes. Admins opt OUT with
`observabilityConfig.backendOverrides.loomMigrate = 'disabled'`.

- **`LOOM_MIGRATE_URL` unset.** Only possible on a pre-2026-07-28 estate that
  has not been redeployed, before the apps tier deploys, or after an explicit
  opt-out. `/admin/migrate` still renders; Assess
  honest-gates with a Fix-it naming the variable and the bicep module
  (`platform/fiab/bicep/modules/data-plane/loom-migrate-aca.bicep`). No
  fabricated counts, ever.
- **A connector without its connection prerequisite.** The reader replies with a
  structured connector gate, and the surface renders a precise message bar naming
  what is missing (account or workspace URL, token) rather than showing zero.
- **In an IL5 boundary** the reader itself runs in-boundary and the on-ramp works
  disconnected; individual SaaS-source connectors stay honestly gated until their
  connection prerequisite is provided.

## Kill-switches

| Flag | OFF behaviour |
|---|---|
| `n-m1-estate-assess` | `/api/migrate/assess` returns a guided "turned off" 503 and the surface's function is hidden on the next load. Nothing else is affected. |
| `n-m2-copy-in` | `/api/migrate/copy` returns a guided 503 and the tab's function is hidden. Assessment, **in-flight pipelines**, and every other surface are unaffected. |
| `n-m3-translate` | `POST /api/migrate/translate` returns a guided 503 and the Translate tab is hidden. Nothing else is affected. |

All three are default ON and need no roll to flip.

## Related

- [Workspace portability](workspace-portability.md) — moving workspaces *within* Loom
- [Forward migration to Microsoft Fabric](../operations/forward-to-fabric.md) — the outbound direction
- [Upgrade and migration](../operations/upgrade-migration.md)
- Tutorial — [Forward-migrate a Lakehouse to Fabric](../tutorials/08-forward-migrate-to-fabric.md)
