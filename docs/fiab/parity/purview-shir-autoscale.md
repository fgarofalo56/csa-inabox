# purview-shir-autoscale — parity with Azure Purview self-hosted IR + ADF SHIR auto-scale

Source UI:
- Microsoft Purview governance portal → Data Map → Source management → Integration runtimes
  (https://learn.microsoft.com/purview/manage-integration-runtimes)
- Azure Data Factory → Manage → Integration runtimes (self-hosted) + Author → pipeline run
  (https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime)

## Problem this closes

The repo already had a scale-to-zero **DLZ ADF SHIR** VMSS + a console scale
engine + an idle-stop workflow. The idle-stop workflow's header *claimed* "a
pipeline trigger scales it up" but **no scale-up code existed** — the SHIR only
ever scaled down. And there was **no Purview SHIR at all**, so a Purview scan
that needs a self-hosted IR (on-prem / VNet-isolated source) had nothing to run
on. This task adds:

1. A **shared admin-zone Purview SHIR VMSS** (pre-deployed, scale-to-zero).
2. **Auto-scale-up on trigger** for both ADF pipelines and Purview scans:
   the system detects when a run uses a SelfHosted IR and scales the right VMSS
   0→N before firing the run.

## Hard Azure constraint (why two VMSS, not one)

A Purview SHIR **cannot** be the same runtime/machine as an ADF/Synapse SHIR:
> "the self-hosted integration runtime must be only registered for Microsoft
> Purview and can't be used for Azure Data Factory or Azure Synapse at the same
> time." — learn.microsoft.com/purview/legacy/concept-best-practices-network
> "The Microsoft Purview Integration Runtime can't be shared with an Azure
> Synapse Analytics or Azure Data Factory Integration Runtime on the same
> machine. It needs to be installed on a separated machine."
> — learn.microsoft.com/purview/data-map-integration-runtime-self-hosted

So "shared" = ONE Purview SHIR VM cluster scanning MANY Purview data sources
(supported), deployed as its OWN VMSS in the admin RG — never a re-point of the
ADF SHIR.

## Feature inventory + Loom coverage

| Capability (Azure/Purview) | Loom coverage | Backend |
|---|---|---|
| Pre-deploy a Purview self-hosted IR host | built ✅ | `purview-shir.bicep` — scale-to-0 Windows VMSS in admin hub `snet-reserved`, CustomScript MSI install + `dmgcmd -RegisterNewNode <purviewKey>` |
| Register the SHIR with the Purview account | honest-gate ⚠️ | Node registers via the Purview auth key (`@secure purviewIrAuthKey`). Key read from the Purview scanning data plane (no ARM listAuthKeys on `Microsoft.Purview/accounts`); empty key ⇒ module not deployed |
| Grant the scaling identity rights on the host | built ✅ | Console UAMI → Virtual Machine Contributor (`9980e02c-…`) on the VMSS |
| Start / stop (scale) the SHIR from the admin UI | built ✅ | `ScaleManagePanel` `purview-shir-vmss` card → `POST /api/admin/scaling/compute` → `scaleVmss` |
| ADF: a Copy activity runs on the SHIR when its linked service is pinned `connectVia → SelfHosted IR` | detection built ✅ | `pipelineUsesSelfHostedIr()` walks `getPipeline().activities[]` + dataset→LS, resolves IR type via `listIntegrationRuntimes()` |
| Auto-scale the SHIR up before an ADF pipeline run | built ✅ | `prewarmShirForPipeline()` in adf-pipeline / data-pipeline / geo-pipeline run routes → `ensureShirUp()` (scale 0→N, poll until a node is up) |
| Purview: a scan runs on a SelfHosted IR (`connectedVia`) | detection built ✅ | `scanUsesSelfHostedIr()` GET scan def + GET `/scan/integrationruntimes/{name}` (kind === SelfHosted) |
| Auto-scale the Purview SHIR up before a scan run | built ✅ | `prewarmPurviewShirForScan()` in the Purview scans route → `ensureShirUp(purviewCfg, N)` |
| Scale the SHIR back to 0 when idle | built ✅ | `csa-loom-shir-idle-stop.yml`: ADF arm (zero InProgress/Queued runs) + new Purview arm (zero Running/Queued scan runs). Fail-safe: never scale down on uncertainty |
| Receipt of the scale-up in the run output | built ✅ | run/scan responses carry `usesSelfHostedIr / shirScaledUp / shirCapacity / shirRunningNodes / shirWarning` |

Zero ❌. The only ⚠️ is the documented Purview-key honest gate (a Microsoft data-plane fact, not a Loom gap).

## Backend per control

- Scale-up engine: `vmss-client.ts` `ensureShirUp()` — `getVmssStatus` → PATCH
  `sku.capacity` (ARM `2024-07-01`) → poll. Fail-open: a scale-up failure NEVER
  blocks the run (warning surfaced in the receipt).
- DLZ SHIR config: `shirVmssConfig()` (`LOOM_SUBSCRIPTION_ID` + `LOOM_DLZ_RG` + `LOOM_SHIR_VMSS_NAME`).
- Purview SHIR config: `purviewShirVmssConfig()` (`LOOM_SUBSCRIPTION_ID` + `LOOM_ADMIN_RG` + `LOOM_PURVIEW_SHIR_VMSS_NAME`).
- Detection: ADF `concepts-integration-runtime#determining-which-ir-to-use`; Purview scanning data-plane scan def + IR get.

## No-Fabric / no-vaporware

Entirely Azure-native: Purview Data Map + Compute VMSS + ADF/Purview scanning
REST. No Fabric/Power BI host on any path. Honest gates: `LOOM_PURVIEW_SHIR_VMSS_NAME`
unset ⇒ the panel card is simply absent and the prewarm is a clean no-op; the
ADF SHIR auto-scale-up works the same on every boundary (the Purview arm is off
at IL5 where Purview isn't deployed).

## Bicep + bootstrap sync

- New module `platform/fiab/bicep/modules/admin-plane/purview-shir.bicep`.
- Wired in `admin-plane/main.bicep` as `module purviewShir` (gated on
  `purviewShirEnabled && purviewEnabled && purviewIrAuthKey && purviewShirAdminPassword`).
- New params: `purviewShirEnabled`, `purviewIrAuthKey` (@secure),
  `purviewShirAdminPassword` (@secure), `purviewShirMaxNodes`, `loomPurviewShirVmssName`.
- New env emitted to the Console: `LOOM_PURVIEW_SHIR_VMSS_NAME`.
- Idle-stop workflow gains the Purview arm (`PURVIEW_ACCOUNT`/`PURVIEW_VMSS`/`ADMIN_RG`).

## Verification (real data E2E)

With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET:
- `GET /api/admin/scaling/compute` lists the `purview-shir-vmss` card with live
  capacity/state when `LOOM_PURVIEW_SHIR_VMSS_NAME` is set; absent otherwise.
- `POST /api/items/adf-pipeline/{id}/run` on a pipeline whose linked service is
  pinned to the SHIR returns `shirScaledUp:true` + the runId after the VMSS goes
  0→4 (real PATCH on `sku.capacity`).
- `POST /api/admin/security/purview/scans { source, scan }` on a SelfHosted-IR
  scan returns `shirScaledUp:true` + the scan runId.
