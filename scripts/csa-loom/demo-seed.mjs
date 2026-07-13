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
