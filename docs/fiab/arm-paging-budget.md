# Bounded ARM paging — the `nextLink` walk ceiling

> **Code:** `apps/fiab-console/lib/azure/paging-budget.ts`,
> `apps/fiab-console/lib/azure/ttl-memo.ts`,
> `apps/fiab-console/lib/azure/foundry-connections-cache.ts`
> **Issue:** [#2557](https://github.com/fgarofalo56/csa-inabox/issues/2557)
> **Sibling:** [`page-load-timeout-sweep.md`](parity/page-load-timeout-sweep.md)
> — that doc bounds ONE round-trip; this one bounds the LOOP that issues them.

## The gap

`fetch-with-timeout` gives every server-side HTTP round-trip a deadline and says
so explicitly: it bounds one request and *"the poll loop itself is responsible
for bounding its own max-attempts."* No pager in the tree did. A bare
`while (nextLink)` walk therefore inherited **no** ceiling — N pages x the 30 s
per-request budget is an unbounded await on a request path.

Measured: `pagedList('/connections')` on the AOAI target-resolution path
(`aoaiChatJson` → `resolveAoaiTarget` → `listConnections`) took **22.9 s** inside
a route whose own `maxDuration` is 60.

## The ceiling

A `PagingBudget` bounds a walk **two** ways, because either alone leaves a hole:

- a **page cap** stops a cyclic / pathological `nextLink` chain — but 50 pages x
  30 s is still 25 minutes;
- a **wall clock** stops slow pages, and (handed down as each page's
  `timeoutMs`) bounds the very first page too.

### Truncate, never throw

The breach can land in two places and **both behave identically**:

| Where the breach lands | What happens |
|---|---|
| At the loop top (`claimPage()` returns false) | walk stops, rows kept |
| **Inside a page fetch** (`fetchWithTimeout` aborts on the handed-down deadline) | `runPage()` absorbs the `FetchTimeoutError`, records a `time` truncation, walk stops, rows kept |

The second case is the dominant one on a genuinely slow tenant — the 22.9 s walk
breaches mid-page, not at a loop top. If that exception propagated, callers that
read "the list call failed" as "the resource does not exist" would surface a
remediation for the wrong problem. That is exactly what happened in the first
cut of this fix: a paging deadline came out of Copilot as
*"No AOAI deployment on Foundry hub. Deploy a gpt-4o / gpt-4.1-class model
first"* — for a model that already existed.

A deadline now surfaces **as a deadline**:

- `PagingDeadlineError` names the wall clock and the knob and says, verbatim,
  that it *does not* mean the resource is missing;
- `AoaiDiscoveryTimeoutError` (copilot-orchestrator) is a distinct type from
  `NoAoaiDeploymentError`, so a slow ARM is never reported as an un-deployed
  model.

A caller that genuinely needs a complete list opts in — `walkPagedListResult()`
exposes `truncatedBy`, and `PagingBudget.assertComplete()` /
`listConnections({ requireComplete: true })` turn truncation into an error
instead of a silently partial answer.

### Foundry `/connections` cache

`/connections` is the one ARM list on the Copilot hot path, so it also gets a
5-minute in-process memo (`ttl-memo.ts`) — in-process rather than the shared
Redis/Cosmos cache tiers on purpose, because those would add a hop to the very
path being shortened.

- Loom's own create/update/delete invalidate it, and `GET
  /api/foundry/connections?refresh=1` forces a re-walk for a change made outside
  Loom (the hub editor's **Reload** button sends it).
- Invalidation bumps a generation counter, so a write landing while a read is
  in flight is not overwritten by the pre-write snapshot.
- A **time**-truncated walk is never memoized — that truncation means ARM was
  slow *right now*, and caching it would keep the surface wrong for five minutes
  after ARM recovered. A **page-cap** truncation is deterministic (re-walking
  re-pays 10 ARM pages for the identical answer) and stays memoized.

## Operator knobs

All four are optional tuning knobs with code defaults — nothing gates on them
(`default-ON / opt-out`). They are read **per walk**, not once at module load,
so raising one takes effect on the next request without a container restart.
They are set to their defaults in
`platform/fiab/bicep/modules/admin-plane/app-deployments.bicep` so a deployment
can retune them per sovereign region.

| Env var | Default | What it bounds |
|---|---|---|
| `LOOM_ARM_PAGING_MAX_PAGES` | `50` | Pages any one `nextLink` walk may fetch. Matches the `guard < 50` literal the discovery clients already hand-rolled. |
| `LOOM_ARM_PAGING_BUDGET_MS` | `15000` | Wall clock for a whole walk. Deliberately **half** `LOOM_SERVER_FETCH_TIMEOUT_MS` so a multi-page list can't out-live the single request it is made of by more than 1x, and well inside a BFF route's 60 s `maxDuration`. |
| `LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS` | `8000` | Tighter wall clock for the Foundry `/connections` walk (Copilot hot path; also 10 pages, not 50). |
| `LOOM_FOUNDRY_CONNECTIONS_TTL_MS` | `300000` | How long a **complete** `/connections` walk is memoized in-process. |

### Reading the warn line

A truncated walk logs exactly one line:

```
[paging-budget] foundry /connections: stopped by time budget after 2 page(s) / 8001ms
(caps: 10 pages, 8000ms) — returning 14 row(s), the list may be incomplete.
Raise LOOM_ARM_PAGING_BUDGET_MS if this collection is legitimately larger (read per walk — no restart needed).
```

Silence means the list is whole. `stopped by pages` → the collection is larger
than the cap (raise `LOOM_ARM_PAGING_MAX_PAGES`). `stopped by time` → the
backend was slow (check ARM / private-endpoint reachability first; raise the
budget only if the collection is genuinely large).

## Coverage

Bounded through `walkPagedListResult` / a `PagingBudget` loop: `foundry-client`
(`pagedList` — 9 lists — plus `listComputes`, `listNotebookSchedules`),
`aml-client`, `aml-automl-client`, `aml-environments-client`,
`eventhubs-client`, `eventgrid-topics-client`, `synapse-artifacts-client`, and
the `api/setup/subscriptions`, `api/setup/scan-cosmos`,
`api/admin/gates/[id]/options` routes.

**Not yet** — these carry a `guard < N` page cap but no wall clock. They cannot
spin forever; they can still be slow, and they adopt the budget when next
touched: `databricks-discovery`, `iothub-client`, `kv-secrets-client`,
`monitor-client` (x3), `network-discovery`, `storage-discovery`,
`workspace-roles-client`, `azure-connections-client`, `cmk-client` (x2),
`api/azure/connectables` (x2), `api/items/eventstream/spark-binding`.

## Tests

| Spec | What it proves |
|---|---|
| `lib/azure/__tests__/paging-budget.test.ts` | Budget arithmetic; an endless pager stops on the page cap; a **hanging** pager (one that only settles on `AbortSignal`) truncates mid-fetch and the caller keeps the rows already collected; `requireComplete` raises a `PagingDeadlineError`; a foreign 30 s timeout still propagates. |
| `lib/azure/__tests__/ttl-memo.test.ts` | De-dupe, no error caching, TTL expiry, and the invalidate-during-in-flight race. |
| `lib/azure/__tests__/aoai-discovery-deadline.test.ts` | A paging deadline surfaces as `AoaiDiscoveryTimeoutError`, never as "deploy a gpt-4o model first"; a genuinely empty hub still gets the honest `NoAoaiDeploymentError` gate. |
| `app/api/setup/__tests__/scan-cosmos-route.test.ts` | One slow subscription degrades the scan instead of 502-ing it; the fan-out shares one wall clock. |
| `app/api/admin/gates/__tests__/gate-options-route.test.ts` | The 100-row picker cap bounds the page loop only — a DLZ subscription's resources stay pickable behind a crowded admin subscription; a hanging ARM truncates the picker (`truncated: 'time'`) instead of failing the request. |
