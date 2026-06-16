/**
 * GET  /api/items/eventstream/[id]/activator
 *   → { ok, workspaceId, activatorId?, activatorName?, rules? }
 *     When the eventstream has a linked activatorId, its rules are read from the
 *     Cosmos activator item (the Azure-native default store).
 *
 * POST /api/items/eventstream/[id]/activator  body:
 *   { ruleName?, threshold?, operator?, property?, evaluationFrequency?,
 *     windowSize?, severity?, action?: { target } }
 *   → { ok, activatorId, activatorName, ruleId, rule, backend }
 *
 * Wires the EventstreamEditor ribbon's "Add alert" quick-create. It lazily
 * creates (and links) a REAL backing `activator` item the first time, then
 * pre-seeds an Azure Monitor scheduledQueryRule whose KQL watches the
 * eventstream's source events. The created alert is linked back onto the
 * eventstream via state.activatorId so subsequent calls reuse it.
 *
 * Per .claude/rules/no-fabric-dependency.md the DEFAULT is the Azure-native
 * Monitor backend — no Fabric Activator / Reflex required. A Fabric Reflex
 * remains an opt-in alternative (LOOM_ACTIVATOR_BACKEND=fabric); this route
 * always uses the Azure-native path (it persists rules on the Cosmos activator
 * item, identical to the activator/[id]/rules + ontology activator branches).
 *
 * The alert is "pre-seeded with the stream source": the rule's KQL is composed
 * from the eventstream's first source node (its name + kind), so the alert is
 * ready to fire against that stream's events table the moment it is created.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem, updateOwnedItem, createOwnedItem } from '../../../_lib/item-crud';
import {
  createMonitorActivatorRule, type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'eventstream';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

/** Honest Azure infra-gate (NOT a Fabric gate) for Monitor errors. */
function monitorGate(e: any): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_ALERT_RG'}.`,
      gate: { reason: 'The Azure-native Activator creates scheduled-query alert rules on Azure Monitor.', remediation: `Set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.` },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to create alert rules.`,
      gate: { reason: 'The Console UAMI needs rights on the alert resource group.', remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create scheduledQueryRules + action groups.' },
    }, { status: 403 });
  }
  return null;
}

/** Resolve the eventstream's first source node ({ kind, name, ... }) from
 *  whatever shape the topology is persisted in (sources[] | source | content). */
function firstSource(item: WorkspaceItem): { kind: string; name: string } | null {
  const st = (item.state || {}) as Record<string, any>;
  const arr = Array.isArray(st.sources) ? st.sources : (st.source ? [st.source] : []);
  if (arr.length && arr[0] && typeof arr[0] === 'object') {
    return { kind: String(arr[0].kind || 'eventhub'), name: String(arr[0].name || 'source-1') };
  }
  // Bundle-installed topology stranded on state.content.sources[].
  const content = st.content;
  if (content && Array.isArray(content.sources) && content.sources[0]) {
    const n = content.sources[0];
    return { kind: String(n.type || 'eventhub'), name: String(n.id || n.type || 'source-1') };
  }
  return null;
}

/**
 * Pre-seed the alert KQL from the eventstream's source. Eventstream events land
 * in a Log Analytics custom table (Azure-native default: Event Hubs → diagnostic
 * / Stream Analytics → custom log). The default table is configurable via
 * LOOM_EVENTSTREAM_EVENTS_TABLE (falls back to LOOM_ACTIVATOR_DEFAULT_TABLE,
 * then 'AppEvents_CL'). The query scopes to the stream's source name so the
 * alert watches THIS stream's events out of the box. Caller can refine the
 * property/operator/threshold via the dialog.
 */
function buildStreamAlertQuery(
  streamName: string,
  source: { kind: string; name: string } | null,
  cond: { property?: string; operator?: string; threshold?: number | string; sourceTable?: string },
): string {
  // Real, always-present App Insights table by default (NOT the phantom
  // `AppEvents_CL`). Caller may override per-rule via body.sourceTable, or
  // deployment-wide via LOOM_EVENTSTREAM_EVENTS_TABLE / LOOM_ACTIVATOR_DEFAULT_TABLE.
  const table =
    ((cond.sourceTable && String(cond.sourceTable).trim()) ||
      process.env.LOOM_EVENTSTREAM_EVENTS_TABLE ||
      process.env.LOOM_ACTIVATOR_DEFAULT_TABLE ||
      'AppEvents').trim() || 'AppEvents';
  const srcName = source?.name ? String(source.name).replace(/"/g, '\\"') : '';
  const op = mapOp(cond.operator);
  const prop = (cond.property && String(cond.property).trim()) || 'value';
  const val = formatVal(cond.threshold);
  // column-safe accessors (column_ifexists + Properties bag fallback) so the
  // rule VALIDATES / provisions against a real table whose literal columns may
  // not exist — instead of a SEM0100 that surfaces as a 502.
  const safe = (c: string) =>
    `column_ifexists("${c}", tostring(parse_json(tostring(column_ifexists("Properties", dynamic({}))))["${c}"]))`;
  const lines = [
    `// Loom Eventstream alert — stream "${streamName.replace(/"/g, '\\"')}"`,
    `// pre-seeded source: ${source ? `${source.kind} "${source.name}"` : '(no source yet)'}`,
    table,
    `| extend _src = ${safe('source')}, _streamSource = ${safe('streamSource_s')}, _v = ${safe(prop)}`,
  ];
  if (srcName) lines.push(`| where _src == "${srcName}" or _streamSource == "${srcName}"`);
  lines.push(`| where _v ${op} ${val}`);
  return lines.join('\n');
}

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

function formatVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '0';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, workspaceId: null, activatorId: null, rules: [] });

  const es = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!es) return err('eventstream not found', 404, 'not_found');
  const state = (es.state || {}) as Record<string, unknown>;
  const activatorId = (state.activatorId as string) || null;
  if (!activatorId) return NextResponse.json({ ok: true, workspaceId: es.workspaceId, activatorId: null, rules: [] });

  const act = await loadOwnedItem(activatorId, 'activator', session.claims.oid);
  const rules = Array.isArray((act?.state as any)?.rules) ? (act!.state as any).rules : [];
  return NextResponse.json({
    ok: true,
    workspaceId: es.workspaceId,
    activatorId,
    activatorName: act?.displayName || null,
    rules,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the eventstream before adding an alert (no id yet)', 400, 'no_id');

  const body = await req.json().catch(() => ({} as any));
  const property = typeof body?.property === 'string' && body.property.trim() ? body.property.trim() : 'value';
  const operator = typeof body?.operator === 'string' ? body.operator : 'gt';
  const threshold = body?.threshold ?? 0;
  const evaluationFrequency = typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : 'PT5M';
  const windowSize = typeof body?.windowSize === 'string' ? body.windowSize : 'PT5M';
  const severity = typeof body?.severity === 'number' ? body.severity : 3;
  const action = body?.action && typeof body.action === 'object' ? body.action : undefined;
  // Optional per-rule source table override (e.g. an eventstream's own custom
  // log table). Falls back to LOOM_EVENTSTREAM_EVENTS_TABLE / default below.
  const sourceTable = typeof body?.sourceTable === 'string' && body.sourceTable.trim() ? body.sourceTable.trim() : undefined;

  const es = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!es) return err('eventstream not found', 404, 'not_found');
  const state = { ...((es.state || {}) as Record<string, unknown>) };

  const source = firstSource(es);
  const streamName = es.displayName || 'Eventstream';
  const ruleName = (typeof body?.ruleName === 'string' && body.ruleName.trim())
    ? body.ruleName.trim()
    : `${streamName}-alert`.slice(0, 60);

  // 1. Lazily create the backing Azure-native (Cosmos) activator item and link
  //    it onto the eventstream (state.activatorId). Pre-seed it with the stream
  //    source so the linked Activator records what stream it watches.
  let activatorId = (state.activatorId as string) || '';
  if (!activatorId) {
    const created = await createOwnedItem(session, 'activator', {
      workspaceId: es.workspaceId,
      displayName: `Eventstream alerts — ${streamName}`,
      description: `Streaming alerts for eventstream ${es.id}`,
      state: {
        content: { kind: 'activator' },
        rules: [],
        sourceEventstreamId: es.id,
        sourceEventstreamName: streamName,
        ...(source ? { sourceNode: source } : {}),
      },
    });
    if (!created.ok) return err(created.error, created.status, 'activator_create_failed');
    activatorId = created.item.id;
    state.activatorId = activatorId;
    state.activatorWorkspaceId = es.workspaceId;
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state });
  }

  // 2. Create the REAL Azure Monitor scheduledQueryRule pre-seeded with the
  //    stream source's KQL.
  const act = await loadOwnedItem(activatorId, 'activator', session.claims.oid);
  if (!act) return err('backing activator not found', 404, 'activator_not_found');
  const query = buildStreamAlertQuery(streamName, source, { property, operator, threshold, sourceTable });
  let rule: MonitorRuleRecord;
  try {
    rule = await createMonitorActivatorRule(act.displayName, {
      name: ruleName,
      query,
      condition: { property, operator, value: threshold },
      evaluationFrequency,
      windowSize,
      severity,
      action,
    });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // 3. Persist the rule onto the Cosmos activator item (same store the
  //    activator/[id]/rules default branch reads from). Stamp eventstream
  //    provenance alongside the monitor record.
  const rules: MonitorRuleRecord[] = Array.isArray((act.state as any)?.rules) ? (act.state as any).rules : [];
  const stampedRule = {
    ...rule,
    sourceEventstreamId: es.id,
    sourceEventstreamName: streamName,
    ...(source ? { sourceNode: source } : {}),
  } as MonitorRuleRecord & Record<string, unknown>;
  const nextRules = [...rules.filter((r) => r.id !== rule.id), stampedRule];
  const items = await itemsContainer();
  const nextItem: WorkspaceItem = { ...act, state: { ...(act.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
  await items.item(act.id, act.workspaceId).replace(nextItem);

  return NextResponse.json({
    ok: true,
    activatorId,
    activatorName: act.displayName,
    ruleId: rule.id,
    rule: stampedRule,
    backend: 'azure-monitor',
    source: source || null,
  });
}
