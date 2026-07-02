/**
 * POST /api/items/workshop-app/[id]/publish
 *   body: { name?, location? }
 *   → { ok, url, hostname, staticSiteName, version, tokenRetrieved, widgetCount, files }
 *
 * Real Publish → Azure Static Web Apps for the Workshop (Atelier) app builder.
 * Mirrors the slate-app publish path: creates (idempotent PUT) a
 * Microsoft.Web/staticSites resource via ARM, waits for its default hostname,
 * and retrieves the SWA deployment token via the ARM `listSecrets` action — the
 * exact credential the SWA CLI / GitHub Action uses to push the generated
 * bundle. The bundle is generated HERE from the app's persisted canvas widgets
 * + typed variables (Cosmos state): index.html + app.js + a SWA config. Data
 * widgets in the published app read REAL rows through this console's
 * /run-action route (parameterised T-SQL on the ontology's Synapse warehouse);
 * filter widgets write object-set-filter variables; buttons apply their
 * set/clear-variable events; forms run real create/update/delete write-backs.
 * A version record (url + hostname + timestamp) is appended to the item's
 * Cosmos `state.versions[]`; the raw deployment token is never persisted or
 * returned to the browser.
 *
 * 100% Azure-native (ARM staticSites + Synapse behind the ontology) — no
 * Microsoft Fabric. Honest infra-gate (503) naming LOOM_SWA_SUBSCRIPTION_ID /
 * LOOM_SWA_RESOURCE_GROUP when unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { armGet, armPut, armPost } from '@/lib/azure/arm-client';
import type { WorkshopWidget, WorkshopVariable } from '@/lib/editors/workshop/workshop-app-builder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'workshop-app';
const SWA_API = '2024-04-01';

function err(error: string, status: number, code?: string, gate?: { reason: string; remediation: string }) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

function slug(v: string): string {
  return (v || 'workshop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workshop';
}

/** Honest gate — SWA needs a subscription + resource group + location. */
function swaConfig(): { sub: string; rg: string; location: string } | { missing: string[] } {
  const sub = (process.env.LOOM_SWA_SUBSCRIPTION_ID || process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const rg = (process.env.LOOM_SWA_RESOURCE_GROUP || process.env.LOOM_SWA_RG || '').trim();
  const location = (process.env.LOOM_SWA_LOCATION || process.env.LOOM_LOCATION || 'eastus2').trim();
  const missing: string[] = [];
  if (!sub) missing.push('LOOM_SWA_SUBSCRIPTION_ID');
  if (!rg) missing.push('LOOM_SWA_RESOURCE_GROUP');
  if (missing.length) return { missing };
  return { sub, rg, location };
}

interface WorkshopVersionRecord {
  version: string; url: string; hostname: string; staticSiteName: string;
  createdAt: string; createdBy?: string; widgetCount: number;
}
interface GeneratedFile { name: string; content: string }

// ── Workshop bundle codegen (mirrors generateSlateBundle in _palantir-codegen) ──

const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  table: { w: 448, h: 288 }, chart: { w: 400, h: 272 }, metric: { w: 224, h: 144 },
  filter: { w: 288, h: 128 }, form: { w: 384, h: 320 }, button: { w: 224, h: 96 }, text: { w: 336, h: 160 },
};

/** Pick only the persisted-widget fields the generated runtime needs. */
function bundleWidget(w: WorkshopWidget, y: number): Record<string, unknown> {
  const size = DEFAULT_SIZE[w.kind] || DEFAULT_SIZE.table;
  return {
    id: w.id, title: w.title, kind: w.kind,
    layout: w.layout || { x: 16, y, w: size.w, h: size.h },
    ...(w.entityType ? { entityType: w.entityType } : {}),
    ...(w.appliesVariableIds?.length ? { appliesVariableIds: w.appliesVariableIds } : {}),
    ...(w.kind === 'chart' ? { chartType: w.chartType, groupBy: w.groupBy, aggFn: w.aggFn, aggColumn: w.aggColumn } : {}),
    ...(w.kind === 'metric' ? { metricFn: w.metricFn, metricColumn: w.metricColumn } : {}),
    ...(w.kind === 'filter' ? { filterColumn: w.filterColumn, filterOp: w.filterOp, targetVariableId: w.targetVariableId, filterControl: w.filterControl } : {}),
    ...(w.kind === 'form' ? { formKind: w.formKind } : {}),
    ...(w.kind === 'text' ? { text: w.text } : {}),
    ...(w.events?.length ? { events: w.events } : {}),
  };
}

/**
 * Real Azure Static Web Apps bundle (index.html + app.js + config) rendering
 * the Workshop canvas: widgets at their persisted { x, y, w, h } positions,
 * data widgets bound live to the ontology's Synapse rows via the console's
 * run-action route, filters/buttons/forms functional.
 */
function generateWorkshopBundle(spec: {
  displayName: string; runActionUrl: string; widgets: WorkshopWidget[]; variables: WorkshopVariable[];
}): GeneratedFile[] {
  const title = spec.displayName || 'Workshop app';
  let autoY = 16;
  const widgetsJson = JSON.stringify(spec.widgets.map((w) => {
    const b = bundleWidget(w, autoY);
    if (!w.layout) autoY += (DEFAULT_SIZE[w.kind]?.h || 200) + 16;
    return b;
  }), null, 2);
  const variablesJson = JSON.stringify(spec.variables.map((v) => ({
    id: v.id, name: v.name, type: v.type,
    ...(v.entityType ? { entityType: v.entityType } : {}),
    ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}),
  })), null, 2);

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${title}</title>`,
    '  <style>',
    '  body{font-family:Segoe UI,system-ui,sans-serif;margin:0;background:#faf9f8;color:#242424}',
    '  header{background:#5b2e91;color:#fff;padding:16px 24px}header h1{margin:0;font-size:22px}',
    '  header p{margin:4px 0 0;font-size:12px;opacity:.85}',
    '  .canvas{position:relative;margin:24px;min-height:320px}',
    '  .widget{position:absolute;display:flex;flex-direction:column;background:#fff;border:1px solid #e1dfdd;',
    '  border-radius:8px;overflow:hidden;box-shadow:0 1.6px 3.6px rgba(0,0,0,.08)}',
    '  .w-head{padding:6px 10px;font-size:13px;font-weight:600;border-bottom:1px solid #edebe9;',
    '  background:linear-gradient(135deg,#ece3f7,#fff)}',
    '  .body{flex:1;min-height:0;overflow:auto;padding:8px}',
    '  table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #edebe9;font-size:12.5px}',
    '  .metric{font-size:32px;font-weight:600;color:#5b2e91}',
    '  .muted{color:#616161;font-size:12px;margin:4px 0}.err{color:#a4262c;font-size:12px}',
    '  .bars{display:flex;flex-direction:column;gap:4px}.bar-row{display:flex;align-items:center;gap:6px;font-size:12px}',
    '  .bar-label{flex:0 0 96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '  .bar{display:inline-block;height:12px;background:#5b2e91;border-radius:3px;flex:0 1 auto}',
    '  .bar-val{color:#616161}',
    '  .btn{background:#5b2e91;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer}',
    '  .btn:hover{background:#4a2578}',
    '  select,input{font:inherit;padding:5px 8px;border:1px solid #c8c6c4;border-radius:4px;max-width:100%;box-sizing:border-box}',
    '  form.crud{display:flex;flex-direction:column;gap:6px}form.crud label{font-size:12px;color:#616161}',
    '  </style>',
    '</head>',
    '<body>',
    '  <header>',
    `    <h1>${title}</h1>`,
    '    <p>Live data via the CSA Loom run-action API (Synapse behind the bound ontology) — sign in to CSA Loom in this browser for authenticated reads.</p>',
    '  </header>',
    '  <div class="canvas" id="canvas"></div>',
    '  <script src="./app.js"></script>',
    '</body>',
    '</html>',
  ].join('\n');

  const appJs = [
    `// ${title} — generated Workshop app over the CSA Loom ontology run-action API (Azure-native, no Fabric).`,
    `const RUN_ACTION_URL = ${JSON.stringify(spec.runActionUrl)};`,
    `const WIDGETS = ${widgetsJson};`,
    `const VARIABLES = ${variablesJson};`,
    '// Runtime variable values: object-set-filter → predicate[], scalars → string.',
    'const rt = {};',
    'for (const v of VARIABLES) rt[v.id] = v.type === "object-set-filter" ? [] : (v.defaultValue || "");',
    'function applyEffect(e, rowValue) {',
    '  const v = VARIABLES.find((x) => x.id === e.targetVariableId);',
    '  if (!v) return;',
    '  if (e.effect === "clear-variable") { rt[v.id] = v.type === "object-set-filter" ? [] : ""; return; }',
    '  if (e.effect !== "set-variable") return;',
    '  if (v.type === "object-set-filter") {',
    '    const val = rowValue !== undefined ? rowValue : (e.value || "");',
    '    rt[v.id] = e.filterColumn && val !== "" ? [{ column: e.filterColumn, op: e.filterOp || "eq", value: String(val) }] : [];',
    '  } else { rt[v.id] = e.value || ""; }',
    '}',
    'for (const w of WIDGETS) if (w.kind === "button") (w.events || []).forEach((e) => { if (e.trigger === "page-load") applyEffect(e); });',
    'function filtersFor(w) {',
    '  const out = [];',
    '  for (const vid of (w.appliesVariableIds || [])) {',
    '    const v = VARIABLES.find((x) => x.id === vid);',
    '    if (!v || v.type !== "object-set-filter") continue;',
    '    if (v.entityType && w.entityType && v.entityType !== w.entityType) continue;',
    '    const rv = rt[vid];',
    '    if (Array.isArray(rv)) out.push.apply(out, rv);',
    '  }',
    '  return out;',
    '}',
    'async function runAction(body) {',
    '  const r = await fetch(RUN_ACTION_URL, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body) });',
    '  const j = await r.json().catch(() => ({}));',
    '  if (!j.ok) throw new Error((j.error || "HTTP " + r.status) + (j.gate && j.gate.remediation ? " — " + j.gate.remediation : ""));',
    '  return j;',
    '}',
    'function esc(v) { const d = document.createElement("div"); d.textContent = v === null || v === undefined ? "" : String(v); return d.innerHTML; }',
    'function bodyOf(w) { return document.getElementById("w-" + w.id).querySelector(".body"); }',
    'function tableHtml(cols, rows) {',
    '  return "<table><thead><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" +',
    '    rows.slice(0, 100).map((r) => "<tr>" + r.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";',
    '}',
    'function barsHtml(rows) {',
    '  const two = rows.length && rows[0].length > 1;',
    '  const vals = rows.map((r) => Number(two ? r[1] : r[0]) || 0);',
    '  const max = Math.max.apply(null, vals.concat([1]));',
    '  return \'<div class="bars">\' + rows.slice(0, 24).map((r, i) =>',
    '    \'<div class="bar-row"><span class="bar-label">\' + esc(two ? r[0] : "value") + \'</span>\' +',
    '    \'<span class="bar" style="width:\' + Math.max(2, Math.round(60 * vals[i] / max)) + \'%"></span>\' +',
    '    \'<span class="bar-val">\' + esc(two ? r[1] : r[0]) + "</span></div>").join("") + "</div>";',
    '}',
    'function interp(text) {',
    '  return (text || "").replace(/\\{\\{([^}]+)\\}\\}/g, (m, n) => {',
    '    const v = VARIABLES.find((x) => x.name === n.trim());',
    '    if (!v) return m;',
    '    const rv = rt[v.id];',
    '    if (Array.isArray(rv)) return rv.map((p) => p.column + " " + p.op + " " + p.value).join(", ") || "(no filter)";',
    '    return String(rv || "");',
    '  });',
    '}',
    'function textHtml(text) {',
    '  return interp(text).split("\\n").map((l) => /^#{1,3}\\s/.test(l) ? "<h3>" + esc(l.replace(/^#+\\s/, "")) + "</h3>" : "<p>" + esc(l) + "</p>").join("");',
    '}',
    'async function renderData(w) {',
    '  const body = bodyOf(w);',
    '  body.innerHTML = \'<p class="muted">Loading…</p>\';',
    '  try {',
    '    if (w.kind === "table") {',
    '      const j = await runAction({ entityType: w.entityType, op: "list", top: 200, filters: filtersFor(w) });',
    '      body.innerHTML = (j.rows || []).length ? tableHtml(j.columns || [], j.rows) : \'<p class="muted">No rows.</p>\';',
    '    } else if (w.kind === "chart") {',
    '      const j = await runAction({ entityType: w.entityType, op: "aggregate", groupBy: w.groupBy, aggFn: w.aggFn || "count", aggColumn: w.aggColumn, filters: filtersFor(w), top: 50 });',
    '      body.innerHTML = (j.rows || []).length ? barsHtml(j.rows) : \'<p class="muted">No rows.</p>\';',
    '    } else if (w.kind === "metric") {',
    '      const j = await runAction({ entityType: w.entityType, op: "aggregate", aggFn: w.metricFn || "count", aggColumn: w.metricColumn, filters: filtersFor(w), top: 1 });',
    '      const v = Number(j.rows && j.rows[0] && j.rows[0][0]);',
    '      body.innerHTML = \'<div class="metric">\' + esc(Number.isFinite(v) ? v.toLocaleString() : "—") + \'</div><p class="muted">\' + esc((w.metricFn || "count") + " · " + w.entityType) + "</p>";',
    '    }',
    '  } catch (e) { body.innerHTML = \'<p class="err">\' + esc(e.message) + "</p>"; }',
    '}',
    'function refreshData() { WIDGETS.forEach((w) => { if ((w.kind === "table" || w.kind === "chart" || w.kind === "metric") && w.entityType) renderData(w); }); }',
    'function applyFilter(w, value) {',
    '  if (!w.targetVariableId || !w.filterColumn) return;',
    '  rt[w.targetVariableId] = value !== "" ? [{ column: w.filterColumn, op: w.filterOp || "eq", value: value }] : [];',
    '  refreshData();',
    '}',
    'async function renderFilter(w) {',
    '  const body = bodyOf(w);',
    '  body.innerHTML = \'<p class="muted">\' + esc((w.filterColumn || "column") + " " + (w.filterOp || "eq")) + "</p>";',
    '  let control;',
    '  if ((w.filterControl || "dropdown") === "dropdown" && w.entityType && w.filterColumn) {',
    '    control = document.createElement("select");',
    '    control.innerHTML = \'<option value="">Any</option>\';',
    '    try {',
    '      const j = await runAction({ entityType: w.entityType, op: "distinct", column: w.filterColumn, top: 200 });',
    '      (j.rows || []).forEach((r) => { const o = document.createElement("option"); o.value = String(r[0] === null || r[0] === undefined ? "" : r[0]); o.textContent = o.value; if (o.value) control.appendChild(o); });',
    '    } catch (e) { /* keep the Any option; reads may need sign-in */ }',
    '    control.onchange = () => applyFilter(w, control.value);',
    '  } else {',
    '    control = document.createElement("input");',
    '    control.placeholder = "Filter value";',
    '    control.onchange = () => applyFilter(w, control.value);',
    '  }',
    '  body.appendChild(control);',
    '}',
    'function renderButton(w) {',
    '  const body = bodyOf(w);',
    '  const b = document.createElement("button");',
    '  b.className = "btn"; b.textContent = w.title || "Run";',
    '  b.onclick = () => { (w.events || []).forEach((e) => { if (e.trigger === "click" && (e.effect === "set-variable" || e.effect === "clear-variable")) applyEffect(e); }); refreshData(); };',
    '  body.appendChild(b);',
    '}',
    'async function renderForm(w) {',
    '  const body = bodyOf(w);',
    '  const kind = w.formKind || "create";',
    '  let cols = [];',
    '  try { const j = await runAction({ entityType: w.entityType, op: "list", top: 1 }); cols = j.columns || []; }',
    '  catch (e) { body.innerHTML = \'<p class="err">\' + esc(e.message) + "</p>"; return; }',
    '  const form = document.createElement("form"); form.className = "crud";',
    '  const valueInputs = {}; let keyColSel = null; let keyInput = null;',
    '  if (kind === "update" || kind === "delete") {',
    '    keyColSel = document.createElement("select");',
    '    cols.forEach((c) => { const o = document.createElement("option"); o.value = c; o.textContent = "Key: " + c; keyColSel.appendChild(o); });',
    '    keyInput = document.createElement("input"); keyInput.placeholder = "Key value";',
    '    form.appendChild(keyColSel); form.appendChild(keyInput);',
    '  }',
    '  if (kind === "create" || kind === "update") {',
    '    cols.forEach((c) => {',
    '      const lab = document.createElement("label"); lab.textContent = c;',
    '      const inp = document.createElement("input"); inp.placeholder = c;',
    '      valueInputs[c] = inp; form.appendChild(lab); form.appendChild(inp);',
    '    });',
    '  }',
    '  const submit = document.createElement("button"); submit.className = "btn"; submit.type = "submit"; submit.textContent = "Run " + kind;',
    '  const msg = document.createElement("p"); msg.className = "muted";',
    '  form.appendChild(submit); form.appendChild(msg);',
    '  form.onsubmit = async (ev) => {',
    '    ev.preventDefault(); msg.className = "muted"; msg.textContent = "Running…";',
    '    const req = { entityType: w.entityType, op: kind };',
    '    if (kind === "create" || kind === "update") {',
    '      const values = {};',
    '      for (const c of Object.keys(valueInputs)) if (valueInputs[c].value !== "") values[c] = valueInputs[c].value;',
    '      req.values = values;',
    '    }',
    '    if (keyColSel) { req.keyColumn = keyColSel.value; req.key = keyInput.value; }',
    '    try { const j = await runAction(req); msg.textContent = kind + " succeeded — " + (j.recordsAffected || 0) + " row(s) affected."; refreshData(); }',
    '    catch (e) { msg.className = "err"; msg.textContent = e.message; }',
    '  };',
    '  body.innerHTML = ""; body.appendChild(form);',
    '}',
    'function boot() {',
    '  const canvas = document.getElementById("canvas");',
    '  let maxB = 0;',
    '  WIDGETS.forEach((w) => {',
    '    const l = w.layout || { x: 16, y: 16, w: 320, h: 200 };',
    '    maxB = Math.max(maxB, l.y + l.h);',
    '    const el = document.createElement("div");',
    '    el.className = "widget"; el.id = "w-" + w.id;',
    '    el.style.left = l.x + "px"; el.style.top = l.y + "px"; el.style.width = l.w + "px"; el.style.height = l.h + "px";',
    '    el.innerHTML = \'<div class="w-head">\' + esc(w.title || w.kind) + \'</div><div class="body"></div>\';',
    '    canvas.appendChild(el);',
    '  });',
    '  canvas.style.height = (maxB + 24) + "px";',
    '  WIDGETS.forEach((w) => {',
    '    if (w.kind === "text") bodyOf(w).innerHTML = textHtml(w.text);',
    '    else if (w.kind === "button") renderButton(w);',
    '    else if (w.kind === "filter") renderFilter(w);',
    '    else if (w.kind === "form") renderForm(w);',
    '  });',
    '  refreshData();',
    '}',
    'boot();',
  ].join('\n');

  const config = JSON.stringify({
    navigationFallback: { rewrite: '/index.html' },
  }, null, 2);

  return [
    { name: 'index.html', content: html },
    { name: 'app.js', content: appJs },
    { name: 'staticwebapp.config.json', content: config },
  ];
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the app first (no id yet)', 400, 'no_id');

  const app = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!app) return err('workshop-app not found', 404, 'not_found');
  const state = (app.state || {}) as Record<string, unknown>;

  const cfg = swaConfig();
  if ('missing' in cfg) {
    return err(
      `Azure Static Web Apps not configured: set ${cfg.missing.join(' + ')}.`,
      503, 'swa_not_configured',
      {
        reason: 'Publish provisions a real Azure Static Web App (Microsoft.Web/staticSites) and retrieves its deployment token.',
        remediation: `Set ${cfg.missing.join(' + ')} (and optionally LOOM_SWA_LOCATION) on the Console, and grant the Console UAMI "Website Contributor" on the resource group. No Microsoft Fabric required.`,
      },
    );
  }

  // Build the deployable bundle from the persisted canvas widgets + variables.
  const body = (await req.json().catch(() => ({}))) as { name?: string; location?: string };
  const widgetsRaw = Array.isArray(state.widgets) ? (state.widgets as WorkshopWidget[]) : [];
  const variables = Array.isArray(state.variables) ? (state.variables as WorkshopVariable[]) : [];
  // Embed every widget that has enough config to function in the bundle.
  const widgets = widgetsRaw.filter((w) => {
    if (!w || !w.kind || !w.id) return false;
    if (w.kind === 'text' || w.kind === 'button') return true;
    return !!w.entityType; // table / chart / metric / filter / form need a bound object type
  });
  if (widgets.length === 0) {
    return err('Nothing to publish — add at least one configured widget to the canvas (data widgets need a bound object type).', 400, 'empty_app');
  }

  // The published app reads through THIS console's run-action route (real
  // parameterised T-SQL over the ontology's Synapse warehouse).
  const publicBase = (process.env.LOOM_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || req.nextUrl.origin;
  const runActionUrl = `${publicBase}/api/items/workshop-app/${encodeURIComponent(id)}/run-action`;
  const files = generateWorkshopBundle({ displayName: app.displayName, runActionUrl, widgets, variables });

  const location = (body?.location || cfg.location).trim();
  // Stable per-item resource name so re-publishing updates the same SWA.
  const persistedName = typeof state.staticSiteName === 'string' ? state.staticSiteName : '';
  const staticSiteName = persistedName || `swa-loom-${slug(body?.name || app.displayName || id)}-${id.slice(0, 6).replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 60);
  const armBase = `/subscriptions/${cfg.sub}/resourceGroups/${cfg.rg}/providers/Microsoft.Web/staticSites/${encodeURIComponent(staticSiteName)}`;

  try {
    // 1) Create / update the Static Web App (Free SKU, standalone — no repo link).
    await armPut(`${armBase}?api-version=${SWA_API}`, {
      location,
      sku: { name: 'Free', tier: 'Free' },
      properties: { allowConfigFileUpdates: true, stagingEnvironmentPolicy: 'Enabled', publicNetworkAccess: 'Enabled' },
    });

    // 2) Poll for the default hostname (SWA populates it shortly after create).
    let hostname = '';
    for (let i = 0; i < 6 && !hostname; i++) {
      const got = await armGet<{ properties?: { defaultHostname?: string } }>(`${armBase}?api-version=${SWA_API}`);
      hostname = String(got?.properties?.defaultHostname || '').trim();
      if (!hostname) await new Promise((r) => setTimeout(r, 1500));
    }
    const url = hostname ? `https://${hostname}` : '';

    // 3) Retrieve the deployment token (the credential to push `files`). Proves
    //    the SWA is publishable; the token is NOT persisted or returned.
    let tokenRetrieved = false;
    try {
      const secrets = await armPost<{ properties?: { apiKey?: string } }>(`${armBase}/listSecrets?api-version=${SWA_API}`, {});
      tokenRetrieved = !!secrets?.properties?.apiKey;
    } catch { /* token retrieval is best-effort; resource is still live */ }

    // 4) Append a version record to Cosmos.
    const prior: WorkshopVersionRecord[] = Array.isArray(state.versions) ? (state.versions as WorkshopVersionRecord[]) : [];
    const version = `v${prior.length + 1}`;
    const record: WorkshopVersionRecord = {
      version, url, hostname, staticSiteName,
      createdAt: new Date().toISOString(), createdBy: session.claims.oid, widgetCount: widgets.length,
    };
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, staticSiteName, swaLocation: location, versions: [record, ...prior].slice(0, 50), lastPublishedAt: record.createdAt, lastPublishedUrl: url },
    });

    return NextResponse.json({ ok: true, url, hostname, staticSiteName, version, tokenRetrieved, widgetCount: widgets.length, files });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/403|forbidden|authoriz/i.test(msg)) {
      return err(
        `ARM authorization failed creating the Static Web App: ${msg.slice(0, 300)}`,
        403, 'swa_forbidden',
        { reason: 'The Console UAMI needs rights on the SWA resource group.', remediation: 'Grant the Console UAMI "Website Contributor" (or Contributor) on LOOM_SWA_RESOURCE_GROUP.' },
      );
    }
    return err(`Static Web App publish failed: ${msg.slice(0, 400)}`, 502, 'publish_failed');
  }
}
