# ARM read quota — who is spending it

> **Code:** `apps/fiab-console/lib/azure/arm-read-gate.ts` (counter + warmer gate),
> `apps/fiab-console/lib/util/arm-counted-raw-fetch.ts` (bare-fetch variant),
> `apps/fiab-console/lib/azure/arm-counted-fetch.ts` (the wrapper),
> `scripts/ci/check-arm-counted-fetch.mjs` + `arm-counted-fetch-allowlist.json` (the guard).
> **Sibling:** [`arm-paging-budget.md`](../arm-paging-budget.md) bounds an ARM page walk;
> [`loom-copilot-throttling.md`](loom-copilot-throttling.md) is the AOAI equivalent.

## Symptom

`429 SubscriptionRequestsThrottled` from ARM. The Console UAMI's READ bucket is
250 tokens refilling at 25/s, per principal per subscription, so one caller's
burst starves every operator read for the next few seconds.

## Where to look

The console logs ONE line per minute (silent when nothing was read):

```text
[arm-reads] {"windowSec":60,"reads":{"warmer.diagnostics":412,"unlabeled":38},"s429":{"warmer.diagnostics":31}}
```

`reads` and `s429` are keyed by caller label (`runWithArmCaller(label, fn)`,
AsyncLocalStorage). `unlabeled` means nobody set a label for that work; find the
route or job and wrap it. Only GETs are counted (writes are a separate ARM bucket).

## What is counted (census, 2026-10-21)

Population: non-test `.ts/.tsx` under `apps/fiab-console/{lib,app}` whose code
(comments stripped) contains `armBase(`, `armHost(` or a management-host
literal — the guard's own `ARM_MARKER`. Reproduce with
`node scripts/ci/check-arm-counted-fetch.mjs` and the counts below with the
`classify()` export of that script.

| | Before | After |
|---|---|---|
| ARM-marked files | 127 | 128 (+ the new wrapper) |
| Counted transport (`beginArmRead` inside) | 2 (`arm-client.ts`, `monitor-arm.ts`) | 3 (+ `arm-counted-fetch.ts`) |
| Raw `fetch`/`fetchWithTimeout`, **uncounted** | **100** | **1** (allowlisted, see below) |
| Route through `armCountedFetch` / `armCountedRawFetch` | 0 | 99 |
| ARM marker but no raw fetch of their own | 25 | 25 |

After-state by file (the 25 "no raw fetch" files only build a URL, scope or
token and are not individually proven to read through a counted transport):

- **Counted transport (3):** `lib/azure/` `arm-client.ts`, `monitor-arm.ts`, `arm-counted-fetch.ts`.
- **`armCountedFetch` (77)** — drop-in for `fetchWithTimeout`: `lib/apps/app-resources.ts`;
  `lib/azure/` 56 clients (every `*-client.ts` / `*-arm*.ts` that built its own ARM URL, incl.
  `adf`, `aas`, `aml*`, `apim`, `kusto*`, `eventhubs`, `synapse-*`, `foundry*`, `cost*`, `monitor-client`);
  `lib/brain-actions/arm*.ts`; `lib/clients/{azure-connections,cmk,workspace-egress}-client.ts`;
  `lib/coe-library/.../live-bindings.ts`; `lib/deploy/discovery-scanner.ts`;
  `lib/install/provisioners/{logic-app,mirrored-database,workspace-monitor}.ts`;
  `lib/setup/{deploy-preflight,estate-scan,user-arm-deploy}.ts`; 7 `app/api` routes
  (`adf/factories/create`, `admin/gates/[id]/options`, `admin/security/purview/discover`,
  `azure/connectables`, `azure/resources`, `setup/scan-cosmos`, `setup/subscriptions`).
- **`armCountedRawFetch` (22, `lib/util/`, kept out of `lib/azure` because breaker-coverage forbids unbounded fetch there)** — drop-in for bare `fetch` (no timeout added):
  `lib/clients/{cost,jupyter-server,networking}-client.ts`, `lib/setup/{lz-rbac,wire-existing}.ts`,
  and 17 `app/api` routes (`admin/azure-resources`, `apim/instances`, `azure/function-apps`,
  `azure/iothub/policies`, `landing-zones/*`, `setup/*`, two `items/*` routes).
- **Allowlisted raw fetch (1):** `lib/admin/health-probes.ts` — `armHost()` only compares a
  hostname; its raw fetches probe Key Vault / app endpoints, not ARM reads.
- **No raw fetch (25):** `lib/admin/{env-checks/*,lcu-autopilot-loop}`, `lib/auth/obo.ts`,
  `lib/azure/{attach-integration,cloud-endpoints,mcp-obo-token-store,powerplatform-client,
  role-grant-client,user-pool-registry,workspace-grants}.ts`, `lib/brain/run/cli.ts`,
  `lib/deploy/fitness-probe.ts`, `lib/logic-app/auto-bind.ts`, `lib/mcp/catalog.ts`,
  two content bundles, `power-automate-editor.tsx`, and 7 `app/` routes.

## How the wrapper behaves

Same signature and request as the function it replaces. A call is counted only
when the method is GET **and** the URL origin equals `armBase()`'s origin, so a
file that mixes ARM with data-plane calls does not book data-plane reads as ARM
(and Gov resolves through `armBase()`, no host literal). Nothing about retry,
timeout or headers changes. One consequence to know: inside a warmer cycle
(`WarmerCycleGuard`) a counted read now also queues in the warmer gate, exactly
as a read through `armFetch` always did.

## Known blind spots (the guard is a regression guard, not a discovery tool)

- A raw fetch to an ARM URL in a file with **no** ARM marker (URL passed in as a
  parameter, or built from a string the marker regex misses).
- A `fetch` aliased to another name, or a call through an SDK that fetches internally.
- Cost Management queries use another transport; they take a warmer token via
  `consumeWarmerToken()` but are not in the `[arm-reads]` counts.
- The counter proves attribution of a burst only for work that sets a label;
  everything else lands under `unlabeled`.

## Adding ARM code

Use `armCountedFetch` (or `armGet`/`armFetch`). `node scripts/ci/check-arm-counted-fetch.mjs`
fails on a new raw fetch next to an ARM helper; an allowlist entry needs a WHY and
a stale entry also fails, so the list only shrinks. Estate verification of the
`[arm-reads]` line on Commercial / Gov: not done (merged, not deployed).
