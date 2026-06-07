/**
 * Action Groups CRUD + test-notification — the Azure-native backend behind the
 * Activator action editor (per .claude/rules/no-fabric-dependency.md). A Loom
 * activator action group is a real Microsoft.Insights/actionGroups resource that
 * delivers email / SMS / webhook / Logic App notifications when an alert fires.
 * No Microsoft Fabric required.
 *
 *   GET  /api/monitor/action-groups
 *        → { ok, actionGroups: ActionGroupSummary[] }  (pick-existing flow)
 *   POST /api/monitor/action-groups
 *        body { name, shortName, emails?, smsReceivers?, webhookReceivers?, logicAppReceivers? }
 *        → { ok, id }                                  (create / update)
 *   POST /api/monitor/action-groups   body { _action: 'test', actionGroupId, alertType? }
 *        → { ok, result }                              (fire a real test notification)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listActionGroups,
  upsertActionGroup,
  sendActionGroupTestNotification,
  MonitorNotConfiguredError,
  MonitorError,
  type SmsReceiverInput,
  type WebhookReceiverInput,
  type LogicAppReceiverInput,
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
        reason: 'Action groups are created in the Loom alert resource group on Azure Monitor.',
        remediation: `Set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.`,
      },
    }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor ${e.status}: not authorized to manage action groups.`,
      gate: {
        reason: 'The Console UAMI needs rights on the alert resource group.',
        remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create action groups + send test notifications.',
      },
    }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const actionGroups = await listActionGroups();
    return NextResponse.json({ ok: true, actionGroups });
  } catch (e) {
    return gate(e) || NextResponse.json({ ok: false, error: (e as Error).message }, { status: e instanceof MonitorError ? e.status : 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // Test notification = fire a real notification through an existing group.
  if (body?._action === 'test') {
    const actionGroupId = typeof body?.actionGroupId === 'string' ? body.actionGroupId : '';
    if (!actionGroupId) return NextResponse.json({ ok: false, error: 'actionGroupId required' }, { status: 400 });
    const alertType = typeof body?.alertType === 'string' ? body.alertType : undefined;
    try {
      const result = await sendActionGroupTestNotification(actionGroupId, alertType);
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      return gate(e) || NextResponse.json({ ok: false, error: (e as Error).message }, { status: e instanceof MonitorError ? e.status : 502 });
    }
  }

  // Create / update an action group.
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const shortName = (typeof body?.shortName === 'string' && body.shortName.trim())
    ? body.shortName.trim()
    : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'loom';
  const emails = Array.isArray(body?.emails) ? (body.emails as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
  const smsReceivers = Array.isArray(body?.smsReceivers) ? (body.smsReceivers as SmsReceiverInput[]) : undefined;
  const webhookReceivers = Array.isArray(body?.webhookReceivers) ? (body.webhookReceivers as WebhookReceiverInput[]) : undefined;
  const logicAppReceivers = Array.isArray(body?.logicAppReceivers) ? (body.logicAppReceivers as LogicAppReceiverInput[]) : undefined;
  try {
    const id = await upsertActionGroup({ name, shortName, emails, smsReceivers, webhookReceivers, logicAppReceivers });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return gate(e) || NextResponse.json({ ok: false, error: (e as Error).message }, { status: e instanceof MonitorError ? e.status : 502 });
  }
}
