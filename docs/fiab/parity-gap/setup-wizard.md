# Parity-gap — Setup Wizard (`/setup`)

**Grade: F (Vaporware)**

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/setup`
Validated: 2026-05-26
Source: `apps/fiab-console/lib/panes/setup-wizard.tsx` + `apps/fiab-console/app/api/setup/deploy/route.ts`

## Live-browser observation

Repeated attempts to load `/setup` in Playwright (3 navigations) all resulted in the
browser auto-redirecting away to a random `/items/<type>/new` route within ~1–3
seconds of landing. The wizard's intro screen was never reachable for screenshot
verification in this session. **This is itself a major (BLOCKER) bug** — see
"Site-wide redirect bug" section below.

The verdict below is therefore based on (a) the **source code** that the page
renders and (b) the **API contract** of the endpoint it calls.

## Wizard step machine (per `setup-wizard.tsx`)

State machine has 8 steps:

1. **intro** — "I'll help you deploy a new Data Landing Zone…" + Get started button
2. **boundary** — Dropdown: Commercial / GCC / GCC-High / IL5 + Next
3. **mode** — Dropdown: single-sub / multi-sub + Next/Back
4. **domain** — Text input for domain name (lowercased + sanitized) + Next/Back
5. **capacity** — Dropdown: F2 / F4 / F8 / F32 / F64 / F128 / F512 + Next/Back
6. **review** — Renders generated bicep param preview + Deploy button
7. **deploying** — ProgressBar + simulated stage text
8. **done** — Success MessageBar + "Deploy another" button

So it's **6 user-facing steps** + 2 internal states (deploying/done).

## Validation behavior (per source)

Each Next button has `disabled={!state.<field>}` — so if the user doesn't pick a
boundary/mode/capacity or doesn't type a domain, Next is greyed out. **This part is
actually correct**: the wizard does enforce step-level required fields.

Note: this is implicit validation (disabled button) rather than explicit error
messaging. A user clicking Next with an empty field gets nothing — no message bar,
no error — they have to figure out the button is grey.

## "Finish" → Deploy button — the killer

When the user reaches the **review** step and clicks "Deploy", the wizard calls:

```http
POST /api/setup/deploy
Content-Type: application/json
{ "step": "review", "boundary": "...", "mode": "...",
  "domainName": "...", "capacitySku": "..." }
```

The endpoint at `apps/fiab-console/app/api/setup/deploy/route.ts` is **a literal stub**:

```ts
// Stub - real impl POSTs to the Setup Orchestrator FastAPI which kicks
// off an azd deploy + tracks progress in Cosmos. Returns a fake
// deploymentId so the Setup Wizard's progress UI animates.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return NextResponse.json({
    deploymentId: `stub-${Date.now()}`,
    status: 'queued',
    config: body,
  });
}
```

So:
- No ARM call
- No Azure MCP server invocation
- No JIT Contributor elevation
- No PIM-for-Groups request
- No bicep deployment
- No resource group creation
- Nothing.

The wizard then runs `setTimeout`-based fake progress that simulates 6 stages
("Validating", "Provisioning network", "Provisioning storage", "Provisioning
Databricks", "Wiring identity", "Done") at 600ms intervals (3.6 seconds total) and
shows a success MessageBar with the fake `stub-{timestamp}` deployment id.

## Vaporware violations per `.claude/rules/no-vaporware.md`

| Violation | Confirmed |
|---|---|
| "Front-end renders without overlaps, keyboard-navigable" | Likely OK (source-checked, not browser-verified due to redirect bug) |
| "Middle (BFF route) exists, validates session, returns structured JSON" | **FAIL** — `/api/setup/deploy` does NOT validate session (no `getSession()` call), accepts any body, returns success regardless |
| "Back-end (Azure service) is actually called" | **FAIL** — explicit comment "Stub - real impl POSTs to the Setup Orchestrator FastAPI" |
| "No mock arrays. No `return []` placeholders. No hard-coded sample data" | **FAIL** — `deploymentId: \`stub-${Date.now()}\`` is the exact pattern |
| "Buttons with no click handler" | The Deploy button HAS a handler but the handler is the stub |
| "Forms that don't POST anywhere" | POSTs to a fake endpoint — variation of the same defect |
| "Real-data E2E receipt" requirement | **FAIL** — receipt would be `{deploymentId: 'stub-...'}` with no Azure resource created |

## Severity matrix

| Element | Severity | Notes |
|---|---|---|
| Intro step renders Get started button | OK (per source) | |
| Boundary dropdown has 4 options | OK | Commercial/GCC/GCC-High/IL5 |
| Mode dropdown has 2 options | OK | single-sub / multi-sub |
| Domain name input sanitizes properly | OK | `toLowerCase().replace(/[^a-z0-9-]/g, '')` |
| Capacity dropdown has 7 SKUs | OK | F2..F512 |
| Required-field validation | MINOR | Implicit only (disabled Next); no error message |
| Review step generates bicep preview | OK | Client-side string template |
| Deploy button executes real deployment | **BLOCKER** | Stub endpoint, no Azure call |
| Deploy session-validates | **MAJOR** | `/api/setup/deploy` does not check `getSession()` |
| Progress bar shows real ARM stages | **BLOCKER** | Fake setTimeout simulation |
| Done state references real deployment id | **BLOCKER** | `stub-{timestamp}` only |
| Wizard reachable from `/setup` URL | **BLOCKER** | Auto-redirect away (see below) |

## Site-wide redirect bug (discovered during this validation)

Every navigation to `/setup`, `/apps`, `/apps/<id>` was followed within 1–3 seconds by
an unsolicited client-side `router.push` to an unrelated `/items/<type>/new` route
(observed: `synapse-dedicated-sql-pool`, `stream-analytics-job`, `dataverse-table`,
`powerplatform-environment`, `eventhouse`, `warehouse`, `admin/capacity`,
`admin/audit-logs`). The destinations rotate seemingly randomly. **Many of these
destinations are themselves invalid routes that render 404 (e.g.,
`/items/stream-analytics-job/new`).**

This bug:
- Makes the entire Apps catalog effectively unreachable via the URL bar
- Makes the Setup wizard effectively unreachable via the URL bar
- Was reproducible across 6+ navigations in this session
- Did not surface in console errors
- Appears to be triggered by some persisted state (likely the `tabs-state` Cosmos
  container which has 10+ tabs persisted for this user's session)

Source-code grep of `router.push` / `router.replace` / `window.location` did not
identify the source — none of the obvious candidates (tab-strip, app-shell,
new-item-dialog, command-palette, recommended-apps) fire a navigation on mount
without user input. Worth a separate investigation ticket.

Workaround attempted: clearing local cache + persisted tabs via
`POST /api/tabs {tabs:[]}` returned 401 because the session was expiring mid-test.

## How to fix to A

1. **Site-wide redirect bug**: identify the component that calls `router.push`
   without user input on `/setup` and `/apps` routes. Until fixed, the wizard is
   effectively non-functional regardless of backend.

2. **Replace stub `/api/setup/deploy`** with a real implementation that:
   - Validates session via `getSession()`
   - Submits an actual bicep deployment via `@azure/arm-resources` SDK
     (`Deployments.beginCreateOrUpdate`) against the target sub
   - Persists a deployment doc in a new Cosmos `setup-deployments` container
   - Returns the real Azure deployment id (not `stub-{timestamp}`)

3. **Wire progress streaming via SSE**: replace the `setTimeout`-fake stages with
   a real SSE/long-poll subscription that pulls deployment.properties.provisioningState
   from ARM and stage names from `deployment.properties.outputResources`.

4. **Honest gate when not deployable**: if the env lacks the required RBAC (Owner on
   target sub) or the Setup Orchestrator FastAPI isn't deployed, the wizard MUST
   show a Fluent MessageBar `intent="warning"` per no-vaporware.md, with the exact
   env var / role / module to fix it. Do NOT silently return a fake deployment id.

5. **Bicep sync**: per no-vaporware.md, if Setup Orchestrator FastAPI is the chosen
   backend, add it to `platform/fiab/bicep/modules/**/*.bicep` and wire it into
   `admin-plane/main.bicep`. Push-button redeploy must provision the orchestrator.

## Acceptance criteria for re-grade

- User completes intro → boundary → mode → domain → capacity → review → Deploy
- POST /api/setup/deploy returns a real ARM deployment id
  (`/subscriptions/.../deployments/{name}`) not `stub-*`
- `az deployment sub show -n {name}` returns a real Deployment resource
- Progress SSE drains real ARM provisioning states
- A new DLZ resource group exists after success
- OR a documented MessageBar gates the wizard if backend isn't deployed
