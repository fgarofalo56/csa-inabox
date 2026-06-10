export const meta = {
  name: 'loom-audit-deep',
  description: 'DEEPER ask-first audit. Exhaustively mine the operator\'s full Atlas context history (all sessions) + memory + specific under-covered areas (Help/Learning Hub, MCP catalog + admin config, Fabric Build 2026 features -> OSS/Azure parity, the page-by-page UI redesign mandate) for asks the first AUDIT-2026-06-10 missed. Output NEW backlog items (audit-T37+) and write docs/fiab/prp/AUDIT-2026-06-10-deep.md.',
  phases: [
    { title: 'Mine', detail: 'parallel deep-dives: atlas history, fabric-build-2026, help/learning, mcp/admin catalog, UI mandate' },
    { title: 'Reconcile', detail: 'dedupe vs the 36 existing items -> NEW items only -> write deep audit doc' },
  ],
}

const REPO = '/e/Repos/GitHub/csa-inabox'
const MEM = 'C:/Users/frgarofa/.claude/projects/E--Repos-GitHub-csa-inabox/memory'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'newBacklog'],
  properties: {
    summary: { type: 'string', description: 'What the first audit missed and the size/shape of the additional backlog.' },
    newBacklog: {
      type: 'array',
      description: 'NEW items NOT already in AUDIT-2026-06-10.md (audit-T01..T36). Number them audit-T37+.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'area', 'askSource', 'status', 'goal', 'wave'],
        properties: {
          id: { type: 'string', description: 'audit-T37, audit-T38, ...' },
          title: { type: 'string' },
          area: { type: 'string', description: 'help-learning | mcp-admin | fabric-build-2026 | ui-redesign | other' },
          askSource: { type: 'string', description: 'WHERE the operator asked it: quote the atlas-recall hit / memory file / session note. This is the proof it was requested.' },
          status: { type: 'string', enum: ['missing', 'partial', 'stub', 'ui-only'] },
          goal: { type: 'string', description: 'concrete acceptance: real backend, Azure-native default, Fluent v9 + Loom tokens.' },
          wave: { type: 'integer', description: 'suggested wave 6..N (continues after the first audit\'s 5 waves)' },
        },
      },
    },
  },
}

phase('Mine')
const mined = await parallel([
  // 1) ATLAS deep history — the main miss last time. Be exhaustive across ALL sessions.
  () => agent(
    `READ-ONLY, EXHAUSTIVE. Mine the operator's (Frank) FULL ask history about CSA Loom / Fabric-in-a-Box from the Atlas second brain. Use the \`atlas-recall\` CLI heavily — first \`atlas-recall --help\`, then run MANY queries and paginate/expand each: ` +
    `"CSA Loom", "Loom feature", "Loom request", "Loom help", "help file", "Learning Hub", "Loom tutorial", "Loom docs", ` +
    `"MCP", "MCP server", "MCP catalog", "MCP config", "MCP settings", "admin settings", "admin catalog", "admin console", ` +
    `"Fabric Build", "Fabric 2026", "new Fabric", "latest Fabric feature", "Loom UI", "Loom redesign", "UI overhaul", "Web 3.0", ` +
    `"Loom marketing", "workshop", "use case", "solution store", "Weave", "Palantir", "Copilot Loom", "Loom backlog". ` +
    `Also: \`atlas-recall "what have I asked for in csa-inabox"\`, recall decisions + topics + per-repo history for fgarofalo56/csa-inabox. ` +
    `Output an EXHAUSTIVE deduped list of DISTINCT asks/requirements/decisions — quote each ask + its source/session. Prioritize asks that sound NOT-yet-built. Do not summarize away detail; this is the master ask ledger the first audit under-sampled.`,
    { model: 'sonnet', phase: 'Mine', label: 'mine:atlas-deep' },
  ),
  // 2) Fabric Build 2026 features -> OSS/Azure parity
  () => agent(
    `Research the LATEST Microsoft Fabric features announced/released around Microsoft Build 2026 (and recent 2026 Fabric updates). Load tools via ToolSearch: select WebSearch, mcp__microsoft_docs_mcp__microsoft_docs_search, mcp__microsoft_docs_mcp__microsoft_docs_fetch. Enumerate the NEW Fabric capabilities (e.g. new RTI/eventhouse, OneLake, Copilot/AI skills, data agents, Power BI, governance, workspace, CI/CD, open-source/Iceberg, SQL database in Fabric, materialized lake views, etc. — find the real 2026 list). For EACH new feature: (a) describe it, (b) propose the 1:1 OSS or Azure-backed parity (no real Fabric dependency), (c) check if CSA Loom already has it (grep ${REPO}/apps/fiab-console + docs/fiab). Output: new-feature -> parity approach -> Loom status (missing/partial/have). This is the "incorporate latest Fabric" backlog the operator asked for.`,
    { model: 'sonnet', phase: 'Mine', label: 'mine:fabric-build-2026' },
  ),
  // 3) Help / Learning Hub deep-dive
  () => agent(
    `READ-ONLY. Enumerate EVERYTHING the operator asked for re: the Help system + Learning Hub in CSA Loom, and what's actually built. Read ${MEM}/csa_loom_learning_hub.md and any help/learn memory; grep ${REPO}/apps/fiab-console for /learn, help, Learning Hub, tutorial, "Learn popup", in-product help, guided tour, onboarding; read docs/fiab learning/tutorial docs. List each asked help/learning capability (in-app help drawer, contextual Learn popups per editor, guided tours, searchable help catalog, notebook/use-case tutorials as Loom-native, import-with-sample-data wizard, Learning Hub Copilot, etc.) and whether it's built/partial/missing.`,
    { model: 'sonnet', phase: 'Mine', label: 'mine:help-learning' },
  ),
  // 4) MCP catalog + admin config/settings deep-dive
  () => agent(
    `READ-ONLY. Enumerate EVERYTHING the operator asked for re: (a) the MCP server library/catalog (deployable curated catalog, KV secretRef, Azure Files, MS servers + vetted gov-safe top-25) and (b) admin config/settings — a FULL catalog + configuration surface in the admin plane. Read ${MEM}/csa_loom_mcp_library.md + any admin memory; grep ${REPO}/apps/fiab-console for MCP, mcp-server, Connect panel, admin settings, catalog, config; read docs/fiab + temp/mcp-gov-research.md if present. List each asked capability and built/partial/missing status: deployable MCP catalog UI, per-server config/secrets, enable/deploy to Container Apps, admin global settings catalog, feature flags, env/config management UI, etc.`,
    { model: 'sonnet', phase: 'Mine', label: 'mine:mcp-admin' },
  ),
  // 5) UI redesign mandate deep-dive
  () => agent(
    `READ-ONLY. Enumerate the operator's full UI/UX redesign mandate for CSA Loom beyond per-pane stubs. Read ${MEM}/csa_loom_ui_overhaul_backlog.md, ${MEM}/loom_design_standards.md, .claude/rules/ui-parity.md; grep for tables/inline styles debt. List the page-by-page redesign asks (Web 3.0 modern feel, no smushed tables, spacing/icons/color, sortable+resizable+filterable tables, tile+list views, foundation primitives, per-page waves) and which pages still need it. Output a concrete per-area UI backlog (distinct from the first audit's generic uiPolish).`,
    { model: 'sonnet', phase: 'Mine', label: 'mine:ui-redesign' },
  ),
])
const [atlas, fabric, help, mcp, uiR] = mined.map((r) => (r == null ? '(failed)' : String(r)))
log('Mine complete')

phase('Reconcile')
const out = await agent(
  `Reconcile these deep-dive ledgers into NEW backlog items the first audit (docs/fiab/prp/AUDIT-2026-06-10.md, items audit-T01..T36) MISSED. First READ ${REPO}/docs/fiab/prp/AUDIT-2026-06-10.md so you do NOT duplicate its 36 items. Then from the ledgers below, extract every DISTINCT asked-for capability that is NOT already covered + NOT already shipped (verify shipped by a quick grep of ${REPO}/apps/fiab-console where unsure). Number NEW items audit-T37+. Group into waves 6+ (e.g. wave 6 help/learning, 7 mcp/admin catalog, 8 fabric-build-2026 parity, 9 UI redesign — your call). Each item needs the askSource quote (proof it was requested).\n\n` +
  `=== ATLAS DEEP HISTORY ===\n${atlas}\n\n=== FABRIC BUILD 2026 ===\n${fabric}\n\n=== HELP/LEARNING ===\n${help}\n\n=== MCP/ADMIN ===\n${mcp}\n\n=== UI REDESIGN ===\n${uiR}\n\n` +
  `WRITE the full report to ${REPO}/docs/fiab/prp/AUDIT-2026-06-10-deep.md (markdown: New Item | Area | Ask Source | Status | Goal | Wave) using the Write tool, and return the structured object. Be generous but honest — every item must trace to a real operator ask.`,
  { model: 'opus', phase: 'Reconcile', label: 'reconcile:new-backlog', schema: SCHEMA },
)
log(`Deep audit: ${out && out.newBacklog ? out.newBacklog.length : 0} NEW items beyond the first 36`)
return out
