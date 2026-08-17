/**
 * GET  /api/items/activator/[id]/rules?workspaceId=...
 * POST /api/items/activator/[id]/rules?workspaceId=...  body { name, condition?, action?, query?, sourceTable?, severity?, evaluationFrequency?, windowSize? }
 * POST /api/items/activator/[id]/rules?workspaceId=&trigger=<ruleId>   — trigger a rule run
 *
 * Backend (per .claude/rules/no-fabric-dependency.md): the DEFAULT is the
 * Azure-native Azure Monitor backend — each Loom activator rule is a real
 * Microsoft.Insights/scheduledQueryRule (+ action group) and "trigger" runs the
 * rule's KQL against the Log Analytics workspace now. Rules persist on the
 * Cosmos activator item (state.rules). A Fabric Reflex is an OPT-IN alternative
 * selected with LOOM_ACTIVATOR_BACKEND=fabric — only then do we call
 * api.fabric.microsoft.com. No Fabric workspace is required for the default.
 *
 * #3551 — GET is SELF-HEALING. When state.rules is empty it reconciles against
 * the live scheduledQueryRules before falling back to the static bundle
 * projection, so an activator whose install created real alert rules but lost
 * the record shows those rules (and can act on them) instead of an empty list.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  listRules, addRule, triggerRule, setTriggerState, deleteTrigger, ActivatorError,
} from '@/lib/azure/activator-client';
import {
  createMonitorActivatorRule, triggerMonitorActivatorRule,
  enableMonitorRule, disableMonitorRule, deleteMonitorActivatorRule,
  isOnDemandAdxRule, appendRunHistory, safeRuleName,
  type MonitorRuleRecord, type OnDemandRunRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError, listScheduledQueryRules, type ScheduledQueryRule } from '@/lib/azure/monitor-client';
import { monitorGate, type MonitorGateBodies } from '@/lib/azure/monitor-gate';
import { KustoError } from '@/lib/azure/kusto-client';
import { loadContentBackedItem, activatorRuleFromContent } from '../../../_lib/ai-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const useFabric = () => process.env.LOOM_ACTIVATOR_BACKEND === 'fabric';

/** Bundle fallback: project state.content.rule into the editor's rule shape so a
 *  freshly-installed activator renders FULLY BUILT-OUT before any live rule. */
async function bundleRules(id: string, tenantId: string) {
  const item = await loadContentBackedItem(id, 'activator', tenantId);
  if (!item) return null;
  const rule = activatorRuleFromContent(item);
  return rule ? [rule] : null;
}

/**
 * #3551 self-heal — rebuild the Loom rule records from the LIVE Azure Monitor
 * scheduledQueryRules when `state.rules` is empty.
 *
 * Install authors REAL scheduledQueryRules and then records them on the item.
 * When that record was lost (the pre-#3551 best-effort write), the alert rules
 * still exist and still fire in Azure, but this GET returned `rules: []` and the
 * editor showed nothing — with no way for the user to recover, since every
 * per-rule action keys off `state.rules`. Rather than leave those items dead,
 * re-derive the records from ARM and write them back, per
 * .claude/rules/auto-bind-by-default.md §3 (a stale binding is repaired
 * automatically, not shown to the user).
 *
 * The join key is the SAME deterministic name the provisioner authors with:
 * `safeRuleName(item.displayName, <rule-suffix>)`, so every rule belonging to
 * this activator starts with `safeRuleName(displayName, '')`. Two activators
 * whose display names sanitize to the same base would share that prefix — but
 * they already collide at WRITE time (they upsert the same azureRuleName), so
 * this does not introduce the ambiguity, it inherits it.
 *
 * Nothing is invented (no-vaporware.md): every field comes from ARM, except
 * `condition`/`action`, which ARM does not return — those are filled ONLY when
 * the item's own bundle content carries a rule of the same name.
 */
function recordFromLiveRule(r: ScheduledQueryRule, bundleRule?: any): MonitorRuleRecord {
  // createMonitorActivatorRule stamps the Loom-facing rule name into the ARM
  // description: "Loom Activator rule '<name>'" (+ " (Eventhouse / ADX)").
  const named = /Loom Activator rule '([^']*)'/.exec(r.description || '')?.[1];
  // The alert SCOPE is the authoritative source backend — an ADX-scoped rule is
  // scoped to the Kusto cluster, an LA rule to the workspace.
  const sourceKind: 'log-analytics' | 'adx' =
    (r.scopes || []).some((s) => /\/providers\/Microsoft\.Kusto\/clusters\//i.test(s)) ? 'adx' : 'log-analytics';
  return {
    id: r.name,
    name: named || r.name,
    query: r.query || '',
    azureRuleName: r.name,
    ...(bundleRule?.condition ? { condition: bundleRule.condition } : {}),
    ...(bundleRule?.action ? { action: bundleRule.action } : {}),
    ...(r.actionGroupIds?.[0] ? { actionGroupId: r.actionGroupIds[0] } : {}),
    severity: typeof r.severity === 'number' ? r.severity : 3,
    evaluationFrequency: r.evaluationFrequency || 'PT5M',
    windowSize: r.windowSize || 'PT5M',
    state: r.enabled ? 'Active' : 'Disabled',
    backend: 'azure-monitor',
    sourceKind,
    scheduled: true,
    // ARM's scheduledQueryRules listing does not return a creation time, so this
    // is the RECOVERY time, not the rule's creation time — said plainly in the
    // note rather than presented as the original (deploy-integrity.md R7).
    createdAt: new Date().toISOString(),
    note:
      'Recovered from the live Azure Monitor alert rule: this rule was created by the install but its record was missing from the item. ' +
      'The created timestamp is when it was recovered — Azure Monitor does not report the rule\'s original creation time.',
  };
}

/**
 * Returns the reconciled records (already written back to the item when the
 * write succeeded), or null when there is nothing to reconcile / Azure Monitor
 * cannot be listed. NEVER throws: a reconcile that can't run must not break a
 * GET that would otherwise fall through to the bundle projection.
 */
async function reconcileFromAzureMonitor(
  item: WorkspaceItem,
  bundleRule: any | null,
): Promise<{ rules: MonitorRuleRecord[]; healed: boolean } | null> {
  try {
    const prefix = safeRuleName(item.displayName || '', '');
    if (!prefix || prefix === '-') return null;
    const live = await listScheduledQueryRules();
    const mine = live.filter((r) => typeof r.name === 'string' && r.name.startsWith(prefix));
    if (mine.length === 0) return null;
    const rules = mine.map((r) => {
      const named = /Loom Activator rule '([^']*)'/.exec(r.description || '')?.[1];
      const match = bundleRule && (bundleRule.name === named || bundleRule.name === r.name) ? bundleRule : undefined;
      return recordFromLiveRule(r, match);
    });
    // Write the recovered records back so the NEXT open is a plain read and every
    // per-rule action (Start/Stop/Edit/Delete) resolves. Best-effort here and
    // honestly reported: the response is correct either way, and a failed write
    // just means the next GET reconciles again.
    let healed = false;
    try {
      const items = await itemsContainer();
      const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules }, updatedAt: new Date().toISOString() };
      await items.item(item.id, item.workspaceId).replace(next);
      healed = true;
    } catch { /* reported as healed:false below */ }
    return { rules, healed };
  } catch {
    // Monitor not configured / not authorized / unreachable — fall through to
    // the bundle projection. The caller's existing gates cover the write paths.
    return null;
  }
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

/** Honest Azure infra-gate for ADX / Eventhouse (Kusto) trigger/preview errors.
 *  A rule authored over Eventhouse data evaluates against the ADX cluster; when
 *  LOOM_KUSTO_* is unset (a non-ADX deploy) or the UAMI lacks cluster rights the
 *  query fails — surface it as a precise 503/403 gate, NOT a Fabric gate. */
function kustoGate(e: any): NextResponse | null {
  if (!(e instanceof KustoError)) return null;
  if (e.status === 401 || e.status === 403) {
    return NextResponse.json({
      ok: false,
      error: `Azure Data Explorer ${e.status}: not authorized to query the Eventhouse cluster.`,
      gate: { reason: 'The Console UAMI needs query rights on the ADX / Eventhouse cluster.', remediation: 'Grant the Console UAMI Database Viewer (or AllDatabasesViewer) on the ADX cluster so it can run the rule KQL. No Microsoft Fabric required.' },
    }, { status: 403 });
  }
  return NextResponse.json({
    ok: false,
    error: `Azure Data Explorer error: ${e.message}`,
    gate: { reason: 'The Eventhouse / ADX cluster is not reachable for this rule.', remediation: 'Set LOOM_KUSTO_CLUSTER_URI (and LOOM_KUSTO_DEFAULT_DB) to your Eventhouse cluster, or choose a Log Analytics source. No Microsoft Fabric required.' },
  }, { status: e.status && e.status >= 400 ? e.status : 503 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, read-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      allowReadRoles: true,
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    try {
      const rules = await listRules(workspaceId, id);
      if (!rules || rules.length === 0) {
        const fb = await bundleRules(id, session.claims.oid);
        if (fb) return NextResponse.json({ ok: true, rules: fb, source: 'bundle', backend: 'fabric' });
      }
      return NextResponse.json({ ok: true, rules, backend: 'fabric' });
    } catch (e: any) {
      const fb = await bundleRules(id, session.claims.oid);
      if (fb) return NextResponse.json({ ok: true, rules: fb, source: 'bundle', fabricError: e?.message || String(e) });
      const status = e instanceof ActivatorError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // ── Azure Monitor (DEFAULT) ── rules persist on the Cosmos item.
  try {
    const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
    const persisted = Array.isArray((item?.state as any)?.rules) ? (item!.state as any).rules : [];
    if (persisted.length > 0) return NextResponse.json({ ok: true, rules: persisted, backend: 'azure-monitor' });

    // state.rules is empty. Before falling back to the STATIC bundle projection
    // (which carries no azureRuleName, so no per-rule Start/Stop/Edit/Delete can
    // resolve), check whether the install DID create real Azure Monitor rules
    // whose record was lost — #3551 — and heal the item from them.
    const bundleRule = item ? activatorRuleFromContent(item) : null;
    if (item) {
      const reconciled = await reconcileFromAzureMonitor(item, bundleRule);
      if (reconciled) {
        return NextResponse.json({
          ok: true,
          rules: reconciled.rules,
          source: 'azure-monitor-reconciled',
          backend: 'azure-monitor',
          healed: reconciled.healed,
        });
      }
    }
    if (bundleRule) return NextResponse.json({ ok: true, rules: [bundleRule], source: 'bundle', backend: 'azure-monitor' });
    return NextResponse.json({ ok: true, rules: [], backend: 'azure-monitor' });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const triggerId = req.nextUrl.searchParams.get('trigger');

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    if (triggerId) {
      try { return NextResponse.json(await triggerRule(workspaceId, id, triggerId)); }
      catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 }); }
    }
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    try {
      const rule = await addRule(workspaceId, id, { name, condition: body?.condition || undefined, action: body?.action || undefined });
      return NextResponse.json({ ok: true, rule, backend: 'fabric' });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 });
    }
  }

  // ── Azure Monitor (DEFAULT) ──
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];

  // Trigger now = run the rule's KQL against its source (ADX/Eventhouse for RTI
  // rules, Log Analytics for LA rules) and report rows / would-fire.
  if (triggerId) {
    const rule = rules.find((r) => r.id === triggerId || r.name === triggerId);
    if (!rule) return NextResponse.json({ ok: false, error: `rule '${triggerId}' not found` }, { status: 404 });
    if (!rule.query && rule.sourceKind !== 'adx') {
      return NextResponse.json({ ok: false, error: `rule '${triggerId}' has no query to run` }, { status: 400 });
    }
    try {
      const out = await triggerMonitorActivatorRule(rule);
      // Persist the evaluation to the item's CAPPED on-demand run history so the
      // Run history tab shows Trigger/Preview runs — on-demand ADX rules (the
      // RTI default when LOOM_ADX_ALERT_SCOPE is unset) have NO Azure Monitor
      // alert instances, so this record is their ONLY history. Best-effort: the
      // trigger result is still returned if the write fails, and the response
      // says honestly whether the run was recorded.
      let historyRecorded = false;
      try {
        const run: OnDemandRunRecord = {
          ruleId: rule.id,
          ruleName: rule.name || rule.azureRuleName || rule.id,
          at: new Date().toISOString(),
          rowCount: out.count,
          fired: out.fired,
          backend: out.backend,
        };
        const runHistory = appendRunHistory(item.state, run);
        const items = await itemsContainer();
        const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), runHistory }, updatedAt: new Date().toISOString() };
        await items.item(item.id, item.workspaceId).replace(next);
        historyRecorded = true;
      } catch { /* run result still returned below */ }
      return NextResponse.json({ ok: true, ...out, historyRecorded });
    } catch (e: any) {
      return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const rule = await createMonitorActivatorRule(item.displayName, {
      name,
      condition: body?.condition || undefined,
      action: body?.action || undefined,
      query: typeof body?.query === 'string' ? body.query : undefined,
      sourceTable: typeof body?.sourceTable === 'string' ? body.sourceTable : undefined,
      severity: typeof body?.severity === 'number' ? body.severity : undefined,
      evaluationFrequency: typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : undefined,
      windowSize: typeof body?.windowSize === 'string' ? body.windowSize : undefined,
      existingActionGroupId: typeof body?.existingActionGroupId === 'string' ? body.existingActionGroupId : undefined,
      sourceKind: body?.sourceKind === 'adx' ? 'adx' : (body?.sourceKind === 'log-analytics' ? 'log-analytics' : undefined),
      adxDatabase: typeof body?.adxDatabase === 'string' ? body.adxDatabase : undefined,
      adxClusterUri: typeof body?.adxClusterUri === 'string' ? body.adxClusterUri : undefined,
      // Trigger-model depth (FGC-13).
      ruleKind: typeof body?.ruleKind === 'string' ? body.ruleKind : undefined,
      objectKey: typeof body?.objectKey === 'string' ? body.objectKey : undefined,
      propertyConditionType: typeof body?.propertyConditionType === 'string' ? body.propertyConditionType : undefined,
      changePercent: typeof body?.changePercent === 'number' ? body.changePercent : undefined,
      rangeMin: typeof body?.rangeMin === 'number' ? body.rangeMin : undefined,
      rangeMax: typeof body?.rangeMax === 'number' ? body.rangeMax : undefined,
      noDataMinutes: typeof body?.noDataMinutes === 'number' ? body.noDataMinutes : undefined,
      timestampColumn: typeof body?.timestampColumn === 'string' ? body.timestampColumn : undefined,
    });
    // Persist onto the Cosmos item so the rule list survives reload.
    const nextRules = [...rules.filter((r) => r.id !== rule.id), rule];
    const items = await itemsContainer();
    const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, rule, backend: 'azure-monitor' });
  } catch (e: any) {
    return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * PATCH /api/items/activator/[id]/rules?workspaceId=&ruleId=<id>&enabled=<true|false>
 *
 * Enable/disable a single rule. Azure-native (DEFAULT): an in-place ARM PATCH
 * of the backing scheduledQueryRule's properties.enabled — preserves the query,
 * scopes, action group, and schedule. The new state is persisted onto the Cosmos
 * item so the list reflects it across reloads. Fabric opt-in: PATCH the trigger
 * to Active/Stopped.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });
  const enabledParam = req.nextUrl.searchParams.get('enabled');
  if (enabledParam !== 'true' && enabledParam !== 'false') {
    return NextResponse.json({ ok: false, error: 'enabled=true|false required' }, { status: 400 });
  }
  const enabled = enabledParam === 'true';

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    try {
      await setTriggerState(workspaceId, id, ruleId, enabled ? 'Active' : 'Stopped');
      return NextResponse.json({ ok: true, backend: 'fabric', enabled });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 });
    }
  }

  // ── Azure Monitor (DEFAULT) ──
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
  const rule = rules.find((r) => r.id === ruleId || r.name === ruleId || r.azureRuleName === ruleId);
  if (!rule?.azureRuleName) return NextResponse.json({ ok: false, error: `rule '${ruleId}' not found` }, { status: 404 });

  try {
    // Unscheduled Eventhouse/ADX rules have NO backing scheduledQueryRule on
    // ARM (LOOM_ADX_ALERT_SCOPE unset) — the ARM PATCH would 404 and the toggle
    // would silently no-op. Their enable/disable IS the persisted flag: the
    // Trigger/Preview path is their evaluation plane. Scheduled rules (LA, or
    // ADX with an alert host) get the real in-place ARM PATCH.
    const onDemand = isOnDemandAdxRule(rule);
    if (!onDemand) {
      if (enabled) await enableMonitorRule(rule.azureRuleName);
      else await disableMonitorRule(rule.azureRuleName);
    }
    // Persist the new state on the Cosmos item.
    const updatedRule: MonitorRuleRecord = { ...rule, state: enabled ? 'Active' : 'Disabled', updatedAt: new Date().toISOString() };
    const nextRules = rules.map((r) => (r.id === rule.id ? updatedRule : r));
    const items = await itemsContainer();
    const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({
      ok: true, rule: updatedRule, backend: 'azure-monitor',
      ...(onDemand ? {
        onDemand: true,
        message: `On-demand Eventhouse/ADX rule — no Azure Monitor scheduledQueryRule to ${enabled ? 'enable' : 'disable'}; enabled flag updated. The rule evaluates via Trigger/Preview.`,
      } : {}),
    });
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * DELETE /api/items/activator/[id]/rules?workspaceId=&ruleId=<id>
 *
 * Delete a single rule. Azure-native (DEFAULT): ARM DELETE of the backing
 * scheduledQueryRule, then splice the record out of the Cosmos item's
 * state.rules. Fabric opt-in: DELETE the trigger.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    try {
      await deleteTrigger(workspaceId, id, ruleId);
      return NextResponse.json({ ok: true, backend: 'fabric' });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 });
    }
  }

  // ── Azure Monitor (DEFAULT) ──
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
  const rule = rules.find((r) => r.id === ruleId || r.name === ruleId || r.azureRuleName === ruleId);
  if (!rule) return NextResponse.json({ ok: false, error: `rule '${ruleId}' not found` }, { status: 404 });

  try {
    if (rule.azureRuleName) await deleteMonitorActivatorRule(rule.azureRuleName);
    const nextRules = rules.filter((r) => r.id !== rule.id);
    const items = await itemsContainer();
    const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, backend: 'azure-monitor' });
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * PUT /api/items/activator/[id]/rules?workspaceId=&ruleId=<id>
 *   body { name?, condition?, action?, query?, sourceTable?, severity?, evaluationFrequency?, windowSize?, existingActionGroupId? }
 *
 * Update an existing rule (the editor's structured Edit-rule flow re-opens the
 * same wizard pre-filled and PUTs the full body — never a freeform JSON box).
 * Azure-native (DEFAULT): re-run createMonitorActivatorRule, which UPSERTS the
 * backing scheduledQueryRule by name, with the new body (omitted fields fall
 * back to the existing record so a partial edit never silently resets config).
 * If a rename changed the azureRuleName, the orphaned ARM rule left under the
 * old name is deleted (best-effort). A paused ('Disabled') rule keeps its state
 * — editing must not surprise-re-enable it. The replaced record is persisted to
 * the Cosmos item's state.rules via the SAME itemsContainer replace path
 * POST/PATCH/DELETE use, so the editor/pane/Start all see the edit on reload.
 * Fabric opt-in: editing a Reflex rule's body is an opt-in follow-up; use
 * enable/disable/delete on that path, or the Azure-native default.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });

  // ── Fabric Reflex (opt-in) ── editing a trigger body is an opt-in follow-up.
  if (useFabric()) {
    return NextResponse.json({
      ok: false,
      error: 'Editing a Fabric Reflex rule body is not supported on the opt-in Fabric backend yet — use enable/disable/delete, or the Azure-native default.',
    }, { status: 501 });
  }

  // ── Azure Monitor (DEFAULT) ──
  const body = await req.json().catch(() => ({}));
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
  const old = rules.find((r) => r.id === ruleId || r.name === ruleId || r.azureRuleName === ruleId);
  if (!old) return NextResponse.json({ ok: false, error: `rule '${ruleId}' not found` }, { status: 404 });

  try {
    // Upsert the backing scheduledQueryRule by name. Omitted body fields fall
    // back to the existing record so a partial PUT doesn't reset live config.
    const rec = await createMonitorActivatorRule(item.displayName, {
      name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : old.name,
      condition: body?.condition ?? old.condition ?? undefined,
      action: body?.action ?? old.action ?? undefined,
      // A new verbatim query wins; else a new structured condition rebuilds it;
      // else keep the rule's existing query (don't lose a verbatim KQL rule).
      query: typeof body?.query === 'string' && body.query.trim()
        ? body.query
        : ((body?.condition || body?.ruleKind || body?.propertyConditionType) ? undefined : old.query),
      sourceTable: typeof body?.sourceTable === 'string' ? body.sourceTable : undefined,
      severity: typeof body?.severity === 'number' ? body.severity : old.severity,
      evaluationFrequency: typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : old.evaluationFrequency,
      windowSize: typeof body?.windowSize === 'string' ? body.windowSize : old.windowSize,
      existingActionGroupId: typeof body?.existingActionGroupId === 'string' ? body.existingActionGroupId : undefined,
      // Preserve (or update) the source backend + ADX target across an edit so a
      // partial PUT never silently flips an Eventhouse rule back to Log Analytics.
      sourceKind: body?.sourceKind === 'adx' ? 'adx' : (body?.sourceKind === 'log-analytics' ? 'log-analytics' : (old.sourceKind || undefined)),
      adxDatabase: typeof body?.adxDatabase === 'string' ? body.adxDatabase : old.adxDatabase,
      adxClusterUri: typeof body?.adxClusterUri === 'string' ? body.adxClusterUri : old.adxClusterUri,
      // Trigger-model depth (FGC-13) — a partial edit preserves the prior kind/condition.
      ruleKind: typeof body?.ruleKind === 'string' ? body.ruleKind : old.ruleKind,
      objectKey: typeof body?.objectKey === 'string' ? body.objectKey : old.objectKey,
      propertyConditionType: typeof body?.propertyConditionType === 'string' ? body.propertyConditionType : old.propertyConditionType,
      changePercent: typeof body?.changePercent === 'number' ? body.changePercent : old.changePercent,
      rangeMin: typeof body?.rangeMin === 'number' ? body.rangeMin : old.rangeMin,
      rangeMax: typeof body?.rangeMax === 'number' ? body.rangeMax : old.rangeMax,
      noDataMinutes: typeof body?.noDataMinutes === 'number' ? body.noDataMinutes : old.noDataMinutes,
      timestampColumn: typeof body?.timestampColumn === 'string' ? body.timestampColumn : old.timestampColumn,
    });
    // Rename → drop the orphan ARM rule left behind under the old name.
    if (rec.azureRuleName !== old.azureRuleName) {
      try { await deleteMonitorActivatorRule(old.azureRuleName); } catch { /* best-effort */ }
    }
    // Preserve a paused rule's state — an edit must not surprise-re-enable it.
    // Unscheduled ADX rules have no ARM rule to PATCH; the persisted flag alone
    // carries their paused state.
    if (old.state === 'Disabled') {
      if (!isOnDemandAdxRule(rec)) {
        try { await disableMonitorRule(rec.azureRuleName); } catch { /* best-effort */ }
      }
      rec.state = 'Disabled';
    }
    // Keep the original creation time; stamp the edit.
    rec.createdAt = old.createdAt || rec.createdAt;
    rec.updatedAt = new Date().toISOString();
    const nextRules = rules.map((r) => (r.id === old.id ? rec : r));
    const items = await itemsContainer();
    const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, rule: rec, backend: 'azure-monitor' });
  } catch (e: any) {
    return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
