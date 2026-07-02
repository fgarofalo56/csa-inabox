/**
 * GET  /api/items/health-check/[id]/action-group
 *   → { ok, groups: ActionGroupSummary[], current: PersistedActionGroup | null }
 * PUT  /api/items/health-check/[id]/action-group
 *   body: { name, shortName?, emails?, sms?, webhooks?, functions?, logicApps? }
 *   → upsert a REAL Azure Monitor action group (Microsoft.Insights/actionGroups),
 *     persist the channel config on the item, and bind future check rules to it
 *     → { ok, id, current }
 * POST /api/items/health-check/[id]/action-group
 *   body: { actionGroupId?, alertType? }  (defaults to the persisted group)
 *   → sendActionGroupTestNotification (real createNotifications) → { ok, result }
 *
 * Azure-native default — no Microsoft Fabric. Honest 503 gate when Azure Monitor
 * / subscription env is unset (MonitorNotConfiguredError); 403 when the Console
 * UAMI lacks rights on the alert resource group. Azure Functions are delivered
 * as webhook receivers to their HTTP-trigger URL (the receiver kind the action
 * group client supports); Logic App callback URLs are resolved via ARM.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import {
  upsertActionGroup,
  listActionGroups,
  sendActionGroupTestNotification,
  getLogicAppCallbackUrl,
  MonitorNotConfiguredError,
  MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'health-check';

interface PersistedActionGroup {
  name: string;
  id?: string;
  shortName: string;
  emails: string[];
  sms: { countryCode: string; phoneNumber: string }[];
  webhooks: { name?: string; serviceUri: string; useCommonAlertSchema?: boolean }[];
  functions: { name?: string; functionUrl: string; useCommonAlertSchema?: boolean }[];
  logicApps: { name?: string; resourceId: string; useCommonAlertSchema?: boolean }[];
}


function monitorGate(e: any): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Azure Monitor not configured: set ${e.missing?.join(' / ') || 'LOOM_SUBSCRIPTION_ID / LOOM_ALERT_RG'}.`,
      gate: {
        reason: 'Notification channels create a real Azure Monitor action group.',
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
        remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG.',
      },
    }, { status: e.status });
  }
  return null;
}

function currentOf(state: Record<string, unknown>): PersistedActionGroup | null {
  const ag = state.actionGroup as PersistedActionGroup | undefined;
  return ag && typeof ag === 'object' && ag.name ? ag : null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, groups: [], current: null });
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return apiError('health-check not found', 404);
  const current = currentOf((hc.state || {}) as Record<string, unknown>);
  try {
    const groups = await listActionGroups();
    return NextResponse.json({ ok: true, groups, current });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e), current }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the health check before configuring notifications (no id yet)', 400);
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return apiError('health-check not found', 404);
  const body = await req.json().catch(() => ({} as any));

  const name = String(body?.name || '').trim();
  if (!name) return apiError('an action-group name is required', 400);
  const shortName = (String(body?.shortName || name).replace(/[^A-Za-z0-9]/g, '') || 'loom').slice(0, 12);

  const emails: string[] = Array.isArray(body?.emails)
    ? body.emails.map((e: any) => String(e || '').trim()).filter((e: string) => e.includes('@'))
    : [];
  const sms = Array.isArray(body?.sms)
    ? body.sms.map((r: any) => ({ countryCode: String(r?.countryCode || '1'), phoneNumber: String(r?.phoneNumber || '') })).filter((r: { phoneNumber: string }) => r.phoneNumber)
    : [];
  const webhooks = Array.isArray(body?.webhooks)
    ? body.webhooks.map((r: any) => ({ name: r?.name ? String(r.name) : undefined, serviceUri: String(r?.serviceUri || '').trim(), useCommonAlertSchema: r?.useCommonAlertSchema !== false })).filter((r: { serviceUri: string }) => /^https?:\/\//i.test(r.serviceUri))
    : [];
  const functions = Array.isArray(body?.functions)
    ? body.functions.map((r: any) => ({ name: r?.name ? String(r.name) : undefined, functionUrl: String(r?.functionUrl || '').trim(), useCommonAlertSchema: r?.useCommonAlertSchema !== false })).filter((r: { functionUrl: string }) => /^https?:\/\//i.test(r.functionUrl))
    : [];
  const logicAppsIn = Array.isArray(body?.logicApps)
    ? body.logicApps.map((r: any) => ({ name: r?.name ? String(r.name) : undefined, resourceId: String(r?.resourceId || '').trim(), useCommonAlertSchema: r?.useCommonAlertSchema !== false })).filter((r: { resourceId: string }) => r.resourceId)
    : [];

  try {
    // Resolve each Logic App's invocable callback URL (SAS) via ARM listCallbackUrl.
    const logicAppReceivers: { resourceId: string; callbackUrl: string; useCommonAlertSchema?: boolean }[] = [];
    for (const la of logicAppsIn) {
      const callbackUrl = await getLogicAppCallbackUrl(la.resourceId);
      logicAppReceivers.push({ resourceId: la.resourceId, callbackUrl, useCommonAlertSchema: la.useCommonAlertSchema });
    }
    // Azure Functions are delivered as webhook receivers to their HTTP-trigger URL.
    const webhookReceivers = [
      ...webhooks.map((w: { serviceUri: string; useCommonAlertSchema?: boolean }) => ({ serviceUri: w.serviceUri, useCommonAlertSchema: w.useCommonAlertSchema })),
      ...functions.map((f: { functionUrl: string; useCommonAlertSchema?: boolean }) => ({ serviceUri: f.functionUrl, useCommonAlertSchema: f.useCommonAlertSchema })),
    ];

    const agId = await upsertActionGroup({
      name,
      shortName,
      emails,
      smsReceivers: sms,
      webhookReceivers,
      logicAppReceivers,
    });

    const current: PersistedActionGroup = { name, id: agId, shortName, emails, sms, webhooks, functions, logicApps: logicAppsIn };
    const state = { ...((hc.state || {}) as Record<string, unknown>), actionGroup: current };
    await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
    return NextResponse.json({ ok: true, id: agId, current });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the health check first', 400);
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return apiError('health-check not found', 404);
  const body = await req.json().catch(() => ({} as any));
  const current = currentOf((hc.state || {}) as Record<string, unknown>);
  const actionGroupId = String(body?.actionGroupId || current?.id || '').trim();
  if (!actionGroupId) return apiError('no action group to test — save notification channels first', 400);
  try {
    const result = await sendActionGroupTestNotification(actionGroupId, typeof body?.alertType === 'string' ? body.alertType : undefined);
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
