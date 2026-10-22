/**
 * GET /api/landing-zones/discover
 * -------------------------------
 * Brownfield attach — the Discover step (§2.2). Enumerates every EXISTING Azure
 * resource of an attachable kind the signed-in user can reach across ALL their
 * subscriptions (their own RBAC + ABAC via a delegated ARM token), in one
 * multi-type Azure Resource Graph query, so the attach wizard can offer them as
 * dropdown picks (loom_no_freeform_config — never a free-text resource id).
 *
 * Optional `?kinds=synapse,adx,storage-adls` narrows the discovery to a subset
 * (default = every attachable kind).
 *
 * CREDENTIAL LADDER (response tagged `via`):
 *   1. via:'user' — signed-in user's delegated ARM token via ARG (per-user RBAC).
 *   2. via:'uami' — Loom UAMI ARM token via ARG (Reader-at-root fallback).
 * When both see nothing on every credential we return an honest gate
 * (code:'no_access', per no-vaporware.md) naming the one-time admin actions,
 * mirroring /api/azure/connectables. Tokens are never logged or returned.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import {
  buildDiscoveryQuery,
  argRowsToCandidates,
  parseKindsParam,
  type ArgResourceRow,
} from '@/lib/azure/attached-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAP = 'admin.attach-service';
const ARG_URL = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;

function sanitize(s: string): string {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** Run the ARG discovery query with a token, following $skipToken paging. */
async function runArg(
  token: string,
  query: string,
): Promise<{ ok: true; rows: ArgResourceRow[] } | { ok: false; status: number; error: string }> {
  const rows: ArgResourceRow[] = [];
  let skipToken: string | undefined;
  let guard = 0;
  do {
    const options: Record<string, unknown> = { resultFormat: 'objectArray', $top: 1000 };
    if (skipToken) options.$skipToken = skipToken;
    let res: Response;
    try {
      res = await fetch(ARG_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, options }),
      });
    } catch (e: any) {
      return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.error?.code || text; } catch { /* non-JSON */ }
      return { ok: false, status: res.status, error: sanitize(msg) };
    }
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { return { ok: false, status: 502, error: 'Resource Graph returned a non-JSON body' }; }
    if (Array.isArray(body?.data)) rows.push(...body.data);
    skipToken = typeof body?.$skipToken === 'string' ? body.$skipToken : undefined;
  } while (skipToken && guard++ < 50);
  return { ok: true, rows };
}

const GATE_MESSAGE =
  'No attachable Azure resources were returned across the subscriptions visible to Loom. ' +
  'This usually means one of two one-time admin actions is still pending: ' +
  '(1) Admin-consent the Loom app registration for the Azure Service Management delegated ' +
  'permission "user_impersonation" so discovery can query with each user\'s own RBAC + ABAC; and/or ' +
  '(2) Grant the Loom user-assigned managed identity (LOOM_UAMI_CLIENT_ID) the "Reader" role at ' +
  'the tenant root management group so the UAMI fallback can enumerate resources. Once either is in ' +
  'place, resources you can access appear here.';

export async function GET(req: NextRequest) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;

  const kinds = parseKindsParam(req.nextUrl.searchParams.get('kinds'));
  const query = buildDiscoveryQuery(kinds);

  const finalize = (rows: ArgResourceRow[], via: 'user' | 'uami') => {
    const candidates = argRowsToCandidates(rows, kinds);
    return NextResponse.json({ ok: true, candidates, via });
  };

  let userArgError: { status: number; error: string } | null = null;
  let uamiArgError: { status: number; error: string } | null = null;

  // (a) user delegated ARM token — per-user RBAC + ABAC.
  try {
    const userToken = (await getUserArmToken(session!.claims.oid)) || null;
    if (userToken) {
      const r = await runArg(userToken, query);
      if (r.ok && r.rows.length > 0) return finalize(r.rows, 'user');
      if (!r.ok) userArgError = { status: r.status, error: r.error };
    }
  } catch { /* fall through to UAMI */ }

  // (b) UAMI — Reader-at-root fallback.
  try {
    const tok = await uamiArmCredential().getToken(armScope());
    if (tok?.token) {
      const r = await runArg(tok.token, query);
      if (r.ok && r.rows.length > 0) return finalize(r.rows, 'uami');
      if (!r.ok) uamiArgError = { status: r.status, error: r.error };
    }
  } catch (e: any) {
    uamiArgError = { status: 502, error: sanitize(e?.message || String(e)) };
  }

  const detail =
    uamiArgError ? ` (Resource Graph error via UAMI: ${uamiArgError.error})`
    : userArgError ? ` (Resource Graph error via user token: ${userArgError.error})`
    : '';
  return NextResponse.json(
    { ok: false, code: 'no_access', error: `${GATE_MESSAGE}${detail}` },
    { status: 200 },
  );
}
