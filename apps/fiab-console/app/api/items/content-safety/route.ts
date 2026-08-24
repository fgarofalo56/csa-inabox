/**
 * GET  /api/items/content-safety — list policies (env-gated)
 * POST /api/items/content-safety — moderate text/image
 *   body: { kind: 'text', text, categories? } OR { kind: 'image', imageBase64 }
 *
 * Route-toolkit: the `withSession` wrapper [R3]. The prologue this replaces was
 * `const session = getSession(); if (!session) return NextResponse.json({ ok:
 * false, error: 'unauthenticated' }, { status: 401 })`, and `apiUnauthorized()`
 * (lib/api/respond.ts:43 → apiError('unauthenticated', 401)) emits that exact
 * body and status — asserted in __tests__/transport-honesty.test.ts rather than
 * assumed.
 *
 * #3578 — a transport failure (the data plane unreachable) used to be relayed
 * verbatim as undici's bare "fetch failed". It is now diagnosed by
 * _lib/transport-error.ts into a TRUE, actionable message (deploy-integrity.md
 * R7). All four routes in this family share that classifier.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { listContentSafetyPolicies, moderateText, moderateImage, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { diagnoseTransportFailure, transportErrorResponse } from './_lib/transport-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  // #3578 — classify BEFORE the verbatim relay, so an unreachable endpoint
  // never surfaces as a bare "fetch failed" with no status and no reason.
  const transport = diagnoseTransportFailure(e);
  if (transport) return transportErrorResponse(transport);
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export const GET = withSession(async () => {
  try {
    const policies = await listContentSafetyPolicies();
    return NextResponse.json({ ok: true, policies });
  } catch (e: any) { return err(e); }
});

export const POST = withSession(async (req: NextRequest) => {
  try {
    const body = await req.json();
    if (body?.kind === 'text') {
      if (!body?.text) return NextResponse.json({ ok: false, error: 'text required' }, { status: 400 });
      const result = await moderateText(body.text, body.categories);
      return NextResponse.json({ ok: true, kind: 'text', result });
    }
    if (body?.kind === 'image') {
      if (!body?.imageBase64) return NextResponse.json({ ok: false, error: 'imageBase64 required' }, { status: 400 });
      const result = await moderateImage(body.imageBase64);
      return NextResponse.json({ ok: true, kind: 'image', result });
    }
    return NextResponse.json({ ok: false, error: "kind must be 'text' or 'image'" }, { status: 400 });
  } catch (e: any) { return err(e); }
});
