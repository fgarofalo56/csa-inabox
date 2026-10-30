# ADR-007 — Measured usage from each gateway's resource logs, attributed by policy traces, folded by a job

**Status:** Proposed 2026-10-28; accepted when W4 ships. W0 (2026-10-29): `GatewayLlmLogs` is offered on Commercial and absent on GCC-High (only `GatewayLogs` and `AllMetrics`); the live diagnostic setting on both is the legacy `AzureDiagnostics` destination (`W0-RECEIPT.md` section 1).
**Mosaic lineage:** ADR 0019 (usage telemetry) and its amendments, 0025
(on-behalf), `usage-analytics.md`.

## Context

The plane is out of the traffic path (ADR-001), so usage can only be read
from what the gateway logs. Loom's bicep sends `GatewayLogs` to Log Analytics
and App Insights (`apim.bicep:131-215`) and #4442 Wave E plans
`llm-emit-token-metric`. Neither attributes a call to a grant, a person or a
cost center.

## Decision

1. **Source**: `ApiManagementGatewayLogs` and `ApiManagementGatewayLlmLog`
   (resource-specific tables), queried per gateway through the Log Analytics
   resource-centric endpoint with Monitoring Reader on the service, so the
   plane needs neither workspace access nor knowledge of where a gateway
   logs. Legacy `AzureDiagnostics` routing is reported, not read. Every value
   spliced into KQL is validated; caller input never reaches a query.
2. **Attribution traces** written by the `loom-*` fragments:
   `loom-attribution v=1 g=<grant> m=<member> a=<client> r=<reference>` after
   grant match and before limits; `loom-deny v=1 r=<reason>` on every refusal
   (fixed reason set: `no-credential`, `key-unknown`, `no-grant`, `model`,
   `access-off`, `cost-center`, `cost-center-mismatch`, `budget`,
   `budget-list`, …); `loom-attempt v=1 …` per pool attempt. Values come from
   policy variables that stay empty until a token validates; metadata uses
   `-` for absent values. No fragment reads bodies.
3. **Diagnostics**: the plane writes the `azuremonitor` logger and a per-API
   diagnostic on APIs it published (100 %, Information, no client IP, headers
   or body bytes, LLM logs with zero prompt/completion bytes). It never
   writes diagnostic settings (routing) and never touches adopted APIs'
   diagnostics. The Telemetry card checks logger, routing (`GatewayLogs` +
   `GatewayLlmLogs`, not `AzureDiagnostics`), the plane's read access (last
   24 h), each published API's diagnostic, and rollups, and prints the `az`
   command for routing fixes.
4. **Rollups** (`apiplane-usage`): facts per day × gateway × grant link ×
   caller with hourly breakdowns by API, deployment, model and client app;
   summaries per day/month × gateway × dimension, sharded at 1,000; an
   attribution registry mapping grant keys and subscriptions to grants (never
   deleted, only marked revoked); state per gateway. The worker runs every 15
   minutes: copy bindings → 15-minute lease per gateway → read today and
   yesterday (+ backfill) → halve windows until results fit → write only
   changed items, delete vanished ones, refold affected months. A day is never
   lowered; a failed query leaves the day unchanged with the reason; manual
   refresh ≤ once per minute per gateway.
5. **Attribution rules**: trace with a known version → grant key (and member
   for group grants); else an APIM subscription in the registry; else
   unattributed with reason (`no-subscription`, `unknown-subscription`,
   `shared-key`). Calls are never dropped. Tokens count only when
   `BackendResponseCode` is 200–299; calls without a model name report under
   the observed model, the deployment name, or **Unknown model**.
6. **Freshness**: current, delayed (> 2 intervals + 30 min), failing,
   waiting for data, no governed APIs; the estate's status is its slowest
   gateway's. Reports show `dataSource` and never fall back to samples; in
   Azure the source is always rollups.
7. **Retention**: daily facts and summaries expire after
   `LOOM_APIPLANE_USAGE_RETENTION_DAYS` (default 400, min 62); monthly
   summaries, registry and state are kept. Object IDs and client IDs are
   personal data; tenants apply retention and access rules to the container
   and the workspace.
8. **On-behalf** (W6): the MCP fragment sets `x-loom-on-behalf-of =
   context.RequestId` when a model caller is configured; the model fragment
   records `r=` only from validated application tokens; the rollup links a
   model call to an MCP call on the same gateway with matching `r=` whose
   caller is the MCP publication's model caller and whose time falls within
   the MCP call's `TotalTime` ± 5 min; `onBehalf` and `onBehalfUnresolved`
   summaries; the application's grant pays, the person is a reporting
   dimension.

## Consequences

- Views lag by ingestion delay plus up to one interval; limits are enforced
  at call time regardless.
- Each governed call adds rows to the customer's workspace (ingestion cost).
- Publications applied before a trace-format change record nothing new until
  reapplied; nothing is grandfathered.
- Shared-key calls can be counted but not tied to a person.

## Alternatives rejected

- Querying Log Analytics per page view (slow, rate-limited, loses history);
  workspace-centric queries (needs Log Analytics Reader everywhere);
  Application Insights and `llm-emit-token-metric` as the ledger (sampling,
  dimension limits, not guaranteed on unmanaged gateways; it stays an
  App Insights nicety owned by #4442 Wave E); APIM's built-in reports (keyed
  to APIM users); Event Hubs streaming (deferred); the plane writing diagnostic
  settings (decides where the customer's logs go and what they cost).

## Verification

`parseAttributionTrace` and `sweep` mutation receipts; `telemetry-probe.mjs`
on Commercial and GCC-High (W0-1 first measures table availability in Gov);
the Loom estate shows ≥ 99 % attributed governed calls after one rollup.
