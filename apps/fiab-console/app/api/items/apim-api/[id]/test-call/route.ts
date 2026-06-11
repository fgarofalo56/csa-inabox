/**
 * POST /api/items/apim-api/[id]/test-call
 *   Executes a real request through the APIM gateway (the in-portal Test
 *   console). Body: { method, urlTemplate, headers?, query?, body?,
 *                     subscriptionId?, subscriptionKey? }
 *   The route resolves the API's path + the gateway URL server-side, then
 *   attaches an Ocp-Apim-Subscription-Key chosen by precedence:
 *     subscriptionKey (manual) → subscriptionId (resolved via listSecrets) →
 *     the all-access "master" subscription (last resort).
 *   The browser never has to hold a key for the selected-subscription path.
 *   Returns { ok, status, statusText, headers, body, keySource }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getApi, testApiCall, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const b = await req.json().catch(() => ({}));
  const method = String(b?.method || 'GET').toUpperCase();
  const urlTemplate = String(b?.urlTemplate || '');
  try {
    const api = await getApi(id);
    if (!api) return NextResponse.json({ ok: false, error: 'API not found' }, { status: 404 });
    const result = await testApiCall({
      apiPath: api.path || '',
      urlTemplate,
      method,
      headers: (b?.headers && typeof b.headers === 'object') ? b.headers : undefined,
      query: (b?.query && typeof b.query === 'object') ? b.query : undefined,
      body: typeof b?.body === 'string' ? b.body : undefined,
      subscriptionId: typeof b?.subscriptionId === 'string' && b.subscriptionId.trim() ? b.subscriptionId.trim() : undefined,
      subscriptionKey: typeof b?.subscriptionKey === 'string' && b.subscriptionKey.trim() ? b.subscriptionKey.trim() : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
