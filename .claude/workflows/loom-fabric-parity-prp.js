export const meta = {
  name: 'loom-fabric-parity-prp',
  description: 'Inventory Microsoft Fabric features -> map 1:1 Azure-native+OSS parity (all clouds) -> audit vs Loom -> write a dev-loop PRP per experience + a master Unleash kickoff prompt. Pass args.experiences to scope/extend.',
  phases: [
    { title: 'Inventory', detail: 'Sonnet: complete Fabric feature set per experience (MS Learn)' },
    { title: 'Parity', detail: 'Sonnet: 1:1 Azure-native + OSS mapping, full service feature sets + UI, all clouds' },
    { title: 'Audit', detail: 'read Loom code: grade every feature built/gate/stub/missing/placeholder' },
    { title: 'PRP', detail: 'write a complete dev-loop PRP per experience under docs/fiab/prp/' },
    { title: 'Master', detail: 'write the PRP index + return the Unleash kickoff prompt' },
  ],
}

// ───────────────────────────────────────────────────────────────────────────
// HOW TO USE (later / to add or refresh experiences):
//   Workflow({ name: 'loom-fabric-parity-prp' })                       // all default experiences
//   Workflow({ name: 'loom-fabric-parity-prp', args: { experiences: [
//       { id:'real-time-intelligence', name:'…', scope:'…' } ] } })    // a subset, or new ones
//   Output: docs/fiab/prp/<id>.md per experience + README.md + UNLEASH-KICKOFF.md;
//   returns the kickoff prompt text. No git ops (operator commits the PRP set).
// ───────────────────────────────────────────────────────────────────────────

const REPO = '/e/Repos/GitHub/csa-inabox'
const PRP_DIR = 'docs/fiab/prp'

const DEFAULT_EXPERIENCES = [
  { id: 'onelake', name: 'OneLake', scope: 'OneLake storage, catalog, shortcuts (internal + ADLS/S3/GCS/Dataverse), OneLake security/roles, file explorer, data hub.' },
  { id: 'data-engineering', name: 'Data Engineering (Lakehouse + Spark)', scope: 'Lakehouse (Files/Tables, Delta, SQL endpoint), Spark Notebooks, Spark Job Definitions, Environments/libraries, Spark pools, table maintenance, shortcuts.' },
  { id: 'data-factory', name: 'Data Factory', scope: 'Pipelines (activities/control flow/params/triggers/monitoring), Dataflows Gen2 (Power Query M), Copy Job, connections/gateways, templates.' },
  { id: 'data-warehouse', name: 'Data Warehouse', scope: 'Warehouse (T-SQL, COPY INTO, cross-DB, query/visual editor, modeling, RLS/CLS/DDM), SQL analytics endpoint, clone, time travel.' },
  { id: 'real-time-intelligence', name: 'Real-Time Intelligence', scope: 'Eventhouse/KQL DB, KQL Querysets, Eventstream, Real-Time Dashboards, Activator/Reflex, Real-Time Hub, update policies, materialized views, KQL graph.' },
  { id: 'data-science', name: 'Data Science', scope: 'ML experiments/runs (MLflow), model registry/scoring, DS notebooks, AutoML, AI functions, SynapseML, endpoints, data wrangler.' },
  { id: 'power-bi', name: 'Power BI / BI', scope: 'Semantic models (Direct Lake/import/DQ/composite; TMDL, measures, relationships, RLS, calc groups, Prep-for-AI), Reports, Paginated reports, Dashboards, Metrics, Datamarts, deployment pipelines.' },
  { id: 'databases', name: 'Databases', scope: 'Fabric SQL Database, Cosmos DB in Fabric, Mirrored databases (Azure SQL/MI, Cosmos, Snowflake, PostgreSQL, open mirroring), replication monitoring.' },
  { id: 'governance-security', name: 'Governance & Security', scope: 'Purview Data Map + Unified Catalog, domains, sensitivity labels (MIP), DLP, lineage, endorsement, workspace roles + item permissions, OneLake security, audit, data quality.' },
  { id: 'copilot-ai', name: 'Copilot & AI', scope: 'Copilot across experiences, Fabric Data Agents (AI skills) over data, copilot admin/governance, AI capacity.' },
  { id: 'platform', name: 'Platform & Admin', scope: 'Workspaces + settings, capacities (scale/throttling/monitoring), Git integration + deployment pipelines, Monitoring hub, Capacity Metrics, admin/tenant settings, REST APIs + automation, CLI/Terraform.' },
  { id: 'data-marketplace', name: 'Data products & API', scope: 'Data products/sharing, org data marketplace, API for GraphQL, Data Activator outputs, external + OneLake sharing.' },
]

const EXPERIENCES = (args && Array.isArray(args.experiences) && args.experiences.length) ? args.experiences : DEFAULT_EXPERIENCES

const INV = { type: 'object', required: ['experience', 'features'], properties: {
  experience: { type: 'string' },
  features: { type: 'array', items: { type: 'object', required: ['name', 'capability'], properties: {
    name: { type: 'string' }, area: { type: 'string' }, capability: { type: 'string' }, uiSurface: { type: 'string' } } } },
  learnRefs: { type: 'array', items: { type: 'string' } } } }
const PAR = { type: 'object', required: ['mappings', 'servicesUsed'], properties: {
  mappings: { type: 'array', items: { type: 'object', required: ['fabricFeature', 'azureNative', 'loomUi'], properties: {
    fabricFeature: { type: 'string' }, azureNative: { type: 'string' }, oss: { type: 'string' }, loomUi: { type: 'string' }, portability: { type: 'string' }, gaps: { type: 'string' } } } },
  servicesUsed: { type: 'array', items: { type: 'object', required: ['service'], properties: {
    service: { type: 'string' }, fullFeatureSet: { type: 'string' }, nativeUiToRebuild: { type: 'string' } } } } } }
const AUD = { type: 'object', required: ['rows', 'summary'], properties: {
  rows: { type: 'array', items: { type: 'object', required: ['feature', 'status'], properties: {
    feature: { type: 'string' }, status: { type: 'string', enum: ['built', 'honest-gate', 'stub', 'placeholder', 'missing'] }, evidence: { type: 'string' }, workNeeded: { type: 'string' } } } },
  summary: { type: 'string' }, grade: { type: 'string' } } }
const PRP = { type: 'object', required: ['file', 'written', 'taskCount'], properties: {
  file: { type: 'string' }, written: { type: 'boolean' }, taskCount: { type: 'integer' }, headline: { type: 'string' } } }

const invPrompt = (e) => `READ-ONLY. Enumerate the COMPLETE feature set of Microsoft Fabric experience "${e.name}". Scope: ${e.scope}\nGround in Microsoft Learn (microsoft_docs_search/fetch via ToolSearch). Exhaustive — every tab/panel/wizard/canvas/dialog/button/capability. Return structured inventory.`
const parPrompt = (e, inv) => `READ-ONLY. For Fabric "${e.name}", map EACH feature to 1:1 parity on Azure-native services (+OSS) surfaced via CSA Loom, NO real Fabric/Power BI dependency.\nINVENTORY:\n${JSON.stringify(inv).slice(0, 6000)}\nGive per feature: Azure-native service(s), OSS, Loom UI approach, PORTABILITY across Commercial/GCC/GCC-High/IL5 (endpoints/SKUs/sovereign). Then SERVICES USED + each one's 100% feature set Loom must surface + native UI to rebuild. Ground in MS Learn. Exhaustive.`
const audPrompt = (e, par) => `Audit what CSA Loom has built TODAY for "${e.name}" vs the target parity. READ repo ${REPO}: apps/fiab-console/lib/editors/*, app/api/**, lib/azure/*, lib/components/**, platform/fiab/bicep/**, docs/fiab/**.\nTARGET:\n${JSON.stringify(par).slice(0, 8000)}\nGrade each feature built/honest-gate/stub/placeholder/missing with file evidence + the concrete enhancement/refactor for no-stub completeness. Specific + honest.`
function prpPrompt(e, inv, par, aud) {
  const file = `${PRP_DIR}/${e.id}.md`
  return `Write a COMPLETE implementation-ready PRP to ${REPO}/${file} for full Fabric parity on "${e.name}" (Azure-native, no Fabric dep).\nINVENTORY:\n${JSON.stringify(inv).slice(0, 5000)}\nPARITY:\n${JSON.stringify(par).slice(0, 7000)}\nAUDIT:\n${JSON.stringify(aud).slice(0, 7000)}\n\nSections: (1) overview + Azure-native+OSS architecture (all 4 clouds); (2) feature-by-feature parity table incl current Loom status + work needed; (3) each Azure/OSS service's full feature set + native UI to rebuild; (4) numbered TASK LIST (goal, files, backend/REST, bicep/portability, UI, acceptance criteria with NO stubs/placeholders/mocks); (5) per-task Claude Code DEV-LOOP (coding -> validation/test [tsc+vitest+real-data E2E] -> docs -> UAT, iterate to pass); (6) experience definition-of-done. Write the file. Return {file, written:true, taskCount, headline}.`
}

const done = await pipeline(
  EXPERIENCES,
  async (e) => ({ e, inv: await agent(invPrompt(e), { model: 'sonnet', agentType: 'Explore', phase: 'Inventory', label: `inv:${e.id}`, schema: INV }) }),
  async (p) => ({ ...p, par: await agent(parPrompt(p.e, p.inv), { model: 'sonnet', agentType: 'Explore', phase: 'Parity', label: `par:${p.e.id}`, schema: PAR }) }),
  async (p) => ({ ...p, aud: await agent(audPrompt(p.e, p.par), { agentType: 'Explore', phase: 'Audit', label: `aud:${p.e.id}`, schema: AUD }) }),
  async (p) => ({ ...p, prp: await agent(prpPrompt(p.e, p.inv, p.par, p.aud), { phase: 'PRP', label: `prp:${p.e.id}`, schema: PRP }) }),
)
const ok = done.filter(Boolean)
log(`PRPs written: ${ok.filter((d) => d.prp?.written).length}/${EXPERIENCES.length}`)

phase('Master')
const index = ok.map((d) => `${d.e.id}: ${d.prp?.headline || d.e.name} (${d.prp?.taskCount || '?'} tasks; grade ${d.aud?.grade || '?'})`).join('\n')
const master = await agent(
  `All per-experience PRPs are under ${REPO}/${PRP_DIR}/. (1) Write ${REPO}/${PRP_DIR}/README.md — master index: intro (100% Fabric parity on Azure-native, via CSA Loom, all clouds, zero stubs), a table linking every PRP with task count + grade, cross-cutting rules (no-fabric-dependency, no-vaporware, ui-parity, loom-no-freeform-config, portability Commercial/GCC/GCC-High/IL5, bicep + bootstrap sync), and overall sequencing. (2) Write ${REPO}/${PRP_DIR}/UNLEASH-KICKOFF.md — the exact prompt to launch the autonomous CODING workflow over these PRPs (iterate every task: research -> coding -> validation/test [tsc+vitest+real-data E2E] -> docs -> UAT until acceptance passes, a PR per task, drain 100%; name the dev-loop discipline: branch off origin/main, explicit staging, no pnpm install in shared tree, filter makeStyles tsc noise, conventional commits + co-author trailer, operator merges after CI — e.g. it can run the saved 'loom-backlog-drain' workflow with args built from the PRP tasks).\nIndex:\n${index}\n\nWrite both files. RETURN the full text of UNLEASH-KICKOFF.md as your final message.`,
  { phase: 'Master', label: 'master-rollup' },
)
return { prpsWritten: ok.filter((d) => d.prp?.written).length, experiences: EXPERIENCES.length, kickoffPrompt: master }
