# loom-trino — Federated SQL engine (N7e)

The **Federated SQL** engine for CSA Loom: a single-node
**[Trino](https://trino.io)** (Apache-2.0) that runs as an *internal-ingress*,
*scale-to-zero* Azure Container App. One SQL statement can join a Loom Iceberg
table on the deployment's own ADLS Gen2 with an external PostgreSQL / MySQL /
MongoDB / Kafka source — which the light default engine (DuckDB, `apps/loom-duckdb`)
does not do.

## Default-ON, and why that is now honest

Trino used to be the single opt-in carve-out of the openness program, on the
grounds that it needed a private AKS cluster. That premise is gone.

Trino's supported single-process deployment (`coordinator=true` +
`node-scheduler.include-coordinator=true`) runs the coordinator **and** the
worker in one JVM, so the whole engine fits in one container. Deployed with
`minReplicas: 0`:

| Shape | Idle cost per cloud | Notes |
|---|---|---|
| **This module** (`data-plane/loom-trino-aca.bicep`) | **~$0** | No replica exists until a query arrives. Consumption billing is per vCPU-second of an *active* replica; a scaled-to-zero Container App has none. |
| Multi-node AKS (`data-plane/loom-trino-aks.bicep`) | **~$140-220** and up | An AKS system node pool **cannot** scale below 1, so at least one node (the module defaults to 3 x `Standard_D4ds_v5`) bills 24/7 whether or not anyone runs a query. The Free control plane is $0; the nodes are not. |

So the default-ON rule (`.claude/rules` — every feature ships enabled, opt-OUT)
is satisfied without a standing bill. The AKS module remains as the **opt-in
scale-out** path for federations that outgrow one container.

**Cold start.** The trade for zero idle cost is that the first query after an
idle period waits ~20-40s for the JVM. The BFF budgets for it
(`TRINO_FETCH_TIMEOUT_MS`, default 120s, in `lib/azure/trino-client.ts`); set
`minReplicas: 1` on the module if a warm engine is worth an always-on replica
(roughly $60-90/mo/cloud at 2 vCPU / 4Gi).

## Wire

The Loom BFF is the only door. `/api/sql/trino` authenticates the caller,
forwards the principal as the Trino user (`X-Trino-User`), runs the statement
over Trino's HTTP protocol (`POST /v1/statement`), and writes an `_auditLog`
data-access row before responding. Ingress is `external: false` — the engine is
never public and has no anonymous path.

## Catalogs

The image is immutable; catalogs are deployment state, rendered at start-up by
`docker-entrypoint.sh`. Nothing is written for a source that is not configured,
so `SHOW CATALOGS` never lists a phantom.

| Catalog | When | Source |
|---|---|---|
| `jmx` | always | in-process (engine self-observability) |
| `memory` | always | in-process scratch (CTAS / temp joins) |
| `iceberg` | `LOOM_ICEBERG_CATALOG_URL` set | N1 Iceberg REST Catalog over the DLZ lake |
| `<name>` | `LOOM_TRINO_CATALOG_<NAME>` set | operator-supplied federation source |

An external source is added without rebuilding the image:

```
LOOM_TRINO_CATALOG_SALES='connector.name=postgresql\nconnection-url=jdbc:postgresql://pg.internal:5432/sales\nconnection-user=loom'
```

Anything carrying a password rides a Key Vault `secretRef` on the Container App,
never a literal app setting.

## Identity & sovereignty

The app carries a user-assigned managed identity (`AZURE_CLIENT_ID` injected by
bicep). Trino's native Azure filesystem runs with `fs.azure.enabled=true` +
`azure.auth-type=DEFAULT`, which authenticates as that identity, and bicep
grants it **Storage Blob Data Reader** on the DLZ lake — read-only by
construction. There are **no storage keys and no SAS** anywhere in the image or
its settings.

Trino is a self-contained JVM server with no external control plane. It reaches
only the in-VNet Iceberg catalog, the deployment's own ADLS Gen2, and whatever
in-boundary sources an operator wires. There is no SaaS query federation (no
Starburst Galaxy, no Athena) and no Microsoft Fabric / OneLake / Power BI on any
path (`.claude/rules/no-fabric-dependency.md`), so the tier runs **disconnected**
in a GCC-High / IL5 enclave. Both Gov param files set
`containerPlatform='containerApps'`, so the engine deploys in Gov exactly as in
Commercial.

## Build

```
az acr build --registry <acr> --image loom-trino:v0.1 \
  --file apps/loom-trino/Dockerfile apps/loom-trino
```

It is in the `all` matrix of `.github/workflows/build-fiab-images-acr-tasks.yml`
and in `.github/workflows/full-app-deploy-commercial.yml`, so a from-scratch
deploy publishes it before the admin plane brings the app up.

## Opt out

* Redeploy with `loomBackends.trino = 'disabled'` — the Container App is not
  created, `LOOM_TRINO_URL` is emitted empty, and SQL Lab keeps serving on
  DuckDB / Synapse Serverless while the Trino option honest-gates.
* Or, with no redeploy, turn off the `n7e-trino-federation` runtime flag in
  **Admin → Runtime flags** to hide the engine choice.
