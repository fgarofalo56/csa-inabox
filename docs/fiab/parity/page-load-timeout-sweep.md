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

Routed the shared fetchers through it so every downstream caller inherits the
ceiling transitively:

| Fetcher | File | Reach |
|---|---|---|
| `armFetch` | `lib/azure/arm-client.ts` | all `armGet/armPatch/armPut` callers |
| `call` (Fabric) | `lib/azure/fabric-client.ts` | every Fabric REST call |
| `armFetch` | `lib/azure/synapse-pool-arm.ts` | dedicated-pool state/pause/resume |
| `callArm` | `lib/azure/kusto-arm-client.ts` | ADX cluster GET/PATCH |
| bare fetches | `lib/install/provisioners/{lakehouse,eventstream,report}.ts` | OneLake/Fabric provisioning round-trips |

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
Applied to spinner-gated pages so a stalled browser→BFF hop fails fast (≈6 s)
instead of waiting out the server budget, and the existing catch/finally
resolves the loading state:

- `app/thread/page.tsx`
- `app/workload-hub/page.tsx`
- `app/governance/page.tsx`
- `app/governance/insights/page.tsx`
- `app/data-products/page.tsx`

(The server-side fix already bounds the common client→BFF→hung-Azure path
transitively, since the BFF now returns an error within its budget rather than
hanging; `clientFetch` is the defense-in-depth client ceiling.)

### Harness (already existed — now wired + discoverable)
`scripts/perf-harness.mjs` visits every static `app/**/page.tsx` route with
Playwright, records load ms + console/network errors, sorts slowest-first, and
writes `test-results/perf/perf-report.{md,json}` with a "Flagged (>4000ms,
timeout, errors)" section. Wired as:
- `pnpm perf` (package.json script)
- `make console-perf` (Makefile target)

Run authed via `LOOM_BASE_URL` + `LOOM_STORAGE_STATE` (the artifact `pnpm uat`
mints). The Flagged section is the prioritised fix-list for the client sweep.

## Tests
`lib/azure/__tests__/fetch-with-timeout.test.ts` — success passthrough,
timeout → `FetchTimeoutError`, caller-abort not misreported, env-driven
default. 4/4 green.

## Bicep sync
`LOOM_SERVER_FETCH_TIMEOUT_MS` added to the common Container App env block in
`platform/fiab/bicep/modules/admin-plane/app-deployments.bicep` (default
`30000`, tunable per sovereign region). No new resource / role / Cosmos
container required — transport-only.
