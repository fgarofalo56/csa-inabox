#!/usr/bin/env node
/**
 * demo-seed — populate the LIVE Loom console with a persistent, navigable DEMO
 * environment owned by the tenant admin, so an operator can walk a full
 * capabilities demo (workspaces + installed apps + representative items).
 *
 * Owned by LOOM_TENANT_ADMIN_OID (passed as UAT_OID) so the signed-in admin can
 * open everything — unlike the transient tut-* capture workspaces (owned by the
 * default automation oid). Idempotent-ish: it names workspaces deterministically
 * and skips creating a workspace whose name already exists.
 *
 * Env: SESSION_SECRET (KV loom-session-secret), LOOM_URL, UAT_OID (admin oid),
 *      UAT_NAME. No creds handled beyond the HMAC session mint (same as the UAT).
 */
import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) { console.error('SESSION_SECRET required'); process.exit(1); }
const BASE = (process.env.LOOM_URL || 'https://csa-loom.limitlessdata.ai').replace(/\/$/, '');
const OID = process.env.UAT_OID || '00000000-0000-0000-0000-000000000000';
const NAME = process.env.UAT_NAME || 'CSA Loom Admin';

function mintSession() {
  const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'),
    Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
  const payload = { claims: { oid: OID, name: NAME, email: 'admin@example.invalid', upn: 'admin@example.invalid' },
    exp: Math.floor(Date.now() / 1000) + 8 * 3600 };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
const COOKIE = `loom_session=${mintSession()}`;

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
}

async function listWorkspaces() {
  const r = await api('GET', '/api/workspaces');
  return Array.isArray(r.json) ? r.json : (r.json?.workspaces || r.json?.items || []);
}

async function ensureWorkspace(name, domain = 'default') {
  const existing = (await listWorkspaces()).find((w) => (w.name || w.displayName) === name);
  if (existing) { console.log(`  ✓ workspace exists: ${name} (${existing.id})`); return existing.id; }
  const r = await api('POST', '/api/workspaces', { name, displayName: name, domain });
  if (r.status >= 300 || !r.json?.id) { console.log(`  ::warn:: create workspace ${name} -> ${r.status} ${JSON.stringify(r.json).slice(0,160)}`); return null; }
  console.log(`  ✓ workspace created: ${name} (${r.json.id})`);
  return r.json.id;
}

async function createItem(wsId, type, displayName) {
  const r = await api('POST', `/api/workspaces/${wsId}/items`, { itemType: type, displayName });
  if (r.status >= 300 || !r.json?.id) { console.log(`    ::warn:: item ${type} -> ${r.status} ${JSON.stringify(r.json).slice(0,140)}`); return null; }
  console.log(`    ✓ item: ${displayName} (${type})`);
  return r.json.id;
}

async function installApp(appId, wsId) {
  const r = await api('POST', `/api/apps/${encodeURIComponent(appId)}/install`, { workspaceId: wsId });
  if (r.status >= 300 || !r.json?.jobId) { console.log(`    ::warn:: install ${appId} -> ${r.status} ${JSON.stringify(r.json).slice(0,140)}`); return; }
  console.log(`    ✓ app install started: ${appId} (job ${r.json.jobId}, ${r.json.totalItems || '?'} items)`);
  // poll briefly so items land (provisioning may continue async)
  for (let i = 0; i < 24; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    const j = await api('GET', `/api/apps/install-jobs/${r.json.jobId}`);
    const st = j.json?.status || j.json?.state;
    if (['succeeded', 'completed', 'failed', 'error', 'partial'].includes(String(st))) {
      console.log(`      install ${appId}: ${st} (installed ${j.json?.installed?.length ?? '?'}/${j.json?.totalItems ?? '?'})`);
      return;
    }
  }
  console.log(`      install ${appId}: still running (items created; provisioning continues async)`);
}

// ── Content stamping (task #17) ──────────────────────────────────────────────
// After the shell items exist, fill the authored-content shells IN PLACE via the
// content-authoring routes so the demo actually demos (dashboards render tiles,
// the report binds a semantic model, the scorecard shows goals, the paginated
// report renders an RDL). Every step is idempotent + additive + best-effort — a
// missing backend/route logs a ::warn:: and never aborts the seed.

const LAKE_DB = 'loom_lakehouse';         // serverless db holding the gold views
const ADX_DB = 'loomdb_default';          // ADX db holding the sample telemetry

async function listItems(wsId) {
  const r = await api('GET', `/api/workspaces/${wsId}/items`);
  return Array.isArray(r.json) ? r.json : (r.json?.items || []);
}
const findItem = (items, type, nameIncludes) =>
  items.find((i) => i.itemType === type && (!nameIncludes || String(i.displayName || '').includes(nameIncludes)));

/** Ensure the denormalized dbo.loom_sales_wide view (+ its inputs) exist on the
 *  serverless lakehouse, so the semantic model / report / scorecard / RDL all
 *  have a single real table to bind. Best-effort: no-ops if the gold views the
 *  medallion apps create aren't present yet. */
async function ensureSalesWideView(lakehouseId) {
  if (!lakehouseId) { console.log('    ::warn:: no lakehouse item — skipping loom_sales_wide view'); return false; }
  const sql = `CREATE OR ALTER VIEW dbo.loom_sales_wide AS
    SELECT f.order_id, dc.customer_name, dc.customer_segment, dc.country,
           dp.product_name, dp.category, d.month_name, d.[year] AS order_year,
           f.quantity, f.extended_amount, f.margin_amount, f.cost_amount
    FROM lakehouse.fact_sales f
    JOIN lakehouse.dim_customer dc ON f.customer_key = dc.customer_key
    JOIN lakehouse.dim_product  dp ON f.product_key  = dp.product_key
    JOIN lakehouse.dim_date     d  ON f.date_key     = d.date_key`;
  const r = await api('POST', `/api/items/lakehouse/${lakehouseId}/query`, { database: LAKE_DB, sql });
  if (r.status >= 300 || r.json?.ok === false) {
    console.log(`    ::warn:: loom_sales_wide view not created (gold views may not exist yet): ${JSON.stringify(r.json).slice(0,140)}`);
    return false;
  }
  console.log('    ✓ ensured view: dbo.loom_sales_wide');
  return true;
}

const DASHBOARD_TILES = {
  earthquakes: [
    { title: 'Total Seismic Events', kql: 'SampleEarthquakes | count', viz: 'stat', database: ADX_DB, w: 3, h: 2 },
    { title: 'Events by Magnitude Band', kql: 'SampleEarthquakes | summarize Events=count() by MagBand=bin(Magnitude,1.0) | order by MagBand asc', viz: 'bar', database: ADX_DB, w: 5, h: 3 },
    { title: 'Strongest Quakes', kql: 'SampleEarthquakes | top 5 by Magnitude desc | project Place, Magnitude, Depth, EventTime', viz: 'table', database: ADX_DB, w: 6, h: 3 },
  ],
};

async function stampDashboards(items) {
  const dashboards = items.filter((i) => i.itemType === 'kql-dashboard');
  for (const dash of dashboards) {
    const cur = await api('GET', `/api/items/kql-dashboard/${dash.id}`);
    const existing = Array.isArray(cur.json?.tiles) ? cur.json.tiles : [];
    if (existing.length > 0) { console.log(`    ✓ dashboard already has ${existing.length} tiles: ${dash.displayName}`); continue; }
    const body = { timeRange: 'last-24h', autoRefreshMs: 0,
      dataSources: [{ id: 'ds1', name: 'Telemetry ADX', database: ADX_DB }],
      tiles: DASHBOARD_TILES.earthquakes };
    const r = await api('PUT', `/api/items/kql-dashboard/${dash.id}`, body);
    if (r.status >= 300 || r.json?.ok === false) { console.log(`    ::warn:: dashboard tiles ${dash.displayName} -> ${r.status} ${JSON.stringify(r.json).slice(0,120)}`); continue; }
    console.log(`    ✓ stamped ${DASHBOARD_TILES.earthquakes.length} tiles: ${dash.displayName}`);
  }
}

async function stampSemanticModel(items) {
  const sm = findItem(items, 'semantic-model', 'Sales Semantic Model');
  if (!sm) { console.log('    ::warn:: no Sales Semantic Model item to stamp'); return null; }
  const cur = await api('GET', `/api/items/semantic-model/${sm.id}/content`);
  if (cur.json?.content?.tables?.length) { console.log('    ✓ semantic model already has content'); return sm.id; }
  const content = {
    kind: 'semantic-model',
    tables: [{
      name: 'loom_sales_wide',
      columns: [
        { name: 'order_id', dataType: 'String' }, { name: 'customer_name', dataType: 'String' },
        { name: 'customer_segment', dataType: 'String' }, { name: 'country', dataType: 'String' },
        { name: 'product_name', dataType: 'String' }, { name: 'category', dataType: 'String' },
        { name: 'month_name', dataType: 'String' }, { name: 'order_year', dataType: 'String' },
        { name: 'quantity', dataType: 'Int64' }, { name: 'extended_amount', dataType: 'Double' },
        { name: 'margin_amount', dataType: 'Double' }, { name: 'cost_amount', dataType: 'Double' },
      ],
    }],
    measures: [
      { table: 'loom_sales_wide', name: 'Total Sales', expression: "CALCULATE(SUM('loom_sales_wide'[extended_amount]))", formatString: '$#,0' },
      { table: 'loom_sales_wide', name: 'Total Margin', expression: "CALCULATE(SUM('loom_sales_wide'[margin_amount]))", formatString: '$#,0' },
    ],
  };
  const r = await api('PUT', `/api/items/semantic-model/${sm.id}/content`, { content, sourceTarget: 'lakehouse', sourceSchema: 'dbo', sourceDatabase: LAKE_DB });
  if (r.status >= 300 || r.json?.ok === false) { console.log(`    ::warn:: semantic model content -> ${r.status} ${JSON.stringify(r.json).slice(0,140)}`); return sm.id; }
  console.log('    ✓ stamped semantic model content (loom_sales_wide + 2 measures)');
  return sm.id;
}

async function stampScorecard(items) {
  const sc = findItem(items, 'scorecard', 'Revenue KPI');
  if (!sc) { console.log('    ::warn:: no Revenue KPI Scorecard item to stamp'); return; }
  const cur = await api('GET', `/api/items/scorecard/${sc.id}/goals`);
  if (Array.isArray(cur.json?.goals) && cur.json.goals.length) { console.log('    ✓ scorecard already has goals'); return; }
  const goals = [
    { id: 'goal-total-sales', name: 'Total Sales', metric: 'USD', target: 5000, current: 0 },
    { id: 'goal-total-margin', name: 'Total Margin', metric: 'USD', target: 2000, current: 0 },
  ];
  const r = await api('POST', `/api/items/scorecard/${sc.id}/goals`, { goals });
  if (r.status >= 300 || r.json?.ok === false) { console.log(`    ::warn:: scorecard goals -> ${r.status} ${JSON.stringify(r.json).slice(0,140)}`); return; }
  console.log(`    ✓ stamped ${goals.length} scorecard goals`);
  // Bind each goal to a Loom-native (serverless SQL) metric — no Power BI / Fabric.
  const binds = [
    ['goal-total-sales', 'SELECT SUM(extended_amount) AS v FROM dbo.loom_sales_wide'],
    ['goal-total-margin', 'SELECT SUM(margin_amount) AS v FROM dbo.loom_sales_wide'],
  ];
  for (const [goalId, sqlQuery] of binds) {
    const b = await api('POST', `/api/items/scorecard/${sc.id}`, { goalId, connectedMetric: { sqlQuery, database: LAKE_DB } });
    if (b.status >= 300 || b.json?.ok === false) { console.log(`    ::warn:: bind metric ${goalId} -> ${b.status} ${JSON.stringify(b.json).slice(0,120)}`); }
  }
}

const INVOICE_RDL = `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition">
  <DataSources><DataSource Name="LoomSynapse"><ConnectionProperties><DataProvider>SQL</DataProvider><ConnectString>Data Source=serverless;Initial Catalog=master</ConnectString></ConnectionProperties></DataSource></DataSources>
  <DataSets><DataSet Name="SalesByCategory">
    <Query><DataSourceName>LoomSynapse</DataSourceName><CommandText>SELECT category, SUM(extended_amount) AS total, SUM(margin_amount) AS margin FROM ${LAKE_DB}.dbo.loom_sales_wide GROUP BY category ORDER BY total DESC</CommandText></Query>
    <Fields><Field Name="category"><DataField>category</DataField></Field><Field Name="total"><DataField>total</DataField></Field><Field Name="margin"><DataField>margin</DataField></Field></Fields>
  </DataSet></DataSets>
  <Body><ReportItems><Tablix Name="Tablix1"><TablixBody>
    <TablixColumns><TablixColumn><Width>3in</Width></TablixColumn><TablixColumn><Width>2in</Width></TablixColumn></TablixColumns>
    <TablixRows><TablixRow><Height>0.25in</Height><TablixCells>
      <TablixCell><CellContents><Textbox Name="c1"><Paragraphs><Paragraph><TextRuns><TextRun><Value>=Fields!category.Value</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox></CellContents></TablixCell>
      <TablixCell><CellContents><Textbox Name="c2"><Paragraphs><Paragraph><TextRuns><TextRun><Value>=Fields!total.Value</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox></CellContents></TablixCell>
    </TablixCells></TablixRow></TablixRows>
  </TablixBody><DataSetName>SalesByCategory</DataSetName></Tablix></ReportItems></Body>
  <Width>7in</Width>
</Report>`;

async function stampPaginatedRdl(items) {
  const pr = findItem(items, 'paginated-report', 'Invoice');
  if (!pr) { console.log('    ::warn:: no Invoice Paginated Report item to stamp'); return; }
  const cur = await api('GET', `/api/items/paginated-report/${pr.id}/rdl`);
  if (cur.json?.rdl && String(cur.json.rdl).trim()) { console.log('    ✓ paginated report already has an RDL'); return; }
  const r = await api('PUT', `/api/items/paginated-report/${pr.id}/rdl`, { rdl: INVOICE_RDL });
  if (r.status >= 300 || r.json?.ok === false) { console.log(`    ::warn:: paginated RDL -> ${r.status} ${JSON.stringify(r.json).slice(0,140)}`); return; }
  console.log('    ✓ stamped default invoice RDL');
}

// DAB entity config authored over the gold warehouse tables (idempotent).
function dabEntity(name, obj, sing, plur) {
  return { name, source: { object: obj, type: 'table' }, rest: { enabled: true },
    graphql: { enabled: true, singular: sing, plural: plur },
    permissions: [{ role: 'anonymous', actions: [{ action: 'read' }] }] };
}
const DAB_RUNTIME = { rest: { enabled: true, path: '/api', requestBodyStrict: true },
  graphql: { enabled: true, path: '/graphql', allowIntrospection: true },
  host: { mode: 'development', corsOrigins: [], corsAllowCredentials: false, authProvider: 'Simulator' },
  cache: { enabled: false, ttlSeconds: 5 }, pagination: { defaultPageSize: 100, maxPageSize: 100000 } };

async function stampDabEntities(items) {
  const dabItems = items.filter((i) => i.itemType === 'data-api-builder');
  for (const it of dabItems) {
    const cur = await api('GET', `/api/dab/${it.id}/config`);
    if (Array.isArray(cur.json?.config?.entities) && cur.json.config.entities.length) { console.log(`    ✓ DAB item already has entities: ${it.displayName}`); continue; }
    const config = { sourceRef: { kind: 'mssql', database: 'loompool' }, runtime: DAB_RUNTIME,
      entities: [ dabEntity('Order', 'gold.fact_sales', 'Order', 'Orders'),
        dabEntity('Customer', 'gold.dim_customer', 'Customer', 'Customers'),
        dabEntity('Product', 'gold.dim_product', 'Product', 'Products') ] };
    const r = await api('PUT', `/api/dab/${it.id}/config`, { config });
    if (r.status >= 300 || r.json?.ok === false) { console.log(`    ::warn:: DAB config ${it.displayName} -> ${r.status} ${JSON.stringify(r.json).slice(0,120)}`); continue; }
    console.log(`    ✓ authored 3 DAB entities: ${it.displayName}`);
  }
}

/** Apply the MERGED DAB config to the shared preview runtime ONCE (idempotent:
 *  skip if the running runtime already serves the demo entities). Best-effort —
 *  a ::warn:: when the ARM target isn't configured, never aborts the seed. */
async function applyDabRuntime(items) {
  const dab = findItem(items, 'data-api-builder');
  if (!dab) { console.log('    ::warn:: no Data API item to apply to the runtime'); return; }
  // Idempotency probe: does the running runtime already expose our entities?
  const schema = await api('GET', `/api/dab/${dab.id}/preview/schema`);
  const paths = schema.json?.doc?.paths || {};
  if (Object.keys(paths).some((p) => /order/i.test(p))) { console.log('    ✓ DAB runtime already serves demo entities'); return; }
  const r = await api('POST', `/api/dab/${dab.id}/apply-to-runtime`);
  if (r.status >= 300 || r.json?.ok === false) { console.log(`    ::warn:: apply-to-runtime -> ${r.status} ${JSON.stringify(r.json).slice(0,160)}`); return; }
  console.log(`    ✓ applied ${r.json.entitiesApplied?.length ?? '?'} entities to shared DAB runtime (rev ${r.json.revisionState}); collisions: ${r.json.collisions?.length ?? 0}`);
}

/** Fill the authored-content shells in the demo workspace (idempotent). */
async function stampDemoContent(wsId) {
  console.log('  · stamping authored content (task #17/#19 content-authoring routes)…');
  const items = await listItems(wsId);
  const lakehouse = findItem(items, 'lakehouse', 'Sales Lakehouse');
  await ensureSalesWideView(lakehouse?.id);
  await stampDashboards(items);
  await stampSemanticModel(items);
  await stampScorecard(items);
  await stampPaginatedRdl(items);
  await stampDabEntities(items);
  await applyDabRuntime(items);
}

// ── The demo layout ──────────────────────────────────────────────────────────
// A clean, hand-curated flagship workspace that tells the medallion → Direct Lake
// → report + real-time + AI/governance story end to end.
const SHOWCASE_ITEMS = [
  ['lakehouse', 'Sales Lakehouse (Medallion)'],
  ['notebook', 'Medallion — Bronze→Silver→Gold Notebook'],
  ['data-pipeline', 'Medallion Orchestration Pipeline'],
  ['warehouse', 'Finance Warehouse'],
  ['semantic-model', 'Sales Semantic Model (Direct Lake)'],
  ['report', 'Executive Sales Report (Loom-native)'],
  ['paginated-report', 'Invoice Paginated Report'],
  ['scorecard', 'Revenue KPI Scorecard'],
  ['eventstream', 'Orders Eventstream'],
  ['eventhouse', 'Telemetry Eventhouse'],
  ['kql-database', 'Telemetry KQL DB'],
  ['kql-dashboard', 'Real-Time Ops Dashboard'],
  ['activator', 'Anomaly Activator'],
  ['ml-model', 'Churn Prediction Model'],
  ['ml-experiment', 'Churn Training Experiment'],
  ['data-agent', 'Sales Data Agent'],
  ['data-product', 'Sales-360 Data Product'],
  ['graphql-api', 'Sales GraphQL API'],
  ['data-api-builder', 'Orders REST API'],
  ['logic-app', 'New-Order Alert Logic App'],
  ['copilot-studio-agent', 'Sales Copilot Agent'],
  ['ontology', 'Enterprise Ontology'],
];
// Compound use-case apps — each is a one-click install that provisions + seeds a
// whole working vertical. Installed into its OWN workspace for a clean per-app demo.
// Covers: medallion (supercharge-*), Direct Lake, real-time, ML/RAG/agents,
// governance/steward, data mesh, FinOps.
const SHOWCASE_APPS = [
  ['app-supercharge-bronze', 'Demo — Medallion Bronze'],
  ['app-supercharge-silver', 'Demo — Medallion Silver'],
  ['app-supercharge-gold', 'Demo — Medallion Gold'],
  ['app-direct-lake-replacement', 'Demo — Direct Lake'],
  ['app-lakehouse-inspector', 'Demo — Lakehouse Inspector'],
  ['app-real-time-dashboards', 'Demo — Real-Time Dashboards'],
  ['app-iot-realtime', 'Demo — IoT Real-Time'],
  ['app-ml-pipeline', 'Demo — ML Pipeline'],
  ['app-rag-builder', 'Demo — RAG Builder'],
  ['app-sovereign-ai-agents', 'Demo — Sovereign AI Agents'],
  ['app-data-governance', 'Demo — Data Governance'],
  ['app-data-steward', 'Demo — Data Steward'],
  ['app-federal-data-mesh', 'Demo — Federal Data Mesh'],
  ['app-finops-cost', 'Demo — FinOps'],
];

async function main() {
  console.log(`== CSA Loom demo seed → ${BASE} (owner oid ${OID.slice(0,8)}…) ==`);
  // 1) Flagship curated workspace — the end-to-end story
  const demoWs = await ensureWorkspace('CSA Loom Demo');
  if (demoWs) {
    for (const [type, label] of SHOWCASE_ITEMS) await createItem(demoWs, type, label);
    // Fill the authored-content shells in place (dashboards/semantic-model/
    // scorecard/paginated-report) via the content-authoring routes — idempotent.
    await stampDemoContent(demoWs);
  }
  // 2) One workspace PER app so each vertical is clean + navigable. Kick installs
  //    off (async provisioning continues on the backend); don't block the whole
  //    seed waiting for every provision.
  for (const [app, wsName] of SHOWCASE_APPS) {
    const ws = await ensureWorkspace(wsName);
    if (ws) await installApp(app, ws);
  }
  // 3) Summary
  const all = await listWorkspaces();
  console.log(`== done. workspaces visible to admin: ${all.length} ==`);
  console.log(all.map((w) => `  - ${w.name || w.displayName} (${w.id})`).join('\n'));
}
main().catch((e) => { console.error('demo-seed error:', e); process.exit(1); });
