# Loom Hyperscale band — cross-cutting platform (HYP-16)

> **Status:** shared-substrate platform landed; the three H-band services
> (Loom OneLake, Loom Direct Lake, Loom Capacity Broker) ship as standalone
> deployables on this substrate. This page is the honest state of the shared
> platform layer only — per-service state lives with each service's own doc.
>
> **Governing rules:** `no-fabric-dependency.md` (Azure-native is the DEFAULT;
> these services NEVER call `api.fabric.microsoft.com` / `api.powerbi.com` /
> `onelake.dfs.fabric.microsoft.com`), `no-vaporware.md` (real backend + a
> measured PSR-1 receipt per merge), default-ON / opt-out.

## What HYP-16 delivers

The Hyperscale band (`PRPs/active/next-waves/PRP-loom-hyperscale-custom-components.md`)
adds three custom Loom-native substrate services. HYP-16 is the **shared
platform chore** every one of them depends on — it does **not** duplicate the
per-service bicep the individual service modules ship. It provides:

| Piece | What | Where |
|---|---|---|
| Shared Redis | One zone-redundant **Azure Cache for Redis Premium**, Entra-auth only, amortized across four consumers | `platform/fiab/bicep/modules/compute/hband-shared.bicep` |
| Least-privilege UAMIs | Three dedicated per-service managed identities (`uami-loom-onelake`, `uami-loom-directlake`, `uami-loom-capacity-broker`) | same module |
| Diagnostics | Standardized Azure Monitor diagnostic settings (`allLogs` + `AllMetrics` → the shared Log Analytics workspace) | same module |
| Console env wiring | `LOOM_ONELAKE_URL`, `LOOM_DIRECTLAKE_URL`, `LOOM_BROKER_URL`, `LOOM_BROKER_REDIS` on the Console app | `platform/fiab/bicep/modules/admin-plane/main.bicep` (apps[] env) + `lib/admin/self-audit.ts` (`ENV_CHECKS`) |

### Why one Redis (the amortization)

A single Premium cache backs **four** capabilities so the resting cost of the
whole band is bounded (PRP §3 + §8 dedup table):

1. **Loom Direct Lake** segment-residency index —
   `{tableId, deltaVersion, columnId, rowGroupId}` → Arrow IPC bytes.
2. **Loom Capacity Broker** 2,880 × 30-second timepoint LCU ledger.
3. **Warm-Pool Keepalive** shared cross-replica Spark/AML lease store (PSR-3).
4. **Shared Result-Cache** — the `query-cache.ts` "back with Redis later" tier
   (PSR-5 / PSR-6).

One metered resource, four capabilities.

### Least-privilege identity model

Each service gets its **own** UAMI with the narrowest grant that lets it work.
The grants live with the resource being granted (correct RBAC hygiene), not on
one broad identity:

| UAMI | Grant | Uses Redis? |
|---|---|---|
| `uami-loom-onelake` | Storage Blob Data Contributor on the DLZ lake + Cosmos data-plane on the registry containers | No (Cosmos registry) |
| `uami-loom-directlake` | Storage Blob Data **Reader** on the DLZ lake (read-path scan) + Redis Data Contributor | Yes (segment residency) |
| `uami-loom-capacity-broker` | **ZERO data-plane roles** — it gates the caller, never proxies the call — + Redis Data Contributor | Yes (timepoint ledger) |

The Redis Data Contributor assignments for the two Redis consumers are wired in
`hband-shared.bicep` (the cache lives in that module's scope). The
Storage/Cosmos grants are cross-RG/cross-sub to the DLZ and are applied by each
per-service module or out-of-band against those resources.

## Deploy

`admin-plane/main.bicep` is at the ARM 256-parameter ceiling, so the shared
substrate is a **standalone out-of-band entrypoint** (orphan-allowlisted in
`scripts/ci/check-bicep-sync.mjs`):

```bash
az deployment group create -g <admin-resource-group> \
  -f platform/fiab/bicep/modules/compute/hband-shared.bicep \
  -p location=<region> \
     workspaceId=<log-analytics-workspace-resource-id> \
     consolePrincipalId=<uami-console-principal-id> \
     complianceTags='{ "env": "<env>" }'
```

Then set the service URLs on the Console app (values come from each per-service
app module output) via `/admin/env-config` or:

```bash
az containerapp update -n <console-app> -g <admin-resource-group> \
  --set-env-vars \
    LOOM_ONELAKE_URL=https://<loom-onelake-fqdn> \
    LOOM_DIRECTLAKE_URL=https://<loom-directlake-fqdn> \
    LOOM_BROKER_URL=https://<loom-capacity-broker-fqdn> \
    LOOM_BROKER_REDIS=<hband-redis-host>:6380
```

## Default-OFF / opt-out behavior (honest gates)

Every H-band URL is emitted with an **empty default** so a from-scratch deploy is
coherent (the env-sync guard is satisfied) and the band defaults to OFF. When a
service URL is unset the Console lib client **honest-503 gates and silently falls
back** — never to a Fabric requirement:

| Service | URL var | Unset → fallback |
|---|---|---|
| Loom OneLake | `LOOM_ONELAKE_URL` | existing per-item library path (`adls-client` / `lakehouse-shortcuts` / `onelake-security-client`) |
| Loom Direct Lake | `LOOM_DIRECTLAKE_URL` | AAS fast-path or Synapse-Serverless cold path (unchanged semantic layer) |
| Loom Capacity Broker | `LOOM_BROKER_URL` / `LOOM_BROKER_REDIS` | job submission proceeds **unthrottled** with a MessageBar (the broker constrains; it never blocks the platform if absent) |

## Government (GCC / GCC-High / DoD IL4-5)

Fully Gov-capable today. Azure Cache for Redis, user-assigned managed
identities, and Log Analytics are all GA in Government. No managed-service
substitution and no alternate Gov path are required — this substrate is
specifically why the H-band is Gov-capable (it replaces the Gov-scarce,
retirement-track AAS/VertiPaq path with an owned OSS engine on Redis).

## Honest limits (this platform layer)

- **Redis warm-cache cost is real.** Unlike scale-to-zero services, a Premium
  cache costs money at rest. It is bounded by the `redisCapacity` floor (P1) and
  amortized across four consumers — the honest trade for import-class latency
  and stateful admission control, surfaced in the Broker's LCU accounting.
- **Cross-RG grants are out-of-band.** `hband-shared.bicep` creates the UAMIs and
  wires their Redis access, but the DLZ Storage/Cosmos grants (different RG /
  subscription) are applied by the per-service module or a bootstrap grant — this
  module deliberately does not reach across subscriptions.
- **Not wired into an orchestrator.** Because `admin-plane/main.bicep` is at the
  256-param ceiling, the substrate + per-service apps are deployed out-of-band and
  their URLs set post-deploy. This is the same pattern the perf-benchmarks DCR and
  the Event Grid webhook transport already use.

## Cross-references

- `PRPs/active/next-waves/PRP-loom-hyperscale-custom-components.md` — the epic
  (architecture §3, work items §4, per-component sections §5–§8).
- `PRPs/active/next-waves/PRP-performance-scale-parity.md` — the PSR-1 harness /
  PSR-2 CI gate (hard prerequisite; supporting HYP-14/15 reference PSR-3/5/6).
- `platform/fiab/bicep/modules/compute/hband-shared.bicep` — the shared substrate
  module this page documents.
