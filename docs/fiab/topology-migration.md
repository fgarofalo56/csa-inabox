# Topology migration — FedCiv estate to multi-subscription (live)

**Audience:** Loom platform operator running the FedCiv estate.
**Scope:** Migrate the single-subscription CSA Loom deployment to the
multi-subscription FedCiv topology (console + shared in the DMLZ sub, bureau
DLZ in its own sub, optional 2nd demo domain in the Main sub, platform +
connectivity hooks in the ALZ sub), validate the NEW console end-to-end, cut
the public endpoint over, retain the old single-sub ring ~2 weeks for UAT, then
tear down with an orphan sweep.

This is a **live, demo-ready** runbook (D3): every step is an actual deployment
or validation command, not a paper exercise. The only manual gate is the
operator go/no-go before teardown.

> **Cloud:** the FedCiv estate is **Azure Commercial** (`AzureCloud`). The
> cutover step uses Azure Front Door (Commercial-GA). If this estate is ever
> promoted to Gov, Front Door is not IL5-certified — gate the cutover on
> Application Gateway (`appGatewayPublicFqdn` output) instead, flip the Cosmos
> suffix to `documents.azure.us`, and add `--cloud AzureUSGovernment` to every
> `az` call below. See `docs/fiab/runbooks/boundary-promotion.md`.

---

## 1. Estate

| Role | Subscription | What lands here | Deployed by |
|------|--------------|-----------------|-------------|
| **DMLZ** — management/console | `<YOUR_SUBSCRIPTION_ID>` | Admin plane: console + shared services + the **NEW** Front Door (`rg-csa-loom-admin-eastus2`) | `params/tenant-dmlz.bicepparam` |
| **DLZ** — bureau data | `<YOUR_DLZ_SUBSCRIPTION_ID>` | Bureau Data Landing Zone (`rg-csa-loom-dlz-bureau-eastus2`) — also the **OLD single-sub** home, retained as the UAT ring | `params/dlz-attach.bicepparam` (`domainName=bureau`) |
| **Main** — 2nd demo | `<YOUR_DEMO_SUBSCRIPTION_ID>` | Optional 2nd demo DLZ (`rg-csa-loom-dlz-demo2-eastus2`) | `params/dlz-attach.bicepparam` (`domainName=demo2`) |
| **ALZ** — platform/connectivity | `<YOUR_CONNECTIVITY_SUBSCRIPTION_ID>` | Connectivity hub VNet + privatelink DNS zones the DLZ spokes peer to / register in | (existing ALZ landing zone — referenced, not deployed here) |

**ALZ seam.** The two cross-sub seams are `adminPlaneHubVnetId` (the VNet the
DLZ spoke peers to) and `adminPlanePrivateDnsZoneIds` (the privatelink zones the
DLZ private endpoints register in). In a classic Azure Landing Zone the
connectivity hub and the privatelink zones live in/under the ALZ sub. To peer
the DLZ spokes under the ALZ platform topology, supply the **ALZ** hub VNet
resource id and the **ALZ** privatelink zone ids as the `LOOM_ADMIN_HUB_VNET_ID`
/ `LOOM_DNS_ZONE_*` env vars in step 2.4 instead of the DMLZ-local ones. No new
bicep — the existing `network.bicep` spoke-peering and the DLZ private-endpoint
DNS-zone params consume them as resource ids.

---

## 2. Clean rebuild

### 2.1 Pre-reqs (one-time, per the env contract)

```bash
# The Setup Orchestrator / Console UAMI needs Contributor on every sub it
# deploys into; tenant-dmlz.bicepparam sets setupOrchestratorEnabled=true so the
# DMLZ grant is bicep-managed. Pre-grant the spoke subs if deploying as a
# different principal than the orchestrator UAMI.
export LOOM_ADMIN_ENTRA_GROUP_ID=<fedciv-loom-admins-group-object-id>
export LOOM_MSAL_CLIENT_ID=<console-app-reg-client-id>
export LOOM_MSAL_CLIENT_SECRET=<...>           # never commit
export LOOM_VANITY_DOMAIN=<csa-loom.agency.gov> # optional; empty = generated FD host
```

### 2.2 Deploy the admin plane (console + shared) into the DMLZ sub

The `--subscription` is what places the admin plane in DMLZ — `main.bicep`
always emits the admin-plane RG, and `adminPlaneSubId` is default-only. The
`tenant-dmlz` param file keeps `dlzSubscriptionIds`/`dlzDomainNames` empty, so
the orchestrator's `dlz[]` for-loop is a no-op and **only** the console + shared
services + Front Door deploy here.

```bash
az deployment sub create \
  --name loom-tenant-dmlz \
  --subscription <YOUR_SUBSCRIPTION_ID> \
  --location eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/tenant-dmlz.bicepparam
```

### 2.3 Capture the admin-plane handoff outputs

The standalone DLZ deploy reads four admin-plane outputs (LAW, private-DNS zone
object, catalog endpoint, Console UAMI principal) plus the hub VNet. These are
re-exported by `main.bicep` (audit-t162):

```bash
OUT=$(az deployment sub show -n loom-tenant-dmlz \
  --subscription <YOUR_SUBSCRIPTION_ID> \
  --query properties.outputs -o json)

export LOOM_ADMIN_HUB_VNET_ID=$(jq -r '.adminPlaneHubVnetId.value'   <<<"$OUT")
export LOOM_ADMIN_LAW_ID=$(jq -r       '.adminPlaneLawId.value'      <<<"$OUT")
export LOOM_CATALOG_ENDPOINT=$(jq -r   '.adminPlaneCatalogEndpoint.value' <<<"$OUT")
export LOOM_CONSOLE_PRINCIPAL_ID=$(jq -r '.consolePrincipalId.value' <<<"$OUT")
# Private DNS zones (object) → individual ids the dlz-attach param rebuilds:
export LOOM_DNS_ZONE_BLOB=$(jq -r            '.adminPlanePrivateDnsZoneIds.value.blob'    <<<"$OUT")
export LOOM_DNS_ZONE_DFS=$(jq -r             '.adminPlanePrivateDnsZoneIds.value.dfs'     <<<"$OUT")
export LOOM_DNS_ZONE_COSMOS=$(jq -r          '.adminPlanePrivateDnsZoneIds.value.cosmos'  <<<"$OUT")
export LOOM_DNS_ZONE_COSMOS_GREMLIN=$(jq -r  '.adminPlanePrivateDnsZoneIds.value.cosmosGremlin' <<<"$OUT")
export LOOM_DNS_ZONE_SERVICEBUS=$(jq -r      '.adminPlanePrivateDnsZoneIds.value.servicebus' <<<"$OUT")
export LOOM_DNS_ZONE_SYNAPSE_SQL=$(jq -r     '.adminPlanePrivateDnsZoneIds.value.synapseSql' <<<"$OUT")
export LOOM_DNS_ZONE_ADF=$(jq -r             '.adminPlanePrivateDnsZoneIds.value.adf'     <<<"$OUT")
# ADX shared-cluster principal (Event Hubs Data Receiver grant on the DLZ):
export LOOM_ADMIN_ADX_PRINCIPAL_ID=$(jq -r   '.adxClusterPrincipalId.value // empty' <<<"$OUT")
```

> If peering the DLZ spokes under the **ALZ** platform hub instead of the DMLZ
> hub, override `LOOM_ADMIN_HUB_VNET_ID` + the `LOOM_DNS_ZONE_*` vars with the
> ALZ connectivity-sub resource ids (the ALZ seam, §1).

### 2.4 Pre-create the DLZ resource groups in the spoke subs

A sub-scoped admin-plane deploy cannot create RGs in other subscriptions, so
bootstrap them first:

```bash
bash scripts/csa-loom/bootstrap-dlz-rgs.sh eastus2 \
  "<YOUR_DLZ_SUBSCRIPTION_ID>,<YOUR_DEMO_SUBSCRIPTION_ID>" \
  "bureau,demo2"
```

### 2.5 Deploy the bureau DLZ (DLZ sub) and the 2nd demo DLZ (Main sub)

The **same** `dlz-attach.bicepparam` deploys both — override `domainName`,
`spokeVnetCidr`, and `--subscription` per invocation (each DLZ needs a unique,
non-overlapping spoke CIDR; the DMLZ hub is `10.0.0.0/16`).

```bash
# Bureau DLZ → DLZ sub
az deployment group create \
  --name loom-dlz-bureau \
  --subscription <YOUR_DLZ_SUBSCRIPTION_ID> \
  -g rg-csa-loom-dlz-bureau-eastus2 \
  -f platform/fiab/bicep/modules/landing-zone/main.bicep \
  -p platform/fiab/bicep/params/dlz-attach.bicepparam \
  -p domainName=bureau -p spokeVnetCidr=10.100.0.0/16

# Optional 2nd demo DLZ → Main sub
az deployment group create \
  --name loom-dlz-demo2 \
  --subscription <YOUR_DEMO_SUBSCRIPTION_ID> \
  -g rg-csa-loom-dlz-demo2-eastus2 \
  -f platform/fiab/bicep/modules/landing-zone/main.bicep \
  -p platform/fiab/bicep/params/dlz-attach.bicepparam \
  -p domainName=demo2 -p spokeVnetCidr=10.101.0.0/16
```

> **UI-parity note.** The Multi-Agency Onboarding content bundle
> (`apps/fiab-console/lib/apps/content-bundles/app-multi-agency-onboarding.ts`)
> renders an *illustrative* dlz-attach snippet that targets `dlz/dlz.bicep` with
> param names like `departmentName`/`dlzSubscriptionId`. That path does **not**
> exist and those names do **not** match the real module. The canonical,
> deployable reference artifact is **`params/dlz-attach.bicepparam` →
> `modules/landing-zone/main.bicep`** (this runbook). Treat the onboarding
> snippet as a teaching aid only.

### 2.6 Wire the console env to the new deployment

Per the console env contract (`apps/fiab-console/lib/admin/self-audit.ts`): the
`subscription` self-audit row requires `LOOM_SUBSCRIPTION_ID` plus at least one
of `LOOM_DLZ_RG` / `LOOM_ADMIN_RG`. After the DMLZ admin-plane deploy these are
auto-derived into the `loom-console` Container App env; confirm and, if running
the console against the bureau DLZ, set:

```bash
az containerapp update -g rg-csa-loom-admin-eastus2 -n loom-console \
  --subscription <YOUR_SUBSCRIPTION_ID> \
  --set-env-vars \
    LOOM_SUBSCRIPTION_ID=<YOUR_SUBSCRIPTION_ID> \
    LOOM_ADMIN_RG=rg-csa-loom-admin-eastus2 \
    LOOM_DLZ_RG=rg-csa-loom-dlz-bureau-eastus2
```

---

## 3. Validate the NEW console

Resolve the new Front Door host from the tenant deploy output, then run both
validators against it.

```bash
NEW_FD=$(jq -r '.frontDoorPublicUrl.value' <<<"$OUT")   # e.g. https://<your-console-hostname>
echo "New console: $NEW_FD"
```

1. **Service-health classifier** — `csa-loom-validate` workflow. It is now
   parameterized (audit-t162): dispatch with the DMLZ sub + new admin RG + new
   URL so it mints a session against the **new** console:

   ```bash
   gh workflow run csa-loom-validate.yml \
     -f loom_url="$NEW_FD" \
     -f sub=<YOUR_SUBSCRIPTION_ID> \
     -f admin_rg=rg-csa-loom-admin-eastus2
   ```

   Pass criterion: zero hard FAILs (honest not-configured NOTEs are fine).

2. **Live smoke** — build-marker / health / version / notebook / data-pipeline /
   copilot-tools:

   ```bash
   bash .github/scripts/loom-validate-live.sh "$NEW_FD" "$(git rev-parse --short HEAD)"
   ```

Both green ⇒ the new console is serving real data from the DMLZ admin plane and
the bureau DLZ. Proceed to cutover.

---

## 4. Cutover — re-point the public endpoint

Goal: move the vanity domain (`$LOOM_VANITY_DOMAIN`) from the OLD Front Door
profile (single-sub, `363ef5d1`) to the NEW one (DMLZ, `e093f4fd`) with no
downtime.

**Constraint (Microsoft Learn):** a custom domain can be validated in **only one
Front Door / CDN profile at a time** — you cannot add the same domain to the new
profile while the old profile still owns it. Plan accordingly:

1. **Pre-stage on the new profile via the generated host.** The new console is
   already reachable at `$NEW_FD` (the AFD-generated endpoint). Keep serving
   traffic there during validation; nothing on the old profile changes yet.
2. **Release the domain from the OLD profile.** On the old Front Door profile
   (`363ef5d1`), remove the vanity custom-domain association + the domain
   object. This frees the name for the new profile. (Brief window: the vanity
   URL falls back to the old generated host until step 5 completes — the old
   generated host stays live, so internal/UAT users are unaffected.)
3. **Add the vanity domain to the NEW profile.** `tenant-dmlz.bicepparam` set
   `loomVanityDomain` (from `LOOM_VANITY_DOMAIN`), so the admin-plane Front Door
   already created the managed-cert custom-domain object. Its validation state
   is **Pending** with a `_dnsauth` TXT challenge. Read the challenge from the
   tenant deploy outputs:

   ```bash
   jq -r '.vanityDnsTxtName.value, .vanityValidationToken.value' <<<"$OUT"
   # → _dnsauth.<subdomain>   <token>
   ```

4. **Add the TXT record + wait for Approved.** Create a `TXT` record named
   `$(vanityDnsTxtName)` with value `$(vanityValidationToken)` at your DNS
   provider. The new profile's domain validation flips **Pending → Approved**
   within minutes (managed-cert path). Confirm:

   ```bash
   az afd custom-domain show -g rg-csa-loom-admin-eastus2 \
     --subscription <YOUR_SUBSCRIPTION_ID> \
     --profile-name <new-afd-profile> --custom-domain-name <vanity-cd> \
     --query domainValidationState -o tsv   # expect: Approved
   ```

5. **Swap the CNAME.** Once **Approved** and associated with the new endpoint's
   `default-route`, repoint the vanity CNAME to the new profile's endpoint host:

   ```bash
   # vanityCnameTarget = the new AFD endpoint host to CNAME to
   jq -r '.vanityCnameTarget.value' <<<"$OUT"
   ```

   Update the vanity domain's `CNAME` to that target. Traffic shifts to the new
   profile with the managed cert; no downtime while the domain is Approved.

6. **Verify.** `curl -s https://$LOOM_VANITY_DOMAIN/api/health` returns
   `{"status":"ok"}` and `/api/version` shows the new build SHA.

---

## 5. Retain the OLD single-sub ring (~2 weeks)

Do **not** tear down immediately. Keep the old single-sub deployment (the
`363ef5d1` `rg-csa-loom-admin-eastus2` admin plane + its
`loom-console-<hash>` Front Door) live for ~2 weeks as a **UAT /
staging ring**:

- Its generated Front Door host stays reachable (it no longer owns the vanity
  domain, but the generated host is unaffected).
- Use it to A/B against the new estate, smoke-test fixes, and provide rollback:
  if the new estate regresses, re-point the vanity CNAME back to the old
  generated host (the old profile can re-validate the domain once the new
  profile releases it).
- Track the retain-until date; the teardown gate (§6) is blocked until it
  passes.

---

## 6. Operator go/no-go → teardown + orphan sweep

**This is the only manual gate.** After the retain window, the operator
confirms go/no-go. On **go**, run teardown — which always does a best-effort
Cosmos export first, then deletes RGs, then sweeps orphans.

### 6.1 Best-effort Cosmos safety export (FIRST, non-fatal)

The old single-sub DLZ Cosmos account holds Loom control-plane state (workspaces,
items, permission grants, config) in the `loom` database. The account sets
`disableLocalAuth=true`, so the export path is AAD-RBAC only. The orphan-sweep
script grants the sweep principal **Cosmos DB Built-in Data Reader**, dumps each
container via the data plane to JSON, and uploads the bundle to a DMLZ storage
container — best-effort and non-fatal (a failed export logs a warning but never
blocks teardown). See `.github/scripts/fiab-orphan-sweep.sh` (`--cosmos-export`).

### 6.2 Delete the RGs

```bash
RG_NAME=rg-csa-loom-admin-eastus2 \
DLZ_SUBS=<YOUR_DLZ_SUBSCRIPTION_ID> \
  bash .github/scripts/fiab-teardown.sh
```

### 6.3 Sweep orphans

Deleting RGs and principals leaves **subscription-scope** artifacts that RG
deletion does NOT remove — chiefly the Contributor role assignments the Setup
Orchestrator granted on each spoke sub (`setup-orchestrator-rbac.bicep`, threaded
via `setupOrchestratorEnabled`). After the principal is gone these show as empty
`principalName` / Unknown type but still grant access. The sweep also handles
orphan DNS records (vanity CNAME + `_dnsauth` TXT), the orphan Front Door
custom-domain + endpoint on the old profile, and orphan Entra app artifacts
(MSAL app reg, SCC-labels app + auth cert).

```bash
# Dry-run first (default) — lists what WOULD be deleted, touches nothing:
SUBS=<YOUR_DLZ_SUBSCRIPTION_ID>,<YOUR_SUBSCRIPTION_ID> \
  bash .github/scripts/fiab-orphan-sweep.sh

# Execute after reviewing the dry-run:
APPLY=1 \
SUBS=<YOUR_DLZ_SUBSCRIPTION_ID>,<YOUR_SUBSCRIPTION_ID> \
VANITY_DOMAIN=$LOOM_VANITY_DOMAIN \
DNS_ZONE_RG=<dns-zone-rg> DNS_ZONE=<vanity-zone> \
OLD_AFD_RG=rg-csa-loom-admin-eastus2 OLD_AFD_PROFILE=<old-afd-profile> \
  bash .github/scripts/fiab-orphan-sweep.sh
```

The sweep is idempotent and **dry-run by default** (`APPLY=1` to execute); each
class is independently gated by its env inputs (skip a class by leaving its env
var unset).

---

## Rollback

Before §6 teardown, rollback is a single CNAME swap back to the old generated
host (§5). After teardown, rollback means redeploying from the same param files
(`tenant-dmlz` + `dlz-attach`) plus restoring the Cosmos export bundle (§6.1).
This is why the retain ring + the safety export both exist.
