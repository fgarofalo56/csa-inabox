export const meta = {
  name: 'loom-backlog-drain',
  description: 'Reusable CSA Loom coding drain: research -> implement -> review/fix -> open a PR per backlog item. Pass items via args to add/refactor.',
  phases: [
    { title: 'Research', detail: 'Sonnet read-only: ground a build plan per item in the real code + MS Learn' },
    { title: 'Build', detail: 'sequential coding agent: implement + tsc/vitest + open PR' },
    { title: 'Review', detail: 'adversarial review + one fix iteration per item' },
  ],
}

// ───────────────────────────────────────────────────────────────────────────
// HOW TO USE (later / for new requests):
//   Workflow({ name: 'loom-backlog-drain', args: { backlog: [
//     { id:'my-feature', title:'…', goal:'…what to build, exactly…',
//       files:'paths to create/edit', research:'what to read to ground it',
//       verify:'how to prove it works (tsc/vitest/grep)' }, … ] } })
//   - args.backlog (or a bare array) overrides DEFAULT_BACKLOG.
//   - Each item flows research(Sonnet) → build(opens a PR) → review(+fix).
//   - The operator MERGES the PRs after CI; agents never merge.
// ───────────────────────────────────────────────────────────────────────────

const REPO = '/e/Repos/GitHub/csa-inabox'
const COAUTHOR = 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'

// Edit this default set as the standing backlog, or override via args.
const DEFAULT_BACKLOG = [
  {
    id: 'snowflake-mirror-source',
    title: 'Mirror: Snowflake source (Azure-native snapshot via a Loom Connection)',
    goal: 'Extend lib/azure/mirror-engine.ts so a Snowflake mirror source snapshots to ADLS Bronze CSV like the SQL/PG/Cosmos families: enumerate tables + read rows via a Key-Vault-backed Loom Connection (connection-string/credentials), reusing the connections-store + kv-secrets-client. If no Snowflake driver/path is available, implement an honest gate (no mock) naming the exact connection/driver requirement, and wire the create wizard source card. Keep ongoing CDC a disclosed follow-up.',
    files: 'apps/fiab-console/lib/azure/mirror-engine.ts, lib/azure/* (any new snowflake read helper), app/api/items/mirrored-database/source-tables/route.ts, docs/fiab/workloads/mirrored-database.md',
    research: 'Read lib/azure/mirror-engine.ts (family dispatch + writeCsvSnapshot), lib/azure/connections-store.ts + kv-secrets-client.ts (how creds are stored/loaded), and check package.json for any snowflake driver. Decide real-read vs honest-gate.',
    verify: 'cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json filtering pre-existing makeStyles px noise; touched files clean.',
  },
]

const BACKLOG =
  (args && Array.isArray(args.backlog) && args.backlog.length) ? args.backlog
  : (Array.isArray(args) && args.length) ? args
  : DEFAULT_BACKLOG

const PLAN_SCHEMA = {
  type: 'object', required: ['summary', 'steps', 'files'],
  properties: {
    summary: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    keyFindings: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}
const BUILD_SCHEMA = {
  type: 'object', required: ['ok', 'note'],
  properties: {
    ok: { type: 'boolean' }, prNumber: { type: 'string' }, branch: { type: 'string' },
    tscClean: { type: 'boolean' }, testsRun: { type: 'string' }, note: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', required: ['pass', 'issues'],
  properties: { pass: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
}

function researchPrompt(item) {
  return `READ-ONLY research for ONE CSA Loom backlog item. Repo ${REPO}.\n` +
    `Item: ${item.title}\nGOAL:\n${item.goal}\nFILES (intended): ${item.files || '(decide)'}\nRESEARCH: ${item.research || 'read the relevant editors/routes/clients + docs; ground in MS Learn where external'}\n\n` +
    `Quote REAL symbols (functions/routes/env) — never invent. Produce a concrete build-ready plan. Honor repo rules: no-vaporware (real backend or honest gate, no mocks), no-fabric-dependency (Azure-native default), loom-no-freeform-config, loom-design-standards.`
}
function fallbackPlan(item) {
  return { summary: item.goal, steps: ['Implement per GOAL', 'Verify per VERIFY', 'Open PR'], files: (item.files || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean), keyFindings: [], risks: ['auto-fallback plan (research returned nothing)'], confidence: 'low' }
}
function buildPrompt(item, plan) {
  return `Coding agent: implement ONE CSA Loom backlog item end-to-end and open a PR. Repo ${REPO}.\n\n` +
    `ITEM: ${item.title}\nGOAL:\n${item.goal}\nVERIFY:\n${item.verify || 'cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json (ignore makeStyles px noise)'}\n\n` +
    `PLAN:\n${JSON.stringify(plan, null, 2)}\n\n` +
    `STRICT dev loop (shared tree):\n` +
    `1. cd ${REPO} && rm -f .git/index.lock && git checkout -q main && git pull -q origin main && git checkout -q -b <short-kebab-branch>\n` +
    `2. Implement with Edit/Write, matching surrounding style. Real backends or honest Fluent MessageBar gates — NO mocks / return [] / placeholders.\n` +
    `3. Verify per VERIFY. tsc: cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" — IGNORE pre-existing makeStyles px noise ("Type '<number>' is not assignable" / GriffelStyles). Touched files must be clean. Run vitest on any test you add/change. Iterate until clean.\n` +
    `4. NEVER pnpm/npm install (corrupts the shared node_modules). NEVER git add -A — stage ONLY the files you changed.\n` +
    `5. Commit (heredoc) ending with: ${COAUTHOR}\n` +
    `6. git push -q -u origin <branch> ; gh pr create --title "<conventional>" --body "<what+why+validation+rules>". Capture the PR number.\n` +
    `7. DO NOT merge. git checkout -q main (leave a clean tree). Return ok=true + prNumber only if a PR was opened; else ok=false + note (still leave clean main: git checkout -- . ; git checkout main).`
}
function reviewPrompt(item, build) {
  return `Adversarially review PR #${build.prNumber || '(unknown)'} (branch ${build.branch || '?'}) for: ${item.title}. Repo ${REPO}.\n` +
    `Run gh pr diff ${build.prNumber || ''}. Check it achieves the GOAL, is no-vaporware (real backend/honest gate), no-fabric-dependency (Azure-native default), and tsc-clean on touched files (ignore makeStyles px noise).\nGOAL:\n${item.goal}\n\nReturn pass=true only if correct+compliant+clean; else concrete minimal issues.`
}
function fixPrompt(item, build, review) {
  return `Fix PR #${build.prNumber} (branch ${build.branch}) for ${item.title}. Repo ${REPO}.\nISSUES:\n${(review.issues || []).map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n` +
    `cd ${REPO} && rm -f .git/index.lock && git checkout -q ${build.branch} && git pull -q origin ${build.branch}. Minimal fixes, re-verify, stage only changed files (no git add -A; no pnpm install), commit (trailer ${COAUTHOR}), push. Do NOT merge. git checkout -q main. Return ok+note.`
}

phase('Research')
const plans = await parallel(BACKLOG.map((item) => () =>
  agent(researchPrompt(item), { label: `research:${item.id}`, phase: 'Research', model: 'sonnet', agentType: 'Explore', schema: PLAN_SCHEMA })
))
// Robust: items whose research returned nothing still build with a fallback plan.
const planned = BACKLOG.map((item, i) => ({ item, plan: plans[i] || fallbackPlan(item) }))

const shipped = []
for (const { item, plan } of planned) {
  log(`Building ${item.id}`)
  const build = await agent(buildPrompt(item, plan), { label: `build:${item.id}`, phase: 'Build', schema: BUILD_SCHEMA })
  if (!build || !build.ok || !build.prNumber) { shipped.push({ item: item.id, ok: false, note: build?.note || 'no PR opened' }); continue }
  const review = await agent(reviewPrompt(item, build), { label: `review:${item.id}`, phase: 'Review', schema: REVIEW_SCHEMA })
  let fixed = false
  if (review && !review.pass && (review.issues || []).length) { await agent(fixPrompt(item, build, review), { label: `fix:${item.id}`, phase: 'Review' }); fixed = true }
  shipped.push({ item: item.id, ok: true, pr: build.prNumber, branch: build.branch, reviewPass: review?.pass ?? null, fixed })
}
log(`Drain complete: ${shipped.filter((s) => s.ok).length}/${BACKLOG.length} PRs opened`)
return { shipped }
