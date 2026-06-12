export const meta = {
  name: 'loom-integrate-open-prs',
  description: 'FAST BATCHED integration of open csa-loom feature PRs. Serial git writes (no .git/index.lock contention), but no per-PR remote-CI wait: admin-merge after a fast local tsc, with the full `next build` batched every N PRs + once at the end. Self-heals tsc/build breaks by attributing to the just-merged PR (fix-forward or revert+flag). Replaces the old serial-per-PR loop that paid ~4.5min of GitHub CI on every PR.',
  phases: [
    { title: 'Survey', detail: 'discover open feature PRs + sort by mergeability (read-only)' },
    { title: 'Integrate', detail: 'serial batches: admin-merge + per-PR tsc, no CI wait' },
    { title: 'Verify', detail: 'final combined next build on main; report' },
  ],
}

// ── USE:
//   Workflow({ name:'loom-integrate-open-prs' })                      // discover all open csa-loom PRs
//   Workflow({ name:'loom-integrate-open-prs', args:{ prs:[1033,1034,...] } })  // explicit list (watchdog path)
//   Workflow({ name:'loom-integrate-open-prs', args:{ batch:8, build:'batch' } })
//
// WHY BATCHED IS FAST: the old path admin-merged each PR but still polled that PR's
// remote CI to green first (~4.5 min) and ran a full `next build` per PR. With 63 PRs
// that's ~8 h, almost all of it waiting. Here: admin-merge bypasses required checks,
// we validate LOCALLY (tsc ~40s/PR — same type errors CI would catch) and run the slow
// `next build` only at batch boundaries + once at the end (the TDZ/runtime net). Serial
// across PRs keeps a single git writer, so no index.lock races.
//
// SAFETY TRADE (operator-approved 'Batched'): a bad PR can briefly land on main (which
// auto-rolls the live console) before the batch-boundary build catches it. Mitigated by
// per-PR tsc + batch build + bisect-on-break. Never narrows safety below tsc.

const REPO = '/e/Repos/GitHub/csa-inabox'
const COAUTHOR = 'Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
const BATCH = (args && Number(args.batch)) || 8
const BUILD_MODE = (args && args.build) || 'batch' // 'batch' | 'final' | 'each'

const PR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prs'],
  properties: {
    prs: {
      type: 'array',
      description: 'Open csa-loom feature PR numbers, ordered cleanly-mergeable-first then by number ascending',
      items: { type: 'integer' },
    },
  },
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }

// ── Survey (read-only): find the work, order it so clean merges go first.
phase('Survey')
let prs = (args && Array.isArray(args.prs) && args.prs.length) ? args.prs.slice() : null
if (!prs) {
  const survey = await agent(
    `READ-ONLY survey. cd ${REPO} && git fetch -q origin.\n` +
    `Run: gh pr list --state open --limit 200 --json number,title,headRefName,mergeable,isDraft.\n` +
    `Keep ONLY feature PRs whose title matches feat(csa-loom)/fix(csa-loom)/docs(csa-loom). EXCLUDE dependabot, EXCLUDE the release-please PR (title "chore(main): release csa-inabox …"), EXCLUDE drafts.\n` +
    `Return them ordered: MERGEABLE=="MERGEABLE" first, then the rest, each group ascending by number. Numbers only.`,
    { model: 'fable', phase: 'Survey', label: 'survey:open-prs', schema: PR_SCHEMA },
  )
  prs = (survey && survey.prs) || []
}
log(`Integrating ${prs.length} PR(s): ${prs.join(', ')}`)
if (!prs.length) { log('Nothing to integrate.'); return { merged: [], flagged: [], prs: 0 } }

const batchPrompt = (group, idx, total) =>
  `SERIAL fast-integrator, batch ${idx + 1}/${total}. Repo ${REPO}. You are the ONLY git writer right now — still, before each git op run \`rm -f ${REPO}/.git/index.lock\`. PRs IN THIS BATCH (in order): ${group.join(', ')}.\n\n` +
  `Start clean: cd ${REPO} && rm -f .git/index.lock && git fetch -q origin && git checkout -q main && git reset -q --hard origin/main.\n\n` +
  `LIVENESS HEARTBEAT: run \`date +%s > ${REPO}/.claude/loom-autopilot.heartbeat\` NOW and again after EVERY PR you process (so the crash-resume watchdog can tell this run is alive and never spawns a competing integrator).\n\n` +
  `FOR EACH PR n in the batch, in order:\n` +
  ` 1. Check it's still open & mergeable: gh pr view n --json state,mergeable,headRefName. If already MERGED/closed → skip. \n` +
  ` 2. If mergeable: \`gh pr merge n --squash --admin --delete-branch\`  ← NO CI WAIT (admin bypasses required checks). Do NOT poll the remote run.\n` +
  `    If it reports a MERGE CONFLICT: checkout the head branch, \`git rebase origin/main\` (or merge main), resolve conflicts KEEPING BOTH feature sets (never drop code), \`git push --force-with-lease\`, then retry the admin merge. If irreconcilable after one honest attempt → record it as flagged, \`git checkout -q main\`, move to the next PR (do not block the batch).\n` +
  ` 3. After a successful merge: git fetch -q origin && git checkout -q main && git reset -q --hard origin/main.\n` +
  ` 4. FAST LOCAL GATE: cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -vE "makeStyles|griffel|\\.css" | grep -E "error TS" | head -40. If touched-file type errors appear, the PR you JUST merged is the culprit → fix-forward on main: make the minimal correction, stage ONLY the changed files (NEVER git add -A; NEVER pnpm/npm install), commit (heredoc, conventional \`fix(csa-loom): …\`, trailer ${COAUTHOR}), git push origin main. Re-run tsc until clean. If you cannot fix in ~2 tries → \`git revert\` the squash merge commit, push, record the PR as flagged(reverted).\n\n` +
  (BUILD_MODE === 'each'
    ? `AFTER EACH PR also run the full build gate below.\n\n`
    : ``) +
  `END OF BATCH — BUILD GATE${BUILD_MODE === 'final' ? ' (SKIP unless this is the last batch)' : ''}: cd ${REPO}/apps/fiab-console && npx next build 2>&1 | tail -25. This is the TDZ/runtime net tsc can't give (use-before-init, bad imports). If it FAILS: the break is in one of THIS batch's just-merged PRs — read the error, fix-forward on main with a minimal \`fix(csa-loom): …\` commit (stage explicit paths, trailer ${COAUTHOR}, push). If you can't pin it to one fix, bisect by reverting the batch's merges newest-first until build is green; record reverted PRs as flagged. NEVER leave main red.\n\n` +
  `GUARDRAILS: conventional commits only; trailer ${COAUTHOR}; never \`git add -A\`; never pnpm/npm install in this shared tree; merges via --admin after the LOCAL gate (not remote CI). Leave the tree on a clean \`main\` == origin/main.\n` +
  `FINAL MESSAGE (exact): \`MERGED=[n,n,...] FLAGGED=[{pr,reason}]\` then one status line.`

phase('Integrate')
const batches = chunk(prs, BATCH)
const merged = []
const flagged = []
for (let i = 0; i < batches.length; i++) {
  const res = await agent(batchPrompt(batches[i], i, batches.length), { model: 'fable', phase: 'Integrate', label: `batch:${i + 1}/${batches.length}` })
  const m = String(res).match(/MERGED=\[([^\]]*)\]/)
  const f = String(res).match(/FLAGGED=\[([^\]]*)\]/)
  if (m && m[1].trim()) merged.push(...m[1].split(/[,\s]+/).filter(Boolean))
  if (f && f[1].trim()) flagged.push(f[1])
  log(`Batch ${i + 1}/${batches.length} done — merged so far: ${merged.length}${flagged.length ? `, flagged: ${flagged.length}` : ''}`)
}

// ── Final combined build (always — the cumulative-state net), even if per-batch built.
phase('Verify')
const verify = await agent(
  `Final integration verify. cd ${REPO} && rm -f .git/index.lock && git fetch -q origin && git checkout -q main && git reset -q --hard origin/main.\n` +
  `Run: cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "makeStyles|griffel" | head; then npx next build 2>&1 | tail -20.\n` +
  `If anything is red, fix-forward on main with a minimal \`fix(csa-loom): …\` commit (explicit paths, trailer ${COAUTHOR}, push) until BOTH are green. Then report: tsc clean? build clean? head SHA. Reply with a 3-line status.`,
  { model: 'fable', phase: 'Verify', label: 'verify:final-build' },
)
log(`Final verify: ${String(verify).slice(0, 200)}`)
return { prs: prs.length, merged, flagged, verify: String(verify).slice(0, 400) }
