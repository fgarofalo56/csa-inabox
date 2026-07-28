# Trino federation (opt-in)

> **Surface:** SQL Lab editor (`/items/sql-lab/<id>`) → the engine picker, **Federated SQL (Trino)** option
> **Backend:** Trino OSS (Apache-2.0) on a private AKS cluster in your own VNet, registered against the Iceberg REST catalog plus any external connectors; reached only through the audited BFF at `/api/sql/trino`
> **Kill-switch flag:** `n7e-trino-federation` — **default OFF**. This is the one documented exception to Loom's default-on rule.
> **Honest gate:** `LOOM_TRINO_URL` (gate id `svc-loom-trino`)

One SQL statement that joins a Loom Iceberg table with an external PostgreSQL
table. That is the whole value proposition, and it is the one thing the light
default engine cannot do.

## Why it exists — and why it is the one opt-in

Every other capability in Loom is default-ON, because a feature nobody can find
is a feature nobody has. Trino is the documented carve-out for one honest
reason: **it stands up a full private AKS cluster**, which is real, disclosed,
recurring cost. Turning that on silently for every deployment would be a spend
gate imposed without consent.

The carve-out is defensible because Trino **gates no feature**. SQL Lab is fully
functional without it — DuckDB is the default engine and Synapse Serverless the
honest fallback. Trino only *adds* a choice in the engine dropdown. The unset
state is the intended default posture, and it is disclosed in the gate registry
with a Fix-it wizard that names the AKS cost at enable time.

## How to use it end to end

**Prerequisites (operator, one time):**

1. Deploy `platform/fiab/bicep/modules/data-plane/loom-trino-aks.bicep`. This is
   a standalone entry point — the admin-plane orchestrator is at the bicep
   256-parameter ceiling, so this module is applied out of band.
2. Set `LOOM_TRINO_URL` on the Console app to the **internal-ingress**
   coordinator URL.
3. Optional knobs: `LOOM_TRINO_ICEBERG_CATALOG` (the Trino catalog name fronting
   the Loom lake, default `iceberg`), `LOOM_TRINO_AUDIENCE` (Entra audience), and
   `LOOM_TRINO_TOKEN` (a Key Vault secret reference bearer, when the cluster is
   configured for token auth).
4. Turn the `n7e-trino-federation` runtime flag **ON** in **Admin → Runtime
   flags**. The flag defaults OFF, so the option is not even offered until an
   admin opts in.

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
| Engine option visibility | The `n7e-trino-federation` runtime flag (default OFF) |
| Query execution | `POST /api/sql/trino` -> the in-VNet AKS Trino coordinator |
| Caller identity | The session principal is forwarded as the Trino user, so the cluster's access control and query log attribute every statement |
| Upstream auth | `LOOM_TRINO_TOKEN` (Key Vault secret reference) when the cluster uses token auth; otherwise the in-VNet perimeter is the trust boundary — the same posture as the sibling internal services |
| Loom lake access | The N1 Iceberg REST Catalog (`LOOM_ICEBERG_CATALOG_URL`) |
| Audit | `_auditLog` plus SIEM fan-out per statement |

The coordinator has **internal ingress only**. The Console BFF is the only door.

## Honest gates

- **Flag ON but `LOOM_TRINO_URL` unset.** The option appears in the engine picker
  and honest-gates when selected, naming the variable and the bicep module. It
  never silently falls back to a different engine and pretends the result came
  from Trino.
- **Flag OFF.** The option is not rendered at all. DuckDB and Synapse Serverless
  are unaffected and remain the default.
- **A SaaS-only external connector in an IL5 boundary.** Trino itself runs
  disconnected — it is a self-hosted OSS container on your own AKS reading your
  own ADLS Gen2 and in-boundary sources. Connectors that reach an external SaaS
  estate stay honestly gated in a disconnected enclave.

## Kill-switch

`n7e-trino-federation` — **default OFF** (the documented exception to
default-on / opt-out). ON exposes the Trino option in the engine dropdown; it
still honest-gates until `LOOM_TRINO_URL` is wired. OFF hides the option
entirely. DuckDB and Synapse Serverless are unaffected either way.

## Related

- [Iceberg REST catalog and interop](iceberg-interop.md) — how Trino sees the Loom lake
- [Arrow Flight SQL and ADBC connect](flight-sql-adbc.md)
- [PRQL modern-query mode](prql-modern-query.md) — the other SQL Lab language option
- [Governance catalog](../governance/catalog.md) · [Multi-cloud data virtualization](../governance/multi-cloud-virtualization.md)
