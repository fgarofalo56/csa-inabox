# loom-risingwave — streaming-SQL tier (N7a)

The **stateful-streaming** tier for CSA Loom: an internal-ingress Azure Container
App running a single-node **[RisingWave](https://github.com/risingwavelabs/risingwave)**
(Apache-2.0). It authors streaming **materialized views** in SQL over **Azure
Event Hubs** (consumed through the namespace's **Kafka-protocol endpoint**,
`<namespace>.servicebus.windows.net:9093`) and sinks the continuously-maintained
results to **Delta / Iceberg** on the deployment's own ADLS Gen2 (the N1 lake) or
serves them over the **Postgres wire**.

It is the tier **above** Azure Stream Analytics — ASA stays the light default for
simple pass-through / tumbling-window jobs; RisingWave handles the stateful class
(multi-stream windowed joins, incremental aggregations, temporal joins) that ASA
cannot express — and it is an **accelerator, never a dependency**: the
`streaming-sql` item type and its editor render fully with `LOOM_RISINGWAVE_URL`
unset, showing an honest Fix-it gate (per `.claude/rules/no-vaporware.md`).

## Wire

The Loom BFF connects to the **frontend Postgres wire on port 4566** only — every
statement is proxied through the audited `/api/streaming-sql/*` routes
(`withSession`, gate-enveloped, `_auditLog` on every mutation). The container has
**internal ingress** (`transport: tcp`); it is never public.

## Identity & sovereignty

The app carries a user-assigned managed identity (bicep grants it *Storage Blob
Data Contributor* on the DLZ lake for the Delta/Iceberg sink). There are **no
storage keys and no SAS** in the image. RisingWave is a single self-contained
Rust binary with no external control plane, so the whole tier runs **disconnected
in an IL5 / air-gapped enclave** against the in-boundary Event Hubs Kafka endpoint
and ADLS Gen2 — no SaaS streaming service, no Microsoft Fabric / OneLake / Power
BI (`.claude/rules/no-fabric-dependency.md`).

## Cost posture (opt-in, disclosed)

The stateful-streaming tier holds materialized-view state and runs a persistent
compute node, so it is **opt-in** and adds roughly **+$150–300/mo per cloud** when
deployed. The `streaming-sql` item type itself is **default-ON** — only the
RisingWave *backend* is an honest Azure infra gate. This is NOT the N7e Trino
opt-in carve-out; it is a standard honest infra-gate like `loom-duckdb` /
`loom-migrate`.

## Deploy

```bash
az deployment group create -g <admin-rg> \
  -f platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep \
  -p location=<region> \
     risingwaveConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
                         "uamiPrincipalId": "<uami-principal-id>", \
                         "acrLoginServer": "<acr>.azurecr.io", \
                         "image": "<acr>.azurecr.io/loom-risingwave:<tag>", \
                         "lakeStorageAccountName": "<dlz-adls-account>" }'
# then set LOOM_RISINGWAVE_URL=<this-app-fqdn>:4566 on the Console app.
```
