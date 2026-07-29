# Trino federation

> **Surface:** SQL Lab editor (`/items/sql-lab/<id>`) → the engine picker, **Federated SQL (Trino)** option
> **Backend:** Trino OSS (Apache-2.0) as a scale-to-zero, internal-ingress Container App in your own VNet, registered against the Iceberg REST catalog plus any external connectors; reached only through the audited BFF at `/api/sql/trino`
> **Kill-switch flag:** `n7e-trino-federation` — **default ON** (opt-out)
> **Honest gate:** `LOOM_TRINO_URL` (gate id `svc-loom-trino`) — wired by a push-button deploy

One SQL statement that joins a Loom Iceberg table with an external PostgreSQL
table. That is the whole value proposition, and it is the one thing the light
default engine cannot do.

## It used to be opt-in. It is not any more.

Trino was the single documented carve-out from Loom's default-on rule, for one
honest reason: it stood up a **private AKS cluster**, which is real, recurring,
un-avoidable cost — an AKS system node pool cannot scale below one node, so it
bills 24/7 whether or not anyone runs a query. Enabling that silently for every
deployment would have been a spend gate imposed without consent.

That premise no longer holds. Trino's supported single-process deployment
(`coordinator=true` + `node-scheduler.include-coordinator=true`) runs the whole
engine in **one container**, so it ships as an internal-ingress Container App
with `minReplicas: 0`: no replica exists until a query arrives, and idle cost is
**nothing**. The capability is therefore default-ON like everything else, and the
multi-node AKS module remains as the **opt-in scale-out** path for federations
that outgrow one container.

The trade is a **cold start**: the first query after an idle period waits ~20-40s
for the JVM. The BFF budgets 120s for that hop
(`LOOM_TRINO_FETCH_TIMEOUT_MS`). Set `minReplicas: 1` on the module if a warm
engine is worth ~$60-90/mo/cloud.

## How to use it end to end

**Prerequisites: none on a push-button deploy.** `admin-plane/main.bicep` deploys
`platform/fiab/bicep/modules/data-plane/loom-trino-aca.bicep` and emits
`LOOM_TRINO_URL` whenever `loomBackends.trino != 'disabled'` on a Container Apps
boundary — which is Commercial **and** both Gov boundaries. The `loom-trino`
image is built by the standard image matrix, so nothing is applied out of band.

Optional knobs: `LOOM_TRINO_ICEBERG_CATALOG` (the Trino catalog name fronting the
Loom lake, default `iceberg`), `LOOM_TRINO_AUDIENCE` (Entra audience),
`LOOM_TRINO_TOKEN` (a Key Vault secret reference bearer), and
`LOOM_TRINO_CATALOG_<NAME>` to register an external federation source without
rebuilding the image (see `apps/loom-trino/README.md`).

**Then, as an analyst:**

1. **Expose the tables you want to federate as Iceberg** — see
   [Iceberg REST catalog and interop](iceberg-interop.md). Trino reads the Loom
   lake through that catalog.
2. Open a **SQL Lab** item and pick **Federated SQL (Trino)** in the engine
   picker.
3. **Write one statement across sources.** A Loom Iceberg table joined to an
   external PostgreSQL, MySQL, Kafka or MongoDB connector registered on the
   cluster.
4. **Read the status bar** for the engine and timing, exactly as on the DuckDB
   tier.
5. **Check the audit rows.** A federated query is an external data-access event:
   the BFF writes an `_auditLog` row (principal, statement scope, catalogs, rows,
   outcome, timestamp) and fans out through the SIEM stream. The audit write is
   awaited before the response is sent — there is no unaudited path to the
   cluster.

## What the backend actually does

| Control | Backend |
|---|---|
| Engine option visibility | The `n7e-trino-federation` runtime flag (default ON) |
| Query execution | `POST /api/sql/trino` -> the in-VNet Trino Container App (scale-to-zero) |
| Caller identity | The session principal is forwarded as the Trino user, so the cluster's access control and query log attribute every statement |
| Upstream auth | `LOOM_TRINO_TOKEN` (Key Vault secret reference) when the cluster uses token auth; otherwise the in-VNet perimeter is the trust boundary — the same posture as the sibling internal services |
| Loom lake access | The N1 Iceberg REST Catalog (`LOOM_ICEBERG_CATALOG_URL`) |
| Audit | `_auditLog` plus SIEM fan-out per statement |

The coordinator has **internal ingress only**. The Console BFF is the only door.

## Honest gates

- **`LOOM_TRINO_URL` unset.** Should not happen on a push-button deploy; it means
  the backend was opted out (`loomBackends.trino='disabled'`), the boundary is
  not Container Apps, or the `loom-trino` image is not in this ACR yet. The
  option appears in the engine picker and honest-gates when selected, naming the
  variable and the bicep module. It never silently falls back to a different
  engine and pretends the result came from Trino.
- **Flag OFF.** The option is not rendered at all. DuckDB and Synapse Serverless
  are unaffected and remain the engine the picker starts on.
- **No Iceberg REST catalog wired.** The engine still starts and serves its
  `jmx` / `memory` catalogs plus any operator-supplied federation source; the
  `iceberg` catalog is simply not rendered, rather than pointed at a URL that
  does not answer.
- **A SaaS-only external connector in an IL5 boundary.** Trino itself runs
  disconnected — it is a self-hosted OSS container in your own VNet reading your
  own ADLS Gen2 and in-boundary sources. Connectors that reach an external SaaS
  estate stay honestly gated in a disconnected enclave.

## Kill-switch

`n7e-trino-federation` — **default ON** (opt-out). OFF hides the Trino option in
the engine dropdown entirely; DuckDB and Synapse Serverless are unaffected either
way. To remove the Container App as well, redeploy with
`loomBackends.trino = 'disabled'`.

## Related

- [Iceberg REST catalog and interop](iceberg-interop.md) — how Trino sees the Loom lake
- [Arrow Flight SQL and ADBC connect](flight-sql-adbc.md)
- [PRQL modern-query mode](prql-modern-query.md) — the other SQL Lab language option
- [Governance catalog](../governance/catalog.md) · [Multi-cloud data virtualization](../governance/multi-cloud-virtualization.md)
