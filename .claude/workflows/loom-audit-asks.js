export const meta = {
  name: 'loom-audit-asks',
  description: 'Comprehensive reconciliation audit: everything the operator has ASKED for (Atlas recall + memory + PRDs/PRPs/specs) vs what was DELIVERED (git history + merged PRs + live code/portal surfaces) vs UI QUALITY. Produces a grounded gap matrix + remaining backlog (incl. UI-polish items) and writes it to docs/fiab/prp/AUDIT-2026-06-10.md.',
  phases: [
    { title: 'Gather', detail: 'parallel readers: asks (atlas+memory+PRP), delivered (git+PRs), surfaces, UI quality, docs-vs-built' },
    { title: 'Synthesize', detail: 'merge into one gap matrix + backlog JSON + write the audit doc' },
  ],
}

// HARNESS QUIRK: some sessions deliver `args` as a JSON-encoded STRING (confirmed
// by zero-agent probe 2026-06-12) — which made args.* undefined and caused the
// 115-task unscoped rebuild. Coerce before any use.
if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { log('args parse failed: ' + e) } }

// USE: Workflow({ name:'loom-audit-asks' })  — read-only except the final audit doc write.
const REPO = '/e/Repos/GitHub/csa-inabox'

const GAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['backlog', 'uiPolish', 'summary'],
  properties: {
    summary: { type: 'string', description: '4-6 sentence executive summary: how much of what was asked is actually shipped vs missing/partial, and the biggest gaps.' },
    backlog: {
      type: 'array',
      description: 'Every remaining/missing/partial capability the operator asked for that is NOT fully shipped+live.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'experience', 'status', 'evidence', 'goal', 'wave'],
        properties: {
          id: { type: 'string', description: 'stable slug, e.g. audit-T01' },
          title: { type: 'string' },
          experience: { type: 'string', description: 'which Loom experience/area (e.g. lakehouse, copilot, data-factory, governance, platform, marketing-studio, weave)' },
          status: { type: 'string', enum: ['missing', 'partial', 'stub', 'ui-only', 'regressed'] },
          evidence: { type: 'string', description: 'what was found: the ask source (atlas/memory/PRP quote) + the delivered state (file/PR or absence).' },
          goal: { type: 'string', description: 'concrete acceptance: what "done" means, real backend, no-fabric default.' },
          wave: { type: 'integer', description: 'suggested build wave 1..N grouping' },
        },
      },
    },
    uiPolish: {
      type: 'array',
      description: 'Per-surface UI/frontend cleanup items (overlaps, spacing, plain-vs-modern, inconsistent Fluent v9/Loom tokens, missing empty/loading states).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['surface', 'grade', 'issues'],
        properties: {
          surface: { type: 'string', description: 'editor/page slug' },
          grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
          issues: { type: 'string', description: 'specific UI problems + the fix.' },
        },
      },
    },
  },
}

phase('Gather')
const readers = await parallel([
  // 1) ASKS — Atlas second brain (the operator's real, indexed requests/decisions)
  () => agent(
    `READ-ONLY. Surface EVERYTHING the operator (Frank) has asked for about CSA Loom / Fabric-in-a-Box, across time. Use the Atlas recall CLI: run \`atlas-recall\` (try \`atlas-recall --help\` first, then queries like \`atlas-recall "CSA Loom"\`, \`atlas-recall "Loom feature request"\`, \`atlas-recall "Fabric parity"\`, \`atlas-recall "Loom UI"\`, \`atlas-recall "marketing studio"\`, \`atlas-recall "Weave Palantir"\`). Also read ${REPO} memory at C:/Users/frgarofa/.claude/projects/E--Repos-GitHub-csa-inabox/memory/*.md. Output a deduped, itemized list of DISTINCT asks/requirements/decisions — quote the ask, note its source. Be exhaustive; this is the "what was requested" ledger.`,
    { model: 'sonnet', phase: 'Gather', label: 'asks:atlas+memory' },
  ),
  // 2) SPECS — PRPs / PRDs / parity docs / migration specs
  () => agent(
    `READ-ONLY. In ${REPO}, read and itemize EVERY specified-but-maybe-unbuilt capability from: docs/fiab/prp/*.md (the 12 experience PRPs + UNLEASH-KICKOFF), docs/fiab/parity/*.md, docs/migrations/palantir-foundry/** (Weave/Atelier/Spindle/etc.), and any PRPs/plans under PRPs/ or docs/. For each, output: spec id/title, the capability, and the acceptance criteria it defines. This is the "what was specified" ledger.`,
    { model: 'sonnet', phase: 'Gather', label: 'specs:prp+parity' },
  ),
  // 3) DELIVERED — git history + merged PRs
  () => agent(
    `READ-ONLY. In ${REPO}, build the "what shipped" ledger for CSA Loom. Run: \`git log --oneline -400 -- apps/fiab-console platform/fiab\` and \`gh pr list --state merged --limit 400 --search "csa-loom" --json number,title,mergedAt\`. Itemize the DELIVERED capabilities (feature → PR#/commit). Group by experience. Be concrete about what each shipped.`,
    { model: 'sonnet', phase: 'Gather', label: 'delivered:git+prs' },
  ),
  // 4) LIVE SURFACES — functional inventory of editors/pages
  () => agent(
    `READ-ONLY. In ${REPO}/apps/fiab-console, enumerate EVERY user-facing surface: list lib/editors/*.tsx, lib/panes/*.tsx, app/**/page.tsx, and the item-type catalog (grep for the catalog/registry of item types + editors). For each surface, state: does it call a REAL backend (useQuery/fetch to /api + a real Azure client) or is it a stub (useState(MOCK), return [], dead buttons, empty tabs)? Cite file:line for any stub/placeholder/TODO/"coming soon". This is the live coverage + vaporware inventory.`,
    { model: 'sonnet', phase: 'Gather', label: 'surfaces:inventory' },
  ),
  // 5) UI QUALITY — frontend polish grading
  () => agent(
    `READ-ONLY frontend-design review. In ${REPO}/apps/fiab-console, sample ~15-20 representative editors/pages (lib/editors, lib/panes) and grade each for UI quality against modern Fluent v9 + Loom-token standards (see .claude/rules/ui-parity.md + loom-design-standards memory): visual hierarchy, spacing/overlaps, consistent tokens/icons, table density (sortable/resizable/filterable, tile+list views), empty/loading/error states, keyboard nav. Output a per-surface grade (A-F) + specific cleanup items. Flag the worst offenders. This is the UI-polish backlog.`,
    { model: 'sonnet', phase: 'Gather', label: 'ui:quality-grade' },
  ),
])
const [asks, specs, delivered, surfaces, ui] = readers.map((r) => (r == null ? '(reader failed)' : String(r)))
log('Gather complete: asks/specs/delivered/surfaces/ui collected')

phase('Synthesize')
const gap = await agent(
  `You are the audit synthesizer. Reconcile these five ledgers into ONE grounded gap analysis for CSA Loom. Be skeptical: an ask counts as DELIVERED only if the surfaces/delivered ledgers show a REAL backend implementation (no stub). If it's spec-only or UI-only or stubbed, it's backlog.\n\n` +
  `=== ASKS (atlas+memory) ===\n${asks}\n\n=== SPECS (prp+parity) ===\n${specs}\n\n=== DELIVERED (git+prs) ===\n${delivered}\n\n=== LIVE SURFACES ===\n${surfaces}\n\n=== UI QUALITY ===\n${ui}\n\n` +
  `Produce: (1) summary; (2) backlog[] — every asked-for capability that is missing/partial/stub/ui-only/regressed, each with evidence + concrete goal + a suggested wave (group related items); (3) uiPolish[] — per-surface cleanup with a grade. Also WRITE the full human-readable report to ${REPO}/docs/fiab/prp/AUDIT-2026-06-10.md (a markdown gap matrix: Ask | Source | Delivered? | Evidence | Backlog item) using the Write tool. Return the structured object.`,
  { model: 'fable', phase: 'Synthesize', label: 'synthesize:gap-matrix', schema: GAP_SCHEMA },
)
log(`Audit: ${gap && gap.backlog ? gap.backlog.length : 0} backlog items, ${gap && gap.uiPolish ? gap.uiPolish.length : 0} UI-polish items`)
return gap
