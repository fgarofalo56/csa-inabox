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

## Supply chain (SC1 Trivy CRITICAL gate)

The image is scanned by the blocking `Trivy gate` step in
`build-fiab-images-acr-tasks.yml` (`--severity CRITICAL --ignore-unfixed
--scanners vuln`). The pinned upstream base scans **105 CRITICAL**; the
Dockerfile plus `scripts/sc1-harden.sh` take the built image to **0**:

| Layer | Finding | Fix |
| --- | --- | --- |
| ubuntu 24.04 | 84 kernel CVEs on `linux-libc-dev` + `linux-tools-*` @ 6.8.0-52.53 | purge `linux-tools-*` (ABI-pinned — a `dist-upgrade` installs a parallel 6.8.0-136 set and leaves the vulnerable one behind), then `dist-upgrade` to `linux-libc-dev` 6.8.0-136.136 |
| jar | 19 `jackson-databind` 2.4.0 CVEs shaded inside `htrace-core-3.2.0-incubating.jar` | delete the jar — HTrace is in the Apache Attic (no 3.x successor, 4.x renamed the API), and it sits in a dead 15-jar island with zero references from the other 460 jars |
| jar | `CVE-2024-47561` — `avro` 1.11.3 | upgrade in place to 1.11.4 with a pinned sha256 |
| jar | `CVE-2025-30065` — `parquet-avro` 1.12.3 | delete — it cannot class-load on this classpath even unmodified (`parquet-hadoop-bundle` 1.10.0 predates `LogicalTypeAnnotation`), so a 1.15.x swap would be a newer version string on the same unloadable jar |

`sc1-harden.sh` asserts each change landed and then compiles and runs
`ConnectorLibsSmokeTest` against the real connector-node classpath, so a bad jar
swap fails the **build** rather than a sink at runtime. That test is not
decoration: it rejected the first attempt at the htrace fix (repacking the jar
without its shaded jackson left `MilliSpan` unable to run its static
initialiser).

The base pin stays at v2.1.3 on purpose — see the Dockerfile header for why
v3.0.2 was evaluated and not taken.

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
