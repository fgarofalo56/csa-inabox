# CSA Loom — Full deployment completeness + Bring-Your-Own services design

**Date:** 2026-06-01
**Author:** investigation for `admin@contoso.gov`
**Scope:** the live `limitlessdata` deployment (DLZ sub `363ef5d1-…`) +
a one-button "complete Loom" deploy that reuses existing services (especially
the tenant Purview) with **no Microsoft Fabric dependency**.

> **Headline:** the live deployment is *far* more complete than the "only ~2 RGs,
> everything says not-configured" report suggests. **Both** Loom RGs plus the
> expected managed RGs are deployed and richly populated, and the console already
> wires APIM, AI Search, Databricks, ADX, Synapse, Cosmos, Event Hubs, Foundry,
> Content Safety, MSAL. The "not configured" gates that remain are a **short,
> specific list** — chiefly **Purview** (the existing one is cross-subscription
> in DMLZ, which the live-wiring script doesn't scan), **Azure Maps**, and
> **Cosmos Gremlin/Vector** (DLZ emits them but the orchestrator never passes
> them to the console). None require redeploying the platform.

---

## 1. Expected vs actual deployment

### 1.1 Resource groups a full single-sub Loom creates

`platform/fiab/bicep/main.bicep` (subscription scope) creates exactly **two**
RGs itself; everything else is platform-managed RGs spawned by the services it
deploys. So "docs say 5-6 RGs, I see 2" is the *expected* shape — the extra RGs
are auto-managed.

| RG | Created by | Live status |
|---|---|---|
| `rg-csa-loom-admin-eastus2` | `main.bicep` (adminPlaneRg) | **PRESENT** |
| `rg-csa-loom-dlz-single-eastus2` | `main.bicep` (singleDlzRg) | **PRESENT** |
| `ME_cae-csa-loom-eastus2_rg-csa-loom-admin-eastus2_eastus2` | Container Apps Env (managed) | PRESENT |
| `rg-mng-adb-loom-default-eastus2-*` | Databricks workspace (managed) | PRESENT |
| `synapseworkspace-managedrg-*` | Synapse workspace (managed) | PRESENT (×2) |
| `safoundryhub…_managed` / `ai_appi-*_managed` | Foundry / App Insights (managed) | PRESENT |

That is the 5-6 RG count the docs reference. Nothing structural is missing.

### 1.2 Major resources — expected vs live

**Admin plane (`rg-csa-loom-admin-eastus2`) — all present:**
LAW `law-csa-loom-eastus2` + Sentinel, App Insights `ai-csa-loom-eastus2`,
hub VNet `vnet-csa-loom-hub-eastus2`, **Azure Firewall** `fw-csa-loom-eastus2` +
policy `fwpol-csa-loom-eastus2`, Bastion, all 8 UAMIs (`uami-loom-*`),
Key Vault `kv-loom-m56yejezt7bjo`, ACR `acrloomm56yejezt7bjo`, Container Apps Env
`cae-csa-loom-eastus2`, **all 6 Loom apps** (`loom-console`, `loom-mcp`,
`loom-setup-orchestrator`, `loom-activator`, `loom-mirroring`,
`loom-direct-lake-shim`), **ADX cluster** `adx-csa-loom-shared`
(DBs: `loomdb-default`, plus user DBs), AI Foundry `aifoundry-csa-loom-eastus2`
+ project `loom-project-default`, Content Safety `cs-loom-eastus2` /
`csloomcontentsafety-eastus2`, **VPN GW** `vgw-loom-eastus2`, **App GW**
`agw-loom-eastus2`, **Front Door** `fd-loom-m56yejezt7bjo`, ~26 private DNS zones
+ private endpoints.

**DLZ (`rg-csa-loom-dlz-single-eastus2`) — all present:**
spoke VNet, **Databricks** `adb-loom-default-eastus2`, **Cosmos**
`cosmos-loom-default-mwfaiy3trukkk`, **ADLS Gen2** `saloomdefaultmwfaiy3truk`
(bronze/silver/gold/landing), **Event Hubs** `evhns-loom-default-eastus2`,
**Synapse** `syn-loom-default-eastus2` + dedicated pool `loompool`, **ADF**
`adf-loom-default-eastus2`, Synapse auto-pause automation, UAT jumpbox.

**Genuinely NOT deployed (these are the real gaps):**

| Expected (param) | Live | Why it's off | UI impact |
|---|---|---|---|
| AI Search **native** (`aiSearchEnabled`) | **NOT deployed** (param `false`, eastus2 capacity exhausted) | reused instead → `search-loom-westus3` + `dlz-aisearch-dev-eastus2` wired | none — reuse covers it |
| **Azure Maps** account (`azureMapsEnabled=true` default) | **NOT present** in admin RG; `LOOM_AZURE_MAPS_ACCOUNT` unset | the deployed revision predates the maps module **and** the bicep self-wiring gap (audit-T94, now fixed: the module output is fed to `LOOM_AZURE_MAPS_ACCOUNT` + `NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT` automatically; `patch-navigator-env.sh` discovers it on the live path) | geo-map / map editors gate to OSM until the fix redeploys / the patch runs |
| **Cosmos Gremlin + NoSQL Vector** | DLZ module emits outputs but **top-level `main.bicep` never passes them to admin-plane** | wiring gap in `main.bicep` (outputs exist on `singleDlz`, not forwarded) | graph + vector-store editors gate |
| **Purview** env (`LOOM_PURVIEW_ACCOUNT`) | **UNSET on live console** | existing Purview is in **DMLZ sub**, not scanned by `patch-navigator-env.sh` | `/admin/security` Purview tab + `/catalog` Purview federation + `register-purview` → 501/503 |
| **MIP / DLP** (`loomMipEnabled`/`loomDlpEnabled`) | unset (off by default) | requires Graph AppRole admin-consent first | `/admin/security` MIP + DLP tabs → 503 (expected, honest gate) |

### 1.3 Missing-env-var → UI-gate mapping (the "not configured" source)

Confirmed by reading the live `loom-console` env (`az containerapp show … env`)
and cross-referencing the editor clients in `apps/fiab-console/lib/azure/*`:

| Missing/empty env var | Console surface that gates | Backing client |
|---|---|---|
| `LOOM_PURVIEW_ACCOUNT` | `/admin/security` Purview tab; `/catalog` Purview federation; `register-purview` action | `lib/azure/purview-client.ts` → `PurviewNotConfiguredError` (HTTP 501 + hint) |
| `LOOM_MIP_ENABLED` | `/admin/security` Information Protection tab | Graph MIP client → 503 |
| `LOOM_DLP_ENABLED` | `/admin/security` DLP tab | Graph DLP client → 503 |
| `LOOM_AZURE_MAPS_ACCOUNT` (+ `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY`) | geo-map / geo-pipeline / map editors | map editor → OSM fallback + MessageBar |
| `LOOM_COSMOS_GREMLIN_ENDPOINT` | cosmos-gremlin-graph editor | gremlin client → honest gate |
| `LOOM_COSMOS_VECTOR_ENDPOINT` | vector-store editor | vector client → persists spec only |

**Everything else the console needs is already set and live** — `LOOM_APIM_NAME`
(=`dml-ai-east-aigateway`, reused), `LOOM_AI_SEARCH_SERVICE`
(=`search-loom-westus3`, reused), `LOOM_DATABRICKS_HOSTNAME`,
`LOOM_KUSTO_CLUSTER_URI`, `LOOM_SYNAPSE_WORKSPACE`, `LOOM_ADF_NAME`,
`LOOM_COSMOS_*`, `LOOM_EVENTHUB*`, `LOOM_FOUNDRY_*`, `LOOM_CONTENT_SAFETY_ENDPOINT`,
MSAL, storage lake URLs. So the perception that "many pages say not configured"
maps to a **handful** of surfaces, dominated by the Purview tab.

### 1.4 Two real code defects found

1. **Cross-sub Purview is never discovered.** `patch-navigator-env.sh:177`
   runs `az purview account list --query "[0].name"` against the **current
   (DLZ) sub only** → no result → `LOOM_PURVIEW_ACCOUNT` left empty. The
   existing Purview lives in DMLZ. Fix: scan all subs, or honor the override.
2. **Override var name mismatch.** `discover-services.sh:69` exports
   `EXISTING_PURVIEW=…`, but `patch-navigator-env.sh:175` reads
   `EXISTING_PURVIEW_ACCOUNT`. Sourcing the discover output never sets the var
   the patch script looks for. (Pick one name; recommend `EXISTING_PURVIEW`.)
3. **Gremlin/Vector outputs orphaned.** `landing-zone/main.bicep` emits
   `cosmosGremlinEndpoint` / `cosmosVectorEndpoint`, and `admin-plane/main.bicep`
   accepts `loomCosmosGremlinEndpoint` / `loomCosmosVectorEndpoint` params — but
   top-level `main.bicep` never forwards `singleDlz.outputs.*` into the
   `adminPlane` module params. The wiring path exists end-to-end except this
   one hop.

---

## 2. Existing reusable-services inventory (all 4 subs)

Login `admin@contoso.gov`. Console UAMI principal to grant on reused
resources: **`<uami-principal-id>`** (`uami-loom-console-eastus2`,
clientId `<uami-client-id>`).

Subs: **DLZ** `<subscription-id>` ·
**DMLZ** `<subscription-id>` ·
**ALZ** `<subscription-id>` ·
**Main** `<subscription-id>`.

### Microsoft Purview (the one the operator wants wired)

| Name | Sub | RG | Resource ID |
|---|---|---|---|
| **`dmlz-dev-purview-eastus`** | DMLZ | `rg-dmlz-dev-governance-eastus` | `/subscriptions/<subscription-id>/resourceGroups/rg-dmlz-dev-governance-eastus/providers/Microsoft.Purview/accounts/dmlz-dev-purview-eastus` |

Only one Purview exists across all 4 subs — and one Enterprise Purview is the
tenant max, so this is the canonical reuse target.

### API Management

| Name | Sub | RG |
|---|---|---|
| `dml-ai-east-aigateway` (currently wired into Loom) | DLZ | `rg-dlz-aiml-stack-dev` |
| `apim-cpeacock-ai` | Main | `rg-cpeacock-ai` |

### Log Analytics workspaces (reuse candidates)

| Name | Sub | RG |
|---|---|---|
| `law-csa-loom-eastus2` (Loom's own) | DLZ | `rg-csa-loom-admin-eastus2` |
| `amlworkspace016595958609` | DLZ | `rg-dlz-aiml-stack-dev` |
| `law-assurancenet-dev` | DLZ | `rg-assurancenet-monitoring-dev` |
| `alz-dev-dataObservability-logAnalyticsWorkspace` | ALZ | `rg-alz-dev-logging` |
| `atlasdiag-law`, `forzelite-dev-law`, `log-atlas-dev-eus2`, … | Main | various |

### Azure Firewall / firewall policy

| Name | Sub | RG |
|---|---|---|
| `fw-csa-loom-eastus2` + `fwpol-csa-loom-eastus2` (Loom's own) | DLZ | `rg-csa-loom-admin-eastus2` |
| `alz-azfw-eastus` + `alz-azfwpolicy-eastus` | ALZ | `rg-alz-dev-hubnetwork-eastus` |

### Synapse

| Name | Sub | RG |
|---|---|---|
| `syn-loom-default-eastus2` (Loom's own) | DLZ | `rg-csa-loom-dlz-single-eastus2` |
| `synapse-sandbox-east2-dlz` | DLZ | `rg-sandbox-demo-east2` |
| `sysnapse-sandbox-east2` | Main | `rg-sandbox-demo-east2` |

### Databricks

| Name | Sub | RG |
|---|---|---|
| `adb-loom-default-eastus2` (Loom's own) | DLZ | `rg-csa-loom-dlz-single-eastus2` |
| `dbw-btfabric-dev` | DLZ | `rg-btfabric-tut57-dev` |
| `adb-eastus2-sandbox` | ALZ | `rg-databricks-eastus2-sandbox` |

### AI Search

`az search service list` returned no enumerable services via the SDK in this
run, but the live console is wired to **`search-loom-westus3`** (Loom-owned,
admin RG) and **`dlz-aisearch-dev-eastus2`** (`rg-dlz-aiml-stack-dev`, DLZ) —
both already reused, so AI Search is covered.

### Cosmos DB

`cosmos-loom-default-mwfaiy3trukkk` (Loom's own, DLZ `rg-csa-loom-dlz-single-eastus2`),
plus sandbox accounts in `rg-dlz-cosmosdb-east2-sandbox`,
`rg-dlz-dev-cosmosdb-eastus2`.

### Event Hubs

`evhns-loom-default-eastus2` (Loom's own, DLZ), plus `rg-dlz-streaming-dev`.

### Cognitive / AI Services (Foundry/AOAI reuse candidates)

| Name | Kind | Sub | RG |
|---|---|---|---|
| `aifoundry-csa-loom-eastus2` (Loom's own) | AIServices | DLZ | `rg-csa-loom-admin-eastus2` |
| `fgarofalo-westus3-resource`, `ala-ai-west2-resource` | AIServices | DLZ | `dlz-foundry` |
| `dml-ai-eastus-sandbox`, `azopenai-dev-eastus2`, `alz-ai-services-westus`, `fgaro-mdg63bud-eastus2` | AIServices/OpenAI | DLZ | `rg-dlz-aiml-stack-dev` |
| `oai-cpeacock-ai`, `forzelite-dev-aoai-ebbzvf` | OpenAI | Main | `rg-cpeacock-ai`, `rg-forzelite-dev-eastus2` |

### Fabric capacities (informational — Loom does **not** depend on Fabric)

| Name | Sub | RG |
|---|---|---|
| `fabriccaplimitlessdatadev` | DLZ | `fabric-dev` |

No-Fabric mode keeps `LOOM_FABRIC_BASE` set (runtime gates on UAMI authz) but the
deployment provisions **no** Fabric capacity and binds no workspace — see §3.6.

---

## 3. Existing-Purview wiring recipe (no redeploy)

The console reads exactly one env var for Purview: **`LOOM_PURVIEW_ACCOUNT`** =
the **short account name** `dmlz-dev-purview-eastus` (NOT a URL — the client
appends `-api.purview.azure.com`, scope `https://purview.azure.net/.default`,
API `2026-03-20-preview`). Two steps:

### 3a. Set the env var on the live console (immediate)

```bash
az containerapp update -n loom-console -g rg-csa-loom-admin-eastus2 \
  --subscription <subscription-id> \
  --set-env-vars LOOM_PURVIEW_ACCOUNT=dmlz-dev-purview-eastus
```

(or persistent: in `commercial-full.bicepparam` it already defaults to
`dmlz-dev-purview-eastus` — the live env just predates that param value.)

### 3b. Grant the Console UAMI Purview data-plane roles (NOT ARM RBAC)

Per `purview-client.ts`, the UAMI principal
`<uami-principal-id>` needs **Data Curator** + **Data Product
Owner** at the governance-domain level, assigned in the **Purview portal**
(`https://dmlz-dev-purview-eastus.purview.azure.com` → Data Map / Unified
Catalog → Roles), because Purview data-plane roles are not Azure RBAC. For
classic Data Map reads also add **Data Reader** on the root collection.

> The existing Purview is in the **DMLZ** subscription, so this is a genuine
> cross-tenant-of-subs reuse. The UAMI lives in DLZ; Purview portal role grants
> are tenant-scoped (same Entra tenant `d1fc0498-…`), so the cross-sub boundary
> doesn't block it.

### 3c. Fix the discovery scripts so this is automatic next time

- `patch-navigator-env.sh`: change the Purview probe to scan **all** subs
  (`for s in $SUBS; az purview account list --subscription $s …`) and to honor
  `EXISTING_PURVIEW` (align the var name).
- `discover-services.sh` / `patch-navigator-env.sh`: unify on `EXISTING_PURVIEW`.

---

## 4. Bring-Your-Own (BYO) design — choose EXISTING vs NEW per service

### 4.1 What already exists (build on this)

The repo already has a real reuse-first spine (`docs/fiab/bring-your-own-services.md`):
- **Params**: `existingAiSearchService/Rg`, `existingApimName/Rg`,
  `existingAdxClusterName/Rg`, `existingFoundryAccountName/Rg` in both
  top-level and admin-plane `main.bicep`; `loomPurviewAccount` for Purview.
- **Gating**: admin-plane modules use `if (xEnabled && empty(existingX))` so
  naming an existing one never deploys a duplicate; console env uses
  `!empty(existingX) ? existing : (xEnabled ? module.output : '')`.
- **Scripts**: `discover-services.sh` (read-only cross-sub inventory →
  `EXISTING_*` exports), `grant-navigator-rbac.sh` (UAMI roles),
  `patch-navigator-env.sh` (live env reconcile).

### 4.2 Proposed full BYO param surface (close the gaps)

Add `existing<Svc>{Name,Rg,Sub}` for the services that currently can only be
reused via the post-deploy script, so a **single bicepparam** fully expresses
intent at deploy time:

| Service | Reuse params (add `…Sub` for cross-sub) | New-flag | Status |
|---|---|---|---|
| AI Search | `existingAiSearchService/Rg` | `aiSearchEnabled` | exists |
| APIM | `existingApimName/Rg` | `apimEnabled` | exists |
| ADX/Kusto | `existingAdxClusterName/Rg` | `adxEnabled` | exists |
| Foundry/AOAI | `existingFoundryAccountName/Rg` | `aiFoundryEnabled` | exists |
| **Purview** | `existingPurviewAccount` (+ `…Sub`) → sets `loomPurviewAccount` | `purviewEnabled` | **add `…Sub`** |
| **Log Analytics** | `existingLawId` (full resourceId) | always-new | **add** |
| **Azure Firewall** | `existingFirewallPolicyId` / skip-hub-fw flag | always-new | **add** |
| **VNet / hub networking** | `existingHubVnetId` + subnet name map | always-new | **add** |
| **Key Vault** | `existingKeyVaultId` | always-new | **add** |
| **Cosmos (navigator)** | `existingCosmosAccount/Rg` | DLZ-new | partial (env only) |
| **Event Hubs** | `existingEventHubNamespace/Rg` | DLZ-new | partial (env only) |
| **Databricks** | `existingDatabricksHostname` | DLZ-new | partial (env only) |
| **Synapse** | `existingSynapseWorkspace/Rg` | DLZ-new | **add** |
| **Fabric** | `fabricEnabled=false` (no-Fabric mode) | — | **add explicit flag** |

Add `…Sub` to every reuse pair so cross-sub reuse (like the DMLZ Purview) is a
first-class deploy-time input, not a post-deploy patch.

### 4.3 Recommended mechanism: **bicepparam-generator script** (not a live wizard)

Two viable approaches:

- **(A) Interactive wizard in the console** (`/admin/setup`): nicer UX but
  requires the console to already be running with broad ARM write perms, and
  duplicates bicep logic in TypeScript. Higher build cost, weaker as the
  *first* deploy of a clean sub.
- **(B) `bicepparam`-generator CLI** (`scripts/csa-loom/byo-wizard.sh`):
  extends the existing `discover-services.sh`. It scans all subs, presents each
  reusable service with the candidates found, prompts **reuse `<name>` / new /
  gate** per service, and **emits a ready `params/<name>.generated.bicepparam`**
  plus a matching `EXISTING_*` env file for the post-deploy scripts.

**Recommendation: (B), the generator script.** It (1) reuses the read-only
discovery already written, (2) produces an auditable, committable artifact that
`az deployment sub create` consumes directly, (3) works on a *clean* sub before
any console exists, and (4) keeps one source of truth (bicep) instead of forking
provisioning logic into the SPA. A console wizard can be layered later as a thin
front-end that writes the same bicepparam.

### 4.4 Orchestrator gating pattern (uniform rule)

Every reusable service follows one rule in `main.bicep` / `admin-plane/main.bicep`:

```bicep
// provision only when not reusing AND the new-flag is on
module x 'x.bicep' = if (xEnabled && empty(existingXName)) { … }

// console env: reuse > provisioned > honest-gate
{ name: 'LOOM_X', value: !empty(existingXName)
    ? existingXName
    : (xEnabled ? x!.outputs.name : '') }
```

For cross-sub reuse, resolve RG/sub with
`var byoXSub = !empty(existingXSub) ? existingXSub : subscription().subscriptionId`
and pass it into the env var + the RBAC script. **Goal: zero manual post-deploy
config** — the console lights up green from either reused or freshly-deployed
backends, and only ever shows an honest MessageBar when a service was
deliberately left gated.

### 4.5 Forward the orphaned DLZ outputs (one-line fix per output)

**Status (T95, 2026-06): the Cosmos Gremlin + vector hop is now wired.**
Top-level `main.bicep` no longer reads the orphaned `singleDlz.outputs.*` (that
would create a cycle — `adminPlane` deploys before `singleDlz`). Instead it
computes the deterministic account names inline (`cosmos-loom-gremlin-default-<uniqueString(singleDlzRg.id)>`
and `cosmos-loom-vec-default-…`) — the same pattern used for `amlWorkspaceName`
/ `loomCosmosAccount` — and passes `loomCosmosGremlinEndpoint` (+ `…Database`=`loom-graph`,
`…Graph`=`default`) and `loomCosmosVectorEndpoint` (+ `…Database`=`loom-vectors`,
`…Container`=`docs-vec`) into the `adminPlane` module, gated on
`deploymentMode == 'single-sub' && cosmosGraphVectorEnabled`. The sovereign host
suffix (`gremlin.cosmos.azure.us` / `azure.com`) is derived from `boundary`. The
DLZ Gremlin private endpoint now also lands in a dedicated
`privatelink.gremlin.cosmos.azure.*` zone (added to `admin-plane/network.bicep`
+ surfaced as the `cosmosGremlin` key), so the `wss://` host resolves over
Private Link. The graph + vector editors therefore work on a default
single-sub deploy with no manual config.

**Multi-sub** still uses `patch-navigator-env.sh` for these two (one Console
env can't statically reference N DLZ accounts).

Other still-orphaned DLZ outputs follow the same one-hop pattern.

### 4.6 No-Fabric mode

Add an explicit `fabricEnabled bool = false` param. When false: provision no
Fabric capacity, bind no workspace, leave `loomDefaultFabricWorkspace` empty.
`LOOM_FABRIC_BASE` stays set (the runtime gates Fabric calls on UAMI authz and
surfaces an honest MessageBar), so the rest of the console is unaffected. The
catalog federates **Purview + Unity Catalog + ADLS/OneLake-by-storage** without
Fabric. This matches the operator's "no Microsoft Fabric dependency" requirement.

---

## 5. Prioritized live-tenant completion plan

Make the **current** limitlessdata deployment a complete, all-green Loom. No
platform redeploy required — all of P0/P1 are live `az containerapp update`
env patches + portal role grants.

### P0 — wire the existing Purview (the operator's explicit ask)

1. **Grant UAMI Purview roles** in the `dmlz-dev-purview-eastus` portal:
   Data Curator + Data Product Owner (+ Data Reader on root collection) to
   principal `<uami-principal-id>`.
2. **Set the env var** on the live console:
   ```bash
   az containerapp update -n loom-console -g rg-csa-loom-admin-eastus2 \
     --subscription <subscription-id> \
     --set-env-vars LOOM_PURVIEW_ACCOUNT=dmlz-dev-purview-eastus
   ```
   Result: `/admin/security` Purview tab + `/catalog` Purview federation +
   `register-purview` go green.

### P1 — close the remaining honest gates

3. **Azure Maps**: now fully automatic on a fresh deploy. `azure-maps.bicep`
   provisions a Gen2 / `G2` account, writes the primary key to KV as
   `loom-azure-maps-primary-key`, and (audit-T94) `main.bicep` feeds the module
   output into `LOOM_AZURE_MAPS_ACCOUNT` + `NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT`
   and the `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` secretRef — no manual
   `--set-env-vars` step. For an already-running revision that predates the fix,
   run `scripts/csa-loom/patch-navigator-env.sh` (it discovers the Maps account
   + primary key and patches the live console). To bring your own account, set
   `EXISTING_AZURE_MAPS_ACCOUNT`. Lights up geo-map / map editors.
4. **Cosmos Gremlin + Vector**: enable `cosmosGraphVectorEnabled` on the DLZ
   Cosmos account (it defaults true — verify the graph/vector containers exist
   on `cosmos-loom-default-mwfaiy3trukkk`), then patch the console:
   `LOOM_COSMOS_GREMLIN_ENDPOINT`, `_DATABASE`, `_GRAPH`,
   `LOOM_COSMOS_VECTOR_ENDPOINT`, `_DATABASE`, `_CONTAINER`. Lights up the
   graph + vector-store editors.
5. **MIP / DLP** (optional, when ready): run
   `scripts/csa-loom/grant-graph-approles.sh` for the Console UAMI
   (InformationProtectionPolicy.Read.All, Policy.Read.All,
   SecurityAlert.Read.All) + admin consent, then
   `--set-env-vars LOOM_MIP_ENABLED=true LOOM_DLP_ENABLED=true`.

### P2 — fix the scripts so a fresh deploy is automatically complete

6. **Patch `patch-navigator-env.sh`** to scan all subscriptions for Purview and
   honor `EXISTING_PURVIEW` (cross-sub), so the DMLZ Purview is auto-discovered.
7. **Unify the override var name** (`EXISTING_PURVIEW`) across
   `discover-services.sh` and `patch-navigator-env.sh`.
8. **Forward the orphaned Gremlin/Vector DLZ outputs** in `main.bicep` (§4.5),
   or extend `patch-navigator-env.sh` to set them from the live Cosmos account.
9. **Add the missing `existing<Svc>{Name,Rg,Sub}` params** (§4.2) +
   `fabricEnabled=false` (§4.6) so the next clean-sub one-button deploy fully
   reuses what already exists with zero manual post-deploy config.

### Verification

After P0+P1, re-run the validate workflow (`csa-loom-validate` /
`pnpm uat`) and a minted-session walk of `/admin/security`, `/catalog`, the
geo-map editor, and the graph/vector editors — each should return real data or a
deliberate honest gate, never a fake (`no-vaporware.md`).

---

### Appendix — key live identifiers

- DLZ sub `<subscription-id>`, tenant `<tenant-id>`
- Console UAMI principal `<uami-principal-id>`, clientId `<uami-client-id>`
- Existing Purview `dmlz-dev-purview-eastus` (DMLZ `e093f4fd-…`, RG `rg-dmlz-dev-governance-eastus`)
- Reused APIM `dml-ai-east-aigateway` (DLZ `rg-dlz-aiml-stack-dev`)
- Reused AI Search `search-loom-westus3` + `dlz-aisearch-dev-eastus2`
- ADX `adx-csa-loom-shared` (DB `loomdb-default`), Foundry `aifoundry-csa-loom-eastus2`
