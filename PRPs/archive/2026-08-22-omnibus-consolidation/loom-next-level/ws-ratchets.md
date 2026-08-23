# WS-R — Convention Ratchets & Code Health

Part of the master PRP **loom-next-level** (rev 2 — post-adversarial-review).
This workstream is **cloud-neutral code health**: it touches BFF-route
structure, editor decomposition, generated typing, a shared editor hook, and
repo layout. None of it changes an Azure vs Fabric code path. **Per-cloud
contract (rev 2, per the master carve-out):** every item in Areas 0–4 (R0–R19)
plus R29/MIG1 carries an implicit **"Per-cloud: cloud-neutral"** declaration in
place of the Commercial/GCC-High/IL5 rows — the ONLY items with a real per-cloud
surface are R21 (Commercial vs Gov deploy workflows, duplicated path refs) and
R28 (ADO default all clouds, GitHub honest-gated in GCC-High/IL5), which state
their own rows.

**Rev-2 additions:** **R0** (the BLOCKER bicep param-cap prerequisite the whole
program depends on), **R28** (git-integration-client consolidation — product
review), **R29** (parity-doc-freshness ratchet — completeness review), **MIG1**
(Cosmos schema-migration convention — completeness review), and Area 5
(R20–R27) re-sequenced as an **independent housekeeping track — execute last,
any time**.

**Shared conventions for every item below**
- Each item is PR-sized, has a stable ID (R0, R1, R2 …), a goal, exact
  files/paths, and acceptance criteria that include a **verification receipt**
  (command + expected output, or a browser E2E where a live editor is touched
  per G1).
- Every new guard follows the **repo ratchet pattern** already used by
  `scripts/ci/check-file-size.mjs` and `scripts/ci/check-no-bare-client-fetch.mjs`:
  a baseline captured **~2 pts below** (or, for counts, **at**) the measured
  value, **up-only cannot regress**, and a `--update-baseline` regen path. The
  ratchet only tightens.
- **Shared ratchet mechanism (rev 2, consistency 5b):** R3, R17, R19, I5's
  credential-adoption guard, and X1's endpoint-literal guard are all
  "count-a-forbidden-pattern + path-glob + baseline + `--update-baseline`"
  guards. Build ONE tested helper — `scripts/ci/_ratchet-count.mjs` (pattern +
  glob + baseline file in; pass/fail + regen out) — with R3 (the first new
  guard), and have the other four consume it instead of five copies of the
  mechanic.

---

## 0. Ground truth (measured 2026-07-22, not from the brief)

Run against `apps/fiab-console` at `main`:

| Metric | Value | How measured |
|---|---:|---|
| Total `app/api/**/route.ts` | **1541** | `git ls-files 'app/api/**/route.ts' \| wc -l` |
| Routes touching `getSession`/toolkit | **1402** | `git grep -l 'getSession\|withSession\|withWorkspaceOwner\|withBackendGate'` |
| Routes using a toolkit wrapper (migrated) | **46 files** | `git grep -l 'withSession\|withWorkspaceOwner\|withBackendGate'` |
| Hand-rolled `getSession` routes NOT on the toolkit | **1356** | `comm -23` of the two lists |

> **Correction to the brief.** The brief said "~60 of ~370 gated routes (54
> migrated in PR #2380)". The real migration universe is **1356 hand-rolled
> session routes out of 1541**, and only **46 files** currently import a toolkit
> wrapper. PR #2380's "54" counts individual handler exports across the
> apim/aml/adx/adf families, not files. **Design the ratchet against the real
> 1356**, not 370 — the baseline file is large but that is expected and correct.

The canonical migrated shapes to target (read and confirmed):
- **session-only** — `apps/fiab-console/app/api/apim/apis/route.ts`:
  `export const GET = withSession(async () => { const g = gate(); if (g) return g; … })`.
- **owner-scoped** — the `withWorkspaceOwner(itemType, handler)` idiom in
  `lib/api/route-toolkit.ts` (runs `loadOwnedItem` internally; the guard checker
  recognizes it).
- **ADX shared-context gate** — `app/api/adx/_shared.ts`
  (`guardAdxRequest` → `apiHonestGateError('svc-adx', …)`).
- **gate envelope** — `lib/api/gate-envelope.ts`
  (`apiHonestGateError(gateId, opts)`, normalized `{ ok:false, gated:true, gate:{…} }`).

---

# AREA 0 — Bicep param-cap remediation (R0) *(NEW, rev 2 — BLOCKER; consistency 3b)*

## R0 — Consolidate `admin-plane/main.bicep` env params into object params (prerequisite for EVERY bicep/env-adding item)

**Ground truth (verified).** `platform/fiab/bicep/modules/admin-plane/main.bicep`
declares **exactly 256 `param`s — the ARM hard cap** (memory
`csa_loom_build_gate_bicep_param_cap`). The rev-1 PRP adds params/modules to
this file from V1 (`loomSyntheticMonitorEnabled`), DR0
(`enableBlobPitr`/`cosmosBackupTier`), DR4 (`loomDrDrillsEnabled`), C1/E2/C3/L3
(Function modules + params), I1 (`ws-identity-rbac` wiring) and rev-2 items (S1,
O1, RUM1, CMK1, V5, A14). **Any new top-level `param` breaks the deploy.**

**Goal.** BEFORE any of those items land, consolidate related env/feature params
into **object (bag) params** — e.g. `param observabilityConfig object` (synthetic
monitor, drift, alerting, RUM), `param drConfig object` (PITR tier, blob-PITR,
drill flags), `param functionAppsConfig object` (per-Function enable/cron/
settings), `param workspaceIdentityConfig object` — freeing headroom well below
the cap and establishing the pattern every later item cites: **"new bicep params
go via a config-object or nested-module param, never a new top-level `param`."**

**Exact files.**
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — introduce the config
  objects; migrate an initial tranche of existing single-purpose flag params
  into them (keep ARM interface compatibility notes per param moved).
  **Scope clarification (round 3, guess-risk):** consolidate ONLY the new
  params this PRP introduces into bags; migrate existing top-level params only
  as needed to reach ≤236, and **enumerate exactly which existing params move
  (with their old→new bag mapping) in the PR description** — two agents must
  not pick different tranches.
- `platform/fiab/bicep/params/commercial-full.bicepparam` + the Gov paramfile —
  updated in lockstep.
- `platform/fiab/bicep/main.bicep` — pass-through updates (mind the bicep
  256-param cap there too — memory: main.bicep AT cap).
- `docs/fiab/` deploy docs — document the bag-pattern rule.

**Acceptance.**
- `az deployment sub what-if` (V5 lane once it exists; manual before) shows
  **NoChange** for the live estate after the refactor — the consolidation is
  behaviorally inert. Receipt: the what-if summary.
- Post-R0 `param` count in `admin-plane/main.bicep` is ≤ 236 (≥20 headroom) and
  the count is asserted by a tiny CI check
  (`scripts/ci/check-bicep-param-cap.mjs`, warn at 240 / fail at 250) so drift
  back toward the cap is loud.
- Every later bicep-touching item's PR references the R0 rule.

**Per-cloud.** Cloud-neutral (same modules deploy both estates; both paramfiles
updated together). IL5: n/a (design-time artifact).

---

# AREA 1 — Route-toolkit codemod + forbidding CI guard (R1–R6)

## The hand-rolled patterns (enumerated from ACTUAL unmigrated routes)

Sampled six diverse unmigrated routes. There are **four** recurring hand-rolled
shapes; the current toolkit covers only two of them, which is why adoption
stalled at 46 files.

**P1 — session-only 401** (most common; `withSession` covers it today)
```ts
// app/api/ai-functions/route.ts:36, app/api/ai-search/service/route.ts:45/66
const session = getSession();
if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
```
Variants of the same idiom (all equivalent, all in the wild):
- `const s = getSession(); if (!s) return NextResponse.json({ ok:false, error:'unauthenticated' }, { status:401 });`
- `if (!session) return apiUnauthorized();` (already uses `respond.ts`)

**P2 — session + owner-by-id** (`withWorkspaceOwner` covers it today)
```ts
const s = getSession(); if (!s) return 401;
const item = await loadOwnedItem(id, 'agent-flow', s.claims.oid);
if (!item) return NextResponse.json({ ok:false, error:'not found' }, { status:404 });
```

**P3 — session + tenant-admin gate** (NO wrapper exists — this is the gap)
```ts
// app/api/access-packages/[id]/route.ts:49-51 (PUT), :78-80 (DELETE)
const s = getSession();
const gate = requireTenantAdmin(s);   // requireTenantAdmin returns a 401/403 NextResponse or null
if (gate) return gate;
```
(also `isTenantAdmin(s)` used inline for a conditional 404 mask, e.g.
`access-packages/[id]/route.ts:38`.)

**P4 — session + DLZ / domain gate** (NO wrapper exists — second gap)
```ts
// app/api/ai-search/service/route.ts:45-52
const session = getSession();
if (!session) return NextResponse.json({ ok:false, error:'unauthenticated' }, { status:401 });
const denied = await denyIfNoDlzAccess(session, 'scaling');
if (denied) return denied;
```

**P5 — inline config gate** (composes with any of the above; `withBackendGate`
or the `gate()` helper covers it) — `apim/apis/route.ts:25-34`,
`ai-search/service/route.ts:31-36`, `ai-functions/route.ts:79-89`
(`NoAoaiDeploymentError` → 501 `not_configured`). The normalized target is
`apiHonestGateError(gateId, …)` from `gate-envelope.ts`.

**Conclusion:** the codemod can mechanically migrate **P1** everywhere and **P2**
where the shape is exact, but **P3 and P4 are ~40% of the ownable-route tail** and
have no wrapper. So R1 (extend the toolkit) is a hard prerequisite for a codemod
that actually drains the backlog rather than stalling again at the session-only
subset.

---

## R1 — Extend the route-toolkit with the two missing wrappers

**Goal.** Add `withTenantAdmin` and `withDlzAccess` to
`apps/fiab-console/lib/api/route-toolkit.ts` so P3/P4 have a canonical target,
matching the existing `withSession`/`withWorkspaceOwner`/`withBackendGate`
composition model. Authorization stays byte-identical — these wrap the exact
existing `requireTenantAdmin` / `denyIfNoDlzAccess` calls.

**Exact files.**
- `apps/fiab-console/lib/api/route-toolkit.ts` — add:
  - `withTenantAdmin<P>(handler)` — composes on `withSession`, then runs
    `requireTenantAdmin(session)`; if it returns a response, short-circuit; else
    call handler with `{ session, params }`. Import `requireTenantAdmin` from
    `@/lib/auth/feature-gate`.
  - `withDlzAccess<P>(pane: DlzPane, handler)` — composes on `withSession`, then
    `await denyIfNoDlzAccess(session, pane)`; short-circuit on a response. Import
    `denyIfNoDlzAccess`/`DlzPane` from `@/lib/auth/dlz-gate`.
  - Keep both generic over the context so they nest inside/around
    `withBackendGate` exactly like the doc comment for `withBackendGate` shows.
- `apps/fiab-console/lib/api/__tests__/route-toolkit.test.ts` — extend with
  unit tests: no session → 401; session but non-admin → the requireTenantAdmin
  response; admin → handler runs; DLZ-denied → the denyIfNoDlzAccess response;
  DLZ-allowed → handler runs.
- **Update the two guards' signal lists so the wrappers register as
  authz:** `scripts/ci/check-route-guards.mjs` `GUARD_SIGNAL_RE` and
  `scripts/ci/generate-route-inventory.mjs` `ADMIN_RE`/`OWNER_RE` already list
  `requireTenantAdmin`/`isTenantAdmin`/`canAccessDlzPanes`; add `withTenantAdmin`
  and `withDlzAccess` to `ADMIN_RE`/`GUARD_SIGNAL_RE` so a route adopting the
  wrapper is still recognized as guarded (mirror the existing
  `withWorkspaceOwner` handling — it's already whitelisted).

**Acceptance.**
- `pnpm --filter fiab-console vitest run lib/api/__tests__/route-toolkit.test.ts` green.
- `node scripts/ci/check-route-guards.mjs` still exits 0 (no new flags) —
  receipt: paste the tail line `[route-guards] OK`.
- Grep receipt: `withTenantAdmin` and `withDlzAccess` both appear in
  `route-toolkit.ts` exports and in both CI scripts' signal regexes.

---

## R2 — The codemod script `scripts/codemods/migrate-route-toolkit.mts`

**Goal.** A **ts-morph** codemod (the repo already ships one-shot codemods under
`apps/fiab-console/scripts/` — `codemod-client-fetch.mjs`,
`codemod-raw-px-to-tokens.mjs` — but those are regex/string rewriters; a
route-handler transform that must rewrite export declarations and hoist the
handler body needs a real AST, hence ts-morph). Dry-run by default, `--apply` to
write, `--family=<area>` to scope to one `/api/<area>` subtree for batched PRs.

**Why ts-morph, not jscodeshift.** The rewrite must (a) change
`export async function GET(req, ctx) { … }` into
`export const GET = withSession(async (req, ctx) => { … })`, (b) delete the
leading `const s = getSession(); if (!s) return …;` guard lines, (c) add the
`import { withSession } from '@/lib/api/route-toolkit'` and drop a now-unused
`getSession` import, and (d) leave the config-gate + business logic byte-for-byte.
That is declaration-level surgery on the TS AST; the repo is TS-first and ts-morph
is the ergonomic choice. Add `ts-morph` to `apps/fiab-console` devDependencies.

**Exact path.** `scripts/codemods/migrate-route-toolkit.mts` (new dir
`scripts/codemods/`). Run via `pnpm --filter fiab-console exec tsx
../../scripts/codemods/migrate-route-toolkit.mts [--apply] [--family=apim]`.

**Mechanics (per handler export in a `route.ts`):**
1. Detect the **exact** hand-rolled prologue. Only migrate when the FIRST
   statements of the handler match one of the known shapes P1/P2/P3/P4 verbatim
   (an allowlist of AST patterns), so the transform is **provably behavior-
   preserving**. Anything unusual is skipped and reported (never guessed).
2. Map prologue → wrapper:
   - P1 (session-only) → `withSession(async (req, ctx) => { <rest> })`
   - P2 (owner) → `withWorkspaceOwner('<itemType>', async (req, { session, item, params }) => { … })`
     — only when `loadOwnedItem(id, '<literal>', s.claims.oid)` with a literal
     itemType and the `!item → 404` shape is present; otherwise skip.
   - P3 (admin) → `withTenantAdmin(async (req, { session, params }) => { … })`
   - P4 (DLZ) → `withDlzAccess('<pane>', async (req, { session, params }) => { … })`
     — only when the pane arg is a string literal.
3. Rewrite the params access: hand-rolled routes read
   `props: { params: Promise<{id}> }` then `await props.params`; the wrapper hands
   `params` already-resolved. The codemod rewrites `const { id } = await props.params`
   → destructure from the wrapper ctx `{ params }`. When the body references
   `props`/`ctx` in ways the codemod can't prove safe, **skip and report**.
4. Fix imports: add the wrapper import; remove `getSession` import if no longer
   referenced; keep `requireTenantAdmin`/`denyIfNoDlzAccess` imports only if still
   used elsewhere in the file.
5. Leave `runtime`/`dynamic` exports, the `gate()` helper, `fail()`/error mapping,
   and all business logic untouched.
6. **Never migrate** a route already on the toolkit, a route whose prologue
   doesn't match a known pattern, or a streaming/SSE route.

**Output.** For each file: `MIGRATED <n> handlers` / `SKIPPED (<reason>)`, and a
summary `APPLIED/DRY-RUN: <handlers> across <files>; <skipped> skipped`. Mirror
the reporting style of `codemod-client-fetch.mjs`.

**Acceptance.**
- Dry-run on the full tree prints a plan and writes nothing (receipt: run without
  `--apply`, confirm `git status` clean).
- `--apply --family=copilot` (small family) then
  `pnpm --filter fiab-console exec tsc -p tsconfig.build.json` green +
  `node scripts/ci/check-route-guards.mjs` exits 0 (no new holes) +
  `git diff` shows only prologue/import churn, business logic unchanged.
- A round-trip test: pick 3 migrated routes, diff the handler body tokens
  pre/post — assert only the wrapper wrap + guard-line deletion changed.

---

## R3 — The forbidding CI guard `scripts/ci/check-route-toolkit.mjs` + baseline

**Goal.** A ratcheting merge-blocker that (a) records the **1356** currently
hand-rolled session routes as a baseline, (b) fails when a route in the baseline
is *edited but not migrated* OR when the total hand-rolled count *rises*, and (c)
lets the baseline **only shrink**. Model it exactly on
`check-no-bare-client-fetch.mjs` (per-path baseline, `--update-baseline`,
`__BASELINE_START__/END__` block).

**Exact path.** `scripts/ci/check-route-toolkit.mjs` +
`scripts/ci/route-toolkit-baseline.json` (the 1356-entry list lives in its own
JSON file, not inline, because it's large — deviation from the inline-allowlist
pattern, justified by size; the script reads it with `fs`).

**Detection.** A route is "hand-rolled session" when its `route.ts`:
- exports a data surface (GET or a mutating verb — reuse the `MUTATING_EXPORT_RE`
  / `GET_EXPORT_RE` from `check-route-guards.mjs`), AND
- calls `getSession(` directly (the hand-rolled marker), AND
- does NOT reference any of `withSession|withWorkspaceOwner|withBackendGate|
  withTenantAdmin|withDlzAccess` (i.e. not migrated).

**Ratchet semantics (two-mode, stricter than a pure count):**
1. **Global count** — total hand-rolled routes must be `<=` baseline total.
   A NEW hand-rolled route (net-new file or a de-migration) fails.
2. **Touched-file rule (the forbidding part)** — a route that is in the baseline
   AND is modified in the PR's diff (`git diff --name-only origin/main...HEAD`)
   must be migrated (dropped from the hand-rolled set) or the PR fails with
   "you touched `<path>`; migrate it to the route-toolkit while you're here
   (`node scripts/codemods/migrate-route-toolkit.mts --apply --family=<area>`)".
   This is the boy-scout ratchet: the backlog can never be edited-in-place and
   left hand-rolled. A documented escape hatch: add the path to a small inline
   `TOUCH_EXEMPT` set with a one-line reason (for a route whose prologue the
   codemod legitimately can't transform).

**Baseline regen.** `node scripts/ci/check-route-toolkit.mjs --update-baseline`
rewrites `route-toolkit-baseline.json` (sorted). Wired into
`.github/workflows/*` alongside the other `check-*.mjs` guards (find the job that
runs `check-file-size.mjs` / `check-no-bare-client-fetch.mjs` and add this to the
same step).

**Acceptance.**
- Fresh run on `main` exits 0 with `[route-toolkit] baseline: 1356 hand-rolled;
  current: 1356` (receipt).
- Synthetic test: touch one baseline route (add a comment), run guard → FAIL with
  the touched-file message; migrate it via the codemod, re-run → PASS and the
  baseline shrinks by 1 after `--update-baseline`.
- CI job wiring diff attached.

---

## R4–R6 — Per-family migration PR batches (order + test requirements)

Migration order by route family, **lowest-risk-first**, each a separate PR that
runs the codemod scoped with `--family=` then hand-verifies. Batching keeps each
PR reviewable and each blast radius small. **Every batch PR must:** run the
codemod, `tsc -p tsconfig.build.json`, the **full** vitest suite (barrel-cycle
and cross-import regressions only surface in a full run — see the WS-E1 barrel
gotcha), `check-route-guards.mjs` (no new holes), and `check-route-toolkit.mjs
--update-baseline` (ratchet tightens); attach a minted-session E2E receipt for
one representative route per family per G1 (`loom_browser_e2e_before_done`).

- **R4 — Session-only families (P1, mechanical, ~largest slice).** Order:
  `copilot/` → `activity/` → `ai-functions/` → `ai-search/` (non-admin reads) →
  `analytics/` → the `apim/`, `aml/`, `adf/`, `adx/` tails not caught by #2380 →
  remaining `/api/<area>` session-only. One PR per 2–4 families (~50–150 handlers
  each). These are the bulk of the 1356 and the safest.
- **R5 — Owner-scoped families (P2).** `items/<type>/[id]/**` routes that thread
  `loadOwnedItem` with a literal item type → `withWorkspaceOwner`. Higher care:
  these are the cross-tenant-sensitive routes the `check-route-guards.mjs` guard
  exists for, so each PR must show `check-route-guards.mjs` still green and
  include an owner-scoping E2E (caller A cannot read caller B's item id).
- **R6 — Admin + DLZ families (P3/P4, needs R1 landed first).** `access-*`,
  `admin/*`, `access-governance/*`, and the `denyIfNoDlzAccess` scaling/domain
  routes → `withTenantAdmin` / `withDlzAccess`. Smallest count, highest
  sensitivity; one PR per sub-area, each with an admin-negative E2E (non-admin →
  403/404 unchanged).

**Sequencing note.** R1 → R2 → R3 must land before any of R4–R6 (wrappers +
codemod + guard). R4 can proceed in parallel PRs once the baseline exists; R5/R6
serialize behind R1. Do not batch two families that import a shared `_shared.ts`
into different concurrent PRs (index.lock / barrel churn) — serialize those.

---

# AREA 2 — Editor-size ratchet + decomposition (R7–R14)

## Current state

`scripts/ci/check-file-size.mjs` (WS-E E3) is a working ratchet: `WARN_THRESHOLD
1500`, `HARD_MAX 6000`, an inline `ALLOWLIST` of per-file `max` ceilings frozen at
current LOC (rounded up to next 100), `--update-baseline` regen. **The ratchet
already only tightens** — the WS-R work is to (a) drive the ceilings DOWN via
decomposition PRs, refreshing the baseline each time, and (b) add per-editor
decomposition items for everything >1500.

`docs/fiab/decomposition-plan.md` is the authoritative extraction blueprint (read
in full) — the 5 priority editors, each with line-ranged extraction seams. Two of
the five (**lakehouse-editor-shell**, **report-designer**) are **already
decomposed** via WS-11.1 (ceilings dropped to 1400). The sibling pattern is
established: `lib/editors/report-designer/{styles.ts,types.ts,helpers.tsx,
use-report-mutations.tsx, page-format-panel.tsx, pages-panel.tsx, well-editor.tsx,
visual-body.tsx, arrange-bar.tsx, pane-section.tsx, rename-page-item.tsx}`.

**Barrel-cycle gotcha (WS-E1 PR #2379, `dfc789b8`).** When you split an editor
into siblings and keep the original file as a barrel re-export, a sibling that
lazy-imports back through the barrel creates an import cycle that `tsc` tolerates
but breaks at runtime (and can freeze the renderer — a G1 live-freeze class).
**Rule for every decomposition item:** lazy/dynamic imports must point at the
**defining sibling module**, never at the barrel. A full `vitest run` (not the
scoped editor suite) is required because the cycle only shows cross-module.

**Extend-vs-decompose policy (rev 2, consistency 3f — binding).** Several R7/R14
targets are simultaneously GROWN by other workstreams: `aas-client` (A4),
`purview-client` (L4), `unity-catalog-client` (L7), `adf-client` (L3),
`kusto-client` (I5), `spark-session-pool` (A11/A12), `monitor-client` (WS-C),
`analytics-pane.tsx` + `loom-chart.tsx` (A6/A7), `visual-body.tsx` (A6/A9).
Policy: **extend-then-decompose** — the feature item lands first and must either
stay under the file's ratchet ceiling or run `check-file-size.mjs
--update-baseline` in the same PR with a one-line justification; the R7/R14
decomposition item then re-baselines downward. Serialize each pair (never race a
decomposition PR against a feature PR on the same file).

## Files currently >1500 LOC (from the allowlist, ceiling→approx LOC)

**Priority editors (decomposition-plan.md, 3 remaining):**
`phase3/semantic-model-editor.tsx` (3050→~3018, 178 useState — hardest),
`notebook-editor.tsx` (3550→~3515), `apim-editors/data-product-editor.tsx`
(1650→~1600, the apim sibling that still needs its 12-tab split).

**Other editors/panes >1500 (not in the plan — new items):**
`foundry-sub-editors.tsx` (3300), `databricks/uc-dialogs.tsx` (3100),
`phase4/plan-editor.tsx` (2900), `phase4/ontology-editor.tsx` (2900),
`phase3/eventhouse-editor.tsx` (2800), `deployment-pipelines-pane.tsx` (2600),
`foundry-hub-editor.tsx` (2600), `phase3/eventstream-editor.tsx` (2600),
`phase3/kql-database-editor.tsx` (2500), `unified-sql-database-editor.tsx` (2400),
`powerplatform-editors.tsx` (2400), `databricks/sql-warehouse-editor.tsx` (2200),
`phase3/kql-dashboard-editor.tsx` (2200), `components/monitor/monitor-pane.tsx`
(2100), `editors/report/analytics-pane.tsx` (2100), `phase4/data-agent-editor.tsx`
(2100), `copilot-studio-editors.tsx` (2000), `components/admin/mcp-servers-panel.tsx`
(2000), `components/eventstream/visual-designer.tsx` (2000),
`synapse-notebook-editor.tsx` (1900), `azure-sql-editors.tsx` (1900),
`panes/setup-wizard.tsx` (1900), `data-pipeline-editor.tsx` (1900),
`workshop/workshop-app-builder.tsx` (1800), `components/admin-security/purview-panel.tsx`
(1700), `azure-services-editors.tsx` (1700), `components/onelake/shortcut-wizard.tsx`
(1600), `data-api-builder-editor.tsx` (1600), `components/canvas/canvas-node-kit.tsx`
(1600).

**Non-UI large `.ts` modules (data catalogs / clients — separate track, R14):**
`pipeline/connector-catalog.ts` (3400), `azure/aas-client.ts` (3000),
`azure/unity-catalog-client.ts` (2900), `azure/purview-client.ts` (2800),
`components/charts/loom-chart.tsx` (2800 — chart lib), `azure/copilot-orchestrator.ts`
(2800), `azure/databricks-client.ts` (2700), `azure/foundry-client.ts` (2600),
`mcp/catalog.ts` (2400), `report/report-definition-sanitizer.ts` (2200),
`azure/kusto-client.ts` (2200), `azure/report-model-resolver.ts` (2100),
`azure/adf-client.ts` (2000), `azure/powerplatform-client.ts` (1900),
`azure/monitor-client.ts` (1900), `pipeline/activity-catalog.ts` (1800),
`pipeline/dataflow-transform-catalog.ts` (1800), `azure/powerbi-client.ts` (1700),
`azure/mirror-engine.ts` (1700), `azure/fabric-client.ts` (1700),
`azure/apim-client.ts` (1600), `azure/foundry-cs-client.ts` (1600),
`azure/sql-objects-client.ts` (1600), `azure/copilot-studio-client.ts` (1600),
`azure/spark-session-pool.ts` (1600), `azure/cosmos-client.ts` (1600 —
`bundleExempt`-adjacent registry, decompose per its allowlist reason).

## R7 — Ratchet floor-tightening harness (mechanical, no decomposition)

**Goal.** Make the ceilings track reality without waiting for decomposition:
re-baseline the allowlist so every ceiling equals `ceilTo100(currentLOC)` (drops
any ceiling that drifted above actual after unrelated edits), and add a CI note.
This is the "floor set ~2pts below measured, up-only" convention applied to the
existing guard: since the guard already rounds up to the next 100 (its slack),
R7 just runs `--update-baseline` and commits the tightened numbers.

**Files.** `scripts/ci/check-file-size.mjs` (ALLOWLIST block only, via
`--update-baseline`).
**Acceptance.** `node scripts/ci/check-file-size.mjs` exits 0; `git diff` shows
only ceiling reductions (no increases). Receipt: the `--update-baseline` JSON diff.

## R8–R12 — Per-editor decomposition (one editor per PR, plan-driven)

Each follows `decomposition-plan.md` §"Shared method" (per-editor folder, thin
shell ≤600 LOC, one pane per tab, data hooks out, pure helpers → `.ts`, dialogs
out) and the plan's **ascending-risk order**. Each PR ends by running
`check-file-size.mjs --update-baseline` to drop the ceiling, and **must** carry a
minted-session browser E2E receipt (G1) clicking every tab/dialog against real
data — `tsc`+`vitest` is explicitly not sufficient (decomposition-plan.md §"Why
plan-only").

- **R8 — `apim-editors/data-product-editor.tsx`** (easiest tail of the apim
  split): carve the 12 tabs into `apim/data-product/panes/*`, helpers into
  `apim/data-product/*`. Target <1500. (Plan §5.)
- **R9 — `notebook-editor.tsx`**: explorer-tree + `use-nb-folders`, cell-list host,
  compute panel + `use-nb-session`, `use-notebook-run`, 9 dialogs →
  `notebook/dialogs/*`, pure helpers → `notebook/notebook-utils.ts`. Shell ~600.
  (Plan §4.)
- **R10 — `phase3/semantic-model-editor.tsx`** (hardest, 178 useState): relocate
  the already-standalone panes (`AasSemanticModelPanel`, `SemanticModelSecurityTab`,
  `SemanticModelCopilotPane`, `SemanticModelPrepForAiPane`, `LoomNativeModelView`)
  into the existing `phase3/semantic-model-editor/` sibling dir, then split the
  22-tab inner component into `panes/modeling/*` + `panes/ops/*`, folding per-tab
  state into panes and lifting only the shared model doc into a `useSemanticModel()`
  reducer/context (this is where R15's shared hook lands first). (Plan §3.)
- **R11 — `foundry-sub-editors.tsx` (3300) + `databricks/uc-dialogs.tsx` (3100)**:
  not in the plan; author the extraction seam analysis first (tab/dialog inventory
  with line ranges, same table format as the plan), append it to
  `decomposition-plan.md`, then split. Two editors, one PR each if seams are
  independent; otherwise split into R11a/R11b.
- **R12 — the `phase3/eventhouse|eventstream|kql-*` + `phase4/plan|ontology|
  data-agent` cluster (2100–2900 each)**: batch by owning area, one editor per PR,
  seam analysis appended to the plan first. `ontology-editor` already extracted its
  security panel (`ontology-security-panel.tsx`) — continue that pattern.

## R13 — Follow-on: `report-definition-sanitizer.ts` (pure module, low risk)

Per decomposition-plan.md §"Follow-on (WS-3.1)": extract the card sub-sanitizers
(`sanitizeNumberFormatByField`, `sanitizeFill`, `sanitizeHeaderIcons`, axis/title/
legend/effects) into `lib/report/report-format-sanitizer.ts`, re-import, drop the
ceiling <1800. Pure format-validation, no UI → no browser E2E needed, only unit
tests for the extracted sanitizers. **Files:** `lib/report/report-definition-
sanitizer.ts`, new `lib/report/report-format-sanitizer.ts`, `check-file-size.mjs`
baseline. **Acceptance:** sanitizer unit tests green; ceiling <1800 after regen.

## R14 — Large non-UI client/catalog modules (separate track)

The `azure/*-client.ts` and `pipeline/*-catalog.ts` monoliths (R7 list) are pure
service adapters / static catalogs — decompose by **capability grouping** (one
`.ts` per REST resource family) behind a barrel, no render risk, unit-testable.
Lowest priority; one PR per client, each dropping its ceiling. `cosmos-client.ts`
is special (the container registry — decompose per-feature-group per its allowlist
reason, keeping `ensure()`/accessor cohesion). **Not gated on browser E2E** (no
UI), only `tsc` + full `vitest` (barrel cycle) + `--update-baseline`.

---

# AREA 3 — Typed API client generation (R15–R17)

## Current state

`scripts/ci/generate-route-inventory.mjs` (WS-D3) already walks
`app/api/**/route.ts` and classifies each route by area / methods / auth scope /
gated / backends, emitting `docs/fiab/route-inventory.md` (1541 routes) with a
`--check` drift gate. `lib/client-fetch.ts` is the typed-ish transport
(`clientFetch(input, init, timeoutMs)` → `Promise<Response>`, no generics today).
`check-no-bare-client-fetch.mjs` already forbids bare `fetch('/api…')` in client
components (ratcheted). So the pieces exist; what's missing is a **typed map from
route path → params/response** and a guard that client fetches name a known route.

## Realistic typing depth (the pragmatic tier — be honest)

Route files return **ad-hoc `NextResponse.json({ ok, … })`** with no shared schema
— there are no zod schemas on responses today, and inferring a precise response
type from an arbitrary handler body is not statically tractable at scale.
Therefore propose **three tiers, ship Tier 1 + 2 now, defer Tier 3:**

- **Tier 1 (mechanical, ship now):** a generated **path + method + auth-scope +
  gated registry** — `lib/api/client-map.generated.ts` emitting a
  `const API_ROUTES = { 'apim/apis': { methods:['GET','POST','DELETE'], scope:'session-only', gated:true }, … } as const` plus a
  `type ApiRoutePath = keyof typeof API_ROUTES`. This is 100% derivable from what
  the inventory generator already computes — **extend the existing generator**,
  don't write a new one. It gives compile-time *path* safety (the guard in R17).
- **Tier 2 (hand-annotated envelopes, ship now for high-traffic families):** a
  small **hand-maintained** `lib/api/client-types.ts` mapping the ~30 most-used
  routes to their `{ ok:true } & Data | GateEnvelope` response type, referencing
  the real `GateEnvelope` from `gate-envelope.ts`. Not generated — curated, with a
  lint that every entry's path exists in `API_ROUTES`. Realistic and immediately
  useful; grows opportunistically.
- **Tier 3 (deferred, documented as future work):** true end-to-end response
  typing via zod schemas co-located in route files + inferred client types. This
  is a large separate initiative (touches 1541 handlers) — record it as a future
  PRP, do NOT attempt here.

## R15 — Extend the generator to emit `client-map.generated.ts`

**Goal.** Add a second output to `generate-route-inventory.mjs`: alongside the
markdown doc, emit `apps/fiab-console/lib/api/client-map.generated.ts` (Tier 1)
from the same `buildRows()` classification. Add `--check` drift coverage for the
new file (fail if the generated `.ts` is stale, same as the doc).

**Files.** `scripts/ci/generate-route-inventory.mjs` (add a `renderClientMap(rows)`
+ write + `--check` compare), new generated `lib/api/client-map.generated.ts`
(header `// GENERATED — do not edit`, `eslint-disable`, `as const` object + the
`ApiRoutePath` union).
**Acceptance.** `node scripts/ci/generate-route-inventory.mjs` writes both files;
`--check` exits 0 when fresh, 1 when either is stale (receipt: touch a route, run
`--check`, see FAIL). `tsc` compiles the generated file. Wire `--check` into the
same CI job it already runs in.

## R16 — `clientFetch` typed overload + `client-types.ts` (Tier 2)

**Goal.** Add a typed generic overload to `clientFetch` and the curated
`client-types.ts` so call sites get response typing without breaking the existing
untyped signature. `clientFetchJson<P extends ApiRoutePath>(path, init?)` that
returns the mapped response type (or `unknown`-envelope for unmapped paths),
built on `clientFetch` + `.json()` with the non-JSON-response handling
(`describeNonJsonResponse`) already in `client-fetch.ts`.

**Files.** `apps/fiab-console/lib/client-fetch.ts` (add `clientFetchJson`,
non-breaking — existing `clientFetch` untouched), new
`apps/fiab-console/lib/api/client-types.ts` (curated map + `ApiResponse<P>` type),
tests in `lib/__tests__/`.
**Acceptance.** Unit test: `clientFetchJson('apim/apis')` infers the APIM apis
response type; an unknown path is a compile error (type-level test via `tsd` or a
`// @ts-expect-error` fixture). Existing `clientFetch` callers unchanged (`tsc`
green repo-wide).

## R17 — Guard: client fetches must name a known route

**Goal.** Extend/rename the existing `check-no-bare-client-fetch.mjs` OR add a
sibling `check-client-fetch-known-route.mjs` that, for each `clientFetch('/api/…')`
literal-URL call, verifies the path (first two segments, normalized) exists in
`API_ROUTES` (the generated Tier-1 map). A fetch to a `/api/typo` route fails CI.
Ratcheted: variable-URL calls (template literals with interpolation) are
grandfathered in a baseline exactly like the bare-fetch baseline.

**Files.** New `scripts/ci/check-client-fetch-known-route.mjs` (imports the
generated map), inline `__BASELINE_START__` for variable-URL exemptions.
**Acceptance.** Fresh run exits 0 (receipt); a synthetic `clientFetch('/api/nope')`
fails with "unknown route /api/nope — add the route or fix the path". CI-wired
next to the other guards.

---

# AREA 4 — Shared editor-state store (R18–R19)

## Current state (the recurring gotcha)

Memory `csa_loom_setstate_snapshot_eager_eval_gotcha`: editors hand-roll a
`setState(prev => { snapshot = prev; return prev; })` trick to read fresh state in
async save handlers, which silently reads **stale** when (a) another `setState`
fired earlier in the handler (React's eager-eval bailout is disabled) AND (b) the
snapshot var is initialized to a constant. The fix pattern — `const stateRef =
useRef(state); stateRef.current = state;` read directly — is already used in
`apim-editors/data-product-editor.tsx` (the literal `stateRef` today) and the
broader `useRef` mirror appears **288 times across 67 editor files** (e.g.
`notebook-editor.tsx` 19, `data-pipeline-editor.tsx` 14, `tsql-monaco.tsx` 11).
Every editor re-implements dirty-tracking + snapshot-safe reads + draft/publish
ad hoc. That is the surface a shared hook removes.

## R18 — Author `lib/editors/use-editor-state.ts`

**Goal.** One hook that bakes in the correct patterns so no editor re-derives
them. API sketch:
```ts
const s = useEditorState<TDoc>(initialDoc, { onDirtyChange });
s.doc            // current committed state (reactive)
s.ref.current    // ALWAYS-fresh mirror — the stateRef fix, built in
s.set(patch)     // shallow-merge update, marks dirty
s.replace(next)  // full replace
s.snapshot()     // returns s.ref.current — the snapshot-safe read for async save handlers
s.isDirty        // dirty-tracking vs last published
s.markPublished()// clears dirty after a successful save/publish (draft/publish seam)
s.undo() / s.redo() / s.canUndo   // undo integration points (thin wrapper over a ring buffer)
```
- **Snapshot safety:** `snapshot()` reads the ref, never the eager-eval trick — the
  gotcha is structurally impossible for adopters.
- **Dirty-tracking:** compares `doc` to the last `markPublished` baseline (cheap
  structural equality or a caller-supplied comparator).
- **Draft/publish:** `isDirty` + `markPublished()` are the seam the ux-baseline
  draft/publish rule wants (`ux-baseline.md` — "silently save-on-editing a live
  topology needs draft/publish").
- **Undo integration points:** expose `undo/redo/canUndo` over an internal history
  ring; editors with a canvas can wire these to the existing canvas undo/redo
  (don't reimplement — the hook provides the state half, the canvas provides the
  command half).

**Files.** New `apps/fiab-console/lib/editors/use-editor-state.ts`,
`lib/editors/__tests__/use-editor-state.test.ts` (cover: snapshot reads fresh after
a preceding `set`; dirty flips on `set`, clears on `markPublished`; undo/redo ring).
**Acceptance.** Vitest green, including a **regression test that reproduces the
eager-eval gotcha** (fire `setStatus` then `set`, assert `snapshot()` is fresh) —
proving the hook fixes the exact bug from the memory.

## R19 — Migration path + convention guard (doc + review checklist, not automated)

**Goal.** New editors MUST use `use-editor-state`; existing editors adopt
opportunistically (during their R8–R12 decomposition — R10's `useSemanticModel()`
reducer is the first real adopter). Per the brief, this is guarded by
**convention doc + review checklist, not an automated codemod** (the 288 sites are
too varied to mechanically rewrite safely).

**Files.**
- `docs/fiab/editor-state-convention.md` — the pattern, the gotcha it prevents
  (link the memory), the API, and "new editors use this; when you touch an editor's
  save handler, migrate its snapshot trick to `snapshot()`".
- Add a row to the editor review checklist (wherever `ux-standards.md §7` /
  the PR template lists editor gates): "☐ async save handlers read via
  `useEditorState().snapshot()` / a stateRef mirror, never the
  `setState(prev=>{snap=prev})` trick".
- **Optional lint (advisory, not blocking):** a `check-editor-snapshot-trick.mjs`
  that greps for the `setState(prev => { …snap… ; return prev; })` shape in
  `lib/editors` and prints a warning count (ratcheted down as adoption grows) — do
  NOT make it a merge-blocker (too many false positives in the 288 sites);
  advisory only, to measure progress.
**Acceptance.** Doc merged; checklist row present; advisory lint prints the current
count (receipt) so future PRs can watch it fall.

---

# AREA 5 — Repo restructure: legacy/ grouping (R20–R27) *(rev 2: INDEPENDENT HOUSEKEEPING TRACK — execute LAST, any time)*

> **Rev-2 re-sequencing (product review — operator-approved scope, adjusted
> schedule).** The restructure stays IN the PRP (the operator approved in-repo
> `legacy/` grouping), but it is now an **independent housekeeping track that
> never blocks or interleaves with the grade-bearing work**: 8 high-risk
> `git mv` PRs (Windows case-folding, 33 workflow refs, 65 mkdocs nav lines)
> contribute **zero** to the "B+ → defensible A" grade while competing for
> reviewer attention and CI stability. **Execute last — or in any quiet window —
> one tree per PR; pause the track instantly if it destabilizes CI.** R27's
> "keep `examples/` at root" recommendation stands.

## Ground truth (from `temp/audit-2026-07-22/repo-audit.md` §4 + verified)

The repo hosts **two projects**: the active **CSA Loom / FiaB** stack (`apps/`,
`platform/fiab`, `azure-functions/`, `scripts/csa-loom`, `scripts/ci`) and the
frozen (05-28) **CSA-in-a-Box** reference architecture. The operator approved
**in-repo grouping** of the frozen trees under `legacy/` (or
`reference-architecture/`). Verified reference counts:

| Tree | Workflow refs | Other refs | Case-fold hazard |
|---|---:|---|---|
| `deploy/` | 5 (`deploy.yml`, `deploy-gov.yml`, `bicep-whatif.yml`, `rollback.yml`, `validate.yml`) | CSA-in-a-Box IaC | — |
| `domains/` | 8 | in `pyproject.toml [tool.ruff] src` | — |
| `decision-trees/` | 0 wf | `docs/ARCHITECTURE.md`, `docs/decisions/` | — |
| `cli/` | 0 wf | in `pyproject.toml [tool.ruff] src` | — |
| `dev-loop/` | 0 wf | in `pyproject.toml [tool.ruff] src` | — |
| `notebooks/` | 2 wf | — | — |
| `portal/react-webapp` | (part of `portal/` 7 wf) | — | — |
| `examples/` | **9 wf** (measured) + **65 mkdocs** (`mkdocs.yml`) | heavily referenced | — |
| `scripts/{data,streaming,marketplace,monitor,governance,purview,sample-up,deploy,sql,seed}` | part of `scripts/` **33 wf** | — | `scripts/PowerShell`, `scripts/SAP`, `scripts/Synapse-DEP` — **Windows case-folding** |

`pyproject.toml [tool.ruff] src = ["domains", "scripts", "csa_platform",
"dev-loop", "cli", "apps"]` (verified; audit called it :320, it's in the
`[tool.ruff]` block). Moving `domains`/`cli`/`dev-loop` requires editing this line
in lockstep or ruff/isort ordering breaks.

## Strategy — scripted, phased, one tree per PR, verify each phase

Each phase: `git mv` the tree under `legacy/<name>/`, update **every** reference
file in the same commit, then verify **CI green + `mkdocs build --strict` +
`ruff check`** before the next phase. A move script per phase
(`scripts/legacy-move/<tree>.sh`) does the `git mv` + `sed` reference rewrites so
it's reproducible and reviewable. **`examples/` is the exception — recommend
keeping at root, or moving it LAST and alone**, because it carries 9 workflows +
65 mkdocs nav entries (highest reference surface, lowest clutter payoff).

**Per-cloud note:** the deploy workflows touched in R21 (`deploy.yml` vs
`deploy-gov.yml`) are Commercial vs Gov — both reference `deploy/bicep`, so a
`deploy/` move must update **both** cloud workflows identically. This is the only
place in WS-R where cloud matters, and only as duplicated path references.

## R20 — Scaffolding + the zero-reference trees (safest first)

**Goal.** Create `legacy/` with a `README.md` explaining the split, and move the
**0-workflow-ref** trees first: `decision-trees/`, `cli/`, `dev-loop/`.
**Files/edits.** `git mv decision-trees legacy/decision-trees` (+ `cli`,
`dev-loop`); update `pyproject.toml [tool.ruff] src` (`"cli"`→`"legacy/cli"`,
`"dev-loop"`→`"legacy/dev-loop"`); update `docs/ARCHITECTURE.md` +
`docs/decisions/*` links to `decision-trees/`; grep `mkdocs.yml` for any of the
three (none expected — confirm). Script: `scripts/legacy-move/phase0.sh`.
**Acceptance.** `ruff check` clean; `mkdocs build --strict` clean;
`git grep -n 'decision-trees/\|(^|[^-])cli/\|dev-loop/'` shows only the new
`legacy/` paths (receipt). CI green.

## R21 — `deploy/` (5 workflows, Commercial + Gov)

**Goal.** `git mv deploy legacy/deploy`; update the 5 deploy workflows'
`deploy/bicep` path references (both `deploy.yml` and `deploy-gov.yml`).
**Files.** `.github/workflows/{deploy,deploy-gov,bicep-whatif,rollback,validate}.yml`,
`scripts/legacy-move/phase1.sh`. **Per-cloud:** verify Commercial and Gov
workflows both updated.
**Acceptance.** `bicep-whatif.yml` dry-run against the moved path (or a `bicep
build legacy/deploy/bicep/...` receipt); `git grep 'deploy/bicep'` → only
`legacy/deploy/bicep`. CI green (or a documented manual whatif receipt since these
are deploy workflows).

## R22 — `domains/` (8 workflows + ruff src)

**Goal.** `git mv domains legacy/domains`; update 8 workflows + `pyproject.toml
[tool.ruff] src` (`"domains"`→`"legacy/domains"`) + its
`extend-exclude = [… "domains/spark/ArcGIS_GeoAnalyticsEngine"]` path.
**Files.** the 8 workflows (enumerate via `git grep -l 'domains/'
.github/workflows`), `pyproject.toml`, `scripts/legacy-move/phase2.sh`.
**Acceptance.** `ruff check` clean; the 8 workflows' path refs updated;
`mkdocs build --strict` clean (domains content in nav re-pointed). CI green.

## R23 — `notebooks/` + `portal/react-webapp`

**Goal.** `git mv notebooks legacy/notebooks` (2 wf) and evaluate
`portal/react-webapp` — but `portal/` has 7 wf refs and mixed active content, so
move **only** the frozen `react-webapp` subtree if it's truly dormant, else defer.
**Files.** the 2 notebooks workflows, any `portal/react-webapp` workflow refs,
`scripts/legacy-move/phase3.sh`.
**Acceptance.** CI green; `mkdocs build --strict` clean; grep receipt.

## R24–R26 — `scripts/` internal split (33 workflows, case-fold hazard)

The single riskiest tree. Do NOT move all of `scripts/` — split **frozen families**
under `scripts/legacy/` while leaving active `csa-loom/`, `ci/`, `dev/`,
`diagnostic-settings/` in place. One family (or a few) per PR:
- **R24 — the 0-CI-ref families** (`data/`, `streaming/`, `marketplace/`,
  `monitor/`, `sample-up/`) → `scripts/legacy/`; plus the 7 zero-ref root scripts
  the audit flagged (`deploy-*.sh`, `check_urls*.py`, `migrate_portal_persistence.py`)
  after a `docs/` grep. Update `pyproject.toml [tool.ruff] src` (`"scripts"` stays
  but confirm globbing still catches `scripts/legacy`).
- **R25 — the workflow-referenced frozen families** (`governance/`, `purview/`,
  `deploy/`, `sql/`, `seed/`) → `scripts/legacy/`; update each referencing workflow
  in lockstep (enumerate via `git grep -l 'scripts/<family>/' .github/workflows`).
- **R26 — CamelCase case-folding fix** (`scripts/PowerShell`, `scripts/SAP`,
  `scripts/Synapse-DEP`): these are tracked CamelCase but appear lowercase on
  Windows on-disk. **Handle with `git mv --force` via a case-only rename staged
  carefully** (git config `core.ignorecase` matters). Do this as its own PR, no
  other moves, and verify on a case-sensitive checkout (CI Linux) that the paths
  resolve. **Per the CLAUDE.md security rule, no `git` history rewriting** — plain
  `git mv` only.
**Acceptance (each).** `ruff check` clean; every touched workflow's `scripts/…`
path updated; CI green on Linux (case-sensitivity proof); grep receipt.

## R27 — `examples/` decision (recommend: keep at root, or move last + alone)

**Recommendation: KEEP `examples/` at root.** It carries 9 workflows + 65 mkdocs
nav entries — the highest reference surface of any tree and the lowest declutter
payoff (it's genuinely referenced content, not frozen cruft). If the operator
insists on grouping it, it goes **last, in its own PR**, updating all 9 workflows +
all 65 `mkdocs.yml` nav lines + the `templates/example-vertical` cookiecutter
output path + `lint-vertical.sh`/`new-vertical.sh` (referenced root scripts). Given
the risk/payoff, R27's deliverable is the **decision doc** recording "keep at root"
with the reference evidence, unless overridden.
**Acceptance.** Decision recorded in `docs/` (or the audit follow-up); if moved,
`mkdocs build --strict` + CI green + all 65 nav entries resolve.

---

# AREA 6 — Rev-2 additions (R28, R29, MIG1)

## R28 — Consolidate the duplicate git-integration clients *(product review §3.2)*

**Ground truth (verified).** There are **two** parallel Fabric-git-parity
implementations serving the same workspace-git feature:
- `lib/azure/git-integration-client.ts` — real commit/pull/status against Azure
  DevOps Repos (REST 7.1) or GitHub (REST v3); serializes each item to canonical
  text (TMSL `model.bim`, PBIR, scorecard JSON) and pushes real commits;
  workspace-scoped PAT in KV; sovereign-aware (`LOOM_ADO_HOST`/`LOOM_GITHUB_HOST`);
  routes `/api/git-integration/{commit,pull,resolve,status}` +
  `/api/workspaces/[id]/scm`.
- `lib/clients/git-integration-client.ts` — a second client behind
  `/api/admin/workspaces/[id]/git/{route,status,sync,meta,branch-out}`.
Both active = two sources of truth for workspace git serialization — drift + a
serialization-format hazard.

**Goal.** Collapse to one client + one route surface; kill the drift.

**Files.** Pick the SDK-free serializer (`lib/clients/*`) as the canonical pure
core; keep the KV/credential wiring from `lib/azure/*` as a thin adapter over
it. Repoint `app/api/admin/workspaces/[id]/git/*` and `app/api/git-integration/*`
at the single client (or converge the two route trees behind one, documented in
a short ADR). Add a `check-*-sync.mjs`-style guard (via `_ratchet-count.mjs`)
that fails if a second git serializer reappears.

**Acceptance.** Full `vitest` (both git test files) green;
`tsc -p tsconfig.build.json` green; a git commit→pull round-trip receipt on a
real workspace item via the surviving route (real SHA = no-vaporware receipt).
No behavior change. **Doc item (product review):** file the one-line correction
re-grading `PRPs/active/loom-competitive-audit-2026-07-20/PARITY-MATRIX.md` §2
"Source control (Git)" from the stale **C / honest-gate** to **A− (Loom-native,
real ADO+GitHub, Fabric-parity, sovereign-aware)**. V1's J6 journey exercises
the surviving route.

**Per-cloud.** Cloud-neutral code health; ADO default all clouds, GitHub
honest-gated in GCC-High/IL5 (already handled by `githubCloudGate()`).

## R29 — Parity-doc-freshness ratchet *(completeness gap 5 — WS-R's own thesis applied to itself)*

**Ground truth (verified).** `scripts/ci/check-parity-doc-freshness.mjs` is
warn-first-by-design: it only hard-fails under `PARITY_DOC_FRESHNESS_ENFORCE=1`
(default = warn, exit 0). Nothing in rev 1 pulled that lever — while the PRP
itself adds new parity docs (L5 `lineage.md`, A6–A9 `report.md`, A8) that will
accrue freshness debt ungated. Omitting this ratchet from a
convention-ratchet workstream was a thematic inconsistency.

**Goal.** Capture the current stale-doc count as a baseline
(`scripts/ci/parity-freshness-baseline.json`), FAIL the PR when the count
*rises* or when a *touched* parity doc is stale (the boy-scout rule, mirroring
R3's touched-file mode), and let the baseline only shrink. Flip
`PARITY_DOC_FRESHNESS_ENFORCE=1` for touched docs.

**Files.** Extend `check-parity-doc-freshness.mjs` with a baseline +
touched-file mode (reuse `_ratchet-count.mjs` mechanics); wire into the same
`check-*.mjs` CI lane.

**Acceptance.** Fresh run exits 0 at baseline; touch a parity doc without
re-reviewing it → FAIL; re-review → PASS + baseline shrinks. **Per-cloud.**
Cloud-neutral.

## MIG1 — Versioned Cosmos doc-migration convention (registry + on-read upgrade) *(completeness gap 3)*

**Ground truth (verified).** `lib/azure/cosmos-client.ts` has no
`schemaVersion`/on-read-upgrade/backfill machinery; doc-shape changes rely on
optional fields + tolerant readers. This PRP's new shapes (ThreadEdge
`columnMappings`, Workspace `workspaceIdentity`, `loom-copilot-evals`,
`loom-cost-anomaly-rules`) are all additive so none *needs* a migration — the
gap is latent, and the convention must exist before someone needs a breaking
change.

**Goal.** A `schemaVersion` field convention + a `migrateOnRead(doc)` registry
(per container), plus an optional backfill script pattern
(`scripts/csa-loom/cosmos-backfill-<container>.mjs`) and a rollback note. New
shapes register a migrator; readers upgrade lazily; a backfill sweeps at
leisure.

**Files.** `lib/azure/cosmos-migrations.ts` (registry + `migrateOnRead`), edit
`cosmos-client.ts` read paths to apply it,
`docs/fiab/cosmos-migration-convention.md`, a unit test proving a v1 fixture doc
upgrades to v2 on read; backfill idempotent.

**Coordinate with** `PRPs/active/enterprise-hardening/appendix-scale-cosmos-data-tier.md §4.2`
(the partition-key migration there is the first real consumer of this
convention — per the master's sibling-PRP decision rules).

**Per-cloud.** Cloud-invariant (Cosmos only). IL5: n/a beyond in-boundary
Cosmos.

---

# AREA 7 — Round-3 additions (R30, FRESH0)

## R30 — Split ENV_CHECKS / GATE_META into per-domain registry fragment files *(round 3, F2 — the #1 throughput unlock)*

**Ground truth.** `lib/admin/env-checks.ts` (ENV_CHECKS) and
`lib/gates/registry.ts` (GATE_META) are hand-edited monolith arrays. The master
serialization list forces **~13 rev-2 items PLUS every env-adding N-item**
(20–30+ PRs) through these two files plus their two test files — the dominant
calendar bottleneck of the entire program, and R0 + X2 both sit upstream of it,
making the critical path `R0 → X2 → [20–30 serialized env-registry PRs]`.

**Goal.** Convert both monoliths into a **per-domain directory of registry
fragments merged at load**: `lib/admin/env-checks/*.ts` and
`lib/gates/registry/*.ts` (one file per domain — `identity`, `data-plane`,
`ai-copilot`, `catalog-governance`, `observability`, `platform`, …) whose
`index.ts` concatenates the fragments into the same exported `ENV_CHECKS` /
`GATE_META` shapes (public API unchanged). A later item that adds an env var
**appends a new/edits its own domain fragment** instead of editing a 256-entry
array — the serialization requirement collapses to same-domain-fragment only.

**Files.** `lib/admin/env-checks.ts` → `lib/admin/env-checks/` fragment dir +
merging `index.ts` (barrel-cycle-safe — mind the WS-E1 barrel-cycle gotcha);
`lib/gates/registry.ts` → `lib/gates/registry/` likewise;
`lib/gates/__tests__/registry.test.ts` + `lib/admin/__tests__/env-config.test.ts`
keep running their parity/invariant checks **over the merged whole** (unchanged
assertions — the merge is behaviorally inert).

**Acceptance.** `tsc` + full vitest green; `registry.test.ts` parity + the
`env-config.test.ts` invariants pass over the merged arrays; a diff-proof that
the merged ENV_CHECKS/GATE_META are element-for-element identical to the
pre-split arrays (snapshot compare in the PR); one follow-up env-adding item
lands touching ONLY its domain fragment (the receipt that the chain is dead).

**Sequencing.** Phase 0, **immediately after X2** (X2 extends the `EnvSpec`
type in the same files — serialize the pair), before the env-adding wave.
**Per-cloud.** Cloud-neutral code health (carve-out declaration: cloud-neutral).
**Size: M.**

## FRESH0 — PRP self-freshness re-baseline gate *(round 3, F4 — R29's thesis, one level up)*

**Ground truth.** The repo's history: "audit plans go STALE" (memory), a prior
PRP invalidated by 109 commits in 2 days, and this PRP's own four same-day rev
headers. R29 ratchets `docs/fiab/parity/*.md` freshness — nothing governs the
PRP itself, which hard-codes ground truth that its own execution invalidates
("1,356 hand-rolled routes", "exactly 256 param declarations", "the DAX
evaluator is 3 regexes", "#2389 OPEN at review time").

**Goal.** `scripts/ci/check-prp-freshness.mjs` — re-runs the ground-truth
counts the PRP cites (route-toolkit gap count, `admin-plane/main.bicep` param
count, the DAX-regex count, the open/merged state of referenced PRs via `gh`)
against `PRPs/active/loom-next-level/**` and **warns when a stated number
diverges from live by >10%** (or a referenced PR's state flipped). Not a
merge-blocker — a **per-phase re-baseline gate**: the master spine's phase
boundaries each include a ~30-minute "PRP re-verification" step that runs it
and commits the updated numbers/statuses.

**Files.** `scripts/ci/check-prp-freshness.mjs` (reuse `_ratchet-count.mjs`
grep mechanics + the "how to spot a violation" greps already written into the
.claude rules); an optional scheduled-lane wiring (weekly warn annotation).

**Acceptance.** Run at current baseline → exits 0; seed a stale number (edit
one count by >10%) → warn annotation names the drifted fact + live value; the
Phase-0→1 boundary run is recorded in the phase's closing PR.
**Per-cloud.** Cloud-neutral. **Size: S.**

---

## Cross-cutting sequencing (rev 2)

0. **AREA 0:** R0 **FIRST — before any bicep/env-adding item program-wide**
   (BLOCKER).
1. **AREA 1:** R1 → R2 → R3 (wrappers, codemod, guard; R3 builds
   `_ratchet-count.mjs`) then R4∥ (parallel families), R5/R6 serialized behind R1.
2. **AREA 2:** R7 (mechanical re-baseline) anytime; R8→R9→R10 serialized (plan
   order); R11/R12/R14 parallel by area (R14 = lowest-value churn — after all
   user-visible depth, per the product review); R13 independent. Honor the
   extend-then-decompose pairs (A4/L3/L4/L7/I5/A6/A7/A9/A11/A12/C — serialize).
3. **AREA 3:** R15 → R16 → R17 (generator, typed client, guard) — serialized.
4. **AREA 4:** R18 → R19; R18 lands before R10 so `useSemanticModel` can adopt it.
5. **AREA 6:** R28, R29, MIG1 — independent; the master places them in the
   Phase-2/3 opportunistic bucket (MIG1 in Phase 0 — the convention should exist
   before the new doc shapes land).
5b. **AREA 7 (round 3):** R30 in Phase 0 **immediately after X2** (same registry
   files — serialized pair), before the env-adding wave; FRESH0 lands Phase 1
   and runs at every phase boundary thereafter (master spine's per-phase
   re-baseline step).
6. **AREA 5 (housekeeping track):** R20 → R21 → R22 → R23 → R24 → R25 → R26 →
   R27, each verified before the next (phase gate: CI + mkdocs + ruff green) —
   **execute LAST or in quiet windows; never interleaved with depth work; pause
   on any CI destabilization.**

Every PR carries its ratchet regen (`--update-baseline`) and, for any live-editor
touch, a minted-session browser E2E receipt (G1). No item is "done" on
`tsc`+`vitest` alone where a live surface is involved.
