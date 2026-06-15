# setup-scan-and-choose — CLI ⇄ Setup Wizard parity

Source: deploy-readiness PRP `docs/fiab/prp/deploy-readiness-100pct.md` §B (scan-and-choose).
This surface has no Azure/Fabric portal twin — its "parity" contract is that the
**CLI** (`scripts/csa-loom/scan-and-deploy.sh`) and the **Setup Wizard** "Scan &
choose" step (`/setup`) offer the *same* pre-deploy scan, the *same* per-service
choice, and the *same* recommendation, so a headless deploy and an interactive
deploy land identical wiring.

## The scan-and-choose contract (both surfaces)

For every Loom-integrable Azure service, scan every subscription the caller can
see and offer **Use existing / New / Disable** with a **recommendation**:

| Candidates found | Recommendation |
|---|---|
| 0 | **New** (provision fresh — everything-ON default) |
| exactly 1 | **Use existing** (reuse it) |
| > 1 | **New** (ambiguous; operator overrides) |
| Purview, any count ≥ 1 | **Use existing** (one Enterprise Purview per tenant) |

Default posture is **everything-ON (opt-out)** — nothing is left unconfigured.

## Coverage

| Capability | CLI `scan-and-deploy.sh` | Setup Wizard `/setup` | Backend |
|---|---|---|---|
| Enumerate subscriptions | ✅ `az account list` | ✅ ARM `GET /subscriptions` (existing step) | ARM |
| Per-service existing-instance scan | ✅ `az graph query` (graph; `az resource list` fallback) | ✅ `GET /api/setup/discover-services` (Azure Resource Graph) | Resource Graph |
| Recommendation per service | ✅ `recommend()` | ✅ route `recommendation`/`recommendedCandidate` | — |
| 3-way choice (existing/new/disable) | ✅ interactive prompt + `--defaults` | ✅ Fluent SegmentedControl + candidate Dropdown | — |
| Everything-ON opt-out default | ✅ `--defaults` = all New | ✅ recommendation pre-seeds each row | — |
| Required bootstrap admin (PRP gap #4) | ✅ `--tenant-admin-oid` (refuses deploy if unset) | ✅ existing wizard config carries `loomTenantAdminOid` | — |
| Emit `.bicepparam` + `EXISTING_*` env | ✅ self-contained param + `temp/*.byo-exports.sh` | n/a (deploy route builds `-p` lines) | — |
| Thread choices into deploy | ✅ `az deployment sub create -p …` | ✅ `serviceChoices` → `POST /api/setup/deploy` `-p existing<Svc>*` / `loom<Svc>Enabled` | ARM |
| Post-deploy RBAC on reused resources | ✅ `grant-navigator-rbac.sh` + `patch-navigator-env.sh` | ✅ existing `/api/setup/wire-existing` path | ARM RBAC |
| No-Fabric default | ✅ `fabricEnabled=false` (BYO_FABRIC opt-in, gov hard-false) | ✅ inherited from boundary param | — |
| Honest gate when scan unavailable | ✅ prints `az`/login remediation | ✅ MessageBar `intent="warning"` + 503 `not_configured` | — |

## Service set (one-for-one between both surfaces)

aisearch · apim · adx · foundry (AOAI) · purview · maps · synapse · cosmos ·
adf · eventhubs · databricks · storage · postgres · keyvault.

The CLI `SERVICES[]` table, the route's `SERVICES` array, and the deploy route's
`SERVICE_PARAM_MAP` share the canonical `EXISTING_*` env names and the
`loom<Svc>Enabled` flags, so all three (CLI, wizard, post-deploy scripts) agree.

## Backend per control

- `GET /api/setup/discover-services` — Azure Resource Graph
  (`POST {arm}/providers/Microsoft.ResourceGraph/resources`), gated on
  `admin.deploy-dlz` (Admin). Honest 503 `not_configured` when the identity
  lacks Reader/Graph.
- `POST /api/setup/deploy` — translates `serviceChoices` into `-p existing<Svc>*`
  / `loom<Svc>Enabled` assignments on the real `az deployment sub create`
  command (orchestrator body, GitHub dispatch, or copy-paste gate).
- `scripts/csa-loom/scan-and-deploy.sh` — `az deployment sub create` +
  `grant-navigator-rbac.sh` / `patch-navigator-env.sh` on reused resources.

## Notes

- The everything-ON enable-flag defaults (`purviewEnabled`/`aiSearchEnabled`
  flipped to true in the boundary params, plus `loom<Svc>Enabled` opt-out flags
  for the DLZ services) are owned by the per-backend deploy-readiness domains
  (Purview/AOAI/Storage/Synapse/Databricks/RTI agents). This surface sets them
  per-choice at scan time, so `--defaults` is everything-ON regardless of the
  committed boundary-param default.
