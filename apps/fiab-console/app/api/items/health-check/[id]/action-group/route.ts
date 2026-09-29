/**
 * GET  /api/items/health-check/[id]/action-group
 *   → { ok, groups: ActionGroupSummary[], current: ActionGroupView | null }
 * PUT  /api/items/health-check/[id]/action-group
 *   body: { name, shortName?, emails?, sms?, webhooks?, functions?, logicApps? }
 *   → upsert a REAL Azure Monitor action group (Microsoft.Insights/actionGroups),
 *     persist the channel config on the item, and bind future check rules to it
 *     → { ok, id, current, bindings }
 * POST /api/items/health-check/[id]/action-group
 *   body: { actionGroupId?, alertType? }  (defaults to the persisted group)
 *   → sendActionGroupTestNotification (real createNotifications) → { ok, result }
 *
 * Azure-native default — no Microsoft Fabric. Honest 503 gate when Azure Monitor
 * / subscription env is unset (MonitorNotConfiguredError); 403 when the Console
 * UAMI lacks rights on the alert resource group.
 *
 * SECRET-BEARING URLS ARE RESOLVED HERE, AT SAVE, AND NEVER STORED OR RETURNED:
 *   • Logic App  → the workflow's HTTP-request trigger is READ from its
 *     definition (#4748 — never assumed to be `manual`), then ARM
 *     listCallbackUrl on it.
 *   • Azure Function → picked as Function App + function (#4740); the invoke
 *     URL and function key come from ARM (`resolveFunctionTriggerUrl`). The
 *     function is delivered as a webhook receiver to that URL, as before.
 *   Pre-#4740 hand-typed function URLs stay delivering, are returned to the
 *   browser with their query stripped, and are shown for re-binding
 *   (`_lib/notification-receivers.ts`).
 *
 * Route-toolkit: withSession (the session prologue is the toolkit's; the owner
 * check stays the explicit `loadOwnedItem` below).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import {
  upsertActionGroup,
  listActionGroups,
  sendActionGroupTestNotification,
  MonitorNotConfiguredError,
  MonitorError,
} from '@/lib/azure/monitor-client';
import { resolveLogicAppCallback, type TriggerChoice } from '@/lib/azure/logic-app-trigger';
import { callerArmToken, userArmGateBody } from '@/lib/azure/caller-arm-token';
import { redactUrlSecrets } from '@/lib/azure/redact-url-secrets';
import { resolveFunctionTriggerUrl } from '@/lib/azure/function-receiver';
import {
  functionReceiverView,
  isLegacyFunctionReceiver,
  parseFunctionRows,
  parseLogicAppRows,
  type FunctionReceiverView,
  type LogicAppReceiverRow,
  type PersistedFunctionReceiver,
} from '../../_lib/notification-receivers';

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
  functions: PersistedFunctionReceiver[];
  logicApps: LogicAppReceiverRow[];
}

/** What the browser is sent. `functions` never carries a URL or key. */
type ActionGroupView = Omit<PersistedActionGroup, 'functions'> & { functions: FunctionReceiverView[] };

function viewOf(ag: PersistedActionGroup | null): ActionGroupView | null {
  if (!ag) return null;
  return { ...ag, functions: (Array.isArray(ag.functions) ? ag.functions : []).map(functionReceiverView) };
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

function lastSegment(id: string): string {
  const parts = id.replace(/\/+$/, '').split('/');
  return decodeURIComponent(parts[parts.length - 1] || id);
}

/**
 * A receiver that could not be resolved. Kept apart from `monitorGate` so a
 * 403 on a Logic App or Function App is not reported as an action-group
 * permission problem (`deploy-integrity.md` R7 — the message names what was
 * actually refused).
 */
function receiverFailure(kind: 'logic-app' | 'function', label: string, e: unknown): NextResponse {
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    const role = kind === 'logic-app' ? 'Logic App Contributor' : 'Website Contributor';
    const action = kind === 'logic-app'
      ? 'read the workflow definition and call listCallbackUrl'
      : 'read the function and call its listkeys action';
    return NextResponse.json({
      ok: false,
      error: `Azure ${e.status}: your account is not authorized to resolve ${kind === 'logic-app' ? 'Logic App' : 'Azure Function'} '${label}'.`,
      gate: {
        reason: `Your Azure account must be able to ${action} to bind this receiver.`,
        remediation: `Ask an owner to grant you "${role}" on '${label}' (or its resource group), then retry.`,
      },
    }, { status: 403 });
  }
  if (e instanceof MonitorError && e.status >= 400 && e.status < 500) {
    const what = kind === 'logic-app' ? 'Logic App receiver' : 'Azure Function receiver';
    // Redact any `code=`/`sig=` an ARM error might echo before it reaches the browser (S4).
    return NextResponse.json({ ok: false, error: redactUrlSecrets(`${what} '${label}': ${e.message}`) }, { status: e.status === 404 ? 404 : 422 });
  }
  return monitorGate(e) || NextResponse.json({ ok: false, error: redactUrlSecrets((e as Error)?.message || String(e)) }, { status: 502 });
}

function currentOf(state: Record<string, unknown>): PersistedActionGroup | null {
  const ag = state.actionGroup as PersistedActionGroup | undefined;
  return ag && typeof ag === 'object' && ag.name ? ag : null;
}

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session: s, params: { id } }) => {
  if (!id || id === 'new') return NextResponse.json({ ok: true, groups: [], current: null });
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return apiError('health-check not found', 404);
  const current = viewOf(currentOf((hc.state || {}) as Record<string, unknown>));
  try {
    const groups = await listActionGroups();
    return NextResponse.json({ ok: true, groups, current });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: redactUrlSecrets(e?.message || String(e)), current }, { status: 502 });
  }
});

export const PUT = withSession<{ id: string }>(async (req: NextRequest, { session: s, params: { id } }) => {
  if (!id || id === 'new') return apiError('save the health check before configuring notifications (no id yet)', 400);
  const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!hc) return apiError('health-check not found', 404);
  const body = await req.json().catch(() => ({} as any));
  const stored = currentOf((hc.state || {}) as Record<string, unknown>);

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
  const parsedFunctions = parseFunctionRows(body?.functions, Array.isArray(stored?.functions) ? stored!.functions : []);
  if (!parsedFunctions.ok) return apiError(parsedFunctions.error, 400);
  const functions = parsedFunctions.rows;
  const logicAppsIn = parseLogicAppRows(body?.logicApps);

  // Resolving a Logic App SAS callback or a Function key is a PRIVILEGED ARM
  // call on a CALLER-CHOSEN resource, so it runs under the caller's own ARM
  // RBAC — never the platform identity. Only needed
  // when there is at least one such receiver to resolve.
  const needsArm = logicAppsIn.length > 0 || functions.some((f) => !isLegacyFunctionReceiver(f));
  const authz = needsArm ? await callerArmToken(s.claims.oid) : { gate: false, token: undefined };
  if (needsArm && authz.gate) return NextResponse.json(userArmGateBody('the selected receiver'), { status: 401 });
  const armToken = authz.token;

  // ── Resolve every secret-bearing receiver URL server-side. ──
  const logicAppReceivers: { resourceId: string; callbackUrl: string; useCommonAlertSchema?: boolean }[] = [];
  const logicAppBindings: { resourceId: string; workflowName: string; triggerName: string; chosenBy: TriggerChoice }[] = [];
  for (const la of logicAppsIn) {
    try {
      const r = await resolveLogicAppCallback(la.resourceId, la.triggerName, armToken);
      logicAppReceivers.push({ resourceId: la.resourceId, callbackUrl: r.callbackUrl, useCommonAlertSchema: la.useCommonAlertSchema });
      logicAppBindings.push({ resourceId: la.resourceId, workflowName: r.workflowName, triggerName: r.triggerName, chosenBy: r.chosenBy });
    } catch (e) {
      return receiverFailure('logic-app', lastSegment(la.resourceId), e);
    }
  }
  const functionWebhooks: { serviceUri: string; useCommonAlertSchema?: boolean }[] = [];
  let legacyFunctionCount = 0;
  for (const f of functions) {
    if (isLegacyFunctionReceiver(f)) {
      // Pre-#4740 row: keep delivering exactly as before until it is re-bound.
      legacyFunctionCount += 1;
      functionWebhooks.push({ serviceUri: f.functionUrl, useCommonAlertSchema: f.useCommonAlertSchema });
      continue;
    }
    const label = `${f.functionAppResourceId ? lastSegment(f.functionAppResourceId) : '(no Function App)'}/${f.functionName || '(no function)'}`;
    try {
      const serviceUri = await resolveFunctionTriggerUrl(f.functionAppResourceId, f.functionName, armToken);
      functionWebhooks.push({ serviceUri, useCommonAlertSchema: f.useCommonAlertSchema });
    } catch (e) {
      return receiverFailure('function', label, e);
    }
  }

  try {
    const webhookReceivers = [
      ...webhooks.map((w: { serviceUri: string; useCommonAlertSchema?: boolean }) => ({ serviceUri: w.serviceUri, useCommonAlertSchema: w.useCommonAlertSchema })),
      ...functionWebhooks,
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
    return NextResponse.json({
      ok: true,
      id: agId,
      current: viewOf(current),
      bindings: { logicApps: logicAppBindings, legacyFunctions: legacyFunctionCount },
    });
  } catch (e: any) {
    return monitorGate(e) || NextResponse.json({ ok: false, error: redactUrlSecrets(e?.message || String(e)) }, { status: 502 });
  }
});

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session: s, params: { id } }) => {
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
    return monitorGate(e) || NextResponse.json({ ok: false, error: redactUrlSecrets(e?.message || String(e)) }, { status: 502 });
  }
});
