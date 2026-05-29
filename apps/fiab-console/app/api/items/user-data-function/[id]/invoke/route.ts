/**
 * POST /api/items/user-data-function/[id]/invoke
 *   Invoke a published Fabric User Data Function via its public REST endpoint,
 *   exactly like the Fabric portal Test/Run panel.
 *   Body: { functionName, parameters }
 *
 *   The function endpoint is resolved from the item's Cosmos state:
 *     state.fabricEndpoint  — the published UDF item base URL, OR
 *     state.fabricWorkspaceId + state.fabricItemId — composed against
 *       LOOM_FABRIC_UDF_HOST (defaults to the public Fabric UDF host pattern).
 *
 *   Honest gate: if the item has not been published to a Fabric workspace
 *   (no endpoint resolvable), returns 409 with the exact publish step + env
 *   var to set, and the full Test panel still renders client-side.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const b = await req.json().catch(() => ({}));
  const functionName = String(b?.functionName || '').trim();
  if (!functionName) return NextResponse.json({ ok: false, error: 'functionName is required' }, { status: 400 });

  // Resolve the published endpoint from the persisted item state.
  let item: any = null;
  try {
    const origin = req.nextUrl.origin;
    const r = await fetch(`${origin}/api/items/user-data-function/${encodeURIComponent(id)}`, {
      headers: { cookie: req.headers.get('cookie') || '' },
    });
    item = await r.json();
  } catch { /* fall through to gate */ }

  const st = item?.state || {};
  const base: string | undefined = st.fabricEndpoint
    || (st.fabricWorkspaceId && st.fabricItemId && process.env.LOOM_FABRIC_UDF_HOST
      ? `${process.env.LOOM_FABRIC_UDF_HOST}/${st.fabricWorkspaceId}/${st.fabricItemId}`
      : undefined);

  if (!base) {
    return NextResponse.json({
      ok: false,
      gated: true,
      error: 'This User Data Function is not published to a Fabric workspace yet.',
      hint: 'Publish the functions (the Publish action saves source + definition to Cosmos; to invoke over the public REST endpoint, set state.fabricEndpoint to the published item URL — or set state.fabricWorkspaceId + state.fabricItemId and the LOOM_FABRIC_UDF_HOST env var on the Console Container App). The Console UAMI must have Execute permission on the User Data Functions item.',
    }, { status: 409 });
  }

  try {
    const t = await credential.getToken(FABRIC_SCOPE);
    if (!t?.token) throw new Error('Failed to acquire Fabric token');
    // The public UDF REST contract: POST {base}/functions/{name}/invoke with a
    // JSON body of the named parameters.
    const url = `${base.replace(/\/+$/, '')}/functions/${encodeURIComponent(functionName)}/invoke`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(b?.parameters || {}),
    });
    const text = await res.text();
    return NextResponse.json({ ok: res.ok, status: res.status, body: text });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
