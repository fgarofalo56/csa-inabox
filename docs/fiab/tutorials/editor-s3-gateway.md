# Tutorial: S3-compatible ADLS gateway editor

> CSA Loom `s3-gateway` editor — **Preview lab**. Put an S3 face in front of your
> ADLS Gen2 so `s3://`-only OSS clients can address it, via an
> **Apache-2.0 s3proxy Container App that Loom deploys by DEFAULT** (the AGPL
> MinIO gateway path is deliberately not used). Azure-native — **no Microsoft
> Fabric**.

## What it is

Some OSS clients only speak the S3 API. This lab exposes an S3-compatible
endpoint in front of your ADLS Gen2 so those clients can connect, and prints the
real per-engine connect snippets for the endpoint that is actually configured.

The editor leads with the honest recommendation: **most engines need no gateway
at all.** Trino, Spark, DuckDB, and Snowflake should use the **Iceberg REST
Catalog + native `abfss://`** path instead, which is governed and audited. A
gateway is for clients that speak S3 exclusively.

## When to use it

- You have a client or tool that cannot address `abfss://` and only supports
  `s3://`.
- You are consolidating an existing S3-based toolchain onto Azure storage
  without rewriting every connector.
- Otherwise: use the Lakehouse **Interop** tab (Iceberg REST Catalog) and the
  native `abfss://` path.

## Step-by-step in Loom

1. **Create the item.** **+ New item → S3-compatible ADLS gateway**. The editor
   opens at `/items/s3-gateway/<id>` with a **Preview** badge, and an
   `endpoint set` badge once a gateway is wired.
2. **Read the native path first.** An always-visible info MessageBar shows the
   no-gateway path: the Iceberg REST Catalog note plus a real `abfss://` example
   built from your deployment's own lake account. If that covers your engines,
   stop here — you do not need a gateway.
3. **Deploy an s3proxy (operator step).** Stand up an **Apache-2.0 s3proxy** in
   front of your ADLS Gen2 storage account. This is an operator action outside
   the editor; the editor never claims a gateway that is not there.
4. **Wire the endpoint.** Use the **Fix-it** on the honest gate to set
   `LOOM_S3_GATEWAY_URL`. The editor refetches `GET /api/s3-gateway/info` and the
   gate clears.
5. **Copy a connect snippet.** With the endpoint set, the editor prints the real
   gateway endpoint and a snippet card per engine — currently **DuckDB (s3
   extension)** and **Trino (hive/iceberg connector)** — each labelled with its
   language, ready to paste into that client's configuration.

## The Azure backend it rides on

- **Gateway:** an **Apache-2.0 s3proxy** Container App deployed by default with
  the platform (`platform/fiab/bicep/modules/data-plane/s3-gateway-aca.bicep`) and
  addressed by `LOOM_S3_GATEWAY_URL`. Internal ingress only, `read-only-blobstore`,
  `minReplicas 0` so it costs nothing at idle, and **S3 signature checking is
  always on** — there is no reachable anonymous mode.
- **Identity:** the proxy runs as a **dedicated** user-assigned identity,
  `uami-loom-s3gw-<region>`, created by its own module and granted **only Storage
  Blob Data Reader** on the lake at the lake's own resource-group / subscription
  scope. It is deliberately *not* the Console UAMI (which also holds Blob Data
  Contributor, Key Vault Secrets User and Network Contributor): `read-only-blobstore`
  is an application-layer control and would not survive a compromise of a Java
  process parsing attacker-supplied S3 signatures, so the IAM boundary carries the
  posture. No account key, no SAS, no connection string anywhere. The Console UAMI
  is attached only as the ACR pull credential.
- **Image:** the pinned upstream `s3proxy:3.3.0`, **mirrored into your own ACR**
  by the image producer for your cloud (`full-app-deploy-commercial.yml` →
  `mirror-upstream` for Commercial, `gov-provision-dataplane-images.yml` for
  GCC-High / IL5). A locked-egress or air-gapped estate therefore needs no
  docker.io egress at pull time.
- **S3 wire credential:** stored in the Loom Key Vault as
  `loom-s3-gateway-access-key` / `loom-s3-gateway-secret-key`, and delivered to the
  container as Container Apps *secrets* — never a plain env value. It is derived
  from the gateway's own dedicated identity, which means it is **stable across
  redeploys**: an external S3 client (Trino, Spark, boto3) holding the pair does
  not start failing with `SignatureDoesNotMatch` after a routine redeploy. (The
  module also accepts an orchestrator-supplied unpredictable seed value instead;
  that variant rotates on every full redeploy and is documented in the module's
  SECURITY POSTURE block.)
- **Storage:** your own **ADLS Gen2** account (the same lake every other Loom
  item reads).
- **Preferred alternative:** the **Iceberg REST Catalog** + native `abfss://`,
  which is the governed, audited path.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| `LOOM_S3_GATEWAY_URL` unset | Fix-it gate (warning, never red) plus *"No S3 gateway wired — and most deployments don't need one"*; the native path stays visible | On a first **tenant-topology** install this is the expected state: that topology deploys no landing zone, so there is no ADLS Gen2 for the proxy to front and standing one up would be a URL that 404s every bucket. **Attach a domain landing zone** (`topology=dlz-attach`) — that pass deploys the gateway into the hub Container Apps environment and patches this var onto the running Console automatically (`main.bicep` `dlzAttachS3Gateway` → `landing-zone/hub-console-dlz-env.bicep`). A single-sub estate gets it directly from `admin-plane/main.bicep`. Otherwise the var is unset only when the apps tier is off or on an AKS boundary |
| `/api/s3-gateway/info` fails (network / timeout) | Error MessageBar with the underlying message and a **Retry** button; it states explicitly that the native `abfss://` + Iceberg REST Catalog path is unaffected | Retry; check console connectivity |
| `n8-s3-gateway` flag off | Guided "turned off" notice; the Iceberg REST Catalog and native `abfss://` path keep working | Re-enable the flag in **Admin → Runtime flags** |

## Licensing note

Loom uses **s3proxy (Apache-2.0)** for this lab. The AGPL-licensed MinIO gateway
path is intentionally not used, so a deployment can adopt this lab without
inheriting AGPL obligations.

## No Fabric required

s3proxy + ADLS Gen2. No Fabric capacity, workspace, OneLake path, or Power BI
workspace is involved.

## Learn more

- Lakehouse editor tutorial (Interop tab / Iceberg REST Catalog):
  `editor-lakehouse.md`
- SQL Lab editor tutorial: `editor-sql-lab.md`
- DuckLake catalog lab: `editor-ducklake-catalog.md`
