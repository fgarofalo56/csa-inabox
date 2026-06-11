export const meta = {
  name: 'loom-unleash-fast',
  description: 'FAST CSA Loom wave builder. Parallel research (all tasks at once), then build the wave in ISOLATED git worktrees ~N at a time (no shared-tree collisions), tsc-only per task (NO per-task next build — the integration phase runs ONE batched next build), then per-task review + frontend Polish. ~3-4x faster than the serial loom-unleash. ALL agents pinned to model opus (session-model inheritance broke once: claude-fable-5[1m] is rejected by the subagent endpoint).',
  phases: [
    { title: 'Plan', detail: 'extract the wave/audit tasks' },
    { title: 'Research', detail: 'parallel: ground every task at once (read-only)' },
    { title: 'Build', detail: 'fan out ~N isolated worktrees; tsc-only; open PR' },
    { title: 'Polish', detail: 'per-task review + frontend-design polish' },
  ],
}

// USE: Workflow({ scriptPath:'...loom-unleash-fast.js', args:{ files:['docs/fiab/prp/AUDIT-2026-06-10.md','docs/fiab/prp/AUDIT-2026-06-10-deep.md'], auditWave:4, fanout:5, exclude:['audit-T34'] } })
const REPO = '/e/Repos/GitHub/csa-inabox'
const REPO_WIN = 'E:\\Repos\\GitHub\\csa-inabox'
const COAUTHOR = 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
const HB = `${REPO}/.claude/loom-autopilot.heartbeat`
const auditWave = (args && args.auditWave) || 0
const files = (args && Array.isArray(args.files) && args.files.length) ? args.files : ['docs/fiab/prp/AUDIT-2026-06-10.md', 'docs/fiab/prp/AUDIT-2026-06-10-deep.md']
const maxTasks = (args && args.maxTasks) || 0
const FANOUT = (args && Number(args.fanout)) || 5
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o }
const rng = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push('audit-t' + i); return o }
const WAVE_IDS = { 4: ['audit-t29','audit-t30','audit-t36'], 5: ['audit-t31','audit-t32','audit-t33','audit-t35'], 6: rng(37,43), 7: rng(44,49), 8: rng(50,87), 9: rng(88,105), 10: rng(106,123), 11: rng(124,146) }

const researchPrompt = (t) => `READ-ONLY research for ONE CSA Loom parity task. Repo ${REPO}.\nTASK: ${t.title}\nGOAL:\n${t.goal}\nFILES: ${t.files || '(decide)'}\n` +
  `Ground in REAL Azure/Fabric behavior (microsoft_docs_search via ToolSearch) + the existing Loom code this touches (Grep/Read apps/fiab-console/**, platform/fiab/bicep/**). Quote real symbols. Output a concrete build plan + per-cloud note. Honor no-vaporware, no-fabric-dependency (Azure-native default), loom-no-freeform-config, ui-parity, bicep+bootstrap sync.`

const buildPrompt = (t, plan) => `Coding agent in an ISOLATED GIT WORKTREE (your own working dir — you run CONCURRENTLY with sibling build agents, so you must NOT touch the main checkout). Implement ONE CSA Loom task end-to-end and open a PR.\nTASK: ${t.title}\nGOAL:\n${t.goal}\nPLAN:\n${plan}\n\n` +
  `SETUP (make tsc work without installing — NEVER pnpm/npm install, it corrupts the shared store):\n` +
  ` 1. You are at the worktree root. Create a junction to the main repo's node_modules so tsc resolves: \`cmd //c "mklink /J apps\\fiab-console\\node_modules ${REPO_WIN}\\apps\\fiab-console\\node_modules"\` (if it errors or exists, continue). If a root-level node_modules is needed too, junction \`${REPO_WIN}\\node_modules\` likewise.\n` +
  ` 2. git fetch -q origin && git checkout -q -B ${(t.id || 'task').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-')} origin/main\n` +
  ` 3. date +%s > ${HB}\n` +
  `IMPLEMENT with Edit/Write: real backends / honest Fluent gates — NO mocks/return[]/placeholders/dead controls; dropdowns/wizards not raw JSON; Azure-native default works with LOOM_DEFAULT_FABRIC_WORKSPACE unset; sync bicep + bootstrap in this task.\n` +
  `VERIFY tsc ONLY: cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "makeStyles|griffel" — the files YOU touched must be clean (a ~185-error pre-existing backlog exists elsewhere; ignore it). DO NOT run \`next build\` — the integration phase runs ONE batched next build as the runtime gate. If junction failed so tsc can't run, proceed anyway (integration will catch it).\n` +
  `NEVER git add -A (stage explicit paths). Commit (heredoc, trailer ${COAUTHOR}). git push -u origin <branch>. gh pr create --title "<conventional>" --body "<what+why+validation; DO-NOT-MERGE: operator merges after CI>". DO NOT merge. date +%s > ${HB}.\n` +
  `FINAL MESSAGE: "PR=<number>" (or "BLOCKED: <reason>").`

const reviewPrompt = (t, pr) => `Adversarially review PR #${pr} for: ${t.title}. Repo ${REPO}. Run gh pr diff ${pr}. Confirm it achieves the GOAL, is no-vaporware (real backend/honest gate), no-fabric-dependency (Azure-native default works Fabric-unset), and has no stubs/placeholders/dead controls.\nGOAL:\n${t.goal}\nReply exactly PASS, or FAIL + numbered concrete fixes.`

const polishPrompt = (t, pr, review) => `Work in an ISOLATED GIT WORKTREE (concurrent with siblings). For PR #${pr} (${t.title}):\n` +
  ` 1. \`cmd //c "mklink /J apps\\fiab-console\\node_modules ${REPO_WIN}\\apps\\fiab-console\\node_modules"\` (ignore if exists/fails).\n` +
  ` 2. headRef=$(gh pr view ${pr} --json headRefName -q .headRefName); git fetch -q origin "$headRef"; git checkout -q -B "$headRef" origin/"$headRef"; date +%s > ${HB}.\n` +
  (/^\s*FAIL/i.test(String(review || '')) ? ` 3a. FIRST apply these review fixes:\n${review}\n` : '') +
  ` 3. Run \`gh pr diff ${pr} --name-only\`. If NO files match lib/editors|lib/panes|lib/components|app/**/*.tsx AND there were no review fixes -> reply "NO-UI" and stop. Else polish ONLY touched front-end surfaces to the frontend-design + loom-design-standards bar (Fluent v9 + Loom tokens; fix overlaps/spacing/alignment; real empty/loading/error states; sortable/filterable tables + tile/list where it fits; keyboard-nav; modern, NOT plain). Do NOT strip headers/controls (ui-parity) — improve. Keep every real backend call (no-vaporware).\n` +
  ` 4. VERIFY tsc ONLY (filtered makeStyles/griffel) — touched files clean. NO next build. NEVER pnpm install; NEVER git add -A.\n` +
  ` 5. Commit (\`style(csa-loom): polish <surface>\` or \`fix(csa-loom): review fixes for <t>\`, trailer ${COAUTHOR}), push. DO NOT merge. date +%s > ${HB}. Reply "DONE #${pr}".`

phase('Plan')
const planText = await agent(
  `READ-ONLY. Read these CSA Loom files in ${REPO}: ${files.join(', ')}. Extract implementable tasks into a single JSON array. ` +
  (auditWave ? `Include ONLY rows/tasks assigned to Wave ${auditWave} (use the Wave column where present, else the "Suggested Build Waves" wave lists). ` : `Extract EVERY implementable task. `) +
  `Each: {"id":"<audit-Tn>","title":"...","goal":"...full intent + acceptance...","files":"likely files","verify":"how to prove it"}. For audit rows use the Goal column as goal + evidence/file hints as files. Output ONLY the JSON array.`,
  { model: 'opus', agentType: 'Explore', phase: 'Plan', label: 'plan:extract' },
)
let tasks = []
try { tasks = JSON.parse(planText.slice(planText.indexOf('['), planText.lastIndexOf(']') + 1)) } catch (e) { log(`parse failed: ${e}`) }
if (maxTasks > 0) tasks = tasks.slice(0, maxTasks)
const excludeIds = ((args && args.exclude) || []).map((s) => String(s).toLowerCase())
if (excludeIds.length) tasks = tasks.filter((t) => !excludeIds.includes(String(t.id || '').toLowerCase()))
const onlyIds = ((args && args.taskIds && args.taskIds.length) ? args.taskIds : (WAVE_IDS[auditWave] || [])).map((s) => String(s).toLowerCase())
if (onlyIds.length) tasks = tasks.filter((t) => onlyIds.includes(String(t.id || '').toLowerCase()))
log(`Wave ${auditWave || '?'}: ${tasks.length} tasks, fanout ${FANOUT}${onlyIds.length ? `, ids=${onlyIds.join(',')}` : ''}${excludeIds.length ? `, excluded ${excludeIds.join(',')}` : ''}`)
if (!tasks.length) return { tasks: 0, shipped: [] }

phase('Research')
const plans = await parallel(tasks.map((t) => () => agent(researchPrompt(t), { model: 'opus', agentType: 'Explore', phase: 'Research', label: `research:${t.id}` })))

phase('Build')
const shipped = []
const batches = chunk(tasks.map((t, i) => ({ t, plan: plans[i] })), FANOUT)
for (let b = 0; b < batches.length; b++) {
  log(`Build batch ${b + 1}/${batches.length} (${batches[b].length} concurrent worktrees)`)
  const res = await parallel(batches[b].map(({ t, plan }) => async () => {
    const build = await agent(buildPrompt(t, plan || '(research unavailable; decide)'), { model: 'opus', isolation: 'worktree', phase: 'Build', label: `build:${t.id}` })
    const pr = (String(build).match(/PR\s*[=#:]?\s*(\d+)/i) || [])[1] || ''
    if (!pr) return { id: t.id, ok: false, note: String(build).slice(0, 160) }
    const review = await agent(reviewPrompt(t, pr), { model: 'opus', phase: 'Polish', label: `review:${t.id}` })
    const polish = await agent(polishPrompt(t, pr, review), { model: 'opus', isolation: 'worktree', phase: 'Polish', label: `polish:${t.id}` })
    return { id: t.id, ok: true, pr, reviewPass: /^\s*PASS/i.test(review), polished: !/NO-?UI/i.test(String(polish)) }
  }))
  shipped.push(...res.filter(Boolean))
}
log(`Wave drain: ${shipped.filter((s) => s.ok).length}/${tasks.length} PRs opened`)
return { wave: auditWave, tasks: tasks.length, shipped }
