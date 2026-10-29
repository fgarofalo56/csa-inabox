/**
 * _w0-telemetry.mjs - family `telemetry` (PRP item W0-1; also read-only evidence
 * for #4442 Wave 0 task 1).
 *
 * Question: does this boundary's APIM expose the `GatewayLlmLogs` diagnostic
 * category, and do the Log Analytics tables the usage design reads
 * (`ApiManagementGatewayLlmLog`, column `TraceRecords` of
 * `ApiManagementGatewayLogs`) exist in the workspace the gateway logs to?
 *
 * ONLY THE CATEGORY LIST ANSWERS AVAILABILITY. An absent TABLE is INCONCLUSIVE
 * (diagnostics may simply be unwired - a table only shows up once something
 * routes to it), and the cell says so in its own text.
 *
 * READ-ONLY. Creates nothing, so there is no cleanup cell.
 *
 * GROUNDING (Learn, fetched 2026-10-29)
 *   Diagnostic settings list (properties.workspaceId, logs[], logAnalyticsDestinationType), 2021-05-01-preview:
 *     https://learn.microsoft.com/en-us/rest/api/monitor/diagnostic-settings/list
 *   Diagnostic settings CATEGORIES list - the Learn REST page for the category
 *   operation returned 404 on every URL tried (diagnostic-settings-category/list
 *   with and without a view, diagnostic-settings-categories/list), so the
 *   operation is grounded in the CLI page that names it
 *   (`az monitor diagnostic-settings categories list`,
 *   https://learn.microsoft.com/en-us/cli/azure/monitor/diagnostic-settings/categories)
 *   and the path `{resourceUri}/providers/Microsoft.Insights/diagnosticSettingsCategories`
 *   at 2021-05-01-preview. NOT GROUNDED IN A LEARN REST PAGE: if the first live run
 *   answers 4xx on it, that is an instrument error, not a boundary finding.
 *   Log Analytics tables list (properties.schema.columns / standardColumns), 2022-10-01:
 *     https://learn.microsoft.com/en-us/rest/api/loganalytics/tables/list-by-workspace?view=rest-loganalytics-2022-10-01
 *   Log Analytics workspaces by resource group, 2022-10-01:
 *     https://learn.microsoft.com/en-us/rest/api/loganalytics/workspaces/list-by-resource-group?view=rest-loganalytics-2022-10-01
 *   Table `ApiManagementGatewayLlmLog` and column `TraceRecords` ("Records emitted by trace policies"):
 *     https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apimanagementgatewayllmlog
 *     https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apimanagementgatewaylogs
 *   LLM logging (UI label "Logs related to generative AI gateway"):
 *     https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-llm-logs
 *   Query API (secondary evidence): POST {api}/v1/workspaces/{workspaceId}/query
 *     https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/access-api
 */
import {
  API, armUrl, listAll, measured, unknown, probeGateway, quote,
  reasonForFailure, sanitize,
} from './_w0-core.mjs';

const F = 'telemetry';
const id = (s) => `${F}.${s}`;

export const CELL_IDS = Object.freeze([
  'apim.sku', 'apim.capacity', 'apim.provisioningState', 'apim.location',
  'apim.virtualNetworkType', 'apim.publicNetworkAccess', 'gateway.reachability',
  'diag.categories', 'diag.GatewayLlmLogs', 'law.discovered',
  'law.table.ApiManagementGatewayLlmLog', 'law.column.TraceRecords',
  'law.kql.ApiManagementGatewayLlmLog', 'law.kql.TraceRecords',
].map(id));

const ROLE_MONITOR = 'Monitoring Reader';
const ROLE_LAW = 'Log Analytics Reader';
const WS_ID_RE = /^\/subscriptions\/([^/]+)\/resourcegroups\/([^/]+)\/providers\/microsoft\.operationalinsights\/workspaces\/([^/]+)$/i;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** "GatewayLlmLogs" -> ["gateway","llm","logs"]; whole camel-case words, so "AllMetrics" is not an "llm" hit. */
const camelTokens = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).map((t) => t.toLowerCase());
const NEAR_TOKENS = ['llm', 'generative', 'genai', 'ai'];

export function parseWorkspaceId(resourceId) {
  const m = WS_ID_RE.exec(String(resourceId || ''));
  return m ? { subscriptionId: m[1], resourceGroup: m[2], name: m[3] } : null;
}

function failureCell(cellId, res, role, scope, required = true) {
  return unknown(cellId, reasonForFailure(res, { role, scope }) ?? 'tooling-error', { required, evidence: quote(res) });
}

function tablesUrl(ctx, ws) {
  const e = encodeURIComponent;
  return `${ctx.cloud.arm}/subscriptions/${e(ws.subscriptionId)}/resourceGroups/${e(ws.resourceGroup)}`
    + `/providers/Microsoft.OperationalInsights/workspaces/${e(ws.name)}/tables?api-version=${API.logAnalyticsMgmt}`;
}

/** Names of a table's columns from either place the list can put them. */
function columnNames(table) {
  const schema = table?.properties?.schema;
  if (!schema) return null;
  const cols = [...(Array.isArray(schema.columns) ? schema.columns : []), ...(Array.isArray(schema.standardColumns) ? schema.standardColumns : [])];
  if (cols.length === 0) return null;
  return cols.map((c) => c?.name).filter((n) => typeof n === 'string');
}

/** 1. diagnostic settings on the APIM, 2. workspaces in its resource group, 3. nothing. */
async function discoverWorkspaces(ctx) {
  const seen = new Map();
  const evidence = { diagnosticSettings: [], diagnosticSettingsRead: null, resourceGroupScan: null };
  let firstFailure = null;

  const ds = await ctx.client.request({ service: 'arm', url: armUrl(ctx, '/providers/Microsoft.Insights/diagnosticSettings', API.diag) });
  evidence.diagnosticSettingsRead = { status: ds.status };
  if (ds.ok && Array.isArray(ds.json?.value)) {
    for (const s of ds.json.value) {
      const p = s?.properties || {};
      const enabled = (Array.isArray(p.logs) ? p.logs : []).filter((l) => l?.enabled).map((l) => l.category || `group:${l.categoryGroup}`);
      evidence.diagnosticSettings.push({
        name: s?.name ?? null,
        routesToWorkspace: Boolean(p.workspaceId),
        destinationType: p.workspaceId ? (p.logAnalyticsDestinationType === 'Dedicated' ? 'resource-specific' : 'AzureDiagnostics (legacy)') : null,
        enabledLogCategories: enabled,
      });
      const ws = parseWorkspaceId(p.workspaceId);
      if (ws) seen.set(`${ws.subscriptionId}/${ws.resourceGroup}/${ws.name}`.toLowerCase(), { ...ws, source: 'diagnostic-setting', customerId: null });
    }
  } else if (!ds.ok) {
    firstFailure = ds;
  }

  if (seen.size === 0) {
    const url = `${ctx.cloud.arm}/subscriptions/${encodeURIComponent(ctx.subscriptionId)}/resourceGroups/${encodeURIComponent(ctx.apim.resourceGroup)}`
      + `/providers/Microsoft.OperationalInsights/workspaces?api-version=${API.logAnalyticsMgmt}`;
    const scan = await listAll(ctx, url);
    evidence.resourceGroupScan = { status: scan.last?.status ?? null, found: scan.ok ? scan.items.length : null };
    if (scan.ok) {
      for (const w of scan.items) {
        const ws = parseWorkspaceId(w?.id);
        if (ws) seen.set(`${ws.subscriptionId}/${ws.resourceGroup}/${ws.name}`.toLowerCase(), { ...ws, source: 'resource-group-scan', customerId: w?.properties?.customerId ?? null });
      }
    } else if (!firstFailure) {
      firstFailure = scan.last;
    }
  }
  return { workspaces: [...seen.values()].slice(0, 3), evidence, firstFailure, dsOk: ds.ok };
}

/** Table list for one workspace -> what it says about the two tables. */
async function checkTables(ctx, ws) {
  const r = await listAll(ctx, tablesUrl(ctx, ws));
  if (!r.ok) return { ok: false, last: r.last };
  const byName = new Map(r.items.map((t) => [t?.name, t]));
  const gw = byName.get('ApiManagementGatewayLogs');
  const cols = gw ? columnNames(gw) : null;
  return {
    ok: true,
    count: r.items.length,
    llmTable: byName.has('ApiManagementGatewayLlmLog'),
    gatewayLogsTable: Boolean(gw),
    // null = the table is listed but its schema was not returned: INCONCLUSIVE, not "absent".
    traceRecords: gw ? (cols === null ? null : cols.includes('TraceRecords')) : null,
    traceRecordsFromAbsentTable: !gw,
  };
}

async function workspaceCustomerId(ctx, ws) {
  if (ws.customerId) return ws.customerId;
  const e = encodeURIComponent;
  const url = `${ctx.cloud.arm}/subscriptions/${e(ws.subscriptionId)}/resourceGroups/${e(ws.resourceGroup)}`
    + `/providers/Microsoft.OperationalInsights/workspaces/${e(ws.name)}?api-version=${API.logAnalyticsMgmt}`;
  const r = await ctx.client.request({ service: 'arm', url });
  return r.ok ? (r.json?.properties?.customerId ?? null) : null;
}

/** Secondary evidence: KQL getschema through the Log Analytics query API. */
async function kqlSchema(ctx, ws, table, column) {
  const customerId = await workspaceCustomerId(ctx, ws);
  if (!customerId || !GUID_RE.test(customerId)) return { kind: 'no-workspace-id' };
  const query = column
    ? `${table} | getschema | where ColumnName == '${column}' | project ColumnName`
    : `${table} | getschema | project ColumnName | take 1`;
  const r = await ctx.client.request({
    service: 'logs', method: 'POST', timeoutMs: 20000,
    url: `${ctx.cloud.logAnalytics}/v1/workspaces/${customerId}/query`,
    body: { query },
  });
  if (r.ok) {
    const rows = r.json?.tables?.[0]?.rows;
    if (!Array.isArray(rows)) return { kind: 'malformed', res: r };
    return { kind: 'answered', present: rows.length > 0, res: r };
  }
  if (r.status === 400 && /failed to resolve|could not be resolved|SEM0100|not found/i.test(r.errorMessage || '')) return { kind: 'table-missing', res: r };
  return { kind: 'failed', res: r };
}

const INCONCLUSIVE = 'absent (INCONCLUSIVE: diagnostics may simply be unwired; only diag.categories answers availability)';
const KQL_NO_ROW = 'absent (INCONCLUSIVE: getschema returned no row; diagnostics may simply be unwired)';

export async function run(ctx, acc) {
  const { cells, controls } = acc;
  const a = ctx.apim;

  // ---- APIM facts (the list call already read them; its status is quoted) ----
  const fact = (name, v) => measured(id(`apim.${name}`), v === undefined || v === null || v === '' ? 'not returned by the service resource' : v, { http: a.httpStatus });
  cells.push(fact('sku', a.sku), fact('capacity', a.capacity), fact('provisioningState', a.provisioningState),
    fact('location', a.location), fact('virtualNetworkType', a.virtualNetworkType), fact('publicNetworkAccess', a.publicNetworkAccess));

  // ---- gateway reachability ----
  const gw = await probeGateway(ctx);
  cells.push(measured(
    id('gateway.reachability'),
    gw.reachable ? `reachable (status endpoint answered HTTP ${gw.status})` : `unreachable from this runner (error class: ${gw.errorClass})`,
    { http: gw.reachable ? gw.status : null, source: gw.reachable ? null : 'network-probe', dataPlane: true, evidence: { runner: ctx.runner, virtualNetworkType: a.virtualNetworkType ?? null, errorClass: gw.errorClass } },
  ));

  // ---- diagnostic categories ----
  const catRes = await ctx.client.request({ service: 'arm', url: armUrl(ctx, '/providers/Microsoft.Insights/diagnosticSettingsCategories', API.diag) });
  if (!catRes.ok) {
    cells.push(failureCell(id('diag.categories'), catRes, ROLE_MONITOR, 'apim'), failureCell(id('diag.GatewayLlmLogs'), catRes, ROLE_MONITOR, 'apim'));
    controls.push({ id: 'categories-contain-GatewayLogs', status: 'unrunnable', detail: `category list not readable (HTTP ${catRes.status ?? 'network'})` });
  } else if (!Array.isArray(catRes.json?.value)) {
    controls.push({ id: 'categories-contain-GatewayLogs', status: 'failed', detail: 'HTTP 200 without a value[] array: not a category list' });
    cells.push(unknown(id('diag.categories'), 'tooling-error', { evidence: { note: '200 without value[]' } }), unknown(id('diag.GatewayLlmLogs'), 'tooling-error', { evidence: { note: '200 without value[]' } }));
  } else {
    const list = catRes.json.value;
    const names = list.map((v) => v?.name).filter((n) => typeof n === 'string');
    const logs = list.filter((v) => (v?.properties?.categoryType ?? 'Logs') === 'Logs').map((v) => v?.name).filter((n) => typeof n === 'string').sort();
    const metrics = list.filter((v) => v?.properties?.categoryType === 'Metrics').map((v) => v?.name).filter((n) => typeof n === 'string').sort();
    // CONTROL: a real APIM category list always carries GatewayLogs. A list without it is not the list.
    const hasGatewayLogs = names.includes('GatewayLogs');
    controls.push({
      id: 'categories-contain-GatewayLogs',
      status: hasGatewayLogs ? 'passed' : 'failed',
      detail: hasGatewayLogs ? 'GatewayLogs is in the category list' : `GatewayLogs is NOT in a ${names.length}-entry list: this is not a usable APIM category list`,
    });
    cells.push(measured(id('diag.categories'), { logs, metrics, total: names.length }, { http: catRes.status }));
    const present = names.includes('GatewayLlmLogs');
    cells.push(measured(id('diag.GatewayLlmLogs'), present ? 'present' : 'absent', {
      http: catRes.status,
      evidence: {
        pastedCategoryNames: names.slice().sort(),
        nearMatches: names.filter((n) => n !== 'GatewayLlmLogs' && camelTokens(n).some((t) => NEAR_TOKENS.includes(t))),
      },
    }));
  }

  // ---- workspace discovery and table evidence ----
  const found = await discoverWorkspaces(ctx);
  if (found.workspaces.length === 0) {
    const r = found.firstFailure
      ? reasonForFailure(found.firstFailure, { role: ROLE_MONITOR, scope: 'apim' }) ?? 'workspace-not-discovered'
      : 'workspace-not-discovered';
    for (const name of ['law.discovered', 'law.table.ApiManagementGatewayLlmLog', 'law.column.TraceRecords']) {
      cells.push(unknown(id(name), r, { evidence: { ...found.evidence, firstFailure: found.firstFailure ? quote(found.firstFailure) : null } }));
    }
    for (const name of ['law.kql.ApiManagementGatewayLlmLog', 'law.kql.TraceRecords']) {
      cells.push(unknown(id(name), r, { required: false, evidence: { note: 'no workspace to query' } }));
    }
    return;
  }

  cells.push(measured(id('law.discovered'), `${found.workspaces.length} workspace(s) via ${found.workspaces[0].source}`, {
    http: 200,
    evidence: { ...found.evidence, workspaceNames: found.workspaces.map((w) => w.name) },
  }));

  const per = [];
  for (const ws of found.workspaces) per.push({ ws, t: await checkTables(ctx, ws) });
  const okOnes = per.filter((p) => p.t.ok);
  const firstBad = per.find((p) => !p.t.ok);
  const wsEvidence = per.map((p) => ({ workspace: p.ws.name, listed: p.t.ok, tableCount: p.t.count ?? null, status: p.t.ok ? 200 : p.t.last?.status ?? null }));

  if (okOnes.some((p) => p.t.llmTable)) {
    cells.push(measured(id('law.table.ApiManagementGatewayLlmLog'), 'present', { http: 200, evidence: { workspaces: wsEvidence } }));
  } else if (!firstBad) {
    cells.push(measured(id('law.table.ApiManagementGatewayLlmLog'), INCONCLUSIVE, { http: 200, evidence: { workspaces: wsEvidence } }));
  } else {
    cells.push(failureCell(id('law.table.ApiManagementGatewayLlmLog'), firstBad.t.last, ROLE_LAW, 'workspace'));
  }

  if (okOnes.some((p) => p.t.traceRecords === true)) {
    cells.push(measured(id('law.column.TraceRecords'), 'present', { http: 200, evidence: { workspaces: wsEvidence } }));
  } else if (!firstBad && okOnes.every((p) => p.t.traceRecords === false)) {
    cells.push(measured(id('law.column.TraceRecords'), 'absent (table ApiManagementGatewayLogs listed, column not in its schema)', { http: 200, evidence: { workspaces: wsEvidence } }));
  } else if (!firstBad) {
    cells.push(measured(id('law.column.TraceRecords'), INCONCLUSIVE, { http: 200, evidence: { workspaces: wsEvidence, note: 'table not listed, or listed without a schema' } }));
  } else {
    cells.push(failureCell(id('law.column.TraceRecords'), firstBad.t.last, ROLE_LAW, 'workspace'));
  }

  // ---- secondary: KQL getschema, only where the query endpoint answers ----
  const target = found.workspaces[0];
  for (const [name, table, column] of [['law.kql.ApiManagementGatewayLlmLog', 'ApiManagementGatewayLlmLog', null], ['law.kql.TraceRecords', 'ApiManagementGatewayLogs', 'TraceRecords']]) {
    const k = await kqlSchema(ctx, target, table, column);
    if (k.kind === 'answered') {
      cells.push(measured(id(name), k.present ? 'present' : KQL_NO_ROW, { http: k.res.status, required: false, evidence: { workspace: target.name } }));
    } else if (k.kind === 'table-missing') {
      cells.push(measured(id(name), INCONCLUSIVE, { http: k.res.status, required: false, evidence: { workspace: target.name, message: sanitize(k.res.errorMessage, 300) } }));
    } else if (k.kind === 'failed') {
      cells.push(unknown(id(name), reasonForFailure(k.res, { role: ROLE_LAW, scope: 'workspace' }) ?? 'tooling-error', { required: false, evidence: { ...quote(k.res), networkErrorClass: k.res.networkErrorClass } }));
    } else {
      cells.push(unknown(id(name), 'tooling-error', { required: false, evidence: { note: k.kind === 'malformed' ? '200 without tables[0].rows' : 'workspace id not available' } }));
    }
  }
}
