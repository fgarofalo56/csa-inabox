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
instead of a silently partial answer. `listConnections({ onTruncated })` is the
softer form: the rows are returned AND the caller is told the list is short, so
it can decide for itself (see *Completeness is the last question* below).

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
- **Only a complete walk is memoized** — a truncated one (either ceiling) is
  handed to the caller that paid for it and then dropped, so the next caller
  re-walks ARM. The memo is shared across consumers that ask for different
  things (Copilot AOAI discovery, `GET /api/foundry/connections`,
  `resolveContentSafetyEndpoint`); caching a partial list would serve it, for
  five minutes, to callers that never asked for a partial list and cannot tell.
  A memo hit is therefore a whole list by construction.

### Completeness is the LAST question, not the first

`requireComplete` / `assertComplete` exist for the negative conclusion only.
A caller looking for one connection must **search first**:

- found in a truncated list → a perfectly good answer, use it;
- **not** found in a *complete* list → a real answer ("it isn't there");
- **not** found in a *truncated* list → not an answer at all; raise the deadline.

`resolveAoaiTarget` gets this wrong the moment it inverts the order: requiring a
complete list up front fails turns whose AOAI connection had already been
collected, which is the fix defeating itself.

## Operator knobs

All six are optional tuning knobs with code defaults — nothing gates on them
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
| `LOOM_FOUNDRY_CONNECTIONS_TTL_MS` | `300000` | How long a **complete** `/connections` walk is memoized in-process. A truncated walk is never memoized. |
| `LOOM_CONNECTABLES_ARG_BUDGET_MS` | `20000` | Wall clock for the `/api/azure/connectables` Resource-Graph fast path (`$skipToken`). Before #2582 this walk had **no** ceiling at all — a bare `fetch`. |
| `LOOM_CONNECTABLES_ARM_BUDGET_MS` | `40000` | Wall clock for the same route's cross-subscription ARM control-plane sweep. Wider than the shared 15 s on purpose: that sweep legitimately takes 20-35 s on a large tenant and must stay `>=` the client's own 40 s `CONNECTABLES_TIMEOUT_MS`. |

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

Every one of those runs its page fetch through `PagingBudget.runPage`, including
the hand-rolled loops (the ones that keep a row cap or rewrite `nextLink` and so
can't use `walkPagedList`). That is not optional polish: handing `remainingMs()`
to `fetchWithTimeout` without absorbing the resulting `FetchTimeoutError` leaves
the loop **throwing** on a deadline, which is the opposite of the contract above.

### The residual pagers — closed by [#2582](https://github.com/fgarofalo56/csa-inabox/issues/2582)

#2568 left fourteen pagers carrying only a hand-rolled `guard < N`. They could
not spin forever, but N pages x the 30 s per-request ceiling is minutes, and a
breach in them was shaped as "stop at N pages", never as a deadline. All now
walk under the budget:

| Site | Walk | Note |
|---|---|---|
| `databricks-discovery` | `armList` | → `walkPagedList` |
| `network-discovery` | `armList` + **2 ARG `$skipToken` walks** | the ARG walks were unlisted |
| `storage-discovery` | `armList` | → `walkPagedList` |
| `azure-connections-client` | `armList` | also swapped a bare `fetch` for `fetchWithTimeout` |
| `iothub-client` | consumer groups | hand-rolled budget loop |
| `kv-secrets-client` | certificates | hand-rolled budget loop |
| `cmk-client` | keys, key versions | also swapped a bare `fetch` for `fetchWithTimeout` |
| `monitor-client` | resource-health ARG, resource-health crawl, activity log, alert history | four, not three |
| `workspace-roles-client` | Graph `transitiveMembers` | **fail-closed** — see below |
| `graph-identity-client` | `getGroupTransitiveMembers` | unlisted |
| `api/azure/connectables` | subscriptions list, per-type list, **ARG `$skipToken`** | the ARG walk had NO ceiling at all |
| `api/items/eventstream/spark-binding` | Synapse workspaces | the route `.catch(() => [])`s this, so a throw silently blanked the picker |

Two call sites needed more than a budget:

- **`workspace-roles-client.graphUserInGroup` is deliberately fail-closed.**
  It is an authorization check, so "truncate and keep the rows" must not become
  "assume the answer": returning a positive off a list we never finished reading
  would grant a role from a membership we never saw. A truncated walk therefore
  answers **`'unknown'`** — the tri-state #3381 added, which
  `userIsTransitiveGroupMember` collapses to `false`, so the posture is the one
  the function always had while the CAUSE is now sayable. (This section
  originally said it answers `false`; that was true when it was written and is
  no longer, because the return type is a `GraphMembership`, not a boolean.)
  `warnIfTruncated` logs the honest cause so the deadline is diagnosable rather
  than silently mis-denying.

  **A SECOND BUDGET LAYER SITS ABOVE IT (#3834).** One `PagingBudget` per
  enumeration bounds ONE group probe; `resolveEffectiveRole` walks EVERY group
  assignment on the workspace, sequentially, and had no ceiling of its own — so
  N groups cost N x (a 30s point-read + a 15s enumeration), on 13 admin-plane
  routes that declare no `maxDuration`. That loop now runs under its own
  walk-wide `PagingBudget`: `maxPages` pinned to the assignment count so the
  wall clock is the only ceiling, `budgetMs` defaulting to
  `DEFAULT_SERVER_FETCH_TIMEOUT_MS` (override with
  `LOOM_GRAPH_GROUP_WALK_BUDGET_MS`), and each probe handed
  `walk.remainingMs()` — which the per-group enumeration then takes the MINIMUM
  of against its own 15s, so one slow group cannot spend the whole walk. A group
  the clock never reached contributes no role, which is fail-closed in the same
  direction as `'unknown'`.
- **`api/azure/connectables` used to report a deadline as a missing role.** Its
  only empty-handed answer was `code:'no_access'`, whose message tells the
  operator to admin-consent the app registration and grant the UAMI Reader at
  the tenant root. A slow ARM that aborted mid-enumeration produced exactly that
  — the route's own comment records the incident, band-aided by raising the
  timeout from 25 s to 40 s rather than by telling the two states apart. The
  truncation is now carried out of `runArg` / `runArmList` and an
  empty-but-truncated result answers `code:'paging_timeout'`, naming the
  deadline and the knob. A truncated walk that DID collect rows returns them
  with `truncated: 'time' | 'pages'` — found-in-a-truncated-list is a good
  answer (see *Completeness is the last question* above).

**Still unbounded on the wall clock** — the same ARG `$skipToken` shape, in
files this change did not otherwise touch. They keep a `guard < N` page cap and
adopt the budget when next touched: `network-topology-graph`,
`topology-inventory`, `api/admin/security/purview/discover`,
`api/landing-zones/discover`, `api/setup/existing-dlzs`.

## Tests

| Spec | What it proves |
|---|---|
| `lib/azure/__tests__/paging-budget.test.ts` | Budget arithmetic; an endless pager stops on the page cap; a **hanging** pager (one that only settles on `AbortSignal`) truncates mid-fetch and the caller keeps the rows already collected; `requireComplete` raises a `PagingDeadlineError`; a foreign 30 s timeout still propagates; **neither** truncation kind is memoized, so no consumer is served another consumer's partial list. |
| `lib/azure/__tests__/paging-budget-handrolled.test.ts` | One case per hand-rolled `PagingBudget` loop (`aml-client.listJobs`, `aml-automl-client.listAutoMlJobs`, `eventhubs-client` `armList`, both `eventgrid-topics-client` walks, `synapse-artifacts-client` `listAll`): a deadline landing inside the page fetch truncates and returns page 1's rows instead of rejecting. |
| `lib/azure/__tests__/paging-budget-residual.test.ts` | The #2582 batch — one case per residual pager, each against a stub whose page 2 settles ONLY on `AbortSignal`, plus a shared `afterEach` assertion that a second fetch was actually issued (proof the MID-FETCH branch ran, not the loop top — a stub that ignores the signal makes that branch unreachable and the test vacuous). Includes the fail-closed `workspace-roles` case: a truncated authz walk answers `false` AND logs the `[paging-budget]` line. |
| `app/api/azure/__tests__/connectables-route.test.ts` | A hanging ARM answers `code:'paging_timeout'` (never `no_access`, never "grant Reader"); a truncated walk that DID collect rows returns them flagged `truncated`; a genuinely empty estate still gets the honest `no_access` gate. |
| `lib/azure/__tests__/ttl-memo.test.ts` | De-dupe, no error caching, TTL expiry, and the invalidate-during-in-flight race. |
| `lib/azure/__tests__/aoai-discovery-deadline.test.ts` | A paging deadline surfaces as `AoaiDiscoveryTimeoutError`, never as "deploy a gpt-4o model first"; a genuinely empty hub still gets the honest `NoAoaiDeploymentError` gate. |
| `lib/azure/__tests__/aoai-discovery-truncated-walk.test.ts` | Over the real client + a stubbed slow ARM: an AOAI connection already collected by a truncated walk RESOLVES; one absent from a truncated walk raises the deadline; one absent from a **complete** walk still raises the honest deploy-a-model gate. |
| `app/api/setup/__tests__/scan-cosmos-route.test.ts` | One slow subscription degrades the scan instead of 502-ing it; the fan-out shares one wall clock. |
| `app/api/admin/gates/__tests__/gate-options-route.test.ts` | The 100-row picker cap bounds the page loop only — a DLZ subscription's resources stay pickable behind a crowded admin subscription; a hanging ARM truncates the picker (`truncated: 'time'`) instead of failing the request. |
