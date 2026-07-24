# flight-sql-connect — parity with a managed Arrow Flight SQL / ADBC serving wire (Dremio Arrow Flight · Databricks SQL ODBC/JDBC · Snowflake ADBC)

**Item:** N3 (loom-next-level) — Arrow Flight SQL + ADBC serving wire
**Surfaces:** lakehouse editor → **Connect** tab (beside N1's Interop tab) · warehouse editor → **Connect** ·
SQL Lab → **Connect**
**Backend:** the Flight SQL gRPC server hosted **in the `loom-duckdb` Container App**
(`apps/loom-duckdb/app/flightsql.py`), on the same engine process that answers the HTTP tier
(`platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep`, `additionalPortMappings` → 8815).

Source spec / UIs this is measured against:

- Arrow Flight SQL protocol — <https://arrow.apache.org/docs/format/FlightSql.html>
- ADBC Flight SQL driver (Python / Go / C++) and the Arrow Flight SQL **JDBC** driver
- Dremio's Arrow Flight endpoint (the "connect your BI tool over Flight" experience)
- Databricks / Snowflake connection-details panes (endpoint + credential + per-client snippets)

---

## Why this exists, and where it lives

ODBC/JDBC spend **60–90% of a large transfer** serializing row-by-row. Flight SQL streams the Arrow
RecordBatches the engine already produced — no re-encode, no row conversion.

**Placement decision (recorded deliberately).** The brief allowed extending `loom-directlake` (DataFusion has a
first-party Flight SQL server) *or* a sibling ACA "if genuinely required". N2b already required a sibling ACA —
`loom-duckdb` — and it is the tier that *executes* interactive SQL over Delta/Iceberg/Parquet. Putting Flight on
that same process means:

- one engine, one result cache, one audit path — an ADBC client and a Loom grid literally read the same batches;
- no second always-on container and no second lake-reader identity to govern;
- `loom-directlake`'s Arrow-IPC HTTP contract stays byte-identical, so HYP-5 / N1 consumers do not churn.

The cost of the decision is that the Flight surface speaks DuckDB's dialect rather than DataFusion's, which is
the same dialect SQL Lab already exposes — so it is one surface for a user to learn, not two.

---

## Feature inventory → Loom coverage

### A. Flight SQL protocol surface

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| A1 | `GetFlightInfo(CommandStatementQuery)` | ✅ plans the statement, returns a `TicketStatementQuery` endpoint + the real result schema | `flightsql.get_flight_info` |
| A2 | `DoGet(TicketStatementQuery)` | ✅ streams real Arrow RecordBatches | `flightsql.do_get` → `pa.flight.RecordBatchStream` |
| A3 | `GetSchema(CommandStatementQuery)` | ✅ schema without materializing rows | `ENGINE.run(sql, max_rows=1)` |
| A4 | `CommandGetSqlInfo` | ⚠️ answered with a correctly-typed **empty** table — this deployment advertises no optional SQL-info capabilities, which is exactly true. Clients fall back to defaults. | `_sql_info_schema()` |
| A5 | Bare-SQL tickets (simple Flight clients) | ✅ accepted, authorized and audited identically | `describe_command` reports "not Any-wrapped" rather than guessing |
| A6 | `ListFlights` | ✅ empty iterator — every flight is a statement the caller submits; there is no static catalog to list | honest, not a stub |
| A7 | Prepared statements, transactions, `CommandGetTables`/`GetDbSchemas`, `DoPut` | ⚠️ honest gap — refused with gRPC `UNIMPLEMENTED` naming the supported set. Catalog browsing is served by N1's Iceberg REST catalog; writes are refused by design (read-only tier). | `flightsql.get_flight_info` guard |
| A8 | Statement handles are single-use and TTL'd | ✅ 120 s TTL, popped on redemption, bound to the minting ticket | `_remember` / `_redeem` |

### B. Credential model — short-lived, Entra-scoped, audited

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| B1 | No long-lived secret anywhere in the flow | ✅ the only credential is a ticket minted per session | `mintFlightTicket` |
| B2 | Minted only from a verified Entra session | ✅ `withSession` (401 first); the claims are copied from the session, never from the body | `POST /api/flightsql/session` |
| B3 | Short expiry, clamped | ✅ default 300 s, hard-capped at 3600 s, floor 30 s | `mintFlightTicket` |
| B4 | Scoped | ✅ the caller's requested scope is recorded in the ticket and in the audit row | claims `scope` |
| B5 | Single audience | ✅ `aud: loom-flightsql`; a ticket cannot be replayed elsewhere | verifier refuses another audience |
| B6 | Cryptographically verified | ✅ HMAC-SHA256 with a Key-Vault-injected key, verified server-side | `tickets.verify_ticket` |
| B7 | Honest when unsigned | ✅ `signed:false` + a note naming `LOOM_FLIGHT_TICKET_SECRET`; the serving tier marks the access row `ticketVerified:false` | never presented as verified |
| B8 | Issuance audited | ✅ `_auditLog` row + SIEM fan-out with the ticket id, scope, TTL, signing posture | `logFlightAccess` |
| B9 | Redemption audited | ✅ one structured line per `DoGet`/`GetFlightInfo`, carrying the SAME `ticketId` | `flightsql._log` |
| B10 | Revocation | ⚠️ honest gap — there is no revocation list; tickets expire in minutes instead. Flipping the FLAG0 `n3-connect-tab` switch withdraws the self-service mint path immediately. | documented, bounded |

### C. Connect tab (Databricks / Snowflake connection-pane parity)

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| C1 | Endpoint + copy affordance | ✅ with an exposure badge (Published / In-VNet only / Not deployed) | `GET /api/flightsql/connect` |
| C2 | **Never** prints an internal container host | ✅ `INTERNAL_HOST_RE` blocks it; the tab explains the in-VNet reality instead | `resolveFlightEndpoint` |
| C3 | Generate a credential in-product | ✅ **Generate ticket** → audited mint, expiry disclosed, copied to clipboard, never rendered | `POST /api/flightsql/session` |
| C4 | Per-client snippets | ✅ ADBC Python · PyArrow Flight · JDBC · ADBC Go · curl (mint) | `buildFlightSnippets` |
| C5 | Snippets contain no secret | ✅ every snippet reads `LOOM_FLIGHT_TICKET` from the reader's own environment; `snippetIsSecretFree` re-checks each body before it ships | route filter |
| C6 | Snippets point at the audited endpoint | ✅ ticket acquisition targets `/api/flightsql/session` on the caller's own origin | `new URL(..., req.nextUrl.origin)` |
| C7 | Renders fully with nothing deployed | ✅ no red on first open; the tab explains that Arrow still flows over the audited HTTP tier | `not-deployed` exposure |
| C8 | Consistent with the sibling Interop tab | ✅ same tab-strip pattern, same card anatomy, same LearnPopover placement; N1's Interop tab untouched | `lakehouse-editor-shell.tsx` |
| C9 | Kill switch | ✅ FLAG0 `n3-connect-tab` | `lib/admin/runtime-flags.ts` |

### D. Loom's own grids over Arrow

| # | Capability | Loom coverage | Backend per control |
| --- | --- | --- | --- |
| D1 | Threshold policy | ✅ ≥ 5 000 rows or ≥ 50 000 cells → Arrow; tunable via `LOOM_FLIGHT_ROW_THRESHOLD` | `lib/arrow/transport-policy.ts` |
| D2 | The decision is explainable | ✅ every decision carries a human `reason` printed in the status bar | `chooseTransport` |
| D3 | Measured before/after | ✅ `compareTransports` subtracts engine time so the number is about the TRANSPORT, and reports honestly when Arrow is NOT faster | `transportMs` / `compareTransports` |
| D4 | Same batches as external clients | ✅ the BFF proxies the identical Arrow IPC stream the Flight wire serves | `POST /api/duckdb/query?format=arrow` |

---

## Where Loom exceeds the comparators

- **The credential is not a password.** Dremio/Databricks/Snowflake connection panes hand out a PAT you paste
  into a tool and forget. Loom hands out a minutes-long, scoped, audited ticket and the snippet reads it from
  your environment — so a screenshot of the Connect tab leaks nothing.
- **It refuses to lie about reachability.** Every comparator prints an endpoint. Loom prints one only when it is
  genuinely reachable, and otherwise says why.
- **Mint and redeem join on one key.** The console's audit row and the serving tier's access line carry the same
  `ticketId`, so an ATO reviewer reconstructs a session end to end.

## IL5 / sovereignty note

gRPC/HTTP2 on Container Apps works in Commercial and Gov. In IL5 the wire stays **internal-ingress only** and
tickets are minted **in-boundary** by this console against in-boundary Entra, so the capability runs
disconnected. There is no SaaS Flight service, no external identity provider and no CDN in the path.

## Verification

- `tests/loom_duckdb/test_flight_wire.py` — the Flight SQL protobuf codec (Any / `CommandStatementQuery` /
  `TicketStatementQuery`, unicode, forward-compat unknown fields, truncation) and ticket verification
  (signature, expiry, audience, unsigned disclosure).
- `lib/azure/__tests__/flight-sql-client.test.ts` — TTL clamping, distinct ticket ids, snippet secret-freedom,
  the internal-host refusal, and the audit row.
- `app/api/flightsql/__tests__/flightsql-routes.test.ts` — 401 first, audited mint, honest not-deployed payload,
  and no internal host in any snippet.
- `lib/components/shared/__tests__/connect-tab.test.tsx` — the tab renders fully in both states and the raw
  ticket never reaches the DOM.
- Browser E2E (G1) pending on a live deployment: mint a ticket in the Connect tab, connect an ADBC client, and
  capture the matching mint/redeem audit pair plus the measured transport comparison.
