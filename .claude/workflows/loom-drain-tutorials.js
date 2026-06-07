export const meta = {
  name: 'loom-drain-tutorials',
  description: 'Example docs-drain: rewrite CSA Loom tutorials 02-08 to the real shipped product (research -> build -> review/fix -> PR). Template for any docs-rewrite drain.',
  phases: [
    { title: 'Research', detail: 'Sonnet read-only: ground each tutorial in the real editors/nav' },
    { title: 'Build', detail: 'rewrite docs/fiab/tutorials/02..08, verify no fake CLIs, open PR' },
    { title: 'Review', detail: 'adversarial check + one fix iteration' },
  ],
}

// Reusable example: a single-target docs-rewrite drain. Copy + adapt the prompts
// for other doc sets. Research is PLAIN TEXT (no schema) so it cannot fail the
// structured-output call. Operator merges the PR after CI.
const REPO = '/e/Repos/GitHub/csa-inabox'
const COAUTHOR = 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'

phase('Research')
const plan = await agent(
  `READ-ONLY. Ground a rewrite of CSA Loom tutorials 02-08 in the REAL shipped product. Repo ${REPO}.\n` +
  `Read: apps/fiab-console/lib/components/left-nav.tsx, app/workspaces/[id]/page.tsx + app/workspaces/page.tsx, the real editors (lakehouse, notebook, warehouse, phase3 activator, phase4 data-agent, mirrored-database), docs/fiab/workloads/*.md, and each docs/fiab/tutorials/02..08-*.md.\n` +
  `Produce a per-tutorial rewrite plan: the REAL step sequence for each + the exact fake things to remove (loom-dl-shim/loom-semantic-model/loom-mirroring/loom-marketplace/fiab-migrate CLIs, per-workspace "panes", POST /api/agent/<id>/chat, the "Databricks Job" activator action) with their real replacements.`,
  { model: 'sonnet', agentType: 'Explore', phase: 'Research', label: 'research:tutorials' },
)

phase('Build')
const build = await agent(
  `Rewrite CSA Loom tutorials 02-08 to the REAL product, then open a PR. Repo ${REPO}.\nPLAN:\n${plan}\n\n` +
  `Rewrite the BODY of docs/fiab/tutorials/02-first-lakehouse.md,03-direct-lake-parity.md,04-activator-rules.md,05-data-agent.md,06-mirroring-cosmos.md,07-marketplace-data-product.md,08-forward-migrate-to-fabric.md so every step maps to a real surface (top-level nav + flat workspace item tree + "+ New item" editors; NO panes). Remove all non-existent CLIs (replace with real UI: 03->Weave Build-a-Power-BI-model; 06->Mirrored database item wizard+Start+Weave; 07->API marketplace+Unified catalog+Weave Publish-as-an-API; 08->mark roadmap). 04: real activator actions only (no Databricks Job; no Firings/History/Export). 05: no POST /api/agent — editor Test tab + Foundry publish. Remove the temporary accuracy banners once each body is correct.\n` +
  `Dev loop: cd ${REPO} && rm -f .git/index.lock && git checkout -q main && git pull -q origin main && git checkout -q -b docs-tutorials-real-rewrite ; edit the 7 files (docs only, no pnpm install) ; VERIFY grep across docs/fiab/tutorials/0[2-8]*.md for loom-dl-shim,loom-semantic-model,loom-mirroring,loom-marketplace,fiab-migrate,'/api/agent/','left rail','Databricks Job' = ZERO ; stage ONLY those 7 files (no git add -A) ; commit (trailer ${COAUTHOR}) ; git push -u origin docs-tutorials-real-rewrite ; gh pr create. DO NOT merge ; git checkout -q main. Return: PR=<number> + status (or BLOCKED: <reason>).`,
  { phase: 'Build', label: 'build:tutorials' },
)

phase('Review')
const prNum = (build.match(/PR\s*[=#:]?\s*(\d+)/i) || [])[1] || ''
const review = await agent(
  `Review tutorials PR #${prNum || '(gh pr list --head docs-tutorials-real-rewrite)'} in ${REPO} via gh pr diff. Confirm: real-surface steps, ZERO fake-CLI/'/api/agent'/'left rail'/'Databricks Job' refs in tutorials 02-08, banners removed, self-consistent. Reply exactly PASS, or FAIL + numbered fixes.`,
  { phase: 'Review', label: 'review:tutorials' },
)
if (/^\s*FAIL/i.test(review)) {
  await agent(
    `Fix tutorials PR #${prNum} (branch docs-tutorials-real-rewrite) in ${REPO} per:\n${review}\ncd ${REPO} && rm -f .git/index.lock && git checkout -q docs-tutorials-real-rewrite && git pull. Minimal fixes, re-verify grep clean, stage only changed files (no git add -A), commit (trailer ${COAUTHOR}), push. Do NOT merge. git checkout -q main.`,
    { phase: 'Review', label: 'fix:tutorials' },
  )
}
return { pr: prNum, reviewPass: /^\s*PASS/i.test(review), build }
