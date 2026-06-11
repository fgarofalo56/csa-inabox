# Page-load timing harness + no-timeout / non-resolving-catch sweep

Source UI: n/a (cross-cutting reliability fix, not a single Azure/Fabric surface)
Audit task: audit-t106

## The two defects this fixes

**Defect A — server calls without a timeout.** The shared ARM/Fabric fetchers
issued bare `fetch(...)` with no `AbortSignal`. A hung Azure backend (or a
stalled `credential.getToken`) made the BFF route hang indefinitely, which made
the calling page spin forever.

**Defect B — non-resolving catch (spinner-forever).** Client pages gate a
`<Spinner>` on a `null` loading state and resolve it only on the success path;
a `.catch()` that swallows or only logs leaves the spinner up on failure. Even
when the catch *does* resolve, a client `fetch` with no timeout waits out the
whole server budget before settling.

## What was built

### Server half — `lib/azure/fetch-with-timeout.ts`
`fetchWithTimeout(input, init?, timeoutMs?)` wraps `fetch` with an
`AbortController` deadline (default `LOOM_SERVER_FETCH_TIMEOUT_MS`, 30 000 ms —
matching the existing `callMcpTool` budget). It composes a caller-supplied
signal (caller aborts still propagate and are not misreported as timeouts) and
throws `FetchTimeoutError` on the deadline.

`LLM_FETCH_TIMEOUT_MS` (default 120 000 ms, `LOOM_LLM_FETCH_TIMEOUT_MS`) is the
longer ceiling for AOAI `/chat/completions` round-trips and the multi-iteration
MAF agent loop — calls that legitimately exceed the 30 s metadata budget but
must still be bounded. Applied at the inference call sites in
`copilot-orchestrator.ts`, `help-copilot-orchestrator.ts`, `data-agent-client.ts`,
and `ai-functions-client.ts`.

**Full sweep — every server module, not a sample.** The first cut wrapped only
the four shared ARM/Fabric fetchers, which left the independent Azure-native
*default* data-plane clients (ADX/`kusto-client`, `cost-client`, `monitor-client`,
`aisearch-client`, `cosmos-data-client`, `adls-client`, `purview-client`, and
~80 more) on bare, unbounded `fetch()`. Those are exactly the backends the
no-fabric rule cares most about, so a hung ADX/Cost/Monitor query could still
pin a BFF worker forever. The sweep now covers **every** server module:

| Scope | Files | Calls | Through |
|---|---|---|---|
| `lib/azure/**` (server clients) | 86 | 218 | `fetchWithTimeout` (4 LLM sites → `LLM_FETCH_TIMEOUT_MS`) |
| `lib/install/provisioners/**` | 6 | 8 | `fetchWithTimeout` |
| `lib/editors/sql-explorer-helpers.ts` (client helper) | 1 | 2 | `clientFetch` (browser→BFF) |

`'use client'` modules and `fetch(` inside comments / codegen string templates
(e.g. `_palantir-codegen.ts`, which *emits* `fetch(` as client-SDK source) are
correctly left untouched.

**Enforced going forward — CI guard.** `scripts/no-bare-server-fetch.mjs` fails
the build if any non-`'use client'` module under `lib/azure/**` or
`lib/install/**` reintroduces a bare global `fetch(`. Wired as
`pnpm guard:server-fetch` and as a pure-node step in `fiab-console-ci.yml`
(no install needed). This is what makes "every server caller inherits the
ceiling" an enforceable invariant rather than a claim — a regression is now a
red check, not a silent hang.

**LRO-safe:** the timeout bounds ONE HTTP round-trip, not a whole long-running
operation. `202 + Location` LRO handling (`fabric-client` `acceptLongRunning`,
`lakehouse` `peekLoadOperation`, the bounded `LOAD_EARLY_PEEKS` poll loop) is
preserved — each poll request inherits the per-request budget.

**Cloud-invariant:** pure transport behaviour; touches none of the sovereign
endpoint logic in `cloud-endpoints.ts`. Commercial / GCC / GCC-High / DoD all
get the same ceiling.

### Client half — `lib/client-fetch.ts`
`clientFetch(url, init?, timeoutMs?)` is the generalised form of the inline
6 s `AbortController` pattern already in `app/admin/api-management/page.tsx`.
A stalled browser→BFF hop fails fast (≈6 s) instead of waiting out the server
budget; the per-page catch/finally then resolves the loading state.

**Full page sweep — 41 of 47 spinner-gated pages.** The first cut converted 5
pages; the remaining 36 `'use client' page.tsx` files that gate a `Spinner` on
a loading state are now on `clientFetch` (110 call sites). Each was audited to
confirm its `catch`/`finally` resolves the loading state — the non-resolving
half is per-page and `clientFetch` only adds the ceiling. The 6 not converted:
`api-management` already carries the canonical inline 6 s `AbortController`, and
5 pages settle via promise-chain `.catch(() => setX([]))` / react-query
`retry:false`, which already resolve on error.

**High-traffic surface — Monitor / Cost.** `/monitor` (and the Cost tab, which
posts to `/api/monitor/cost`) renders through `lib/components/monitor/monitor-pane.tsx`,
whose 17 bare `fetch()` calls bypassed both fetchers. Initial-load reads
(inventory, health, cost, activity, alerts list) now use the 6 s `clientFetch`
so the page never spins forever; user-triggered KQL log/metric queries, ARM
diagnostics/alert CRUD and Defender remediation use a local `actionFetch`
(`MONITOR_ACTION_TIMEOUT_MS`, 60 s) so a real long query isn't aborted at 6 s
yet is still bounded.

### Harness (already existed — now wired + discoverable)
`scripts/perf-harness.mjs` visits every static `app/**/page.tsx` route with
Playwright, records load ms + console/network errors, sorts slowest-first, and
writes `test-results/perf/perf-report.{md,json}` with a "Flagged (>4000ms,
timeout, errors)" section. Wired as:
- `pnpm perf` (package.json script)
- `make console-perf` (Makefile target)

Run authed via `LOOM_BASE_URL` + `LOOM_STORAGE_STATE` (the artifact `pnpm uat`
mints). The Flagged section is the prioritised fix-list for the client sweep.

## Tests + guards
`lib/azure/__tests__/fetch-with-timeout.test.ts` — success passthrough,
timeout → `FetchTimeoutError`, caller-abort not misreported, env-driven
default. 4/4 green.

`scripts/no-bare-server-fetch.mjs` — CI guard (also `pnpm guard:server-fetch`).
Asserts zero bare global `fetch(` in `lib/azure/**` + `lib/install/**` server
modules. Green on this branch; fails the build on any future regression.

## Perf-report artifact (acceptance: "per-route timing report produced")
The harness emits `test-results/perf/perf-report.{md,json}`, but a meaningful
run is **authed against a live deployment** (`LOOM_BASE_URL` +
`LOOM_STORAGE_STATE`). This branch was built in an isolated CI worktree with no
cloud credentials, so the authed run + attached report is performed in the
deploy/UAT environment (`make console-perf` after `pnpm uat` mints the storage
state), not from the build sandbox. The Flagged (slowest-first) section is the
prioritised fix-list; the sweep above was scoped by *defect class* (every
server data-plane client + every spinner-gated page), which is a superset of
whatever the report flags, so it does not depend on the report to be complete.

## Bicep sync
`LOOM_SERVER_FETCH_TIMEOUT_MS` (30000) and `LOOM_LLM_FETCH_TIMEOUT_MS` (120000)
added to the common Container App env block in
`platform/fiab/bicep/modules/admin-plane/app-deployments.bicep` (tunable per
sovereign region). No new resource / role / Cosmos container required —
transport-only.
