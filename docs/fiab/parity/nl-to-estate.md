# nl-to-estate — parity with NL-to-Full-Estate planner (WS-8.1 / BTB-3)

Source UI: none — this is a **burn-the-box** Loom differentiator. Neither
Microsoft Fabric nor the Azure portal has a surface that composes an entire data
estate (lakehouse → medallion → semantic model → report → API → data agent →
governance) from a single natural-language prompt into a typed, reviewable,
approvable plan that then executes the full chain via real Weave bridges.
This doc records that the WS-8.1 feature is **real end-to-end** (no-vaporware.md).

Related: `estate-builder.md` covers both WS-8.1 (NL) and WS-8.2 (One-Canvas)
together. This doc focuses on the NL planner surface specifically.

## Capability inventory (the burn-the-box bar for WS-8.1)

| # | Capability | Loom coverage | Backend / control |
|---|------------|---------------|-------------------|
| 1 | One NL prompt accepted from `<Textarea>` | ✅ | `EstateConsole` "Describe it" tab |
| 2 | Prompt routed to the reasoning tier (WS-1.1) | ✅ | `planEstateFromPrompt` → `aoaiChatJson({ tier:'strong', taskClass:'reasoning' })` via `model-tier-router` |
| 3 | System prompt built from the LIVE bridge registry | ✅ | `buildEstatePlanPrompt()` reads `WEAVE_BRIDGES` + `ESTATE_NODE_KINDS` — never advertises a nonexistent bridge |
| 4 | Planner emits a typed plan DAG (create + weave nodes) | ✅ | `parseEstatePlan()` normalises model JSON → `EstatePlan` (hallucinated bridges dropped) |
| 5 | Plan DAG validates against the real Weave bridge registry | ✅ | `validatePlan()` checks bridge ids, source-type compatibility, produced-type match, no cycles |
| 6 | Dry-run diff rendered before any write | ✅ | `planDiff()` → `EstateDiff.ops` shown in review card (create/weave badges, upstream labels) |
| 7 | Nothing created until explicit approve | ✅ | Plan route is read-only; execute route only fires on "Approve & build the estate" click |
| 8 | Approve → execute the full chain via real Weave bridges | ✅ | `POST /api/estate/execute` → `executeEstatePlan` calls `createOwnedItem` + real thread route handlers in-process |
| 9 | Created item ids thread downstream as bridge sources | ✅ | Executor resolves each `fromNodeId`'s `resultItemId` as the next bridge's `from` input |
| 10 | Failed step skips its downstream subtree honestly | ✅ | Executor marks dependent nodes `skipped` with the reason — no phantom source item |
| 11 | Per-step live status in the diff panel (pending/running/created/skipped/failed) | ✅ | `result.plan.nodes` status overlaid on the static diff ops after execute |
| 12 | "Open" link to each created item post-execute | ✅ | `resultLink` rendered as Fluent `<Link>` in the diff row |
| 13 | G2 — Fix-it button when reasoning model not configured | ✅ | 503 response sets `errorCode='no_aoai_deployment'` → `<MessageBarActions>` with `/admin/gates?gate=svc-model-reasoning-tier` |
| 14 | Honest MessageBar gate (not a blank screen or crash) | ✅ | `NoAoaiDeploymentError` → 503 naming `LOOM_AOAI_STRONG_DEPLOYMENT`; full UI still renders |
| 15 | Azure-native — no Fabric dependency on default path | ✅ | Every produced item uses the Azure-native bridge backend; no `fabricWorkspaceId` on default path |
| 16 | Fluent v9 + Loom tokens, no raw px | ✅ | `makeStyles` throughout; gap/spacing use `tokens.spacing*`; no hard-coded px/hex |
| 17 | `flexWrap` + `minWidth:0` — badges never overlap | ✅ | `opRow` style has `flexWrap:'wrap'` + `minWidth:0` |
| 18 | Workspace picker — items land in a target workspace | ✅ | `useWorkspaces` + `<Select>` drives `workspaceId` posted to both plan + execute routes |
| 19 | Example prompt for guided first-use | ✅ | "Use the example" button pre-fills the full sales-analytics estate prompt |
| 20 | New-item first-open is clean (no errors on blank state) | ✅ | Error + plan state is null on mount; no banners on a fresh open |

Zero ❌.

## Backend per control

| Control | Route / function |
|---------|-----------------|
| "Plan the estate" button | `POST /api/estate/plan` → `planEstateFromPrompt` (AOAI reasoning tier) → `parseEstatePlan` → `validatePlan` + `planDiff` |
| "Approve & build the estate" button | `POST /api/estate/execute` → `executeEstatePlan({ createDispatch, weaveDispatch })` |
| `createDispatch` | `createOwnedItem(session, itemType, { workspaceId, displayName })` (real Cosmos item) |
| `weaveDispatch(action)` | dynamic-imports `app/api/thread/<route>/route.ts` and calls `POST(innerRequest)` with the ambient session cookie (real Azure backend) |
| Fix-it button | `/admin/gates?gate=svc-model-reasoning-tier` — opens the gate resolver wizard that lists real AOAI deployments from the subscription |

## Weave bridges the chain can execute (all 13)

`analyze-in-notebook`, `bind-to-ontology`, `add-data-agent-source`,
`build-loom-report`, `build-report-from-model`, `analyze-in-powerbi`,
`build-powerbi-model`, `publish-as-api`, `mirror-to-notebook`,
`mirror-to-lakehouse`, `analyze-with-dax`, `materialize-to-kql`,
`kql-query-to-dashboard-tile`, `promote-medallion` — 14 entries in
`WEAVE_BRIDGES` (the catalog includes `build-report-from-model` alongside
`build-loom-report`), all wired in `/api/estate/execute` `BRIDGE_ROUTES`.

## Verification

- Unit (`lib/estate/__tests__/`): 19 tests across plan-model DAG (topo/validate/diff/compile), planner (NL→DAG parse, bridge hallucination drop, node cap), and executor (create→weave chain, skip-on-failure, no-mutation).
- TypeScript: `tsc -p tsconfig.build.json --noEmit` — 0 errors.
- CI: check-no-freeform, check-file-size, check-route-guards, check-bff-errors, check-no-bare-client-fetch, check-env-sync, check-no-raw-px, check-sql-quoting — all OK.
- **Owed: browser-E2E receipt (Track-0)** — one NL prompt produces a plan reviewed and then executed end-to-end with real items created in a workspace. To be attached against a live deployment before A-grade sign-off.
