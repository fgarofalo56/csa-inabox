export const meta = {
  name: 'loom-unleash',
  description: 'Unleash CSA Loom: read the Fabric-parity PRPs (or AUDIT gap docs) for a wave, extract tasks, and drain each (research -> code -> review/fix -> frontend Polish -> PR). Operator merges after CI.',
  phases: [
    { title: 'Plan', detail: 'extract the wave\'s PRP/audit tasks into a backlog' },
    { title: 'Research', detail: 'Sonnet: ground each task in real Azure/MS Learn + Loom code' },
    { title: 'Build', detail: 'sequential coding agent: implement + tsc/vitest + open PR' },
    { title: 'Review', detail: 'adversarial review + one fix iteration per task' },
    { title: 'Polish', detail: 'frontend-design pass: clean up the UI of any touched surface' },
  ],
}

// ── USE: Workflow({ name:'loom-unleash', args:{ wave:1 } })  (legacy WAVES 1..5)
//        Workflow({ name:'loom-unleash', args:{ files:['docs/fiab/prp/onelake.md'], maxTasks:5 } })
//        Workflow({ name:'loom-unleash', args:{ files:['docs/fiab/prp/AUDIT-2026-06-10.md','docs/fiab/prp/AUDIT-2026-06-10-deep.md'], auditWave:6 } })
//   auditWave filters the AUDIT gap-matrix rows by their Wave column. maxTasks (default 0 = all).
const REPO = '/e/Repos/GitHub/csa-inabox'
const COAUTHOR = 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
const HB = `${REPO}/.claude/loom-autopilot.heartbeat`
const WAVES = {
  1: ['docs/fiab/prp/data-engineering.md', 'docs/fiab/prp/data-factory.md'],
  2: ['docs/fiab/prp/real-time-intelligence.md'],
  3: ['docs/fiab/prp/data-science.md'],
  4: ['docs/fiab/prp/governance-security.md', 'docs/fiab/prp/data-marketplace.md'],
  5: ['docs/fiab/prp/onelake.md', 'docs/fiab/prp/data-warehouse.md', 'docs/fiab/prp/power-bi.md', 'docs/fiab/prp/databases.md', 'docs/fiab/prp/copilot-ai.md', 'docs/fiab/prp/platform.md'],
}
const auditWave = (args && args.auditWave) || 0
const files = (args && Array.isArray(args.files) && args.files.length) ? args.files : WAVES[(args && args.wave) || 1]
const maxTasks = (args && args.maxTasks) || 0

const researchPrompt = (t) => `READ-ONLY research for ONE CSA Loom parity task. Repo ${REPO}.\nTASK: ${t.title}\nGOAL:\n${t.goal}\nFILES: ${t.files || '(decide)'}\n` +
  `Ground in the REAL Azure/Fabric behavior (microsoft_docs_search/fetch via ToolSearch) AND the existing Loom code paths this touches (Grep/Read apps/fiab-console/**, platform/fiab/bicep/**). Quote real symbols. Output a concrete build plan + the per-cloud (Commercial/GCC/GCC-High/IL5) note. Honor: no-vaporware, no-fabric-dependency (Azure-native default), loom-no-freeform-config, ui-parity, bicep+bootstrap sync.`
const buildPrompt = (t, plan) => `Coding agent: implement ONE CSA Loom parity task end-to-end and open a PR. Repo ${REPO}.\nTASK: ${t.title}\nGOAL:\n${t.goal}\nVERIFY:\n${t.verify || 'cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json (ignore makeStyles px noise); vitest on touched tests'}\nPLAN:\n${plan}\n\n` +
  `LIVENESS HEARTBEAT: run \`date +%s > ${HB}\` at the start and again after you push — so the crash-resume watchdog knows this run is alive.\n` +
  `STRICT dev loop (shared tree): 1) cd ${REPO} && rm -f .git/index.lock && git fetch -q origin && git checkout -q -B ${(t.id || 'task').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-')} origin/main 2) implement with Edit/Write (real backends / honest Fluent gates — NO mocks/return[]/placeholders/dead controls; dropdowns/wizards not raw JSON; Azure-native default works with LOOM_DEFAULT_FABRIC_WORKSPACE unset; sync bicep + bootstrap in this task). 3) VERIFY: tsc filtered of makeStyles px noise — touched files clean; run vitest on any test you add. Iterate until clean. 4) NEVER pnpm/npm install; NEVER git add -A (stage explicit paths). 5) commit (heredoc, trailer ${COAUTHOR}). 6) git push -u origin <branch>; gh pr create --title "<conventional>" --body "<what+why+validation; mark DO-NOT-MERGE: operator merges after CI>". 7) DO NOT merge; git checkout -q main. Final message: "PR=<number>" + one-line status (or "BLOCKED: <reason>" after leaving a clean main).`
const reviewPrompt = (t, pr) => `Adversarially review PR #${pr} for: ${t.title}. Repo ${REPO}. Run gh pr diff ${pr}. Confirm it achieves the GOAL, is no-vaporware (real backend/honest gate), no-fabric-dependency (Azure-native default works Fabric-unset), tsc-clean on touched files (ignore makeStyles px noise), and has no stubs/placeholders/dead controls.\nGOAL:\n${t.goal}\nReply exactly PASS, or FAIL + numbered concrete fixes.`
const fixPrompt = (t, pr, review) => `Fix PR #${pr} (for ${t.title}) per:\n${review}\ncd ${REPO} && rm -f .git/index.lock && git fetch -q origin && git checkout -q $(gh pr view ${pr} --json headRefName -q .headRefName) && git pull -q. Minimal fixes, re-verify (tsc filtered/vitest), stage only changed files (no git add -A; no pnpm install), commit (trailer ${COAUTHOR}), push. Do NOT merge. git checkout -q main.`
const polishPrompt = (t, pr) => `FRONTEND-DESIGN polish pass for PR #${pr} (${t.title}). Repo ${REPO}.\n` +
  `1) cd ${REPO} && rm -f .git/index.lock && git fetch -q origin && git checkout -q $(gh pr view ${pr} --json headRefName -q .headRefName) && git pull -q && date +%s > ${HB}.\n` +
  `2) Run \`gh pr diff ${pr} --name-only\`. If NO files match lib/editors/**, lib/panes/**, lib/components/**, or app/**/*.tsx -> reply "NO-UI" and stop (git checkout -q main). Otherwise polish ONLY the touched front-end surfaces.\n` +
  `3) Apply the frontend-design + loom-design-standards bar (Fluent UI v9 + Loom tokens): fix overlaps/spacing/alignment, consistent tokens + icons, real empty/loading/error states (Spinner + MessageBar), tables that are sortable/resizable/filterable with tile+list views where it fits, keyboard-navigable, modern look — NOT functional-but-plain. Do NOT remove headers/banners/controls to "clean up" (ui-parity.md): improve, don't strip. Keep every real backend call intact (no-vaporware).\n` +
  `4) VERIFY: cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json filtered of makeStyles/griffel noise — touched files clean; \`npx next build\` exit 0. NEVER pnpm install; NEVER git add -A (stage explicit paths).\n` +
  `5) commit (conventional \`style(csa-loom): polish <surface> UI\`, trailer ${COAUTHOR}), push, do NOT merge, git checkout -q main. Reply "POLISHED <surfaces>" or "NO-UI".`

phase('Plan')
const planText = await agent(
  `READ-ONLY. Read these CSA Loom PRP files in ${REPO}: ${files.join(', ')}. Extract implementable tasks into a single JSON array, in order. ` +
  (auditWave ? `IMPORTANT: include ONLY the rows whose "Wave" column equals ${auditWave} (audit-T## gap-matrix rows). ` : `Extract EVERY implementable task (their numbered task lists). `) +
  `Each element exactly: {"id": "<exp-Tn>", "title": "...", "goal": "...the full task intent + acceptance...", "files": "likely files", "verify": "how to prove it"}. For audit rows, use the Goal column as goal and the evidence/file hints as files. Output ONLY the JSON array — no prose, no code fence.`,
  { agentType: 'Explore', phase: 'Plan', label: 'plan:extract' },
)
let tasks = []
try { tasks = JSON.parse(planText.slice(planText.indexOf('['), planText.lastIndexOf(']') + 1)) } catch (e) { log(`extract parse failed: ${e}`) }
if (maxTasks > 0) tasks = tasks.slice(0, maxTasks)
log(`Extracted ${tasks.length} tasks from ${files.length} source(s)${auditWave ? ` (wave ${auditWave})` : ''}`)

const shipped = []
for (const t of tasks) {
  log(`Task ${t.id}: ${t.title}`)
  const research = await agent(researchPrompt(t), { model: 'sonnet', agentType: 'Explore', phase: 'Research', label: `research:${t.id}` })
  const build = await agent(buildPrompt(t, research), { phase: 'Build', label: `build:${t.id}` })
  const pr = (String(build).match(/PR\s*[=#:]?\s*(\d+)/i) || [])[1] || ''
  if (!pr) { shipped.push({ id: t.id, ok: false, note: String(build).slice(0, 200) }); continue }
  const review = await agent(reviewPrompt(t, pr), { phase: 'Review', label: `review:${t.id}` })
  if (/^\s*FAIL/i.test(review)) await agent(fixPrompt(t, pr, review), { phase: 'Review', label: `fix:${t.id}` })
  const polish = await agent(polishPrompt(t, pr), { phase: 'Polish', label: `polish:${t.id}` })
  shipped.push({ id: t.id, ok: true, pr, reviewPass: /^\s*PASS/i.test(review), polished: !/NO-?UI/i.test(String(polish)) })
}
log(`Wave drain: ${shipped.filter((s) => s.ok).length}/${tasks.length} PRs opened`)
return { files, tasks: tasks.length, shipped }
