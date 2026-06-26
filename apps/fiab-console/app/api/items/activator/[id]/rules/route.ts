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
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  listRules, addRule, triggerRule, setTriggerState, deleteTrigger, ActivatorError,
} from '@/lib/azure/activator-client';
import {
  createMonitorActivatorRule, triggerMonitorActivatorRule,
  enableMonitorRule, disableMonitorRule, deleteMonitorActivatorRule,
  type MonitorRuleRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { loadContentBackedItem, activatorRuleFromContent } from '../../../_lib/ai-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
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
    const fb = await bundleRules(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, rules: fb, source: 'bundle', backend: 'azure-monitor' });
    return NextResponse.json({ ok: true, rules: [], backend: 'azure-monitor' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
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

  // Trigger now = run the rule's KQL against Log Analytics and report rows.
  if (triggerId) {
    const rule = rules.find((r) => r.id === triggerId || r.name === triggerId);
    if (!rule?.query) return NextResponse.json({ ok: false, error: `rule '${triggerId}' not found` }, { status: 404 });
    try {
      const out = await triggerMonitorActivatorRule(rule.query);
      return NextResponse.json({ ok: true, ...out, backend: 'azure-monitor' });
    } catch (e: any) {
      return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
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
    });
    // Persist onto the Cosmos item so the rule list survives reload.
    const nextRules = [...rules.filter((r) => r.id !== rule.id), rule];
    const items = await itemsContainer();
    const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, rule, backend: 'azure-monitor' });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
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
    if (enabled) await enableMonitorRule(rule.azureRuleName);
    else await disableMonitorRule(rule.azureRuleName);
    // Persist the new state on the Cosmos item.
    const updatedRule: MonitorRuleRecord = { ...rule, state: enabled ? 'Active' : 'Disabled', updatedAt: new Date().toISOString() };
    const nextRules = rules.map((r) => (r.id === rule.id ? updatedRule : r));
    const items = await itemsContainer();
    const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, rule: updatedRule, backend: 'azure-monitor' });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
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
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
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
        : (body?.condition ? undefined : old.query),
      sourceTable: typeof body?.sourceTable === 'string' ? body.sourceTable : undefined,
      severity: typeof body?.severity === 'number' ? body.severity : old.severity,
      evaluationFrequency: typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : old.evaluationFrequency,
      windowSize: typeof body?.windowSize === 'string' ? body.windowSize : old.windowSize,
      existingActionGroupId: typeof body?.existingActionGroupId === 'string' ? body.existingActionGroupId : undefined,
    });
    // Rename → drop the orphan ARM rule left behind under the old name.
    if (rec.azureRuleName !== old.azureRuleName) {
      try { await deleteMonitorActivatorRule(old.azureRuleName); } catch { /* best-effort */ }
    }
    // Preserve a paused rule's state — an edit must not surprise-re-enable it.
    if (old.state === 'Disabled') {
      try { await disableMonitorRule(rec.azureRuleName); } catch { /* best-effort */ }
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
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
