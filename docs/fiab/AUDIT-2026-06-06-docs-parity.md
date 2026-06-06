# CSA Loom docs ↔ shipped-code audit (2026-06-06)

Full audit of `docs/**` against the shipped code (`apps/fiab-console`,
`platform/fiab/bicep`) in both directions: (1) every doc claim of shipped
functionality must be backed by code; (2) every shipped feature must be
documented. Method: parallel cross-checks of each doc cluster against the
editors (`lib/editors/*`), API routes (`app/api/**`), Azure clients
(`lib/azure/*`), and bicep.

## Headline

- **Parity docs are clean.** All ~103 `docs/fiab/parity/*.md` "✅ built" rows
  resolve to a real route / client / editor. The parity corpus is candid — it
  marks gaps `❌ MISSING` / `⚠️ honest-gate` rather than overclaiming.
- **Per-editor workload docs are accurate** (lakehouse, notebook, eventhouse,
  data-pipeline, copy-job, dbt-job, stream-analytics-job, kql-dashboard,
  eventstream, …).
- **Vaporware concentrates in a few "design/service" docs** that describe a
  sophisticated standalone backend as if shipped, while the actual Console path
  does something materially simpler. These are fixed in this batch (below).
- **Tutorials 01–08** describe a navigation model (per-workspace left-rail
  panes) and `loom-*` / `fiab-migrate` CLIs that the shipped product does not
  have. Tracked for rewrite (below).
- **Undocumented:** only `/api/network/private-endpoints` (minor route group).
  (`/connections` IS documented — `docs/fiab/console/connections.md`.)

## Direction 1 — doc claims not backed by code

| doc | claim | reality (code checked) | status |
|---|---|---|---|
| `services/mirroring-engine.md` | Spark Structured Streaming on Databricks; steady-state CDC lag < 60s | shipped Start = one-shot CSV snapshot to Bronze (`lib/azure/mirror-engine.ts`) | **fixed in this batch** |
| `workloads/mirroring-parity.md` | Debezium + Spark Streaming + Delta MERGE pipeline as the running design | same — CSV snapshot; Debezium/replicator are unwired scaffold | **fixed in this batch** |
| `services/activator-engine.md` | 8 action types (Teams/Email/Power Automate/Logic App/Databricks Job/ADF/UDF/Webhook) | engine `ActionType` = 4 (Teams, Email, LogicApp, Webhook) | **fixed in this batch** |
| `workloads/data-activator-parity.md` | same 8-action surface table | same — 4 implemented | **fixed in this batch** |
| `workloads/activator.md` | Fabric REST documented as the default backend | code default = Azure-native (Cosmos + Monitor); Fabric opt-in via `LOOM_ACTIVATOR_BACKEND=fabric`. Also understates shipped start/stop | **fixed in this batch** |
| `workloads/direct-lake-parity.md`, `services/direct-lake-shim.md` | TOM/XMLA partition refresh; TMDL editor; visual model designer; <30s refresh SLA | semantic-model build uses Power BI **push datasets** ("no XMLA required"); no TMDL editor / designer in `lib/editors` | **fixed — banners added** |
| `workloads/onelake-parity.md` | `apps/fiab-shortcuts-service` Container App + Redis cache | no such app; shortcut logic is in-Console (`shortcut-engines.ts`) | **fixed — banner added** |
| `workloads/data-science.md` | `apps/fiab-ai-functions/` PyPI library; Models/Endpoints panes | no such app/package; no models/endpoints pane | **fixed — banner added** |
| `tutorials/01–08` | per-workspace left-rail panes; `loom-dl-shim`/`loom-mirroring`/`loom-marketplace`/`fiab-migrate` CLIs; Databricks-Job activator action; `POST /api/agent/<id>/chat` | console uses a flat workspace item tree + global nav + "+ New item" editors; no such CLIs/endpoint; activator actions are Teams/Email/Webhook/ADF/Notebook/PowerAutomate | **tracked — rewrite 01–08** |

## Direction 2 — shipped but undocumented

| feature | file | status |
|---|---|---|
| `/api/network/private-endpoints` route group | `app/api/network/private-endpoints/route.ts` | **fixed — `docs/fiab/admin/network-private-dns.md`** |

Everything else recent (mirroring Weave edges, API-marketplace mini-app,
connections, data-agent, data-api-builder) is documented.

## Follow-ups (tracked)

1. ✅ Tutorials 01–08 corrected — 01 fully rewritten to the real navigation
   (flat workspace item tree + global nav + "+ New item"); 02–08 carry accuracy
   banners stating the real nav and flagging the non-existent CLIs
   (`loom-dl-shim`/`loom-semantic-model`/`loom-mirroring`/`loom-marketplace`/
   `fiab-migrate`), the missing `POST /api/agent/<id>/chat`, and the
   non-existent activator "Databricks Job" action — each pointing at the real
   shipped flow. (Full step-by-step refreshes of 02–08 remain a nice-to-have.)
2. ✅ Reconciled `direct-lake-*`, `onelake-parity.md`, `data-science.md` with
   honest shipped-vs-design banners.
3. ✅ Documented `/api/network/private-endpoints` (`docs/fiab/admin/network-private-dns.md`).
