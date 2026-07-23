# Support bundle — one-click diagnostics export for incident triage

**Surface:** Admin → **Diagnostics** (`/admin/diagnostics`).
**API:** `GET /api/admin/diagnostics/bundle` (tenant-admin) — inline preview;
`GET …?download=1` streams the same document as an attachment
(`loom-support-bundle-<ts>.json`).

The bundle is a **point-in-time, secret-scrubbed snapshot** of the deployment's
posture, assembled by `lib/admin/support-bundle.ts` from the live in-process
registries + probes. Attach it to an incident ticket or share it with support —
it carries **zero secrets, tokens, or connection strings**.

---

## 1. What's in the bundle

| Section | Source | Notes |
|---------|--------|-------|
| `version` | `resolveCurrentVersion` + `readBuildMarker` + `CONTAINER_APP_REVISION`/`CONTAINER_APP_NAME` + `detectLoomCloud` | which image + ACA revision is serving, and the cloud |
| `gateSummary` / `gates` | `allGateStatuses()` | every config gate's status (configured / blocked / cloud-unavailable) + missing vars |
| `env` | `buildEnvPosture(ENV_CHECKS, process.env)` | **masked** posture of every referenced env var — secrets are `***`, never the value |
| `probes` | `probeCosmosReachable` (bounded) | live dependency reachability from this replica |
| `lastSyntheticRun` | `readSyntheticRuns({ n: 1 })` | the last V1 synthetic-journey run summary (pass/fail/skip) |
| `recentAudit` | Cosmos `_auditLog` (top 25, tenant-scoped) | recent privileged mutations (who / kind / target) |
| `notes` | assembler | honest notes for feeds absent in this deployment (e.g. synthetic store unwired, DR-drill summary) |

## 2. Secret safety — two layers

1. **Masked at source** — env values go through `maskValue`, so any key the
   registry classifies as a secret is collapsed to `***` before it ever enters
   the bundle.
2. **Defence-in-depth scrub** — the assembled bundle is then run through
   `scrubDeep` → `scrubSecrets`, which redacts JWTs, `Bearer` tokens, storage
   `AccountKey=` / SAS `sig=`, connection-string `Password=`/`ClientSecret=`,
   and any `key=value` whose key name implies a secret (SECRET / PASSWORD /
   TOKEN / APIKEY / ACCOUNTKEY / CONNECTIONSTRING) — across **every** free-text
   field (probe errors, audit detail, notes). Safe diagnostic values (build
   SHA, resource GUIDs, ISO timestamps) are deliberately **kept**.

The scrubber + masking are unit-tested (`support-bundle.test.ts`) against
seeded fake secrets — a redaction regression fails CI.

## 3. Using it in an incident

1. **Export the bundle FIRST**, before changing anything — it snapshots posture
   before your remediation mutates it.
2. Read `gateSummary` — `blocked` = a config gate someone must fix (the missing
   env var/role is in that gate's `missing`); `cloudUnavailable` = a service
   that does not exist in this cloud (honest, not a defect).
3. Read `probes` — a failed `cosmos-reachable` explains a broad outage before
   you chase individual surfaces.
4. Cross-reference `lastSyntheticRun` with the **Journeys** tab
   (`/admin/health?tab=journeys`) and `recentAudit` with **Audit logs**
   (`/admin/audit-logs`) for the full timeline.

## 4. Extending the bundle

The assembler takes injected inputs, so new sections are additive: add the
field to `SupportBundle` + `SupportBundleInputs`, resolve it in the route, and —
if it is free-text — it is already covered by the final scrub. The **DR-drill
summary** section is declared as a `note` until DR4's summary store lands; wire
it into the route's `notes`/a new field then.

**Related:** `docs/fiab/runbooks/slo-error-budget.md`,
`docs/fiab/runbooks/synthetic-journeys.md`, `/admin/gates`, `/admin/env-config`.
