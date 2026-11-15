---
name: ib-05-slate-parity-a
status: backlog
priority: P2
order: 105
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4374, 4360, 4362, 4929, 4368]
branch: fix/ib-05-slate-parity-a
---

# PRP: ib-05 Slate app parity, widget kinds and inspector (batch A)

## Goal
Close five rows of `docs/fiab/parity/slate-app.md` that share one file family, the slate-app builder: fix the false `{{variable}}` hint on text widgets (#4374), add input and action widget kinds (#4360), graph / tree / image-gallery widgets (#4362), the five missing chart widgets (#4929), and a dependency / debug inspector (#4368). Each parity row flips to BUILT only with a live in-browser receipt.

## Why
All five issues edit `apps/fiab-console/lib/editors/slate/slate-app-builder.tsx`, a single 1273-line file (`SlateWidgetKind` is `table|chart|metric|text|container`; `WidgetView`, `WidgetInspector`, `runInteractions`, `runPreview`). They cannot be split across parallel PRPs without conflicting, so they are one serial batch. #4374 is first because it is a false promise (the hint at `:670` says `{{variable}}` shows a live value; `renderMarkdownLite` takes no variables) and the fix shape (thread `variables` and `runtime` into the text path) is the same plumbing the input widgets need.

Deferred, with reasons: #4361 (Map widget) needs an Azure Maps account deployed by bicep and an env var (auto-bind: the platform deploys it), so it belongs in the single bicep slot; #4363 (multi-page, container nesting), #4364 (query helpers, paging), #4365 (variable transforms, user storage), #4366 (styles, custom HTML), #4367 (parameters, public apps, kiosk) each reshape `state` or the query route and are independent sessions.

## Scope / Non-goals
In scope: the five items, the extraction of new widget renderers into `lib/editors/slate/widgets/` to keep the main file from growing, and the parity doc rows. Non-goals: any Power BI or Fabric dependency (`no-fabric-dependency.md`; the Azure-native path is the default); changing the `slate-app` publish route.
Cloud scope: client-side rendering plus existing BFF routes; the same code serves Commercial and Gov. Receipts: Commercial live walk; GCC-High through the console roll via Actions (supported-in-code until walked); GCC never exercised.

> ASSUMPTION: #4929 may be satisfied per widget by either building it or recording an explicit out-of-scope reason in the parity doc (the issue allows both). Declaring any of the five out of scope requires the operator, so the default is to build all five and ask before descoping.

## Acceptance criteria
- [ ] #4374: a text widget containing `Region: {{region}}` with variable `region` defaulting to `eastus` renders `Region: eastus` in Preview. Fails if the literal `{{region}}` appears; also fails if a value containing markup (`<img onerror=...>`) is rendered as HTML rather than escaped text.
- [ ] #4360: Text Input, Numeric Input, Date-Time, Dropdown, Button, Tabs and Toast kinds exist; each input writes its `SlateVariable` through `setRuntimeScalar` and a Button fires its `onClick` interaction. Fails if changing a Dropdown does not change a query bound to `{{var}}` in Preview.
- [ ] #4362: Graph (via `canvas-node-kit`), Tree (the console explorer tree primitive) and Image Gallery (URLs from query rows) render live query rows. Fails if any is fed from a literal array (`no-vaporware.md`).
- [ ] #4929: Vega, Gantt, Pivot Table, Timeline and Time-Series Analysis widgets each bound to live query results; parity row 5 moves from `3 of 8`. Fails if `grep -ci "pivot" slate-app-builder.tsx widgets/*` is 0.
- [ ] #4368: a Dependencies panel (widget to query to variable) and per-widget load timing and error columns fed by `runPreview` results; `state.lastGeneratedAt` and `state.lastPublishedAt` shown as history. Fails if a failing query shows no per-widget error.
- [ ] Parity doc `docs/fiab/parity/slate-app.md` has every touched row marked BUILT or honest-gate with zero MISSING among the five; `ux-baseline.md` section 7 boxes hold (undo/redo and shared canvas rail untouched, node compactness, no overlapping badges).
- [ ] G1: live browser E2E per widget kind, dark and light screenshots.

## Read first
- `apps/fiab-console/lib/editors/slate/slate-app-builder.tsx` (`SlateWidgetKind`, `WidgetView`, `renderMarkdownLite`, `interpolate`, `runInteractions`, `runPreview`, `WidgetInspector`)
- `apps/fiab-console/app/api/items/slate-app/[id]/query/` (run route), `app/api/items/slate-app/[id]/generate/`
- `docs/fiab/parity/slate-app.md`, `docs/fiab/ux-standards.md`
- `apps/fiab-console/lib/components/canvas/canvas-node-kit.tsx` (graph widget), the console explorer tree primitive
- `.claude/rules/{no-vaporware,ux-baseline,web3-ui,ui-parity}.md`

## Owns
- `apps/fiab-console/lib/editors/slate/slate-app-builder.tsx`
- `apps/fiab-console/lib/editors/slate/widgets/input-widgets.tsx` (new)
- `apps/fiab-console/lib/editors/slate/widgets/viz-widgets.tsx` (new)
- `apps/fiab-console/lib/editors/slate/widgets/chart-widgets.tsx` (new)
- `apps/fiab-console/lib/editors/slate/widgets/dependency-panel.tsx` (new)
- `apps/fiab-console/lib/editors/slate/__tests__/slate-widgets.test.tsx` (new)
- `apps/fiab-console/lib/editors/slate/__tests__/slate-interpolation.test.tsx` (new)
- `docs/fiab/parity/slate-app.md`

## Must NOT touch
- `apps/fiab-console/app/api/items/slate-app/**` routes except by a separate PRP (no route changes are needed for these five items; if one proves necessary, stop and report)
- any bicep (`platform/fiab/bicep/**`), `lib/gates/registry/**`, `lib/fabric-item-types.ts`, `item-crud.ts` (hot files)
- `lib/components/canvas/canvas-node-kit.tsx` (shared; consume only)

## Consumes
- Existing slate-app query run route and `canvas-node-kit`. No other PRP owns the slate files (grep of `PRPs/` found no program PRP naming `lib/editors/slate`).

## Provides
- Widget kinds usable by the deferred slate parity issues (#4361, #4363-#4367), which should start after this PRP merges to avoid a conflict in the builder file.

## Steps
1. #4374: thread variables and runtime into the text widget; escape values; vitest spec that goes RED if `interpolate` is not called on the text path.
2. Extract the new widget renderers into `widgets/*.tsx`, keeping `slate-app-builder.tsx` edits to registration, the inspector fields and the kind union.
3. #4360 then #4362 then #4929 (each an incremental PR-sized commit; run the suite between).
4. #4368 last (it consumes timing and error data from `runPreview`).
5. Update the parity doc rows with the receipt links; take screenshots.

## Validation
- `pnpm --dir apps/fiab-console vitest run lib/editors/slate`
- `make validate-typescript` (no unit-level typecheck on tests alone counts)
- `pnpm --dir apps/fiab-console uat` live walk of each widget kind; "merged, not deployed" until the console is rolled and the walk repeated on the estate.
- A rendered-HTML assertion for #4374 states its failing input (the `<img onerror>` value).

## Rollback
Revert the PR; saved apps with the new kinds would render an unknown-kind placeholder, so state a guard that unknown kinds render a labelled placeholder rather than throwing (add it in step 2).

## Docs to update
`docs/fiab/parity/slate-app.md` (rows 5, 7, 8, 9, 31 and the hint text).

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-05-slate-parity-a · Worktree: E:/Repos/_ib-05

## Hot files
None of the registry hot files. `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4374 | todo | | sonnet | | |
| #4360 | todo | | sonnet | | |
| #4362 | todo | | sonnet | | |
| #4929 | todo | | sonnet | | |
| #4368 | todo | | sonnet | | |

Deferred candidates: #4361 (needs Azure Maps via bicep slot), #4363, #4364, #4365, #4366, #4367 (each a separate session on the same builder file; start after this merges).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-05-slate-parity-a.md, docs/fiab/parity/slate-app.md and .claude/rules/ux-baseline.md. Worktree E:/Repos/_ib-05, branch fix/ib-05-slate-parity-a. Start with #4374 (text interpolation, with a spec that fails on the literal), then extract new widgets into lib/editors/slate/widgets/ and do #4360, #4362, #4929, #4368 in that order. No mock data, no Fabric or Power BI. Proof of done: `pnpm --dir apps/fiab-console vitest run lib/editors/slate` green, `make validate-typescript`, and a browser receipt per widget kind with screenshots.
