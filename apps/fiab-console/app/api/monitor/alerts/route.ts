/**
 * /api/monitor/alerts — Azure Monitor alert-rule lifecycle for CSA Loom.
 *
 * Two distinct ARM resource types live behind this route, both Azure-native
 * (no Microsoft Fabric — per .claude/rules/no-fabric-dependency.md):
 *
 *   GET  /api/monitor/alerts
 *        → { ok, data: { rules: AlertRule[] } }
 *        Lists Microsoft.Insights/metricAlerts scoped to the Loom RGs
 *        (read-only inventory of threshold-on-metric rules).
 *   GET  /api/monitor/alerts?kind=scheduled
 *        → { ok, rules: ScheduledQueryRule[] }
 *        Lists Microsoft.Insights/scheduledQueryRules (the Loom-managed,
 *        KQL-evaluated rules the authoring UI creates/edits).
 *
 *   POST /api/monitor/alerts  body { _action }:
 *     'list-scheduled'  → { ok, rules }            (list scheduled query rules)
 *     'upsert', rule    → { ok, id }               (create/edit — idempotent PUT)
 *     'patch', name, enabled → { ok }              (enable/disable in place)
 *     'delete', name    → { ok }                   (delete a rule)
 *
 * Authoring (upsert/patch/delete) requires the Console UAMI to hold
 * "Monitoring Contributor" on LOOM_ALERT_RG — granted by the monitoring.bicep
 * module. A missing grant surfaces an honest 403 gate, never a Fabric gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAlertRules,
  listScheduledQueryRules,
  upsertScheduledQueryRule,
  patchScheduledQueryRule,
  deleteScheduledQueryRule,
  MonitorNotConfiguredError,
  MonitorError,
  type ScheduledQueryRuleInput,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Honest Azure infra-gate (NOT a Fabric gate) for Monitor errors. */
function gate(e: unknown): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID / LOOM_ALERT_RG'}.`,
      gate: {
        missing: e.missing,
        reason: 'Scheduled query alert rules are created in the Loom alert resource group on Azure Monitor.',
        remediation: `Set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID + LOOM_ALERT_RG + LOOM_LOG_ANALYTICS_RESOURCE_ID'} on the Console. No Microsoft Fabric required.`,
      },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to manage alert rules.`,
      gate: {
        reason: 'The Console UAMI needs rights on the alert resource group.',
        remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create / edit / delete scheduled query alert rules. No Microsoft Fabric required.',
      },
    }, { status: 403 });
  }
  return null;
}

function fail(e: unknown, fallbackStatus = 502): NextResponse {
  return gate(e) || NextResponse.json(
    { ok: false, error: (e as Error).message },
    { status: e instanceof MonitorError ? e.status : fallbackStatus },
  );
}

export async function GET(req?: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const kind = req?.url ? new URL(req.url).searchParams.get('kind') : null;
  try {
    if (kind === 'scheduled') {
      const rules = await listScheduledQueryRules();
      return NextResponse.json({ ok: true, rules });
    }
    const rules = await listAlertRules();
    return NextResponse.json({ ok: true, data: { rules } });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = typeof body?._action === 'string' ? body._action : '';

  if (action === 'list-scheduled') {
    try {
      const rules = await listScheduledQueryRules();
      return NextResponse.json({ ok: true, rules });
    } catch (e) {
      return fail(e);
    }
  }

  if (action === 'patch') {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    if (typeof body?.enabled !== 'boolean') return NextResponse.json({ ok: false, error: 'enabled (boolean) required' }, { status: 400 });
    try {
      await patchScheduledQueryRule(name, body.enabled);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return fail(e);
    }
  }

  if (action === 'delete') {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    try {
      await deleteScheduledQueryRule(name);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return fail(e);
    }
  }

  if (action === 'upsert') {
    const r = (body?.rule || {}) as Record<string, unknown>;
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    const query = typeof r?.query === 'string' ? r.query.trim() : '';
    if (!name) return NextResponse.json({ ok: false, error: 'rule.name required' }, { status: 400 });
    if (!query) return NextResponse.json({ ok: false, error: 'rule.query (KQL) required' }, { status: 400 });
    const input: ScheduledQueryRuleInput = {
      name,
      query,
      description: typeof r?.description === 'string' ? r.description : undefined,
      operator: typeof r?.operator === 'string' ? r.operator : undefined,
      threshold: typeof r?.threshold === 'number'
        ? r.threshold
        : (r?.threshold != null && Number.isFinite(Number(r.threshold)) ? Number(r.threshold) : undefined),
      severity: typeof r?.severity === 'number'
        ? r.severity
        : (r?.severity != null && Number.isFinite(Number(r.severity)) ? Number(r.severity) : undefined),
      evaluationFrequency: typeof r?.evaluationFrequency === 'string' ? r.evaluationFrequency : undefined,
      windowSize: typeof r?.windowSize === 'string' ? r.windowSize : undefined,
      actionGroupIds: Array.isArray(r?.actionGroupIds)
        ? (r.actionGroupIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!x)
        : undefined,
      enabled: typeof r?.enabled === 'boolean' ? r.enabled : undefined,
    };
    try {
      const id = await upsertScheduledQueryRule(input);
      return NextResponse.json({ ok: true, id });
    } catch (e) {
      return fail(e);
    }
  }

  return NextResponse.json({ ok: false, error: `unknown _action '${action}'` }, { status: 400 });
}
