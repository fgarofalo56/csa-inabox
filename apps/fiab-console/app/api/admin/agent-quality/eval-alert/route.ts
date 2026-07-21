/**
 * WS-1.5 — /api/admin/agent-quality/eval-alert
 *
 *   GET  — return the current eval regression alert rule status
 *          (lists loom-eval-regression-alert from Azure Monitor)
 *   POST — create/update the eval regression alert rule
 *          (calls upsertScheduledQueryRule from monitor-client)
 *   DELETE — disable the alert rule (patchScheduledQueryRule enabled=false)
 *
 * The alert is a real Microsoft.Insights/scheduledQueryRules resource. It fires
 * every 15 minutes when any agent eval avgScore falls below the threshold in the
 * past hour — indicating a regression vs the baseline run.
 *
 * Requires: LOOM_SUBSCRIPTION_ID, LOOM_ALERT_RG (or LOOM_ADMIN_RG),
 *           LOOM_LOG_ANALYTICS_RESOURCE_ID — all existing env vars.
 * Optional: LOOM_EVAL_MONITOR_ACTION_GROUP_ID (for alert notifications).
 *
 * Tenant-admin gated. No mocks. No new Cosmos container, no new bicep.
 * See .claude/rules/no-vaporware.md, no-fabric-dependency.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  upsertScheduledQueryRule,
  listScheduledQueryRules,
  patchScheduledQueryRule,
  MonitorNotConfiguredError,
  MonitorError,
} from '@/lib/azure/monitor-client';
import {
  buildEvalAlertInput,
  readEvalActionGroupId,
  EVAL_ALERT_NAME,
  DEFAULT_EVAL_SCORE_THRESHOLD,
} from '@/lib/foundry/eval-alert';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function monitorGate(e: unknown): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json(
      {
        ok: false,
        error: 'monitor_not_configured',
        hint: 'Set LOOM_SUBSCRIPTION_ID, LOOM_ALERT_RG (or LOOM_ADMIN_RG), and LOOM_LOG_ANALYTICS_RESOURCE_ID on the Console app.',
        missing: e.missing,
      },
      { status: 503 },
    );
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'monitor_unauthorized',
        hint: 'Grant the Console UAMI "Monitoring Contributor" on the Loom resource group.',
      },
      { status: 403 },
    );
  }
  return null;
}

/** GET — return current eval alert rule status. */
export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const adminErr = requireTenantAdmin(session);
  if (adminErr) return adminErr;

  try {
    const rules = await listScheduledQueryRules();
    const alert = rules.find((r) => r.name === EVAL_ALERT_NAME) ?? null;
    return NextResponse.json({ ok: true, alert });
  } catch (e: unknown) {
    const gate = monitorGate(e);
    if (gate) return gate;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
}

/** POST — create/update the eval regression alert rule. */
export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const adminErr = requireTenantAdmin(session);
  if (adminErr) return adminErr;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const scoreThreshold = typeof body?.scoreThreshold === 'number'
    ? Math.max(1, Math.min(5, body.scoreThreshold))
    : DEFAULT_EVAL_SCORE_THRESHOLD;
  const enabled = body?.enabled !== false;

  // Action group: read from request body first, then env fallback.
  const actionGroupIdFromBody = typeof body?.actionGroupId === 'string' && body.actionGroupId.trim()
    ? body.actionGroupId.trim()
    : null;
  const actionGroupId = actionGroupIdFromBody || readEvalActionGroupId();

  try {
    const input = buildEvalAlertInput({
      scoreThreshold,
      enabled,
      actionGroupIds: actionGroupId ? [actionGroupId] : undefined,
    });
    const ruleId = await upsertScheduledQueryRule(input);
    return NextResponse.json({
      ok: true,
      ruleId,
      name: EVAL_ALERT_NAME,
      scoreThreshold,
      enabled,
      hasActionGroup: !!actionGroupId,
    });
  } catch (e: unknown) {
    const gate = monitorGate(e);
    if (gate) return gate;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
}

/** DELETE — disable the eval regression alert rule. */
export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const adminErr = requireTenantAdmin(session);
  if (adminErr) return adminErr;

  try {
    await patchScheduledQueryRule(EVAL_ALERT_NAME, false);
    return NextResponse.json({ ok: true, name: EVAL_ALERT_NAME, enabled: false });
  } catch (e: unknown) {
    const gate = monitorGate(e);
    if (gate) return gate;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
}
