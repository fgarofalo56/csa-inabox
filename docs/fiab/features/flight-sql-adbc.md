# Arrow Flight SQL and ADBC connect

> **Surface:** the shared **Connect** tab on the lakehouse, warehouse and SQL Lab editors
> **Backend:** the Flight SQL gRPC wire served by the `loom-duckdb` Container App off the same embedded DuckDB process that answers the HTTP tier
> **Kill-switch flag:** `n3-connect-tab` (default ON)
> **Honest gate:** `LOOM_FLIGHTSQL_URL` / `LOOM_FLIGHTSQL_PUBLIC_URL` (gate id `svc-flight-sql`)

"How do I read this from my own tools?" gets a first-class answer. The Connect
tab hands an analyst the endpoint, a short-lived credential, and copy-paste
client code for ADBC / Flight SQL / JDBC — so an external client streams the
**same Arrow RecordBatches** the engine produced instead of paying ODBC's
row-by-row serialization tax.

## Why it exists

ODBC and JDBC spend 60-90% of a large transfer serializing row by row. Arrow
Flight SQL streams the batches the engine already built, over gRPC/HTTP2, with
no re-encode and no row conversion. Because `loom-duckdb` serves the Flight wire
off the *same* embedded DuckDB process that answers Loom's own HTTP tier, an
external ADBC client and Loom's own result grid read byte-identical batches.

The second reason is credential hygiene. Before this tab, "connect your own
tool" meant handing someone a long-lived secret. A Flight ticket lives for
minutes, carries the caller's own Entra identity, and is audited at both mint
and redeem.

## How to use it end to end

1. **Open a lakehouse, warehouse or SQL Lab item** and select the **Connect**
   tab.
2. **Read the exposure line.** The tab states honestly which of three states the
   endpoint is in: **published** (externally reachable), **in-VNet only**, or
   **not deployed**. When the endpoint is internal the tab says so rather than
   printing the `*.internal.*` container FQDN — that hostname would not resolve
   for the reader, so printing it would be a lie dressed as help.
3. **Click Generate ticket.** The BFF mints a ticket **only from a verified
   Entra session**. The ticket carries the caller's Entra identity (object id,
   UPN, tenant), the granted scope, a ticket id, and an expiry in minutes
   (default 5, hard-capped at 60). It is HMAC-SHA256 signed with a
   Key-Vault-injected key that never leaves the boundary, and it is
   single-audience so it cannot be replayed elsewhere.
4. **Copy the ticket.** The tab shows its expiry and copies it to the clipboard.
   This is the only credential in the flow.
5. **Copy a client snippet.** Snippets are emitted per client (ADBC, Flight,
   JDBC) and **read the ticket from your own environment variable** — nothing
   secret is ever rendered inline or captured in a screenshot.
6. **Run it from your tool** and get Arrow batches back.
7. **Join the audit trail.** Issuance and session creation are audited by the
   console; the serving tier logs one structured line per redemption carrying
   the same ticket id, so an ATO reviewer joins mint to redeem on a single key.

The Connect tab is a **read-only surface**. It issues a credential and prints
code. It cannot change the endpoint, the engine, or anyone's access.

## What the backend actually does

| Control | Backend |
|---|---|
| Endpoint + exposure | `LOOM_FLIGHTSQL_URL` (internal gRPC listener) and `LOOM_FLIGHTSQL_PUBLIC_URL` (published listener, when you publish one) |
| Generate ticket | The audited BFF ticket route; HMAC-SHA256 over a versioned payload grammar shared verbatim with the Python verifier in `apps/loom-duckdb` |
| Serving | `loom-duckdb` Container App, Flight gRPC on the additional port mapping, same DuckDB process as the HTTP tier |
| Audit | `_auditLog` plus SIEM fan-out at mint; a structured redemption line at the serving tier |

Both sides of the ticket grammar have unit tests over it, so a mint and a verify
can never drift.

## Honest gates

- **`LOOM_FLIGHTSQL_URL` unset.** The tab renders fully and states that the
  endpoint is not deployed, with a Fix-it naming the variable and the bicep
  module (`platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep`, which
  deploys the Flight listener by default).
- **Internal-only endpoint.** Set `LOOM_FLIGHTSQL_PUBLIC_URL` when you publish an
  externally reachable listener so the tab can hand out a directly usable URI
  instead of explaining that the endpoint is in-VNet only.
- **Ticket verification.** Set `LOOM_FLIGHT_TICKET_SECRET` (a Key Vault secret
  reference, on **both** the Console and the `loom-duckdb` app) so minted tickets
  are cryptographically verified rather than accepted on in-VNet trust alone.

Related tuning on the same tier: `LOOM_DUCKDB_MAX_ROWS` (per-response row cap,
default 200000) and `LOOM_FLIGHT_ROW_THRESHOLD` (rows past which Loom's own grids
switch to the Arrow transport, default 5000).

## Kill-switch

`n3-connect-tab` — default ON. Flipping it OFF hides the Connect tab on the next
render. **Already-minted tickets keep working until they expire** (minutes), the
serving tier is untouched, and every other tab is unaffected. Use it to withdraw
the self-service ticket path without redeploying.

## Related

- [Iceberg REST catalog and interop](iceberg-interop.md) — the other half of external-engine access
- [Trino federation (opt-in)](trino-federation.md)
- Editor guide — [Lakehouse](../tutorials/editor-lakehouse.md) · [Warehouse](../tutorials/editor-warehouse.md)
- [Scoped API tokens](../developer/api-tokens.md)
