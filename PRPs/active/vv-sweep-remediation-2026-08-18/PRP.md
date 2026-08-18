# PRP — V&V Sweep Remediation (item catalog, apps catalog, admin pages, workspace settings)

**Status:** DRAFT (execution-ready — 2026-08-18). Author: Claude Code, operator-directed.
**Origin:** Every item below is an **already-filed, already-reproduced** GitHub issue — not a
speculative backlog. Source is a live-browser V&V sweep run 2026-08-18 against the Commercial
deployment (`https://csa-loom.limitlessdata.ai`), driven through the operator's own authenticated
Chrome session, that walked: the "+ New item" catalog (142/142 item types), the Apps catalog
(29/29 apps), every admin page (52/52 routes across 8 sidebar clusters), and the per-workspace
Settings drawer (12/12 tabs). This PRP is a **planning artifact** — it sequences fix work; it does
not build features itself.

**Cross-references (authoritative):**
- [`#3527`](https://github.com/fgarofalo56/csa-inabox/issues/3527) — the parent V&V epic. Its
  comment thread carries the full round-by-round narrative this PRP was scoped from, including the
  2026-08-18 supplementary-sweep comment and final rollup.
- [`#3730`](https://github.com/fgarofalo56/csa-inabox/issues/3730) — Gov/GCC-High estate is stale
  and its roll path has stopped applying `main`. **Not owned by this PRP** (infra/CI, not console
  code), but it **blocks** the Gov-parity follow-up sweep named in Non-goals below — do not start
  that follow-up until this is resolved, or its findings will be unattributable (real bug vs.
  fix-hasn't-shipped-here-yet).
- [`#3615`](https://github.com/fgarofalo56/csa-inabox/issues/3615) — the pre-existing no-freeform
  program EPIC (~150 untracked freeform sites). This PRP's Wave F items are net-new findings from
  this sweep, additive to that epic, not a duplicate of it.
- `docs/fiab/parity/MASTER-SCORECARD.md`, `docs/fiab/parity/<slug>.md` (486 docs) — per-surface
  grades; several are cited as stale evidence below.

**Die-hard rules that bind every item here** (`.claude/rules/`):
- `no-vaporware.md` — every fix ships a real backend behavior change with a live-data E2E receipt;
  honest gates only, never a fake green state.
- `auto-bind-by-default.md` — Wave F items specifically: replace freeform text with a real
  discovery-backed picker, no "bind to an existing X" dead end.
- `ux-baseline.md` — **G1** (browser E2E before "done" — this whole backlog exists *because* G1 was
  applied where static/CI checks had passed clean), **G2** (any remaining honest gate needs an
  inline Fix-it registered in the gate registry).
- `ui-parity.md` — Wave B items (breadth gaps) must close against the real Azure/Databricks source
  UI, not an approximation.

---

## (a) Validation ledger — all 30 items, already root-caused (not speculative)

Unlike a typical backlog PRD, every row below was reproduced live before filing — this section
records evidence, not verdicts-to-be-checked. Severity is assigned for sequencing, not by
`sp:N` alone (a small `sp:1` fix can be P0 if it's actively misleading an operator).

| # | Issue | What's wrong | Root cause (file:line where known) | Severity |
|---|---|---|---|---|
| R1 | [#3753](https://github.com/fgarofalo56/csa-inabox/issues/3753) | 3rd occurrence of the same bug: Cosmos reads scoped by caller's oid instead of the resource's own key | `app/api/admin/domains/mesh/route.ts` (mirrors closed #3282's fix-site); `resolveWorkspaceRole` in the permissions path | **P0** |
| R2 | [#3729](https://github.com/fgarofalo56/csa-inabox/issues/3729) | `/admin/readiness` Fix-it dialog asks the admin to retype env vars `/admin/env-config` already confirms are set | readiness route's remediation-copy generator | **P0** |
| T1 | [#3746](https://github.com/fgarofalo56/csa-inabox/issues/3746) | Green "Live" badge next to a red "unreachable, HTTP 403" banner for the same check | `app/admin/catalog/page.tsx:424-428` (badge ignores `catalog.error`) | **P0** |
| T2 | [#3741](https://github.com/fgarofalo56/csa-inabox/issues/3741) | MCP server card shows "Connected" while its own body says sign-in is required | `mcp-servers-panel.tsx:1280` (badge computed from `configured && registered`, ignores `status.tokenReady`) | **P0** |
| T3 | [#3739](https://github.com/fgarofalo56/csa-inabox/issues/3739) | FinOps Cockpit shows confident "no anomalies / no budgets" when the Cost Management read actually failed | `finops-cockpit-pane.tsx` — the `readState(query).isError` guard exists on 2 sibling panels, missing on these 2 | **P0** |
| T4 | [#3733](https://github.com/fgarofalo56/csa-inabox/issues/3733) | Recommendations card claims "everything's inside its bars" while cache hit-rate and warehouse p95 are both visibly breaching | two auto-tune rules (`cache-raise-ttl`, `warehouse-scale-up`) silently suppress once pinned at their admin-configured ceiling | **P0** |
| T5 | [#3749](https://github.com/fgarofalo56/csa-inabox/issues/3749) | DLP policy card headline claims a missing env var; its own next line says the var is already set | `dlp-graph-client.ts` — 3 hint-builders mislabel Graph-tenant-limitation/AppRole-gap/Gov-cloud-gap as "missing env var" | **P1** |
| D1 | [#3743](https://github.com/fgarofalo56/csa-inabox/issues/3743) | Top-users cost estimate ~13x inflated vs. token totals for the same calls | `route.ts:146` — `kqlByUser` never selects `model`, falls through to `estCostUsd('', ...)` default price | **P0** |
| D2 | [#3735](https://github.com/fgarofalo56/csa-inabox/issues/3735) | RUM shows 0 page loads / 0 route changes in a window Web Vitals shows 55 page views for | 3 independent KQL queries sharing the same timespan, not a windowing artifact (confirmed via source) | **P1** |
| D3 | [#3737](https://github.com/fgarofalo56/csa-inabox/issues/3737) | "Most active items (30d)" table empty on all 25 rows | `app/api/admin/usage/route.ts:172-183` — ranking by raw edit-count lets Unity Catalog system events (`unity:schema.list:...`) dominate the top-25, which never match a real Cosmos item | **P1** |
| D4 | [#3750](https://github.com/fgarofalo56/csa-inabox/issues/3750) | Security Audit tab's Kind column + filter are blank for the dominant live traffic type | Unity Catalog audit rows write `operation`, never `kind`/`key` | **P1** |
| D5 | [#3752](https://github.com/fgarofalo56/csa-inabox/issues/3752) | Policy-as-code "Load sample" shows a compiled preview claiming "no statements" while the loaded source visibly has 3 | compiled preview only refreshes after a save round-trip, not from live edits | **P2** |
| F1 | [#3718](https://github.com/fgarofalo56/csa-inabox/issues/3718) | `lakehouse-shortcut`: 13 freeform ARM/path sites, largest footprint in the item catalog | `lakehouse-shortcut-editor.tsx` (7 sites) + `onelake/shortcut-wizard.tsx` (6 sites) | **P1** |
| F2 | [#3734](https://github.com/fgarofalo56/csa-inabox/issues/3734) | Incident console "New monitor" dialog: raw item-id + hand-typed `catalog.schema.table` string | working `LakehouseTablePicker` component already exists in-repo, unused here | **P1** |
| F3 | [#3742](https://github.com/fgarofalo56/csa-inabox/issues/3742) | Copilot-quality Budgets "New budget" dialog: freeform Scope id `<Input>` | `useWorkspaces()` picker + the Agent-quality tab's own agent dropdown are both already in the same codebase | **P1** |
| X1 | [#3748](https://github.com/fgarofalo56/csa-inabox/issues/3748) | Landing Zones map renders blank (React hydration error `#418`) | **Same minified stack frame as already-open #3528** on an unrelated route — confirms shared blast radius, not a new root cause | **P1** |
| X2 | [#3740](https://github.com/fgarofalo56/csa-inabox/issues/3740) | Daily-token sparkline renders as one edge-to-edge block when only 1 day has data | `copilot-usage.tsx` — `dailyTotals()` never zero-fills missing days | **P2** |
| X3 | [#3736](https://github.com/fgarofalo56/csa-inabox/issues/3736) | ~1-in-6 synthetic-monitor runs report "crashed before Playwright ran" | reproduced across 2 reloads with distinct real run IDs | **P2** |
| X4 | [#3757](https://github.com/fgarofalo56/csa-inabox/issues/3757) | Workspace Settings → Encryption tab leaks a raw ARM 404 instead of an honest gate | `app/api/admin/workspaces/[id]/cmk/route.ts:125-131` — catch block converts 403s to honest-gate shape, 404 falls through raw | **P1** |
| N1 | [#3724](https://github.com/fgarofalo56/csa-inabox/issues/3724) | `/admin/classifications` + `/admin/sensitivity-labels` are fully built but unreachable from any nav | absent from `ADMIN_SECTIONS` and `ADMIN_LEGACY_REDIRECTS` | **P2** |
| B1 | [#3719](https://github.com/fgarofalo56/csa-inabox/issues/3719) | `databricks-pipeline` (Lakeflow/DLT): 31 missing capability rows, worst breadth gap in the catalog | doc-confirmed; **`sp:13` — needs grooming into sub-issues, not a single fix** | **P2 (groom first)** |
| B2 | [#3721](https://github.com/fgarofalo56/csa-inabox/issues/3721) | `digital-twin`: 27 missing capability rows | doc-confirmed; **needs grooming** | **P2 (groom first)** |
| B3 | [#3722](https://github.com/fgarofalo56/csa-inabox/issues/3722) | `ai-red-team`: parity doc says "Not A-grade" | doc-confirmed; **needs grooming** | **P2 (groom first)** |
| B4 | [#3720](https://github.com/fgarofalo56/csa-inabox/issues/3720) | `slate-app`: the only item type whose own doc self-grades **D** | doc says "target A once P0+P1 land" — those P0/P1 aren't yet enumerated as issues | **P2 (groom first)** |
| C1 | [#3723](https://github.com/fgarofalo56/csa-inabox/issues/3723) | `model-serving-endpoint`: zero parity doc exists at all | doc-only gap | **P2** |
| C2 | [#3725](https://github.com/fgarofalo56/csa-inabox/issues/3725) | 4 admin parity docs (`admin-shell`, `workspace-create`, `folders-taskflows`, `users-licenses`) are confirmed stale by real post-grade commits | doc-only gap, but 2 of the 4 masked real bug fixes | **P1** |
| C3 | [#3726](https://github.com/fgarofalo56/csa-inabox/issues/3726) | 15 admin pages have zero parity doc | doc-only gap | **P2** |
| C4 | [#3738](https://github.com/fgarofalo56/csa-inabox/issues/3738) | `usage-adoption.md` doc is stale against a 751-line live page with 5 undocumented sections | doc-only gap | **P2** |
| — | #3747, #3751 | Both are literal instances of R1's pattern | **Subsumed by R1 — do not fix separately** | — |

**Counts:** 30 issues filed, 28 distinct work items after subsuming #3747/#3751 into R1. Zero
duplicates (every issue was searched against existing tracking before filing).

---

## (b) Wave plan — sequenced by blast radius and dependency, not issue number

### Wave R — Root-cause fixes (fix first; two of these are prerequisites for trusting everything downstream)
- **R1** Grep the full `apps/fiab-console/app/api/**` tree for the caller-oid-vs-resource-key
  pattern (per #3753's own acceptance criteria) rather than patching #3747/#3751 in isolation. Add
  a lint rule or test pattern if feasible so a 4th occurrence doesn't ship.
  *Acceptance:* a tenant admin can manage access on a workspace/domain they didn't personally
  create — must succeed, not 404. Live E2E receipt required (this bug class is specifically the
  kind that looks fine in a unit test with a self-owned fixture).
- **R2** Fix `/admin/readiness`'s remediation-copy generator so its Fix-it dialog reflects the
  *actual* unmet prerequisite, not a stale/wrong env-var list. Cross-check against `/admin/env-config`'s
  own source of truth for what's set.
  *Acceptance:* reproduce the original failing case from #3729; the Fix-it dialog's asked-for
  values must match what's genuinely unset.
- **Rules:** `no-vaporware` (this is exactly the "green report over broken reality" failure mode
  the rule exists for).

### Wave T — "Lying UI" (self-contradicting badges/banners; same shape, fix together)
- **T1–T5** (#3746, #3741, #3739, #3733, #3749). Each is a place where a status indicator and the
  real underlying state disagree. Recommended approach: **before fixing each individually, check
  whether the sibling-panel-has-the-right-guard pattern from T3 (`finops-cockpit-pane.tsx`) repeats
  elsewhere in the same file/component family** — T3's own filing already found the correct guard
  present on 2 of 4 panels in one file, missing on the other 2, which is a copy-paste-omission
  shape worth checking for in T1/T2/T4/T5's files too before treating each as a bespoke fix.
  *Acceptance per item:* the badge/banner is derived from the same status object the detail text
  already reads correctly; reproduce the original failure (don't just eyeball the code) before and
  after.
- **Rules:** `no-vaporware` (an honest-looking-but-wrong status is arguably worse than an honest
  gate — it actively misdirects).

### Wave D — Data correctness (numbers/aggregates disagreeing with themselves or with reality)
- **D1** Fix `kqlByUser` to select `model`; `estCostUsd` must never silently fall through to a
  generic default price for a named, priced model.
- **D2** Reconcile the 3 independent KQL queries behind RUM's page-load / route-change / Web-Vitals
  counts — they should agree on the same timespan by construction; find where one diverges.
- **D3** Fix the "most active items" ranking to filter out (or separately bucket) Unity Catalog
  governance/system events before joining against real Cosmos items — or, if system events are
  meant to be visible, label them as such instead of leaving Type/Workspace/Requests blank.
- **D4** Give Unity Catalog audit rows a real `kind`/`key`, or make the generic audit reader and
  `AuditPanel` derive a badge from `operation` when `kind` is absent, rather than rendering blank.
- **D5** Make Policy-as-code's compiled preview reactive to live source edits, not just
  save-round-trips.
- **Acceptance per item:** hand-verify the corrected number/state against an independent source
  (a direct KQL query, a manual count) before calling it fixed — this whole wave exists because a
  page disagreeing with itself is exactly the kind of thing that looks plausible without that check.
- **Rules:** `no-vaporware`.

### Wave F — Freeform-text-instead-of-picker (`auto-bind-by-default.md` violations)
- **F1** Replace all 13 sites across `lakehouse-shortcut-editor.tsx` + `onelake/shortcut-wizard.tsx`
  with discovery-backed pickers (existing storage accounts / containers / OneLake paths already
  visible to the tenant), or move any genuine BYO field into `check-no-freeform.mjs`'s `ACCEPTED`
  table with a stated reason.
- **F2** Wire the existing `LakehouseTablePicker` into the Incident-console "New monitor" dialog in
  place of the raw item-id + `catalog.schema.table` text fields.
- **F3** Wire `useWorkspaces()` (or the Agent-quality tab's existing agent dropdown, whichever fits
  the field's actual scope) into the Copilot-quality Budgets "New budget" dialog's Scope-id field.
- **Acceptance:** `node scripts/ci/check-no-freeform.mjs` count drops by the sites fixed, with no
  regression elsewhere; live E2E receipt showing the picker populated with real discovered values.
- **Rules:** `auto-bind-by-default.md` (zero user-performed plumbing where the platform can
  discover/provision it).

### Wave X — Rendering / reliability defects
- **X1** Coordinate with whoever owns #3528 — this is the same hydration error (`#418`, identical
  minified stack frame), so the fix belongs in the shared shell/layout code, not a per-page patch.
  Do not fix X1 in isolation; fixing #3528's root cause should resolve both.
- **X2** Zero-fill `dailyTotals()` for missing days before computing bar widths.
- **X3** Root-cause the ~1-in-6 synthetic-monitor "crashed before Playwright ran" failures — 2
  distinct real run IDs were captured in the original repro, use those as a starting trace.
- **X4** Extend the CMK route's error-catch to convert ARM 404s to the same honest-gate shape it
  already gives 403s, per the file's own docstring promise.
- **Rules:** `no-vaporware` (X4 specifically — a raw ARM error string is exactly what an honest
  gate is supposed to replace).

### Wave N — Navigation / reachability
- **N1** Add `/admin/classifications` and `/admin/sensitivity-labels` to `ADMIN_SECTIONS` under the
  appropriate clusters. First confirm neither duplicates an existing `/governance/*` surface before
  wiring in — resolve which is canonical if there's overlap.

### Wave B — Breadth gaps (grooming step BEFORE any fix work)
- **B1–B4** (#3719, #3721, #3722, #3720). These are not single-PR fixes — each is a doc-confirmed
  double-digit-row capability gap or a self-graded failing grade. **The work item for this wave is
  grooming, not fixing:** read each item's current parity doc, confirm the gap list against
  `main` (docs may have drifted further since filing), and split each into Tier-ordered sub-issues
  per `MASTER-SCORECARD.md`'s own Tier-0/Tier-1 convention (quick wins first, flagship gaps later).
  Do not start build work on any of these until that grooming pass produces sized sub-issues.

### Wave C — Documentation-only (no code defect)
- **C1, C3** Author the missing parity docs (`model-serving-endpoint.md`, and the 15 admin pages
  named in #3726) per the standard template.
- **C2** Re-verify and update the 4 confirmed-stale admin docs against current `main` via live
  browser walk (not a re-read of the diff) per `ui-parity.md`'s own methodology.
- **C4** Rewrite `usage-adoption.md` to cover the live page's actual 5 sections.
- These can run in parallel with any other wave — no code dependency — and are good candidates for
  a lower-priority/background lane.

---

## (c) Sequencing rationale

1. **Why R before T before everything else:** R1 is an access-control correctness bug that's
   already recurred 3 times — shipping more fixes before generalizing it risks a 4th instance
   landing in whatever's touched next. R2 is the readiness page itself giving wrong guidance,
   which undermines trust in every other honest-gate fix downstream (an operator who's been told
   the wrong remediation once won't trust the next one either).
2. **Why T is one wave, not five separate ones:** T3's filing already found the correct fix
   pattern present in 2 sibling panels of the same file and missing in the other 2 — a strong
   signal this is a systemic copy-paste-omission shape, not five independent bugs. Checking for the
   same shape across T1/T2/T4/T5 before writing five bespoke fixes is cheap and likely to shrink
   the wave.
3. **Why B is "groom, don't fix":** these are the four items in this backlog that don't have a
   bounded acceptance criterion yet — they're doc-confirmed breadth gaps, not diagnosed bugs. This
   repo's own `sp:13` convention ("TOO BIG, split before starting") applies directly; treating them
   as fixable in this PRP's wave structure without grooming first would produce unbounded work.
4. **Why X1 is explicitly "don't fix in isolation":** shipping a per-page patch for a shared
   hydration bug (#3528's stack frame) risks the classic whack-a-mole outcome — the bug resurfaces
   on a third page next sweep. Fix it once, at the root.
5. **Gov/GCC-High is explicitly out of this PRP's scope** (see Non-goals) — not because it isn't
   found work, but because #3730 makes any Gov-specific finding unattributable until the estate
   catches up to `main`.

---

## (d) Non-goals

- **Not** re-running the Gov/GCC-High live sweep — blocked on #3730, tracked as separate follow-up
  work once that's resolved.
- **Not** re-opening or re-scoping #3615 (the pre-existing no-freeform EPIC) — Wave F here is
  additive to it, not a replacement.
- **Not** fixing #3730 itself — that's infra/CI deploy-pipeline work, cross-referenced but not
  owned by this PRP.
- **Not** starting build work on Wave B's four breadth gaps before their grooming pass produces
  sized sub-issues.
- **Not** a framework or architecture change — every fix here is scoped to the file(s) named in
  its issue.

## Verification per merge (binding)

Per this repo's own standard (`no-vaporware.md`, `ux-baseline.md` G1): a real-data E2E receipt in
the PR (endpoint hit + response + screenshot or Playwright trace), reproduction of the *original*
failing case before claiming it's fixed (not just a plausible-looking diff), and — for any item
that touches a gate — a gate-registry + Admin-gate-page entry per G2. A wave is done only when
every item in it has a live receipt with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

---

## Backlog index (compact)

- **Wave R (P0, fix first):** R1 (#3753) R2 (#3729)
- **Wave T (P0/P1, same shape):** T1 (#3746) T2 (#3741) T3 (#3739) T4 (#3733) T5 (#3749)
- **Wave D (P0-P2, data correctness):** D1 (#3743) D2 (#3735) D3 (#3737) D4 (#3750) D5 (#3752)
- **Wave F (P1, auto-bind):** F1 (#3718) F2 (#3734) F3 (#3742)
- **Wave X (P1/P2, rendering/reliability):** X1 (#3748, coordinate w/ #3528) X2 (#3740) X3 (#3736) X4 (#3757)
- **Wave N (P2, nav):** N1 (#3724)
- **Wave B (P2, groom before fixing):** B1 (#3719) B2 (#3721) B3 (#3722) B4 (#3720)
- **Wave C (P2, docs-only, parallelizable):** C1 (#3723) C2 (#3725) C3 (#3726) C4 (#3738)
- **Subsumed, not separate work:** #3747, #3751 (both = R1)

**Total: 28 distinct work items (30 issues, 2 subsumed) across 8 waves.**
