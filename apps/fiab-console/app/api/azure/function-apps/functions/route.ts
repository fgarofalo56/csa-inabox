/**
 * GET /api/azure/function-apps/functions?siteId=<Function App ARM id>
 *   → { ok: true, functions: [{ name, httpTrigger, authLevel, isDisabled, usable, reason? }] }
 *   → { ok: false, error, gate? }
 *
 * The functions inside a Function App, each marked with whether it can back an
 * Azure Monitor notification receiver (#4740). An individual function is not a
 * Resource Graph row (`/api/azure/resources` declines
 * `Microsoft.Web/sites/functions`), so the app is picked via the
 * `function-app-id` AzureBackedField and its functions are read here from the
 * site's own ARM surface: GET {siteId}/functions.
 *
 * NO key is read or returned. The key-bearing trigger URL is resolved only at
 * save, server-side (`resolveFunctionTriggerUrl`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { MonitorError } from '@/lib/azure/monitor-arm';
import { assertFunctionAppId, listFunctionTriggers } from '@/lib/azure/function-receiver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest) => {
  const siteId = (req.nextUrl.searchParams.get('siteId') || '').trim();
  let appName: string;
  try {
    appName = assertFunctionAppId(siteId);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
  try {
    const functions = await listFunctionTriggers(siteId);
    return NextResponse.json({ ok: true, functions });
  } catch (e) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        error: `Azure ${e.status}: not authorized to list the functions of '${appName}'.`,
        gate: {
          reason: 'The Console UAMI needs read on the Function App to list its functions.',
          remediation: `Grant the Console UAMI "Website Contributor" on Function App '${appName}' (it also covers the listkeys action the save needs).`,
        },
      }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: e instanceof MonitorError ? e.status : 502 });
  }
});
