# Dimension: external-deployer + 3-cloud matrix (Commercial / GCC / MAG+GCC-High)

> Produced by the gov-deployer audit agent, 2026-07-02. Perspective: a
> brand-new government customer who cloned the public repo and deploys into
> their own tenant following only what the repo says.

**Verdict:** The Azure data-plane engineering is cloud-complete and genuinely
well built — one sovereign-aware module (`apps/fiab-console/lib/azure/cloud-endpoints.ts`)
verified against Microsoft Learn. The failures a stranger hits are in
**on-ramp and M365-family surfaces**: the root README sends them to the wrong
stack, the "60-minute quickstart" leads with an `azd` path that isn't wired,
and Power BI / Power Platform / Copilot Studio only partially switch to
GCC/Gov endpoints — worst in the Commercial-Azure + GCC-M365 case.

## (a) Documented-path walkthrough — stranger-gets-stuck points

- **A1 — Entry point sends the stranger to the wrong product (stall).** Root
  `README.md` is about the legacy "CSA-in-a-Box" data platform (QUICKSTART.md,
  `deploy/bicep/`, `portal/`, `cli/`, `make setup`). `platform/fiab/` +
  `apps/fiab-console/` are never named; CSA Loom docs are buried at nav
  position 999 (`mkdocs.yml:1383` "moved to end of nav per user request"). A
  stranger deploys the wrong thing.
- **A2 — Quickstart `azd` happy path is not executable (fail).**
  `docs/fiab/deployment/quickstart.md` says `cd platform/fiab` → `azd init -t .`
  → `azd up`, but the azd file is at `platform/fiab/azd/azure.yaml` and is
  marked `Status: SCAFFOLDED` (line 3); there is **no `main.parameters.json`
  anywhere in the repo**; `deploymentMode` has no default; `azure.yaml`
  documents `CSA_LOOM_*` env names that match nothing. `azd up` cannot work.
- **A3 — Two entry docs, two tools.** The WORKING path is
  `az deployment sub create --template-file platform/fiab/bicep/main.bicep
  --parameters params/<boundary>.bicepparam --parameters adminEntraGroupId=...`
  (per `docs/fiab/deployment/gcc-high.md` + `scripts/csa-loom/redeploy-gov.sh`),
  contradicting the quickstart.
- **A4 — Commercial param file hardcodes the operator's admin group (fail).**
  `platform/fiab/bicep/params/commercial-full.bicepparam:184`
  `adminEntraGroupId = '716f5ec5-20d0-4713-9e42-57ef931cd665'` → a stranger's
  deploy grants admin to a nonexistent group; no one can open `/admin/*`.
- **A5 — Long-lead Gov prerequisites, no pre-flight.** AOAI quota
  usgovvirginia + usgovarizona (embeddings = Arizona-only), Power BI Premium
  F-SKU, Databricks Premium quota — no script verifies before a 70–110-min
  deploy.
- **A6 — Front Door origin ACA-vs-AKS (verify).**
  `modules/admin-plane/front-door.bicep` is written for a Container Apps
  Private Link origin (`caeId`, `caeDefaultDomain`); GCC-High/IL5 use
  `containerPlatform='aks'` while `gcc-high.bicepparam:192` sets
  `frontDoorEnabled=true`. Verify main.bicep adapts the origin for AKS. (Note:
  Front Door Standard/Premium IS GA in Azure Government — the il5.bicepparam
  "not IL5-certified" comment is stale.)

## (b) Cloud matrix

Legend: OK = correct on default/derived path · auto = switches from `boundary`
· env-only = switch exists but shipped param files don't set it · none = no
switch (hardcoded commercial) · N/A = not in that cloud (honest-gated).

| Component / integration | Commercial | Commercial + GCC | MAG + GCC-High/IL5 |
|---|---|---|---|
| ARM, Entra sign-in, Microsoft Graph | OK | OK | OK auto (`usgovcloudapi.net`, `login.microsoftonline.us`, `graph.microsoft.us`) |
| ADLS/Synapse/ADX/Cosmos/KV/Event Hubs | OK | OK | OK auto (`*.usgovcloudapi.net`) |
| Azure OpenAI / AI Foundry / AI Search | OK | OK | OK auto; Foundry Agent Svc→MAF; AI Search off-by-default |
| Container host / APIM / Functions | ACA/PremiumV2/Flex | same | auto → AKS / Premium / EP1 |
| Databricks UC / SQL Warehouse | OK | OK | N/A (Hive + Synapse Serverless fallback) |
| Azure Analysis Services / Azure Maps | OK | OK | N/A (honest-gated) |
| Content Safety | OK | OK | GCC-High OK; IL5/DoD N/A |
| Front Door | OK | OK | OK (GA in Gov); verify ACA-vs-AKS origin (A6) |
| Microsoft Fabric / Activator | opt-in | opt-in | N/A (`assertFabricFamilyAvailable` throws → Azure-native) |
| **Power BI REST host** | OK | **env-only / likely wrong — B1** | OK auto (`api.powerbigov.us`) |
| **Power BI embed host** | OK | **needs-switch** (`app.powerbi.com` → should be powerbigov.us) | OK auto |
| **Power Platform bases (BAP/PowerApps/Flow)** | OK | **env-only, unset in gcc.bicepparam → commercial (B2)** | **env-only, unset (B2)** |
| **Power Platform token scopes** | OK | **none — hardcoded commercial (B3)** | **none (B3)** |
| Copilot Studio DirectLine | OK | env-only, unset | env-only, unset (Gov = `…azure.us`) |
| Dataverse host | OK | OK (per-env) | OK (per-env) |

### M365-family blockers (both non-commercial columns)

- **B1 — Power BI host↔scope mismatch in GCC.** `admin-plane/main.bicep:3581`
  pins GCC host to commercial `api.powerbi.com` while `:3588` gives GCC the Gov
  scope `analysis.usgovcloudapi.net/powerbi/api/.default` — token audience
  won't authenticate to that host. Per Microsoft "Power BI for US government,"
  GCC = `api.powerbigov.us`. Also `cloud-endpoints.ts:912 getPbiEmbedHostname()`
  returns `app.powerbi.com` for GCC.
- **B2 — Power Platform control-plane bases default commercial; no Gov param
  file sets them.** `lib/azure/powerplatform-client.ts:32-34` hardcodes
  `api.bap.microsoft.com` / `api.powerapps.com` / `api.flow.microsoft.com`
  with `LOOM_*_BASE` overrides; bicep params exist and document the Gov values
  (`admin-plane/main.bicep:88-95`) and env is wired (`:3676-3678`) — but params
  default empty, are NOT derived from `boundary`, and neither `gcc.bicepparam`
  nor `gcc-high`/`il5` set them → Power Apps/Automate admin broken
  out-of-the-box in both GCC and GCC-High.
- **B3 — Power Platform / Copilot Studio token scopes have NO switch.**
  `powerplatform-client.ts:36-38` + `copilot-studio-client.ts:54`: commercial
  audience constants, no env override, no boundary branch. Config alone cannot
  fix Gov auth.

Fixes: (1) GCC `LOOM_POWERBI_BASE=api.powerbigov.us` (host+scope must match);
(2) auto-derive `powerPlatform*Base` from `boundary` + set in the Gov param
files; (3) add boundary/env switch for PP + Copilot Studio token scopes.
Structural: Azure data planes are cloud-complete because switching is
centralized in `cloud-endpoints.ts`; M365-family clients keep local commercial
constants — centralize them the same way.

## (c) Entra / bootstrap / permission gaps

- **C1 — Deploy needs a second privileged human, not surfaced up front.**
  Prereqs A–D in `docs/fiab/v3-tenant-bootstrap.md` need: Graph
  `AppRoleAssignment.ReadWrite.All` (Global Admin/PRA), admin-consent for
  `Azure Service Management/user_impersonation`, Console UAMI Reader at
  tenant-root MG (tenant Owner), DLP policy-list preview (support ticket);
  deploy SP needs Owner + User Access Administrator; Databricks account-admin
  one-time human step. All honest-gated in-app, but the who-must-do-what RACI
  is scattered across a 3,000-line doc — not in the quickstart.
- **C2 — Day-one automation isn't connected to the CLI deploy path** (most
  likely "deployed but can't sign in"). All bootstrap automation lives in
  `.github/workflows/csa-loom-post-deploy-bootstrap.yml` (operator's repo). A
  customer deploying via `az deployment sub create` is never told to run the
  bootstrap or equivalent scripts (`bootstrap-msal-app-reg.sh`,
  `grant-graph-approles.sh`, `grant-powerplatform-sp.sh`). Quickstart ends at
  "open the Console URL" → MSAL app registration never applied → login gates.
- **C3 — MSAL breakage mitigations are encoded (strength).**
  `bootstrap-msal-app-reg.sh` fixes AADSTS50011 (redirect-URI merge),
  AADSTS700025 (confidential app), AADSTS7000215 (KV-reference secret). Only
  helps if C2 is closed.
- **Minor:** admin-group env var has four names across surfaces
  (`adminEntraGroupId` / `LOOM_ADMIN_ENTRA_GROUP_ID` / `CSA_LOOM_ADMIN_GROUP_ID`
  / `FIAB_GOV_ADMIN_GROUP_ID`).

## (d) Day-2 gaps

- **D1 — Upgrade doc repeats the broken azd path + aspirational plumbing**
  (`docs/fiab/deployment/upgrade.md`: `azd up`, "Microsoft public release
  feed," "public Microsoft ACR" — images actually live in the operator's ACR).
  Documented upgrade + rollback not executable by a stranger.
- **D2 — Teardown omits Gov soft-delete purge.** KV (Premium HSM at IL5),
  Cognitive/AOAI, APIM must be purged before name reuse; VNet-before-NSG
  ordering. Re-deploy under same names fails with "name in soft-deleted state."
- **D3 — Cost docs miss the idle floor.** APIM Premium, AKS, ADX, Front Door
  (~$330/mo), VPN gateway, Purview bill continuously → idle Gov deployment
  floors ~$2–3K/mo; docs only give active-use ranges.

## Priority

1. A1/A2/A3 — root README → CSA Loom; quickstart leads with the WORKING
   `az deployment sub create` flow (or actually wire azd).
2. A4 — remove operator admin-group GUID from commercial-full.bicepparam.
3. C2 — document/automate post-deploy bootstrap for CLI deployers.
4. B1/B2/B3 — Power BI + Power Platform Gov endpoint wiring + token-scope switch.
5. A6 — verify Front Door origin on AKS (Gov) path.
6. D1/D2 — fix upgrade doc; add Gov soft-delete purge to teardown.

**Strengths to preserve:** `cloud-endpoints.ts` (sovereign endpoint truth),
honest MessageBar gating, `bootstrap-msal-app-reg.sh`, per-boundary Gov param
files (gcc-high/il5 correctly encode AKS/EP1/Premium/Hive/MAF/Presidio deltas).
