# Redis → Azure Managed Redis cutover (Commercial)

**When to use:** you are scheduling the migration of the live Commercial cache
`redis-loom-hband-k6mvh5sm6z7do` (classic Azure Cache for Redis, Premium P1) onto
**Azure Managed Redis** (`Microsoft.Cache/redisEnterprise`) before Microsoft's
**2028-10-01** turn-off of all remaining Basic/Standard/Premium caches.

**Scope:** Commercial only. Sovereign boundaries do **not** follow this runbook —
Azure Managed Redis is Azure Public cloud only
([AMR planning FAQ](https://learn.microsoft.com/azure/redis/planning-faq)), so
**GCC-High / IL5** get the OSS Valkey substrate
(`platform/fiab/bicep/modules/shared/redis-oss-aca.bicep`), which
`admin-plane/main.bicep` deploys and auto-binds with no operator step.
**GCC does not, yet:** `redisOssActive` also requires `deployAppsEnabled`, which
`platform/fiab/bicep/params/gcc.bicepparam` deliberately leaves unset because GCC
has no image-producer lane (#3078) — a GCC deploy stands up zero Container Apps,
so no cache is deployed and `LOOM_RESULT_CACHE_REDIS` is expected to be unset
there. GCC gains the cache with its apps lane, not by editing config. See
[§9](#9-what-the-platform-does-automatically-and-what-needs-you).

**This runbook is not the fix.** The template migrated in #2851/#2940; the *live
resource* did not. Per `deploy-integrity.md` R2 that is "merged, not deployed",
and the merge cannot change it. This document is the scheduled operator action
that closes the gap.

**The single most important number in here:** the cache currently serves
**zero** Loom traffic — measured, not assumed
([§1](#1-what-is-actually-connected-measured-not-assumed)). That turns a
"seven connected clients, plan an outage" job into a low-risk provision-and-point
job. Re-run the measurements in [§2](#2-pre-cutover-checks) on the day; if they
have changed, the risk profile changes with them and [§7](#7-window-estimate)
tells you how.

**Two blocking decisions are buried in the detail and neither is optional.** Read
[§6.3](#63-the-capacity-broker-cannot-speak-to-amr-under-the-module-defaults)
before you schedule anything.

---

## 1. What is actually connected (measured, not assumed)

Issue #2642 records "**Seven connected clients**" from the `connectedclients`
metric on 2026-08-11 and concludes "anything that removes the cache without
standing up the AMR replacement first takes the capacity broker down with it."

**Re-derived 2026-09-01. The number is now 4–5, and — more importantly — it never
counted Loom applications in the first place.** `connectedclients` is a
*connection* gauge that includes Azure's own management and health connections to
the cache. The metrics that count application work are all flat zero:

```
$ SUB=<admin-subscription-id>                  # NOT necessarily your default az context — see §2
$ RID="/subscriptions/$SUB/resourceGroups/rg-csa-loom-admin-centralus/providers/Microsoft.Cache/Redis/redis-loom-hband-k6mvh5sm6z7do"
$ MSYS_NO_PATHCONV=1 az monitor metrics list --subscription "$SUB" --resource "$RID" \
    --metric getcommands setcommands totalkeys allconnectedclients \
    --aggregation Total Maximum --interval P1D --offset 7d

getcommands           total 0.0   every day, 7/7        <- no application reads
setcommands           total 0.0   every day, 7/7        <- no application writes
totalkeys             max   0.0   every day, 7/7        <- THE CACHE IS EMPTY
allconnectedclients   max   5–6   every day, 7/7        <- POSITIVE CONTROL: the query path works
```

`cachehits` and `cachemisses` are likewise 0 across every 12-hour bucket for
7 days, while `operationsPerSecond` runs a flat 20–30/s — commands that are
neither hits nor misses (`PING`/`INFO`-class health traffic), with no diurnal
shape. `usedmemory` sits at **101.7 MB, flat to within ~80 KB**, which is the
empty-server footprint of a 6 GB P1, not stored data.

`allconnectedclients` returning 5–6 from the *same query, same window* is the
positive control: the zeros are real zeros, not a broken query.

### 1.1 Client inventory — every binder, from source

Five environment variables carry an H-band Redis `host:port` in this codebase.
Here is every runtime read and every deployment binding:

| # | Consumer | Env var | Binds at | Reads at | Live value (measured 2026-09-01) |
|---|---|---|---|---|---|
| 1 | **loom-console** (BFF, result cache) | `LOOM_RESULT_CACHE_REDIS` | *(nothing — see below)* | `apps/fiab-console/lib/azure/redis-cache-client.ts:72,357` | **not set at all** on the live app |
| 2 | **loom-console** (Spark warm-lease store) | `LOOM_SPARK_POOL_REDIS` | *(nothing)* | `apps/fiab-console/lib/azure/spark-lease-store.ts:106` | not set |
| 3 | **loom-console** (lease-store alias) | `LOOM_BROKER_REDIS` | `platform/fiab/bicep/modules/admin-plane/main.bicep` (hard-coded `''`) | `apps/fiab-console/lib/azure/spark-lease-store.ts:106` | **`""` (empty)** |
| 4 | **loom-console** (lease-store alias) | `LOOM_DIRECTLAKE_REDIS` | *(nothing)* | `apps/fiab-console/lib/azure/spark-lease-store.ts:106` | not set |
| 5 | **loom-capacity-broker** (LCU timepoint ledger) | `LOOM_BROKER_REDIS` / `LOOM_CAPACITY_BROKER_REDIS` | `platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep:90,97-98` (secret `redis-conn`) | `apps/loom-capacity-broker/internal/ledger/ledger.go:61-62` | **`secretRef: redis-conn`** — the only real binding in the estate |

Measured across all **30** Container Apps in `rg-csa-loom-admin-centralus`,
exactly **two** carry any `*REDIS*` environment variable:

```
$ az containerapp list --subscription "$SUB" -g rg-csa-loom-admin-centralus \
    --query "[].{name:name,env:properties.template.containers[0].env[?contains(name,'REDIS')].name}" -o json
loom-console            ["LOOM_BROKER_REDIS"]     -> value ""          (does not connect)
loom-capacity-broker    ["LOOM_BROKER_REDIS"]     -> secretRef redis-conn
… 28 other apps         []
```

And the one real binder is **not running**:

```
$ az containerapp show  --subscription "$SUB" -g rg-csa-loom-admin-centralus -n loom-capacity-broker \
    --query "properties.template.scale" -o json
{ "minReplicas": 0, "maxReplicas": 5, "rules": null, "cooldownPeriod": 300, "pollingInterval": 30 }

$ az containerapp replica list --subscription "$SUB" -g rg-csa-loom-admin-centralus \
    -n loom-capacity-broker --revision loom-capacity-broker--0000001 --query "length(@)"
0
```

`minReplicas: 0` with **no scale rules** and internal-only ingress means the app
idles at zero and nothing wakes it. (Note this also contradicts its own module,
`loom-capacity-broker-app.bicep:186`, which pins `minReplicas: 2` — the live app
was provisioned out of band. Not a blocker for the cutover, but do not assume the
running app matches the template.)

### 1.2 Drift from the issue, stated plainly

| Issue #2642 says | Measured 2026-09-01 | Consequence for this cutover |
|---|---|---|
| "Seven connected clients" | `connectedclients` 4–5 (`allconnectedclients` 5–6) | The gauge counts *connections*, including Azure's own. It was never an application count. |
| "It has live traffic — not an orphaned resource" | `getcommands`/`setcommands`/`cachehits`/`cachemisses` = **0** for 7 days | There is no traffic to interrupt. |
| "`loom-capacity-broker` is the actual consumer" | True as a *binding*; the app runs **0 replicas** | The one real consumer is not connected right now. |
| "Migrating a live cache with seven connected clients is a change with an outage window" | `totalkeys` = 0 — the cache is **empty** | **No data migration, no dual-write, no import/export.** This is a provision-and-point, not a data move. |
| `az redis list -g rg-csa-loom-admin-centralus` | `ResourceGroupNotFound` — the admin RG is **not** in the default `az` context; it sits in a different subscription of the same tenant | Every command in this runbook passes `--subscription` explicitly. Resolve it once (§2) rather than trusting `az account show`. |

**Nothing here says the issue was careless** — `connectedclients: 7` was a true
reading of a metric that does not mean what it looks like it means. That is
precisely why this runbook re-derives rather than inherits, and why you re-run
[§2](#2-pre-cutover-checks) on the day instead of trusting this table.

---

## 2. Pre-cutover checks

Run all of these. Each has a **STOP** condition; there is no "probably fine".

```bash
RG=rg-csa-loom-admin-centralus
CACHE=redis-loom-hband-k6mvh5sm6z7do

# RESOLVE the subscription — do NOT assume `az account show`. On 2026-09-01 the
# admin RG was in a DIFFERENT subscription of the same tenant than the default
# context, and `az redis list -g <rg>` returned a flat ResourceGroupNotFound that
# reads like "the cache is gone" rather than "you are looking in the wrong place".
SUB=$(az account list --query "[].id" -o tsv | tr -d '\r' | while read -r s; do
        az group show --subscription "$s" -n "$RG" --query id -o tsv > /dev/null 2>>/tmp/rg-probe.err && echo "$s"
      done | head -1)
# NOTE: no `RC=$?` here on purpose. After a pipeline `$?` is the LAST stage's
# status (`head`, which succeeds on empty input), so it would report success for
# a subscription that was never found. The emptiness of $SUB is the real signal.

if [ -z "$SUB" ]; then
  echo "STOP: $RG not found in any subscription this identity can see. Check the tenant (az login --tenant), not the resource. Nothing below will work — $RID would be composed from an empty subscription id and every az call would fail with a misleading 'not found'."
else
  RID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Cache/Redis/$CACHE"
  echo "Resolved: SUB=$SUB"
fi
```

Every step below assumes `$SUB` and `$RID` are set. If the STOP above fired, do
not continue — resolve the subscription first.

**2.1 — Confirm the traffic picture still holds.**

```bash
MSYS_NO_PATHCONV=1 az monitor metrics list --subscription "$SUB" --resource "$RID" \
  --metric getcommands setcommands totalkeys allconnectedclients \
  --aggregation Total Maximum --interval P1D --offset 7d -o json > /tmp/redis-pre.json
RC=$?
[ "$RC" -eq 0 ] || echo "STOP: metrics query failed (rc=$RC). Do NOT read /tmp/redis-pre.json — a failed query leaves it empty or partial, and an empty file is not 'zero traffic'."
```

- **STOP if `totalkeys` > 0 or `getcommands`/`setcommands` > 0.** Something started
  using the cache since 2026-09-01. You now have live state and this becomes a
  data migration: follow
  [Migrate Basic/Standard/Premium to AMR](https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview)
  and re-plan the window from [§7.2](#72-if-the-cache-is-no-longer-empty).
- **STOP if the command errors or every series is `null`.** `null` is not zero.
  A `null` series means the query did not run — check the subscription, the
  resource id, and that `MSYS_NO_PATHCONV=1` is set (Git Bash rewrites a
  leading-slash resource id and the CLI then rejects a well-formed id).

**2.2 — Confirm the consumer set has not grown.**

```bash
# `containers[]` — NOT `containers[0]`. A REDIS var injected on a SIDECAR is
# invisible to a containers[0] query, and this step's whole job is population
# completeness: a consumer it cannot see is a consumer that breaks at cutover
# with no warning.
az containerapp list --subscription "$SUB" -g "$RG" \
  --query "[?length(properties.template.containers[].env[?contains(name,'REDIS')])>\`0\`].{name:name,env:properties.template.containers[].env[?contains(name,'REDIS')]}" -o json
```

- **STOP if any app other than `loom-console` / `loom-capacity-broker` appears** —
  update [§1.1](#11-client-inventory-every-binder-from-source) and [§6](#6-what-breaks-if-this-is-done-wrong-and-the-blast-radius) before proceeding.

**2.3 — Confirm the AMR prerequisites exist.** Both were verified present on
2026-09-01; verify again rather than assume.

```bash
# The AMR private DNS zone is a DIFFERENT zone from the classic one and must be
# VNet-linked. Measured 2026-09-01: present, 1 VNet link, 1 record set (SOA only).
az network private-dns zone list --subscription "$SUB" \
  --query "[?contains(name,'redis')].{name:name,rg:resourceGroup,records:numberOfRecordSets,links:numberOfVirtualNetworkLinks}" -o table

# The PE subnet the new endpoint lands in (same one the classic PE uses).
az network private-endpoint show --subscription "$SUB" -g "$RG" -n pe-redis-loom-hband \
  --query "{subnet:subnet.id,group:privateLinkServiceConnections[0].groupIds}" -o json
```

Expected: `privatelink.redis.azure.net` present with `links: 1`, and the classic
PE on `.../vnet-csa-loom-hub-centralus/subnets/snet-private-endpoints` with
`groupIds: ["redisCache"]`.

- **STOP if `privatelink.redis.azure.net` is missing or has 0 VNet links.** Deploy
  `platform/fiab/bicep/modules/admin-plane/network.bicep` first — the zone is
  `privateDnsZones[25]`, published as `privateDnsZoneIds.redisManaged`. Without
  it the AMR private endpoint resolves to nothing and every client silently
  falls back to its local tier.

**2.4 — Confirm zero AMR clusters exist yet** (so the deploy creates rather than
adopts something unexpected):

```bash
az resource list --subscription "$SUB" --resource-type Microsoft.Cache/redisEnterprise --query "length(@)"
# Measured 2026-09-01, subscription-wide: 0
```

**2.5 — Record the rollback anchor.** Capture the current console + broker
configuration so [§5](#5-rollback) is a restore, not a reconstruction:

```bash
# Create the directory FIRST — a `>` redirect into a missing directory fails
# ("No such file or directory") and the shell writes nothing, so you would enter
# the change window believing you had an anchor you do not have.
ROLLBACK_DIR=./temp/rollback
mkdir -p "$ROLLBACK_DIR"
STAMP=$(date +%Y%m%d)

az containerapp show --subscription "$SUB" -g "$RG" -n loom-console \
  --query "properties.template.containers[].env" -o json > "$ROLLBACK_DIR/console-env-$STAMP.json"
RC=$?
[ "$RC" -eq 0 ] || echo "STOP: console anchor capture failed (rc=$RC). Do not start the cutover without it."

az containerapp show --subscription "$SUB" -g "$RG" -n loom-capacity-broker \
  --query "{env:properties.template.containers[].env,rev:properties.latestRevisionName}" -o json \
  > "$ROLLBACK_DIR/broker-$STAMP.json"
RC=$?
[ "$RC" -eq 0 ] || echo "STOP: broker anchor capture failed (rc=$RC). Do not start the cutover without it."

ls -l "$ROLLBACK_DIR"   # both files present and non-empty before you proceed
```

These capture *names and secret references*, never secret values — an
`az containerapp show` does not return a secret's value, and nothing in this
runbook asks you to print one.

**2.6 — Decide the two blocking questions in
[§6.3](#63-the-capacity-broker-cannot-speak-to-amr-under-the-module-defaults)
before the window opens.** They change what you deploy, not just what you do.

---

## 3. Cutover sequence

Every step is idempotent and every step leaves the classic cache running. The
old cache is **not touched** until [§8](#8-decommissioning-the-classic-cache),
which is a separate, later change.

### 3.1 Provision the AMR cluster (no client change yet)

`compute/hband-shared.bicep` already creates AMR when `redisBackend=managed`
(the default), under a **deliberately different name** — `amr-loom-hband-*` vs
`redis-loom-hband-*` — so both coexist legibly in the portal during the window.

```bash
az deployment group create --subscription "$SUB" -g "$RG" \
  -n redis-amr-cutover-$(date +%Y%m%d) \
  -f platform/fiab/bicep/modules/compute/hband-shared.bicep \
  -p location=centralus \
     redisBackend=managed \
     managedRedisSku=Balanced_B5 \
     workspaceId="$(az monitor log-analytics workspace show --subscription "$SUB" -g "$RG" -n law-csa-loom-centralus --query id -o tsv | tr -d '\r')" \
     privateEndpointSubnetId="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-hub-centralus/subnets/snet-private-endpoints" \
     privateDnsZoneRedisManagedId="$(az network private-dns zone show --subscription "$SUB" -g "$RG" -n privatelink.redis.azure.net --query id -o tsv | tr -d '\r')" \
     consolePrincipalId="<uami-loom-console principalId>" \
  -o json > /tmp/amr-deploy.json
RC=$?
```

> `tr -d '\r'` is not decoration: `az ... -o tsv` emits a trailing carriage
> return on Windows, and a CR inside a resource id produces an error that names
> the wrong thing.

`managedRedisSku=Balanced_B5` is the module's default and the closest small
Balanced size to the P1 being replaced. It is a **cost decision, not a technical
one** — see [§9](#9-what-the-platform-does-automatically-and-what-needs-you).
`Balanced_B0` is the cheapest that functions, and given the measured working set
(0 keys, 0 ops) it is defensible; choose deliberately, and record why.

Read the outputs — do not assume:

```bash
python -c "
import json; d=json.load(open('/tmp/amr-deploy.json'))['properties']['outputs']
for k in ('redisBackendDeployed','redisName','redisHostName','redisSslPort','redisEndpoint'):
    print(k, '=', d.get(k,{}).get('value'))
"
```

Expected: `redisBackendDeployed = managed`, `redisSslPort = 10000`, and
`redisEndpoint` ending `:10000`. **Use `redisEndpoint` verbatim from here on.**

### 3.2 Verify the deployed cluster before pointing anything at it

Three properties are load-bearing and two of them fail *silently* if wrong.

```bash
AMR=$(python -c "import json;print(json.load(open('/tmp/amr-deploy.json'))['properties']['outputs']['redisName']['value'])")

az resource show --subscription "$SUB" -g "$RG" -n "$AMR" \
  --resource-type Microsoft.Cache/redisEnterprise \
  --query "{host:properties.hostName,state:properties.provisioningState,ha:properties.highAvailability,pna:properties.publicNetworkAccess,minTls:properties.minimumTlsVersion}" -o json

az resource show --subscription "$SUB" -g "$RG" --namespace Microsoft.Cache \
  --parent "redisEnterprise/$AMR" --resource-type databases -n default \
  --query "{port:properties.port,clustering:properties.clusteringPolicy,protocol:properties.clientProtocol,eviction:properties.evictionPolicy,keys:properties.accessKeysAuthentication}" -o json
```

Required:

| Property | Required value | Why — and how it fails if wrong |
|---|---|---|
| `clusteringPolicy` | **`EnterpriseCluster`** | The ARM default is `OSSCluster`, which needs a client that follows `MOVED` redirects and opens per-shard connections. Both Loom clients are hand-rolled RESP2 speakers with **no cluster support** and both degrade **silently**. Under `OSSCluster` the cache deploys green, the env var is set, and every `GET` fails invisibly. |
| `port` | **`10000`** | Classic is 6380. Anything that composes `host + :6380` points at a closed port. |
| `clientProtocol` | `Encrypted` | TLS-only on the data path; there is no `enableNonSslPort` equivalent on AMR. |
| `provisioningState` | `Succeeded` | A cluster mid-provision accepts connections inconsistently. |

**STOP on any mismatch.** Fix the template, redeploy, re-verify. Do not proceed
to §3.3 with a wrong clustering policy — it produces a cutover that looks
perfect and works not at all.

### 3.3 Prove the endpoint works *before* any client is pointed at it

The probe is a real client round trip from inside the VNet, not a TCP connect.
`loom-script-runner` shares the Container Apps environment and can reach the
private endpoint:

```bash
AMR_EP=$(python -c "import json;print(json.load(open('/tmp/amr-deploy.json'))['properties']['outputs']['redisEndpoint']['value'])")

az containerapp exec --subscription "$SUB" -g "$RG" -n loom-script-runner \
  --command "sh -c \"python - <<'EOF'
import socket,ssl
h,p=('$AMR_EP').rsplit(':',1)
s=ssl.create_default_context().wrap_socket(socket.create_connection((h,int(p)),timeout=5),server_hostname=h)
s.sendall(b'*1\r\n\$4\r\nPING\r\n'); print(s.recv(128))
EOF\""
```

Expected: `b'-NOAUTH Authentication required.\r\n'` (or `+PONG` if the caller is
already authorised). **`-NOAUTH` is a PASS** — it proves DNS resolved to the
private endpoint, TLS negotiated on 10000, and a Redis server answered. A
connection timeout means DNS or the PE is wrong; a TLS error means the protocol
or port is wrong.

> `az containerapp exec` has a ~2 KB URL cap and 429s with `retry-after: 600`
> if you chunk it. Send one minified command; do not split it.

### 3.4 Point the Console's result cache at AMR

The Console's Entra path works against AMR: `managed-redis.bicep` assigns the
`default` access policy to the Console UAMI, and `redis-cache-client.ts:340-347`
sends `AUTH <oid> <token>` for the `https://redis.azure.com/.default` scope.

```bash
az containerapp update --subscription "$SUB" -g "$RG" -n loom-console \
  --set-env-vars "LOOM_RESULT_CACHE_REDIS=$AMR_EP"
```

Do **not** set `LOOM_RESULT_CACHE_REDIS_PASSWORD` and do **not** set
`LOOM_RESULT_CACHE_REDIS_TLS`. Both defaults are correct here: no password ⇒ the
client takes its Entra branch; TLS defaults on, which AMR requires. (The OSS
sovereign path is the opposite on both counts — that is why the two boundaries do
not share a configuration.)

An `az containerapp update` rolls a new revision; Key Vault secretRefs and env
are resolved at revision activation, so pickup requires the roll, which this
command performs.

### 3.5 Decide and apply the Capacity Broker's ledger

**This step depends on the [§6.3](#63-the-capacity-broker-cannot-speak-to-amr-under-the-module-defaults) decision. Do not improvise it in the window.**

If the decision was **"AMR with access keys"**, the deployment must set
`accessKeysAuthentication: 'Enabled'` on the database (the module defaults it to
`Disabled`), and the broker's connection string must enable TLS **explicitly** —
a bare `host:10000` will **not**, because the Go client's auto-TLS heuristic only
fires on a `:6380` suffix
(`apps/loom-capacity-broker/internal/ledger/redis_ledger.go:124-126`).

**Use the `host:port,password=…,ssl=True` form — NOT a `rediss://` URL.** Both
reach `parseConn` (`redis_ledger.go:72-128`), but only the comma form is safe for
an AMR access key. This is [§6.2 trap 3](#62-the-four-traps-that-produce-a-green-but-broken-cutover),
and it is the difference between a working ledger and a silent one:

```bash
AMR_RID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Cache/redisEnterprise/$AMR"

# Read the key into a variable so its exit status is CHECKABLE. Inlining the
# `az rest` inside --secrets makes a failed call yield an EMPTY password, and
# the broker then falls back to its in-process ledger without saying so.
KEY=$(MSYS_NO_PATHCONV=1 az rest --method post \
  --url "https://management.azure.com${AMR_RID}/databases/default/listKeys?api-version=2025-07-01" \
  --query primaryKey -o tsv)
RC=$?
KEY=$(printf '%s' "$KEY" | tr -d '\r')
if [ "$RC" -ne 0 ] || [ -z "$KEY" ]; then
  unset KEY
  echo "STOP: listKeys failed (rc=$RC) or returned empty. Confirm accessKeysAuthentication is Enabled on the database, then re-run. Do NOT set the secret, and do NOT restart the broker — restarting without the secret is precisely the silent fall-back to the in-process ledger that this step exists to prevent."
else
  # Comma form, never rediss://. An AMR key is standard base64, whose alphabet
  # includes `/`, and an RFC 3986 authority ends at the first `/` — so a URL is
  # unparseable for ~48% of keys (measured), and Go's url.Parse then reports a
  # bogus "invalid port" rather than the truth. `parseConn`'s comma branch splits
  # on `,` then SplitN(p,"=",2), so both `/` and `=` padding survive intact, and
  # ssl=True sets TLS outright instead of relying on the :6380 heuristic.
  az containerapp secret set --subscription "$SUB" -g "$RG" -n loom-capacity-broker \
    --secrets "redis-conn=$AMR_EP,password=$KEY,ssl=True"
  SET_RC=$?
  unset KEY   # never echoed, never written to a file, never in this document

  # The restart is INSIDE this branch on purpose. A restart that runs after a
  # failed secret write brings the broker up on the old (or absent) value and it
  # reports green on its in-process ledger — the exact failure mode above.
  if [ "$SET_RC" -ne 0 ]; then
    echo "STOP: secret set failed (rc=$SET_RC). The broker was NOT restarted, so it is still running its previous configuration. Fix the write, then re-run this step."
  else
    az containerapp revision restart --subscription "$SUB" -g "$RG" -n loom-capacity-broker \
      --revision "$(az containerapp show --subscription "$SUB" -g "$RG" -n loom-capacity-broker --query properties.latestRevisionName -o tsv | tr -d '\r')"
  fi
fi
```

If the decision was **"leave the broker on its in-process ledger"** (defensible
today: it runs 0 replicas and the ledger is a smoothing input, not a system of
record), then **clear** the stale binding so the broker does not spend 5 seconds
per boot dialling a cache it can never authenticate to:

```bash
az containerapp update --subscription "$SUB" -g "$RG" -n loom-capacity-broker \
  --set-env-vars "LOOM_BROKER_REDIS="
```

Record the choice in the issue. An undocumented "we left it" becomes an
unexplained regression six months from now.

---

## 4. Verification — how you know each client actually reconnected

A green revision is **not** verification. Both clients are built to degrade
silently, which means a failed cutover and a successful one look identical from
the outside. Every check below is **positive**: it requires the new cache to show
work, not merely the app to stay up.

### 4.1 loom-console result cache — the authoritative check

```bash
AMR_RID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Cache/redisEnterprise/$AMR"   # if not already set in §3.5
MSYS_NO_PATHCONV=1 az monitor metrics list --subscription "$SUB" --resource "$AMR_RID" \
  --metric cachehit cachemiss connectedclients --aggregation Total Maximum \
  --interval PT5M --offset 30m -o json
```

**PASS:** `cachemiss` **> 0** within ~15 minutes of driving traffic (open a
Console surface that runs a cached query — the Data Explorer / query result
grid — twice), then `cachehit` **> 0** on the second run. `connectedclients` > 0.

**FAIL — and this is the failure mode that looks like success:** `connectedclients`
climbs but `cachehit`/`cachemiss` stay 0. That is the `OSSCluster` /
wrong-port / auth-rejected signature. Go back to §3.2.

**FAIL:** all three flat at 0 ⇒ the Console never connected. Check the revision
picked up the env var:

```bash
az containerapp show --subscription "$SUB" -g "$RG" -n loom-console \
  --query "properties.template.containers[0].env[?contains(name,'RESULT_CACHE')]" -o json
```

The client warns exactly once per replica on failure; the string is
`[redis-cache-client] shared Redis tier unavailable; using local tiers only`
(`redis-cache-client.ts:272`):

```bash
az containerapp logs show --subscription "$SUB" -g "$RG" -n loom-console --tail 500 \
  | grep -F "redis-cache-client"
```

Absence of that warning plus non-zero `cachemiss` is the pass. Absence of the
warning *alone* proves nothing — the client only warns after it has tried, and
`ensureConnected()` never blocks a request.

### 4.2 loom-capacity-broker — only if §3.5 pointed it at AMR

The Go ledger `PING`s once at construction and falls back to the in-process
ledger on any failure, surfacing the error upstream for logging
(`ledger.go:59-73`). The backend it actually chose is reported per response via
`Backend()`, so ask the app rather than inferring:

```bash
az containerapp update --subscription "$SUB" -g "$RG" -n loom-capacity-broker --min-replicas 1
az containerapp logs show --subscription "$SUB" -g "$RG" -n loom-capacity-broker --tail 200
```

**PASS:** the ledger reports `redis`, and `connectedclients` on the AMR cluster
increases by at least one.
**FAIL:** the ledger reports `memory` — the broker is up, admission control still
works per replica, and cross-replica LCU coherence is silently gone. That is a
FAIL, not a degraded pass.

Return `--min-replicas` to its prior value afterwards (0 today; the template says
2 — decide which is correct and make them agree, in a separate change).

### 4.3 Confirm the old cache went quiet

```bash
MSYS_NO_PATHCONV=1 az monitor metrics list --subscription "$SUB" --resource "$RID" \
  --metric getcommands setcommands allconnectedclients --aggregation Total Maximum \
  --interval PT1H --offset 2h -o json
```

Because the cache was already at zero application traffic before the cutover
([§1](#1-what-is-actually-connected-measured-not-assumed)), this is a
*control*, not a success criterion: it should look exactly as it did in §2.1.
A change here means something you did not inventory is connected.

### 4.4 Console end-to-end

Per `ux-baseline.md` G1 the cutover is not complete on metrics alone. Sign in,
run the same query twice on a query surface, and confirm the second run reports a
cache hit in the result grid's timing status bar. Attach that to the change
record.

---

## 5. Rollback

**Rollback is cheap and fast for the whole window, because nothing is deleted and
there is no data to lose.** The classic cache keeps running untouched throughout
§3 and §4; AMR is additive.

**Trigger:** any FAIL in §4, or any Console latency regression, or any doubt.

**5.1 — Console (≈2 minutes, one revision roll):**

```bash
az containerapp update --subscription "$SUB" -g "$RG" -n loom-console \
  --set-env-vars "LOOM_RESULT_CACHE_REDIS="
```

An empty value turns the tier off outright (`redisCacheConfigured()` is a
non-empty check, `redis-cache-client.ts:72`) and the result cache reverts to the
per-replica in-process LRU — **which is exactly the state it was in before this
runbook**, since the var was never set on the live console. There is no
degradation relative to the pre-cutover baseline. This is the whole reason the
Console half of the cutover is low risk.

**5.2 — Capacity broker (≈2 minutes), only if §3.5 changed it:**

```bash
# Restore the previous revision wholesale — it still carries the old redis-conn
# secret pointing at the classic cache, which is still running.
az containerapp revision activate --subscription "$SUB" -g "$RG" -n loom-capacity-broker \
  --revision "$(python -c "import json;print(json.load(open('./temp/rollback/broker-<date>.json'))['rev'])")"
```

If §3.5 cleared `LOOM_BROKER_REDIS` instead, restore it from the captured env
JSON (the value is a `secretRef` name, not a secret).

**5.3 — Infrastructure:** leave the AMR cluster in place. It costs money but it
is idle, and tearing it down mid-incident removes your ability to retry. Delete
it in a follow-up change if the migration is abandoned:

```bash
az resource delete --subscription "$SUB" -g "$RG" -n "$AMR" --resource-type Microsoft.Cache/redisEnterprise
```

**5.4 — What rollback does NOT cover.** If §8 has already run and the classic
cache is deleted, there is no rollback target. That is the entire reason §8 is a
separate change on a separate day.

---

## 6. What breaks if this is done wrong, and the blast radius

### 6.1 Blast radius per client

| Client | If the cutover is wrong | Blast radius | Severity today |
|---|---|---|---|
| **loom-console** — result cache | Client cannot connect / auth / speak the cluster protocol. `withDeadline` caps connect at 2 s and each op at 500 ms, and the circuit breaker opens after 3 consecutive failures for 60 s (`redis-cache-client.ts:99-121,161-177`). Requests then serve from the in-process LRU, Cosmos, and finally a direct query. | **Latency only.** No 5xx, no data loss, no auth impact. | **None** — the var is unset today, so the "broken" state *is* the current state. |
| **loom-console** — Spark warm-lease store | `sharedSubstrateConfigured()` is a presence check over three vars (`spark-lease-store.ts:106`). A bad endpoint still reads as "configured". | Warm Spark sessions stop being shared across replicas; the pool falls back to per-replica leases and the Cosmos `spark-warm-leases` container. Cold-start latency on notebook attach. | **None** — all three vars are unset/empty today. |
| **loom-capacity-broker** — LCU ledger | `NewRedis` dials + `PING`s at construction and returns the in-process ledger on failure (`ledger.go:59-73`). The service stays up. | Admission control smooths per **replica** instead of estate-wide ⇒ over-admission under concurrency, and the 4-stage throttle reads a partial window. **Silent**: no error surfaces to a caller. | **None today** (0 replicas), **Medium** whenever it is scaled up. |
| **The estate generally** | Nothing else binds Redis — verified across all 30 Container Apps. | — | None |

### 6.2 The four traps that produce a green-but-broken cutover

1. **`OSSCluster` clustering policy.** The ARM default. Both Loom clients are
   non-cluster-aware and fail silently. `managed-redis.bicep:138` pins
   `EnterpriseCluster` for exactly this reason — verify it on the *deployed*
   resource (§3.2), not in the source.
2. **Port 6380.** AMR is **10000**. Any consumer or script that appends a
   hard-coded `:6380` to the host output points at a closed port. Always publish
   the module's `redisEndpoint` output verbatim.
3. **TLS on the broker — and never a `rediss://` URL.** The Go client only
   auto-enables TLS when the address ends `:6380` (`redis_ledger.go:124-126`),
   so a bare `host:10000` connects in **plaintext** to a TLS-only listener and
   fails. TLS must be set explicitly — and it must be set with the comma form
   `host:10000,password=KEY,ssl=True`, **not** with `rediss://:KEY@host:10000`.
   An AMR access key is standard base64, whose alphabet includes `/`, and an RFC
   3986 authority ends at the **first** `/`. Measured with an RFC-3986 parser:
   `ab/cd==` yields `Port could not be cast to integer value as 'ab'`, and
   **48.4%** of keys derived from 32 random bytes contain at least one `/`
   (n=100000). Go's `url.Parse` truncates the authority the same way — before
   `parseAuthority` looks for the last `@` — so it reports a bogus `invalid
   port`, and `ledger.go:67-71` turns that error into a **silent** fallback to
   the in-process ledger. `parseConn`'s comma branch (`redis_ledger.go:95-115`)
   splits on `,` then `SplitN(p,"=",2)`, so both `/` and `=` padding survive
   intact. The executable step is
   [§3.5](#35-decide-and-apply-the-capacity-brokers-ledger); keep the two in
   step if either changes.
4. **Access-policy granularity.** AMR accepts exactly one policy name —
   `default`, which is full data access. Classic's
   Data Owner / Contributor / Reader split does not exist. Every principal you
   assign gets **more** access than it had on classic. That is a real posture
   change; disclose it in the change record rather than discovering it in an
   audit.

### 6.3 The Capacity Broker cannot speak to AMR under the module defaults

**This is a blocking design decision, not a step.** It is tracked as **#4270**.
Two facts collide:

- `managed-redis.bicep:155` sets `accessKeysAuthentication: 'Disabled'` by
  default — deliberately, so there is no shared key to leak; Loom connects with
  Entra tokens.
- `apps/loom-capacity-broker/internal/ledger/redis_ledger.go:151-162` sends only
  `AUTH <password>` (optionally `AUTH <user> <password>`). It has **no Entra
  token path at all** — unlike the Console client, which does.

So on an Entra-only AMR the broker has no way to authenticate, `NewRedis` fails
its `PING`, and it silently falls back to the in-process ledger. Choose one,
before the window:

| Option | What it costs | What it gives up |
|---|---|---|
| **A. Enable access keys on the AMR database** and hand the broker a `host:10000,password=KEY,ssl=True` secret (comma form — never `rediss://`, see [§6.2 trap 3](#62-the-four-traps-that-produce-a-green-but-broken-cutover)) | A shared key exists again — the thing `accessKeysAuthentication: 'Disabled'` was set to avoid. Key rotation becomes a standing obligation. | Nothing functionally. Fastest path. |
| **B. Leave the broker on its in-process ledger** (clear `LOOM_BROKER_REDIS`) | Cross-replica LCU coherence, whenever the broker is scaled above 1 replica. | Nothing today — it runs 0 replicas. Costs nothing, defers the problem. |
| **C. Teach the Go client Entra auth** (`AUTH <oid> <token>` + background token refresh, mirroring `redis-cache-client.ts:331-347`) | Engineering work + a broker image rebuild. Note `loom-capacity-broker` currently has **no CI image producer** (#3370), so this needs an image lane first. | Nothing. The correct end state. |

**Recommended: B for the cutover, C tracked as the follow-up.** B is honest about
today's estate (the broker is not running), keeps the Entra-only posture intact,
and does not manufacture a key to rotate. A is acceptable if the broker must be
scaled up before C lands — but write down that a key now exists.

---

## 7. Window estimate

### 7.1 With the measured state (empty cache, no traffic)

| Step | Estimate | Basis |
|---|---|---|
| §3.1 AMR cluster + database + PE + DNS group | **20–45 min** | **Estimated, not measured.** Zero `redisEnterprise` resources have ever been created in this subscription, so there is no local history, and Microsoft publishes no provisioning SLA for AMR. Treat this as the one genuine unknown and budget the top of the range. |
| §3.2–3.3 Verify properties + in-VNet `PING` probe | 5–10 min | ARM reads plus one `containerapp exec`. |
| §3.4 Console env + revision roll | 3–5 min | Single-revision ACA roll, measured behaviour on this estate. |
| §3.5 Broker (only under option A) | 5 min | Secret set + revision restart. |
| §4 Verification incl. the browser E2E | 15–20 min | Metrics land on a ~5 min granularity, so two runs plus a settle. |
| **Total wall clock** | **50–85 min** | |
| **Of which any client is affected** | **≈0 min** | Nothing is connected; §3.4 is an *addition*, and the classic cache runs untouched throughout. |

The window is long because provisioning is slow, **not** because anything is
down. Schedule it as a change, not as an outage. Rollback (§5) is ~2 minutes and
returns the estate to a state byte-identical to today.

### 7.2 If the cache is no longer empty

If §2.1 finds `totalkeys > 0`, this stops being a provision-and-point:

- Add a **data migration** decision (accept a cold cache and let it refill, or
  export/import per the
  [migration guide](https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview)).
  For a pure LRU result cache, "accept a cold cache" is almost always right and
  costs a brief latency bump — **it is not right for the Broker ledger**, whose
  keys are a 24 h rolling window with a 24 h `EXPIRE`.
- Add a **traffic drain** step before §3.4.
- Add **60–90 min** and re-derive the blast-radius table with real severities.

---

## 8. Decommissioning the classic cache

**Separate change, separate day, minimum 7 days after a clean §4.**

Deleting the old cache is what makes rollback impossible, so it does not belong
in the cutover window. Before deleting:

```bash
# Prove nothing has connected since the cutover.
MSYS_NO_PATHCONV=1 az monitor metrics list --subscription "$SUB" --resource "$RID" \
  --metric allconnectedclients getcommands setcommands --aggregation Maximum Total \
  --interval P1D --offset 7d -o json
```

`getcommands`/`setcommands` must be 0 for the full 7 days and
`allconnectedclients` must be at its Azure-management baseline (4–6). Then delete
the cache **and** its private endpoint `pe-redis-loom-hband`, and remove the stale
A record from `privatelink.redis.cache.windows.net`.

Note the classic cache has **no RDB or AOF backup configured** (`rdbBackupEnabled`
and `aofBackupEnabled` are both null, measured 2026-09-01), so deletion is
irreversible and there is no snapshot to restore. With `totalkeys: 0` that is
academic — but confirm it is still 0 on the day.

---

## 9. What the platform does automatically, and what needs you

`auto-bind-by-default.md` §5 is explicit: anything the platform *can* do, it
must; "set `LOOM_X` yourself" as a terminal state is a defect. Here is the honest
split.

### 9.1 Already automatic

| Action | Where |
|---|---|
| Create the AMR cluster + its mandatory `default` database | `modules/shared/managed-redis.bicep` |
| Pin `EnterpriseCluster` so the non-cluster-aware clients work | `managed-redis.bicep:138` |
| Create the AMR private endpoint with the right `redisEnterprise` group id and bind the `privatelink.redis.azure.net` zone group | `managed-redis.bicep:229-255` |
| Assign the Console UAMI Entra data access on the database | `managed-redis.bicep:212-224` |
| Publish `host:10000` as a single `endpoint` output so no caller composes a port | `managed-redis.bicep:296`, `hband-shared.bicep:424` |
| Wire diagnostics to the estate LAW | `managed-redis.bicep:261` |
| Select the backend per boundary (Commercial → managed, sovereign → classic) | `platform/fiab/bicep/main.bicep:933` |
| **Sovereign only:** deploy the OSS Valkey cache *and set all three client vars on the Console* | `modules/shared/redis-oss-aca.bicep`, invoked by `admin-plane/main.bicep` (`redisOssActive`) |

### 9.2 Should be automatic and is not — tracked gaps

These are auto-bind defects, recorded here rather than left as folklore:

1. **`compute/hband-shared.bicep` has zero module invocations repo-wide.** No
   orchestrator deploys the H-band substrate, which is why §3.1 is a hand-run
   `az deployment group create`. Until an orchestrator owns it, the Commercial
   cutover cannot be push-button.
2. **`LOOM_RESULT_CACHE_REDIS` is not emitted for Commercial.** The sovereign path
   now sets it from the deploy; Commercial's is §3.4, by hand. Closing gap 1
   closes this one with it.
3. **`LOOM_BROKER_REDIS` is hard-coded `''` on the Console**
   (`admin-plane/main.bicep`) and `loom-capacity-broker` has **no CI image
   producer** (#3370). Both must be fixed before the broker's binding can be
   produced by a deploy.

### 9.3 Genuinely operator decisions

Not automatable, and correctly so:

- **The change window itself.** Scheduling is an operator judgement.
- **The AMR SKU.** `Balanced_B5` (module default, closest to P1) vs `Balanced_B0`
  (cheapest functional). Cost-material, and the measured working set is zero —
  an `auto-bind-by-default.md` "cost-material opt-in".
- **The [§6.3](#63-the-capacity-broker-cannot-speak-to-amr-under-the-module-defaults) broker auth decision.** Option A materially changes the security
  posture (a shared key exists); that is a person's call.
- **Deleting the classic cache** (§8). Irreversible, no backup configured.

---

## Related

- `.claude/rules/deploy-integrity.md` — R2 (merged ≠ done), R4 (both clouds),
  R7 (error messages must be true)
- `.claude/rules/cloud-parity.md` — why sovereign gets Valkey rather than a
  worse version of this
- `.claude/rules/auto-bind-by-default.md` — §5, and §9.2 above
- `platform/fiab/bicep/modules/shared/managed-redis.bicep` — the AMR module and
  the four ways its shape differs from classic
- `platform/fiab/bicep/modules/shared/redis-oss-aca.bicep` — the sovereign path
- Issue **#2642** — history, including the retracted 2026 creation-block dates
- Learn: [Migrate Basic/Standard/Premium to Azure Managed Redis](https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview)
  · [What's new in Azure Cache for Redis](https://learn.microsoft.com/azure/azure-cache-for-redis/cache-whats-new)
  (the July 2026 revision that withdrew the 2026 creation blocks)
  · [AMR planning FAQ](https://learn.microsoft.com/azure/redis/planning-faq)
