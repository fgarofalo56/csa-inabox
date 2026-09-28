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
import { callerArmToken, userArmGateBody } from '@/lib/azure/caller-arm-token';
import { redactUrlSecrets } from '@/lib/azure/redact-url-secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const workflowResourceId = typeof body?.workflowResourceId === 'string' ? body.workflowResourceId.trim() : '';
  if (!workflowResourceId) return NextResponse.json({ ok: false, error: 'workflowResourceId required' }, { status: 400 });
  const triggerName = typeof body?.triggerName === 'string' && body.triggerName.trim() ? body.triggerName.trim() : undefined;
  // The callback URL carries a SAS signature — a SECRET. The workflow is
  // caller-chosen, so this resolves it under the CALLER's own ARM RBAC and only
  // hands it back to a caller who could have minted it themselves; there is no
  // platform-identity fallback that would return it to any signed-in user
  // (GHSA-66f6-7xvq-8qxw / S3).
  const authz = await callerArmToken(s.claims.oid);
  if (authz.gate) return NextResponse.json(userArmGateBody('the selected Logic App'), { status: 401 });
  try {
    const callbackUrl = await getLogicAppCallbackUrl(workflowResourceId, triggerName, authz.token);
    return NextResponse.json({ ok: true, callbackUrl });
  } catch (e) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        error: `Azure ${e.status}: your account is not authorized to read the Logic App callback URL.`,
        gate: {
          reason: 'Your Azure account needs rights on the Logic App workflow.',
          remediation: 'Ask an owner to grant you "Logic App Contributor" (or read + listCallbackUrl/action) on the workflow, then retry.',
        },
      }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: redactUrlSecrets((e as Error).message) }, { status: e instanceof MonitorError ? e.status : 502 });
  }
}
