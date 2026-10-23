# L2 — CI, Gates & Guards

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 1
**Rigor:** Normal (gates + one independent pass)
**Suggested concurrency:** up to **4** agents in this lane simultaneously.
**Inventory:** **45 open issues** (13 bugs, 0 epics, 0 labelled security).

## 1. Thesis

The gates are the only thing standing between a plausible claim and a shipped defect. A gate that cannot fail is worse than no gate.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `scripts/ci/** (excluding the files declared by L0 and L1)`
- `.github/workflows/** (excluding deploy/gov/roll/build — L0)`
- `dev-loop/gates/**`
- `scripts/ci/__tests__/**`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `anything under apps/fiab-console/** (L3/L4/L5)`
- `platform/fiab/bicep/** (L0)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `node --test on the changed guard's suite`
- `a POSITIVE CONTROL: the guard must FAIL on a deliberately broken input`
- `make lint / make validate-python where touched`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- `2>/dev/null`, `|| true`, and `continue-on-error` convert a measurement into a decoration.
- Capture `RC=$?` on the line IMMEDIATELY after the subject command — never after a pipe.
- `bash -e` in guardrails aborts LATER guards; removing `|| true` without `set -e` changes nothing.
- A required check can conclude SUCCESS having executed nothing (#3783). Verify with temp/merge-eligible.py + temp/hollow-control.py.
- hollow-check flags PATH-APPROPRIATE skips too — diff the PR's changed files against what the check covers before accepting OR dismissing its verdict.
- A test reading ambient git history asserts nothing on a depth-1 CI checkout.

## 5. Fan-out plan

1. **Triage pass first (1 agent, sp:1).** Walk the inventory in §7 and split it into
   `real` / `stale` / `duplicate` / `already-fixed`. Verify "already-fixed" by measurement
   — several issues in this repo claim a current failure that is no longer true, and
   several claim a fix that never deployed. Record the verdict as an issue comment.
2. **Batch the survivors by shared file.** Two items touching the same file become ONE
   work item, or they run sequentially. This is the step that prevents the merge
   treadmill, and it is where most of the wall-clock is won or lost.
3. **Fan out to 4 concurrent agents**, each in its own worktree, each owning a
   disjoint file set from step 2.
4. **Serialize the merges.** Branch protection is `strict`, so every merge invalidates
   the branches behind it. Merge one, re-verify, merge the next. Prefer batching several
   fixes per PR over one PR per issue: with strict protection, N PRs cost N CI cycles.

## 6. Definition of done for this lane

- Every §7 issue is closed, or re-scoped with its reason recorded, or explicitly deferred
  by the operator.
- Every closure is on DEPLOYED-and-verified evidence, never on a merge.
- No guard introduced by this lane passes when its subject is mutated.
- The lane's own landmine list in §4 has been extended with anything new it learned.

## 7. Issue inventory (45)

| # | title | labels |
|---|---|---|
| #3866 | flake: reindex-loom-docs.test.mjs:168 has a 6s wall-clock budget inside a 124-way concurrent runner | bug,lane:ci |
| #3865 | test: give commitsIn the same cwd treatment expectedCount got in #3853 | enhancement,lane:ci |
| #3848 | auto-bind-sweep has no repo guard script — one spec file is the sole enforcement |  |
| #3842 | gov-bff-verify: the probe decides on the full body but prints 260 chars, so a gated verdict shows evidence tha |  |
| #3838 | bulk-delete: 500-id serial batch has no maxDuration, no aggregate Graph bound, and is non-transactional — wall |  |
| #3837 | The login-CSRF tamper spec is a ~6% flake: its last-base64url-char flip is a padding no-op 1 run in 16 |  |
| #3821 | vitest change-detection: a PRPs/-only PR still runs ZERO tests — the stale-corpus guard is unreachable by both | bug |
| #3819 | vitest change-detection: floor too low, deriver untested, and two more green-on-zero routes | bug |
| #3815 | fix(copilot): validate_gate_dry_run passes -WhatIf to five gates that all reject it, and its tests lock the de |  |
| #3811 | make validate reports "All gates passed!" having run ZERO gates — dev-loop/gates has no TypeScript leg, and an |  |
| #3799 | After #3795 the #3676 revert is detected but never healed — auto-dispatch the roll-forward the gate already kn | bug |
| #3797 | The #3676 gate discards an actionable regression when the revision read fails — operator loses the roll-forwar | bug |
| #3784 | fix(test): gates-2641 R7 clause pins the classifier's ingredients but not its POLARITY — dropping one '!' stay | lane:ci,sprint:next |
| #3783 | vitest (node 20) is a required check that reports green having executed ZERO tests when a PR touches only .git | lane:ci,sprint:active |
| #3760 | fix(test): reindex-loom-docs asserts elapsed MILLISECONDS where it means poll COUNT — 1755ms idle vs 7908ms un | lane:ci,sprint:next |
| #3756 | pipeline-canvas-collab-type.test.tsx passes only on CI retry: 8.77s isolated, 46.5s and failing under parallel | lane:console,sprint:next |
| #3726 | 15 admin pages have zero parity doc — no audit baseline exists, several high-stakes | csa-loom,documentation,lane:console,sprint:next |
| #3708 | ci: check-honest-gate-coverage cannot see a remediation bar whose missing-var is interpolated at runtime — the | bug,lane:ci,sprint:next |
| #3705 | ci: reindex-loom-docs test asserts a 6s WALL CLOCK budget — 8.5s idle / 16s under load on Windows, so it is a  | bug,lane:ci,sprint:next |
| #3677 | route-toolkit-baseline.json is stale by 39 keys — the ratchet's touched-file rule fires on already-migrated ro | csa-loom,lane:ci,sprint:next |
| #3626 | no-freeform: clear the 4 baselined free-text sites in unified-sql-database-editor.tsx | lane:console,sprint:next |
| #3615 | EPIC: the no-freeform program is ~16% done — 176 ratcheted + 34 accepted sites remain, and ~150 are tracked by | lane:console,sprint:blocked |
| #3609 | Two live copies of the DLZ Resource Graph resolver, and the new one drops the 60s SWR cache | lane:ci,sprint:next |
| #3607 | check-route-guards: ALLOWLIST_PREFIXES entries are never premise-tested, and `app/api/setup/` is load-bearing  | lane:ci,sprint:active |
| #3601 | check-no-raw-px.mjs flags a COMMENT describing a style object — a scanner that cannot tell code from prose abo | lane:ci,sprint:next |
| #3598 | fix(ci): the no-freeform guard's own comment claims readOnly had ZERO occurrences — there are 16, and its own  | lane:ci,sprint:next |
| #3594 | no-freeform's storage-loc needs the literal word 'storage', so 'ADLS Gen2 location' reads as clean while 'Stor | bug,csa-loom,lane:ci,sprint:next |
| #3550 | ci: three guards cannot reach a verdict on Windows, so 'I ran the guards locally' is not meaningful here | lane:ci,sprint:next |
| #3544 | G2 violation: Copilot Studio 'not a member of the organization' is a bare remediation MessageBar, no Fix-it, n | lane:console,sprint:next |
| #3513 | 23 opt-in remediation gates (Fabric backends + Purview UC data-plane roles) are plain-text messages with no in | bug,csa-loom,lane:console,sprint:next |
| #3506 | ci: examples/ai-agents/requirements.txt is ResolutionImpossible — the resolve gate triggered on it and never c | lane:ci,sprint:next |
| #3505 | ci: the loom-vscode test lane runs but is NOT a required context — a red result would not block a merge | lane:ci,sprint:next |
| #3495 | ci: reindex-loom-docs asserts a 6s wall-clock budget inside a concurrent pool — flakes the required guardrails | lane:ci,sprint:next |
| #3490 | chore: prune the branch list — 562 of 566 are provably landed (audit corrects this issue's premise) | lane:ci,sprint:next |
| #3472 | ci: the eval gate fails PRs on a stale docs index it does not control | lane:ci,sprint:next |
| #3464 | D3 role-assignment guard: blind to YAML env: role GUIDs, floor on the wrong population, and checks probe PRESE | lane:ci,sprint:next |
| #3462 | release-please: held action_required runs DO exist — approving them could delete the dispatch fan-out AND the  | lane:ci,sprint:next |
| #3459 | ci: the test suite transiently mutates a TRACKED file (lib/client-fetch.ts) — any `git add -A` during a run sh | bug,lane:ci,sprint:next |
| #3450 | The 'platform tells you to run it' class is 26 sites, not the 2 in #3374 — ratcheted, but the inventory should | lane:console,sprint:next |
| #3438 | check-guard-logical-lines scans only check-*.mjs — a guard that factors its scanner into a _-module is invisib | lane:ci,sprint:next |
| #3352 | Chaos Studio + Load Testing wired into readiness, so "ready" means "survived something" | csa-feature-request,csa-loom,lane:ci,sprint:next |
| #3169 | a11y regressions past baseline on /workspaces and /setup (found by first honest UAT run) | bug,lane:console,sprint:next |
| #3167 | UAT gate: the 20 F-grades were a hydration-timing artifact — the real defects are slow first paint, data-pipel | bug,lane:console,sprint:next |
| #3158 | Committed generated route map races the merge queue — PR A adds a route, PR B regenerates, main goes red | bug,lane:ci,sprint:next |
| #2581 | B-R10 follow-up: in-browser click-walk receipt for the 3 decomposed semantic-model tabs (ux-baseline G1) | lane:console,sprint:blocked |

