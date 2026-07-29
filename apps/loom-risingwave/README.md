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

## Authentication — mandatory, fail-closed

Upstream RisingWave ships `root` as a **superuser with no password** (with
`AuthInfo` unset the frontend's `UserAuthenticator` is `None`). Deployed that way
to the live Commercial estate on 2026-07-29, this app had env
`[LOOM_LAKE_ACCOUNT]` and **zero secrets**, on the same Container Apps
environment as `loom-script-runner` and `loom-udf-runtime` — two services that
execute user-supplied code. It was removed from the estate.

A network rule cannot fix that: **every app in a Container Apps environment
draws its pod IP from the same infrastructure subnet**, so an ACA
`ipSecurityRestrictions` allow-list that admits the Console necessarily admits
the code-execution apps, and a dedicated environment only moves the problem to
the peer subnets. A credential can, because they do not hold it.

`scripts/entrypoint.sh` is therefore the image ENTRYPOINT and:

1. **exits 1** if `LOOM_RW_ROOT_PASSWORD` is empty — there is no unauthenticated
   branch left in this image;
2. boots the engine **sealed**, `single_node --listen-addr 127.0.0.1:4566`, so
   during bootstrap the wire port exists only inside the container's network
   namespace (upstream forwards `--listen-addr` straight to
   `FrontendOpts.listen_addr`, `src/cmd_all/src/single_node.rs`);
3. applies `ALTER USER root PASSWORD` and then **asserts the negative** — a
   password-less connection must be rejected, or it kills the engine and exits;
4. re-execs bound to `0.0.0.0` against the same `--store-directory`, whose
   SQLite meta store now carries the credential.

The password arrives as a **Key-Vault-backed Container Apps secretRef** resolved
by the app's own managed identity (`risingwaveConfig.rootPasswordSecretUri`),
never as a plain env literal. `postgresql-client` is installed for step 3 and
the entrypoint refuses to start without it.

Residual, disclosed: ACA TCP ingress does not terminate TLS. The credential is
not exposed (md5 salted-challenge handshake), but statements and results are
plaintext in-VNet.

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
