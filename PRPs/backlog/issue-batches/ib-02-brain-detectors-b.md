---
name: ib-02-brain-detectors-b
status: backlog
priority: P2
order: 102
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4411, 4504, 4522, 4806, 4819]
branch: fix/ib-02-brain-detectors-b
---

# PRP: ib-02 Brain security-graph extractor fixes (batch B)

## Goal
Five open issues against the Loom Brain security-graph extractor and its committed artifact: a case-sensitivity drop in `scanFiles` (#4411), a docblock that defers to a closed issue (#4504), a false "yml under .github is out of scope" premise with no record (#4522), a missing `withCapability` authorizer node (#4806), and two wording nits (#4819). One session, one file family, one regeneration of the artifact.

## Why
The extractor feeds the Brain security lane and route-risk views. #4806 makes capability-guarded routes read as unguarded (review-sensitive, hence `review: required`). The other four are small honesty fixes in the same files, so batching them avoids five serial regenerations of `security-graph.json`.

Verified on main while writing: `scripts/brain/extract-security-graph.mjs:153` still does `predicate(rel) && visible.has(rel)` (case-sensitive); `scripts/brain/_artifact-drift.mjs:263` still says "The identity scheme is still open on #4275" (#4275 is CLOSED); `consumption.ts` lists `withCapability` in `CONSUMING_WRAPPERS` but `security-graph.json` contains 0 mentions of `withCapability`; `docs/fiab/brain/security-graph-extraction.md` has no "publication root / scan root" paragraph and no standalone-run refusal note; the `image-build-date.test.ts` comment at about line 55 is the one #4819 names.

> ASSUMPTION: #4806 is still live (the artifact has no capability authorizer node for `/api/admin/gates` and `/api/admin/readiness`). The implementer confirms with `node scripts/brain/extract-security-graph.mjs --check` before editing.

## Scope / Non-goals
In scope: the five issues. Non-goals: the positional-ordinal node identity (#4557, large, touches every sink id and the artifact shape; deferred); making the drift job a required check (#4029) or gating the console roll on it (#4807), both of which are branch-protection or roll-gate decisions (`scripts/ci/roll-gate-decision.mjs`, operator-held); the required-lane weakness (#4282, deferred). Cloud scope: tooling only, cloud-neutral; no boundary receipt applies.

## Acceptance criteria
- [ ] #4411: on a fixture repo whose on-disk directory case differs from `git ls-files` (a throwaway repo with `Scripts/` tracked as `scripts/`), `scanFiles` returns the same file count as on a case-exact checkout. Fails if the dropped-file count differs by even one (the issue measured 182 vs 187). The new fixture test must go RED with `visible.has(rel)` reverted.
- [ ] #4504: `_artifact-drift.mjs` no longer cites #4275 as the open owner of the identity scheme; it cites the issue that actually tracks it (#4557). Fails if `grep -n "still open on #4275" scripts/brain/_artifact-drift.mjs` returns a line.
- [ ] #4522: `docs/fiab/brain/security-graph-extraction.md` states that `.github` and `scripts` are publication roots, that `.yml` there is counted into `meta.skipped` and not ignored, and that drift is reasoned from adds/deletes/renames under scan roots, not from extensions. Fails if either "publication root" or "scan root" is absent from the doc.
- [ ] #4806: regenerated `security-graph.json` carries a capability authorizer node for `/api/admin/gates` and `/api/admin/readiness`; `--check` passes; the new fixtures go RED when the `withCapability` recognition is removed from the extractor. A route migrated onto `withCapability` must not lose its authorizer node.
- [ ] #4819: the `image-build-date.test.ts` comment names the Dockerfile marker test as the one that catches a dropped marker; the doc records the standalone-run refusal as intentional; the message near `artifact.ts:256` does not claim more than the marker check established. Fails if the comment still says dropping a marker breaks that test.

## Read first
- `scripts/brain/extract-security-graph.mjs` (`scanFiles`, `gitVisibleFiles`, `PUBLICATION_ROOTS`), `scripts/brain/_artifact-drift.mjs` (docblock around line 220-265)
- `apps/fiab-console/lib/brain/security/extract/{route-nodes.ts,consumption.ts,sinks.ts,artifact.ts}`
- `apps/fiab-console/lib/brain/security/extract/__tests__/image-build-date.test.ts`
- `scripts/ci/__tests__/security-graph-drift-shape.test.mjs`
- `docs/fiab/brain/security-graph-extraction.md`

## Owns
- `scripts/brain/extract-security-graph.mjs`
- `scripts/brain/_artifact-drift.mjs`
- `apps/fiab-console/lib/brain/security/extract/route-nodes.ts`
- `apps/fiab-console/lib/brain/security/extract/consumption.ts`
- `apps/fiab-console/lib/brain/security/extract/artifact.ts`
- `apps/fiab-console/lib/brain/security/extract/__tests__/image-build-date.test.ts`
- `apps/fiab-console/lib/brain/security/extract/__tests__/route-nodes-capability.test.ts` (new)
- `apps/fiab-console/lib/brain/security/extract/__generated__/security-graph.json`
- `scripts/ci/__tests__/security-graph-scan-case.test.mjs` (new)
- `scripts/ci/__tests__/security-graph-drift-shape.test.mjs`
- `docs/fiab/brain/security-graph-extraction.md`

## Must NOT touch
- `apps/fiab-console/lib/brain/{graph,detectors,agents,history,cost}/**` and `lib/brain/security/detectors/**` (owned by `ib-01-brain-detectors-a`)
- `apps/fiab-console/lib/brain/run/**`, `app/admin/brain/**`, `lib/brain-actions/**`, `.github/workflows/loom-brain-scan.yml` (owned by `PRPs/backlog/loom-brain/`)
- `.github/workflows/fiab-console-ci.yml`, `scripts/ci/roll-gate-decision.mjs` (#4029, #4807 are deferred)

## Consumes
- Nothing from other PRPs. Any other PR that adds or renames a file under a scan root (`apps/fiab-console/app/api`, `scripts`, `.github`) forces an artifact re-derive; rebase and re-run `--check` last.

## Provides
- A correct, regenerated `security-graph.json` and a documented scan-scope premise other PRs can cite.

## Steps
1. Measure first: `node scripts/brain/extract-security-graph.mjs --check` on a clean tree (record RC and file count).
2. #4411: add the fixture test (throwaway git repo, mismatched case) and make `scanFiles` compare case-insensitively on case-insensitive filesystems, or fail loudly with the dropped count; state which in the PR. Prove RED by reverting in a sandbox copy.
3. #4806: teach `route-nodes.ts` to emit the authorizer node for `withCapability(<cap>, handler)` and for any sibling wrapper in `CONSUMING_WRAPPERS` that authorizes; add a fixture per wrapper and a mutation arm that drops the recognition.
4. #4504, #4522, #4819: prose and comment fixes; the artifact does not depend on them.
5. Regenerate the artifact last, once, with the repo's documented command in the extraction doc; run `--check`.

## Validation
- `node scripts/brain/extract-security-graph.mjs --check` (RC 0)
- `node --test scripts/ci/__tests__/security-graph-scan-case.test.mjs scripts/ci/__tests__/security-graph-drift-shape.test.mjs`
- `pnpm --dir apps/fiab-console vitest run lib/brain/security/extract`
- `make validate-typescript`
- Merged is not done: this is tooling and an artifact consumed by the Brain lane. State "merged, not deployed" until the console is rolled and the risk lane shows the capability node on `/api/admin/gates`. Cloud-neutral; Commercial and GCC-High read the same artifact.

## Rollback
Revert the PR and regenerate the artifact from the reverted tree.

## Docs to update
`docs/fiab/brain/security-graph-extraction.md` (in scope above).

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-02-brain-detectors-b · Worktree: E:/Repos/_ib-02

## Hot files
`security-graph.json` is regenerated by any PR touching a scanned file; re-derive last. `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4411 | todo | | sonnet | | |
| #4504 | todo | | sonnet | | |
| #4522 | todo | | sonnet | | |
| #4806 | todo | | sonnet | | |
| #4819 | todo | | sonnet | | |

Deferred candidates: #4557 (positional ordinal identity, large, artifact-shape change), #4029 (make drift gate a required context, branch protection, operator-held), #4807 (roll gate on artifact drift, `scripts/ci/roll-gate-decision.mjs`), #4282 (required lane compares three integers; overlaps #4557).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-02-brain-detectors-b.md, scripts/brain/extract-security-graph.mjs and docs/fiab/brain/security-graph-extraction.md. Worktree E:/Repos/_ib-02, branch fix/ib-02-brain-detectors-b. Run `node scripts/brain/extract-security-graph.mjs --check` first and record the result. Do #4411 and #4806 with RED-first fixtures proven on a sandbox copy, then the three prose fixes, then regenerate security-graph.json once at the end. Do not touch lib/brain/{graph,detectors,agents,history} or lib/brain/run. Proof of done: the three validation commands in section 11 all exit 0; open the PR for review (review: required).
