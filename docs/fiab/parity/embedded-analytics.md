# embedded-analytics — parity with Power BI Embedded (Fabric-FREE)

Source UI/API: Power BI Embedded — "app owns data" embedding + Embed Token API
(`POST /generateToken`) with **RLS via effective identity** (roles + username).
As of the Fabric era, Power BI Embedded requires a Fabric **F-SKU** capacity —
a hard Fabric dependency this platform forbids (`no-fabric-dependency.md`).
N18 delivers the same capability Azure-natively: **no PBI host, no F-SKU, no
Fabric workspace** — identical on every cloud, and this IS the Gov embed story.

## Power BI Embedded feature inventory (grounded in Learn)

| # | Capability | Power BI Embedded |
|---|------------|-------------------|
| 1 | Embed token minted server-side by the app that owns the data | `POST …/GenerateToken` (app owns data) |
| 2 | Short-lived, scoped token | minutes-lifetime embed token, per-report |
| 3 | Effective identity carried in the token | `EffectiveIdentity { username, roles, datasets }` |
| 4 | **Row-level security enforced at query time** by identity | RLS roles filter the model rows server-side |
| 5 | Client embed component / SDK | `powerbi-client` (`powerbi.embed`, `<div>` + JS) |
| 6 | React wrapper | `powerbi-client-react` (`<PowerBIEmbed>`) |
| 7 | Report renders real data through the service | Analysis Services / dataset query |
| 8 | Token expiry rejected | expired token → 403 at the service |
| 9 | Audit of token issuance | Power BI activity log |

## Loom coverage

| # | Capability | Status | Loom implementation |
|---|------------|--------|---------------------|
| 1 | App-owns-data server mint | ✅ | `POST /api/embed/token` (`withSession`; owner-bound `session.claims.oid`) |
| 2 | Short-lived, scoped, signed token | ✅ | HMAC-SHA256 (key HKDF-derived from `SESSION_SECRET`), single-audience `loom-embed`, TTL clamped to [30 s, 60 min] (`lib/embed/embed-token.ts`) |
| 3 | Effective identity in the token | ✅ | `{ sub, rls }` claims carried in the signed payload |
| 4 | **RLS enforced at query time** | ✅ | The identity's `rls` claims → `MetricFilter[]` ANDed into the compiled `WHERE` by the N15 metric compiler (bound TDS param / escaped KQL literal) — engine-level, never client-side. Two identities ⇒ different rows. Folded into the result-cache key so no cross-identity cache bleed. |
| 5 | Web component / SDK | ✅ | `<loom-report>` custom element (`@csa-loom/embed`), builds on `@csa-loom/sdk` |
| 6 | React wrapper | ✅ | `<LoomReport>` + `useLoomReport` hook (`@csa-loom/embed/react`) |
| 7 | Real data through the service | ✅ | `POST /api/embed/query` → `runGovernedMetricQuery` → real Synapse serverless / ADX (the ONE N15 execute path) |
| 8 | Expired/tampered token rejected | ✅ | `verifyEmbedToken` constant-time HMAC + audience + expiry check → 401 |
| 9 | Audit of issuance | ✅ | `embed-token.mint` audited emit-first (`emitAuditEvent` + `_auditLog`); every query writes the N15 `metrics.query` data-access row with the embed identity as `who` |

## Backend per control

| Control | Backend |
|---------|---------|
| `POST /api/embed/token` | Stateless HMAC mint (SESSION_SECRET-derived key) + Cosmos `_auditLog` + SIEM fan-out. No new Azure resource. |
| `POST /api/embed/query` | Embed-token auth → `runGovernedMetricQuery` → **Synapse serverless (T-SQL, TDS-parameterised)** or **Azure Data Explorer (KQL)**. |
| RLS predicate | N15 `compileMetricQuery` (`CompileMetricArgs.rls`) — whitelisted against the governed model (an unknown dimension fails the query CLOSED), bound/escaped via `@/lib/sql/quoting`. |

FLAG0 kill-switch: `n18-embedded-analytics` (default-ON) — OFF makes both
endpoints return a guided gate on the next call; already-issued tokens stop
resolving. IL5: mint + verify + query run entirely in-boundary, zero external
egress.

**A-grade:** every inventory row ✅ — zero ❌, zero stub. No Fabric F-SKU on any
path.
