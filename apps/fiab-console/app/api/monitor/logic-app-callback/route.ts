/**
 * Logic App trigger callback URL resolver — fetches the invocable SAS URL for a
 * Consumption Logic App workflow trigger so the Activator action editor can wire
 * a logicAppReceiver into an action group (per .claude/rules/no-fabric-dependency.md).
 *
 *   POST /api/monitor/logic-app-callback
 *        body { workflowResourceId, triggerName? }
 *        → { ok, callbackUrl }
 *
 * Backend: ARM listCallbackUrl (real REST). No Microsoft Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getLogicAppCallbackUrl, MonitorError } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const workflowResourceId = typeof body?.workflowResourceId === 'string' ? body.workflowResourceId.trim() : '';
  if (!workflowResourceId) return NextResponse.json({ ok: false, error: 'workflowResourceId required' }, { status: 400 });
  const triggerName = typeof body?.triggerName === 'string' && body.triggerName.trim() ? body.triggerName.trim() : undefined;
  try {
    const callbackUrl = await getLogicAppCallbackUrl(workflowResourceId, triggerName);
    return NextResponse.json({ ok: true, callbackUrl });
  } catch (e) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        error: `Azure ${e.status}: not authorized to read the Logic App callback URL.`,
        gate: {
          reason: 'The Console UAMI needs rights on the Logic App workflow.',
          remediation: 'Grant the Console UAMI "Logic App Contributor" (or read + listCallbackUrl/action) on the workflow so it can resolve the trigger callback URL.',
        },
      }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: e instanceof MonitorError ? e.status : 502 });
  }
}
