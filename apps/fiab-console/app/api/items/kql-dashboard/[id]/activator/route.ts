/**
 * GET  /api/items/kql-dashboard/[id]/activator
 *   → { ok, workspaceId, activatorId?, activatorName?, rules? }
 *     When the dashboard has a linked activatorId, its rules are read from the
 *     Cosmos activator item (the Azure-native default store).
 *
 * POST /api/items/kql-dashboard/[id]/activator  body:
 *   { ruleName?, tileTitle, tileKql, dataSourceId?, database?,
 *     fireOn?: 'rows' | 'condition', property?, operator?, threshold?,
 *     evaluationFrequency?, windowSize?, severity?, action?: { target },
 *     parameters?, timeRange?, baseQueries?, dataSources? }
 *   → { ok, activatorId, activatorName, ruleId, rule, backend, database,
 *       preview? | previewError? }
 *
 * Fabric Real-Time Dashboard "Set alert on this tile" parity, on the
 * ADX-native Activator runtime (per .claude/rules/no-fabric-dependency.md):
 * the tile's KQL (with the dashboard's base queries, parameters, and time
 * range substituted server-side via the SAME buildTileKql the /run route
 * uses) becomes a REAL Activator rule with sourceKind:'adx' — evaluated
 * against the tile's resolved KQL database on the Azure Data Explorer
 * cluster via kusto-client. The route lazily creates (and links) a backing
 * `activator` item the first time (state.activatorId on the dashboard),
 * identical to the eventstream "Add alert" quick-create, so the rule lands
 * in the same store the activator/[id]/rules editor reads. When
 * LOOM_ADX_ALERT_SCOPE is provisioned the rule ALSO gets a real Azure
 * Monitor scheduledQueryRule scoped to the cluster (hands-off continuous
 * evaluation); otherwise the record carries the honest on-demand note.
 * No Fabric workspace, Reflex, or Power BI anywhere on this path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem, updateOwnedItem, createOwnedItem } from '../../../_lib/item-crud';
import {
  createMonitorActivatorRule, triggerMonitorActivatorRule, type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { monitorGate, type MonitorGateBodies } from '@/lib/azure/monitor-gate';
import { KustoError, resolveDashboardDatabase, type KustoItem } from '@/lib/azure/kusto-client';
import { buildTileKql, resolveTileDatabase, sanitizeModel } from '@/lib/azure/kql-dashboard-model';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'kql-dashboard';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}

/** Honest Azure infra-gate (NOT a Fabric gate) for Monitor errors. */
const monitorGateBodies: MonitorGateBodies = {
  notConfigured: (missing) => ({ error: `Azure Monitor not configured: set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_ALERT_RG'}.`,
      gate: { reason: 'The Azure-native Activator creates scheduled-query alert rules on Azure Monitor.', remediation: `Set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.` },
    }),
  unauthorized: (status) => ({ error: `Azure Monitor ${status}: not authorized to create alert rules.`,
      gate: { reason: 'The Console UAMI needs rights on the alert resource group.', remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create scheduledQueryRules + action groups.' },
    }),
};

function mapOp(op?: string): string {
  switch ((op || '').toLowerCase()) {
    case 'lt': case '<': return '<';
    case 'gte': case '>=': return '>=';
    case 'lte': case '<=': return '<=';
    case 'ne': case '!=': return '!=';
    case 'eq': case '==': return '==';
    case 'contains': return 'contains';
    case 'gt': case '>': default: return '>';
  }
}

/**
 * Compose the alert KQL from the tile's substituted KQL. `fireOn:'rows'` uses
 * the tile query verbatim (rule fires when it returns ≥1 row — the Fabric RTD
 * "results are returned" condition). `fireOn:'condition'` appends a
 * column-safe threshold predicate over the tile's RESULT columns
 * (column_ifexists resolves against the pipeline schema at that stage, so a
 * renamed/absent column yields no rows — never a query error).
 */
function composeTileAlertQuery(
  tileKql: string,
  fireOn: 'rows' | 'condition',
  cond: { property?: string; operator?: string; threshold?: string },
): string {
  const base = tileKql.trim();
  if (fireOn !== 'condition') return base;
  const prop = (cond.property || 'value').trim().replace(/"/g, '\\"');
  const op = mapOp(cond.operator);
  const raw = String(cond.threshold ?? '0').trim();
  const numeric = /^-?\d+(\.\d+)?$/.test(raw) && op !== 'contains';
  const safeCol = `column_ifexists("${prop}", dynamic(null))`;
  const lhs = numeric ? `todouble(${safeCol})` : `tostring(${safeCol})`;
  const val = numeric ? raw : `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${base}\n| extend _v = ${lhs}\n| where _v ${op} ${val}`;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, workspaceId: null, activatorId: null, rules: [] });

  const dash = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!dash) return err('dashboard not found', 404, 'not_found');
  const state = (dash.state || {}) as Record<string, unknown>;
  const activatorId = (state.activatorId as string) || null;
  if (!activatorId) return NextResponse.json({ ok: true, workspaceId: dash.workspaceId, activatorId: null, rules: [] });

  const act = await loadOwnedItem(activatorId, 'activator', session.claims.oid);
  const rules = Array.isArray((act?.state as any)?.rules) ? (act!.state as any).rules : [];
  return NextResponse.json({
    ok: true,
    workspaceId: dash.workspaceId,
    activatorId,
    activatorName: act?.displayName || null,
    rules,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the dashboard before setting an alert (no id yet)', 400, 'no_id');

  const body = await req.json().catch(() => ({} as any));
  const tileKqlRaw = typeof body?.tileKql === 'string' ? body.tileKql.trim() : '';
  if (!tileKqlRaw) return err('tileKql required — the tile has no KQL to alert on', 400, 'no_kql');
  const tileTitle = (typeof body?.tileTitle === 'string' && body.tileTitle.trim()) ? body.tileTitle.trim().slice(0, 200) : 'Tile';
  const fireOn: 'rows' | 'condition' = body?.fireOn === 'condition' ? 'condition' : 'rows';
  const property = typeof body?.property === 'string' && body.property.trim() ? body.property.trim() : 'value';
  const operator = typeof body?.operator === 'string' ? body.operator : 'gt';
  const threshold = body?.threshold !== undefined ? String(body.threshold) : '0';
  const evaluationFrequency = typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : 'PT5M';
  const windowSize = typeof body?.windowSize === 'string' ? body.windowSize : evaluationFrequency;
  const severity = typeof body?.severity === 'number' ? body.severity : 3;
  const action = body?.action && typeof body.action === 'object' ? body.action : undefined;

  const dash = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!dash) return err('dashboard not found', 404, 'not_found');
  const state = { ...((dash.state || {}) as Record<string, unknown>) };
  const dashName = dash.displayName || 'Real-Time Dashboard';

  // Resolve the tile's database exactly like /run does: explicit tile override
  // → bound data source → the dashboard's resolved database (which follows a
  // bundle-provisioned sibling kql-database when present).
  const model = sanitizeModel({
    tiles: [],
    dataSources: body?.dataSources,
    parameters: body?.parameters,
    baseQueries: body?.baseQueries,
    timeRange: body?.timeRange,
  });
  const fallbackDb = await resolveDashboardDatabase(dash as unknown as KustoItem);
  const database = resolveTileDatabase(
    {
      title: tileTitle,
      kql: tileKqlRaw,
      viz: 'table',
      database: typeof body?.database === 'string' ? body.database : undefined,
      dataSourceId: typeof body?.dataSourceId === 'string' ? body.dataSourceId : undefined,
    },
    model.dataSources,
    fallbackDb,
  );
  const boundSource = typeof body?.dataSourceId === 'string'
    ? model.dataSources.find((d) => d.id === body.dataSourceId)
    : undefined;
  const adxClusterUri = boundSource?.clusterUri;

  // Substitute base queries + parameters + the global time range so the rule's
  // KQL is self-contained (relative ago() bounds stay meaningful per tick).
  const substituted = buildTileKql(tileKqlRaw, model.parameters, model.timeRange, model.baseQueries);
  const query = composeTileAlertQuery(substituted, fireOn, { property, operator, threshold });

  const ruleName = (typeof body?.ruleName === 'string' && body.ruleName.trim())
    ? body.ruleName.trim().slice(0, 60)
    : `${tileTitle}-alert`.slice(0, 60);

  // 1. Lazily create the backing Azure-native (Cosmos) activator item and link
  //    it onto the dashboard (state.activatorId) — the same pattern the
  //    eventstream "Add alert" quick-create uses. Subsequent tile alerts on
  //    this dashboard reuse the linked Activator.
  let activatorId = (state.activatorId as string) || '';
  if (activatorId) {
    // A dangling link (activator deleted) must not brick Set-alert — recreate.
    const existing = await loadOwnedItem(activatorId, 'activator', session.claims.oid);
    if (!existing) activatorId = '';
  }
  if (!activatorId) {
    const created = await createOwnedItem(session, 'activator', {
      workspaceId: dash.workspaceId,
      displayName: `Dashboard alerts — ${dashName}`.slice(0, 120),
      description: `Real-Time Dashboard tile alerts for ${dash.id}`,
      state: {
        content: { kind: 'activator' },
        rules: [],
        sourceDashboardId: dash.id,
        sourceDashboardName: dashName,
      },
    });
    if (!created.ok) return err(created.error, created.status, 'activator_create_failed');
    activatorId = created.item.id;
    state.activatorId = activatorId;
    state.activatorWorkspaceId = dash.workspaceId;
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state });
  }

  // 2. Create the rule on the ADX-native Activator runtime. sourceKind:'adx'
  //    routes evaluation through kusto-client against the tile's database; when
  //    LOOM_ADX_ALERT_SCOPE is set a real ADX-scoped Azure Monitor
  //    scheduledQueryRule is ALSO provisioned for hands-off evaluation.
  const act = await loadOwnedItem(activatorId, 'activator', session.claims.oid);
  if (!act) return err('backing activator not found', 404, 'activator_not_found');
  let rule: MonitorRuleRecord;
  try {
    rule = await createMonitorActivatorRule(act.displayName, {
      name: ruleName,
      query,
      // Condition metadata only for threshold rules; a fire-on-any-rows rule is
      // its verbatim query (no condition), so a later structured Edit in the
      // Activator editor can never silently rebuild-away the tile KQL.
      ...(fireOn === 'condition' ? { condition: { property, operator, value: threshold } } : {}),
      evaluationFrequency,
      windowSize,
      severity,
      action,
      sourceKind: 'adx',
      adxDatabase: database,
      ...(adxClusterUri ? { adxClusterUri } : {}),
    });
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // 3. Persist the rule onto the Cosmos activator item (same store the
  //    activator/[id]/rules default branch reads). Stamp dashboard provenance.
  const rules: MonitorRuleRecord[] = Array.isArray((act.state as any)?.rules) ? (act.state as any).rules : [];
  const stampedRule = {
    ...rule,
    sourceDashboardId: dash.id,
    sourceDashboardName: dashName,
    sourceTileTitle: tileTitle,
  } as MonitorRuleRecord & Record<string, unknown>;
  const nextRules = [...rules.filter((r) => r.id !== rule.id), stampedRule];
  const items = await itemsContainer();
  const nextItem: WorkspaceItem = { ...act, state: { ...(act.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
  await items.item(act.id, act.workspaceId).replace(nextItem);

  // 4. Best-effort live receipt: evaluate the rule NOW against the real ADX
  //    cluster (the same Trigger/Preview path the Activator editor runs) so the
  //    dialog can show "would fire now: yes/no (N rows)". A Kusto failure here
  //    is non-fatal (the rule is created) but surfaces the honest remediation.
  let preview: { count: number; fired: boolean } | undefined;
  let previewError: string | undefined;
  try {
    const out = await triggerMonitorActivatorRule(stampedRule);
    preview = { count: out.count, fired: out.fired };
  } catch (e: any) {
    previewError = e instanceof KustoError
      ? `${e.message} — set LOOM_KUSTO_CLUSTER_URI / grant the Console UAMI Database Viewer on the ADX cluster to evaluate rules. No Microsoft Fabric required.`
      : (e?.message || String(e));
  }

  return NextResponse.json({
    ok: true,
    activatorId,
    activatorName: act.displayName,
    ruleId: rule.id,
    rule: stampedRule,
    backend: 'azure-monitor',
    sourceKind: 'adx',
    database,
    scheduled: rule.scheduled === true,
    note: rule.note,
    ...(preview ? { preview } : {}),
    ...(previewError ? { previewError } : {}),
  });
}
