/**
 * Logic App request-trigger inspector — tells the picker, BEFORE save, whether a
 * workflow can be wired as an Azure Monitor receiver and which trigger will be
 * used (#4748).
 *
 *   GET /api/monitor/logic-app-triggers?workflowResourceId=<arm id>[&triggerName=<name>]
 *     → { ok: true, workflowName, triggers: [{ name, type, kind, callbackCapable }],
 *         triggerName, chosenBy }                        a request trigger resolves
 *     → { ok: true, workflowName, triggers, problem }    none can be used (422 reason)
 *     → { ok: false, error, gate? }                      ARM refused / failed
 *
 * Backend: ARM GET Microsoft.Logic/workflows (definition.triggers). NO secret is
 * read or returned — listCallbackUrl is only called at save, server-side.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { armGet, MonitorError } from '@/lib/azure/monitor-arm';
import { armIdPath, assertLogicAppId, chooseRequestTrigger, triggersOfDefinition, LOGIC_API } from '@/lib/azure/logic-app-trigger';
import { callerArmToken, userArmGateBody } from '@/lib/azure/caller-arm-token';
import { redactUrlSecrets } from '@/lib/azure/redact-url-secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const workflowResourceId = (req.nextUrl.searchParams.get('workflowResourceId') || '').trim();
  const preferred = (req.nextUrl.searchParams.get('triggerName') || '').trim() || undefined;
  let fallbackName: string;
  try {
    fallbackName = assertLogicAppId(workflowResourceId);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
  // The workflow is caller-chosen: read it under the caller's own ARM RBAC.
  const authz = await callerArmToken(session.claims.oid);
  if (authz.gate) return NextResponse.json(userArmGateBody(fallbackName), { status: 401 });
  try {
    const wf = await armGet(`${armIdPath(workflowResourceId)}?api-version=${LOGIC_API}`, undefined, authz.token);
    const workflowName = wf?.name || fallbackName;
    const triggers = triggersOfDefinition(wf?.properties?.definition);
    try {
      const { triggerName, chosenBy } = chooseRequestTrigger(workflowName, triggers, preferred);
      return NextResponse.json({ ok: true, workflowName, triggers, triggerName, chosenBy });
    } catch (e) {
      if (e instanceof MonitorError && e.status === 422) {
        return NextResponse.json({ ok: true, workflowName, triggers, problem: e.message });
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        error: `Azure ${e.status}: your account is not authorized to read Logic App '${fallbackName}'.`,
        gate: {
          reason: 'Your Azure account needs read on the workflow to find its HTTP-request trigger.',
          remediation: `Ask an owner to grant you "Logic App Contributor" on '${fallbackName}', or pick a Logic App you can read.`,
        },
      }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: redactUrlSecrets((e as Error).message) }, { status: e instanceof MonitorError ? e.status : 502 });
  }
});
