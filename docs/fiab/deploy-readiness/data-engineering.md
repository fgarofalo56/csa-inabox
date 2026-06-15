# Deploy-readiness — Synapse / Databricks / ADF / SHIR (data engineering)

Part of `docs/fiab/prp/deploy-readiness-100pct.md`. Goal: every data-engineering
backend is **provisioned + wired (env + RBAC + PE/DNS) ON BY DEFAULT** behind a
`loom<Svc>Enabled` opt-out flag, with a scan-and-choose entry in both the CLI and
the Setup Wizard. Azure-native default works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset (per `no-fabric-dependency.md`).

## Opt-out flags (all default `true` → provision new)

| Flag (`main.bicep` + `landing-zone/main.bicep`) | Backend | `false` effect |
|---|---|---|
| `loomSynapseEnabled` | Synapse workspace (Serverless + dedicated `loompool` + Spark `loompool`) | skips Synapse + autopause + storage RBAC + PEs; admin-plane blanks `LOOM_SYNAPSE_WORKSPACE` → editor honest-gates |
| `loomDatabricksEnabled` | Databricks workspace (+ Access Connector + UC when supported) | skips Databricks + storage RBAC + UC bootstrap; admin-plane blanks `LOOM_DATABRICKS_HOSTNAME(S)` |
| `loomDataFactoryEnabled` | Azure Data Factory (+ geo-enrich starter pipeline) | skips ADF; admin-plane blanks `LOOM_ADF_NAME` |
| `loomSelfHostedIrEnabled` | Scaled self-hosted IR (VMSS scale-to-0 on the DLZ ADF) | skips SHIR VMSS; admin-plane blanks `LOOM_SHIR_VMSS_NAME` |

The admin-plane mirrors ride on the existing `byoExisting` object (`de*` keys) to
stay under the ARM 256-parameter ceiling — no new admin-plane param.

## What each change fixes (vs. the stock `az deployment sub create`)

- **Synapse data-plane RBAC at deploy.** `synapseRoleAssignmentUamiId` is now
  wired to the Console UAMI resource id, so `synapse.bicep`'s Artifact Publisher
  (KQL/SJD authoring) + Compute Operator (notebook Livy run-cell) grant scripts
  run at deploy instead of only via the GHA. The scripts are failure-tolerant
  (`|| echo`) so they no-op safely until the UAMI holds Synapse Administrator
  (granted by the bootstrap mirror), then a re-deploy applies them directly.
- **Databricks host output.** `landing-zone/main.bicep` now emits
  `databricksWorkspaceHost`; the GHA `patch-navigator-env.sh` remains the
  idempotent mirror that patches `LOOM_DATABRICKS_HOSTNAME` post-DLZ so every
  Databricks editor stops honest-gating on first login.
- **ADF decoupled from the private-DNS-zone presence.** ADF now provisions
  whenever `loomDataFactoryEnabled && consolePrincipalId` — a missing
  `privatelink.adf.azure.com` zone only skips the PE DNS group (in `adf.bicep`),
  it no longer silently skips the whole factory while `LOOM_ADF_NAME` still
  pointed at it (the old 502 trap).
- **SHIR on by default.** `main.bicep` auto-generates a complexity-satisfying
  admin password (`effShirAdminPassword`) into the deployment when none is
  supplied, so the VMSS (scale-to-0, no idle cost) provisions without manual
  input. Supply `shirAdminPassword` from Key Vault to override.

## Scan-and-choose

- **CLI** — `scripts/csa-loom/scan-and-deploy.sh`: enumerates subscriptions via
  Azure Resource Graph, prompts **use-existing / provision-new / disable** per
  backend with a recommendation, emits a generated `.bicepparam` (existing IDs
  or `loom<Svc>Enabled=true/false`), then runs `az deployment sub create`.
  `--defaults` is non-interactive (everything new).
- **Wizard** — `GET /api/setup/scan` (`app/api/setup/scan/route.ts`): the
  in-console twin. Session-gated, MI-first credential, returns
  `{ service, existing[], recommendation }` per backend for the per-service
  choice cards. (UI cards in `app/setup/page.tsx` consume this at integration.)

## Bootstrap mirror (kept idempotent)

`.github/workflows/csa-loom-post-deploy-bootstrap.yml` continues to apply the
Synapse Administrator grant, Databricks SCIM/UC, and `patch-navigator-env.sh`.
These are idempotent mirrors of the bicep so re-running is safe (bicep+bootstrap
sync rule). The Databricks front-end private endpoint + in-bicep SCIM/hostname
deploymentScript remain follow-ups (the GHA mirror covers them today, honestly).

## Verification

- `az bicep build --file platform/fiab/bicep/main.bicep` — error-free.
- `az bicep build-params --file platform/fiab/bicep/params/commercial.bicepparam` — error-free.
- `tsc --noEmit` — `app/api/setup/scan/route.ts` clean.
- `bash -n scripts/csa-loom/scan-and-deploy.sh` — clean.
