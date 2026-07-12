# Service exercise — validate every backend data path

The **Exercise services** validation goes one level deeper than the config-presence
self-audit on `/admin/health`: each probe **executes a tiny, safe, real operation
through the backend's actual data path** and reports `pass` / `gate` / `fail`. A
backend that is configured — resource deployed, env vars set, every presence check
green — but **cannot do work** shows up here as a red `fail`.

The motivating failure class: a **faulted Synapse Spark pool**. The workspace and
pool existed, `LOOM_SYNAPSE_WORKSPACE` was set, the self-audit was green — but
every Livy session errored instantly (state `dead`, `appId=null`), silently making
notebooks unusable. The `spark` probe catches exactly that, by default, every day.

## The probes

| Service | Exercise (real backend call) | Self-cleaning |
| --- | --- | --- |
| `spark` | Create a minimal Livy session on the default Spark pool, poll to `idle`, run `spark.range(1).count()` | Session is **deleted** — even on failure or timeout |
| `warehouse-sql` | `SELECT 1` over the Synapse serverless TDS endpoint | read-only |
| `adx` | `print 1` KQL on the default ADX database | read-only |
| `adls` | `exists()` probe of every configured DLZ lake container (the managed-PE path) | read-only |
| `cosmos` | `getDatabaseAccount()` + a real query against the Loom store | read-only |
| `aoai` | Resolve the model target + a one-shot 16-token completion | read-only |
| `domain-sync` | `runDomainSync(apply:false)` — a **dry-run** Purview / Unity Catalog reconcile | non-mutating by contract |
| `adf` | List pipelines on the env-pinned default factory (ARM control plane) | read-only |

### Statuses

- **pass** — the real backend executed the exercise; evidence (rows, reply text,
  container names) is attached to the result.
- **gate** — an honest infra gate (per `no-vaporware.md`): the backend is **not
  configured**, and the detail names the exact env var / role / bicep module. A
  fresh minimal deployment is all-gates, zero-fails — gates never fail a run.
- **fail** — the backend **is configured but the exercise failed**: a faulted
  pool, a revoked role, a broken private endpoint / DNS path. This is the signal
  the platform surfaces so the operator does not discover it through a user.

## Where it runs

1. **UI** — `/admin/health` → the *Exercise services* panel (tenant-admin only).
   Run all probes or re-run a single one; each row shows status, latency, and an
   evidence expander with the raw backend response.
2. **BFF** — `POST /api/admin/health/exercise[?service=spark]` starts a
   background run (the Spark probe outlives Front Door's response window, so the
   route never blocks); `GET /api/admin/health/exercise` polls the run state and
   returns the structured report. Tenant-admin gated.
3. **CI / cron** — `.github/workflows/csa-loom-exercise-services.yml` runs daily
   (05:30 UTC) and on dispatch, on the in-VNet `[self-hosted, loom-aca]` runner
   (the backends are PE-locked). It mints a `loom_session` cookie from the Key
   Vault `session-secret` (same chain as `loom-ui-verify`), drives the route via
   `scripts/csa-loom/exercise-services.mjs`, and **fails the job on any real
   `fail`** — gates are annotated as warnings. This is the "caught by the
   platform by default" mechanism.

### Workflow requirements (same one-time setup as loom-ui-verify)

- GH secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
  (OIDC federated SP with Key Vault Secrets User on the loom KV).
- GH vars: `LOOM_VERIFY_URL`, `LOOM_AUTOMATION_OID`, and `LOOM_KV_NAME` (or
  `LOOM_ADMIN_RG` for auto-discovery).
- `LOOM_AUTOMATION_OID` **must be a tenant admin** (`LOOM_TENANT_ADMIN_OID` or a
  member of `LOOM_TENANT_ADMIN_GROUP_ID`) — the exercise route is admin-gated
  because probes execute real work against shared tenant backends.

## Tuning

| Env var (Console app) | Default | Meaning |
| --- | --- | --- |
| `LOOM_EXERCISE_TIMEOUT_MS` | per-probe default | Global per-probe budget override |
| `LOOM_EXERCISE_SPARK_TIMEOUT_MS` | `240000` | Spark probe budget (session create → idle → statement) |
| `LOOM_EXERCISE_<SERVICE>_TIMEOUT_MS` | per-probe default | Any single probe's budget (e.g. `LOOM_EXERCISE_ADX_TIMEOUT_MS`) |

CI driver knobs: `EXERCISE_SERVICES` (comma-separated probe filter) and
`EXERCISE_POLL_TIMEOUT_MS` (default 8 minutes).

## Engine

`apps/fiab-console/lib/admin/service-probes.ts` — the probe registry + runner +
run-state store (in-memory + a best-effort Cosmos `tenant-settings` doc
`service-exercise:<tenantId>` so the report survives replica routing). Probes run
in parallel, each with its own deadline; a probe that overruns is failed by a
hard backstop and its cleanup (`finally`) still runs.
