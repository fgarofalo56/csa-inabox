/**
 * GET /api/azure/resources?type=<armResourceType>[&kind=<kind>]
 * -------------------------------------------------------------
 * Cross-subscription, user-RBAC Azure resource lister. Returns every resource
 * of the requested ARM type (optionally narrowed by `kind`) across ALL
 * subscriptions the calling identity can read — in ONE query — via Azure
 * Resource Graph.
 *
 *   POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources
 *        ?api-version=2021-03-01
 *   body { query: "resources | where type =~ '<type>' [| where kind =~ '<kind>']
 *                  | project id,name,type,kind,location,resourceGroup,subscriptionId
 *                  | order by name asc",
 *          options: { resultFormat: 'objectArray' } }
 *
 * `subscriptions` is intentionally omitted so ARG scopes the query to every
 * subscription the token's identity has access to (per-identity RBAC).
 *
 * CREDENTIAL LADDER (first that yields a token wins; response is tagged `via`):
 *   1. via:'user' — the signed-in user's cached ARM token (lib/azure/
 *      user-token-store). This gives the USER's RBAC: they see exactly the subs
 *      and resources they're entitled to. Requires the Loom app registration to
 *      have the delegated `https://management.azure.com/user_impersonation`
 *      scope admin-consented (captured at login).
 *   2. via:'uami'  — the Loom UAMI ChainedTokenCredential ARM token (same
 *      pattern as adf-client.ts / foundry-cs-client.ts). Sees whatever the UAMI
 *      is granted (e.g. Reader at a management-group / tenant-root scope).
 *
 * When neither yields any resource AND the user path was unavailable, returns an
 * honest gate (ok:false, code:'no_access') naming the exact one-time admin
 * actions — per .claude/rules/no-vaporware.md. Tokens are never logged and never
 * returned to the browser.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARM_SCOPE = 'https://management.azure.com/.default';
const ARG_URL =
  'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01';

export interface AzureResourceRow {
  id: string;
  name: string;
  type: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
}

/** Strip any HTML/tags and collapse whitespace so error text is safe to render. */
function sanitize(s: string): string {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** UAMI → DefaultAzureCredential chain (matches adf-client / foundry-cs-client). */
function uamiCredential(): ChainedTokenCredential | DefaultAzureCredential {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID;
  return clientId
    ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId }), new DefaultAzureCredential())
    : new DefaultAzureCredential();
}

/**
 * KQL is single-quote delimited; ARM resource types and kinds are a constrained
 * alphabet (letters, digits, dot, slash, dash, underscore, space). Reject
 * anything else rather than trying to escape — prevents query injection and
 * keeps the ARG query well-formed.
 */
function isSafeArgLiteral(v: string): boolean {
  return /^[A-Za-z0-9._/\- ]{1,128}$/.test(v);
}

function buildQuery(type: string, kind?: string): string {
  let q = `resources | where type =~ '${type}'`;
  if (kind) q += ` | where kind =~ '${kind}'`;
  q += ' | project id,name,type,kind,location,resourceGroup,subscriptionId | order by name asc';
  return q;
}

/**
 * Run the ARG query with a single bearer token. Returns the parsed rows on
 * success, or an error descriptor (status + sanitized message) on failure.
 */
async function runArg(
  token: string,
  query: string,
): Promise<{ ok: true; rows: AzureResourceRow[] } | { ok: false; status: number; error: string }> {
  let res: Response;
  try {
    res = await fetch(ARG_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, options: { resultFormat: 'objectArray' } }),
    });
  } catch (e: any) {
    return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.error?.code || text;
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: res.status, error: sanitize(msg) };
  }
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, status: 502, error: 'Resource Graph returned a non-JSON body' };
  }
  const data: AzureResourceRow[] = Array.isArray(body?.data) ? body.data : [];
  return { ok: true, rows: data };
}

const GATE_MESSAGE =
  'No Azure resources were returned across the subscriptions visible to Loom. ' +
  'This usually means one of two one-time admin actions is still pending: ' +
  '(1) Admin-consent the Loom app registration for the Azure Service Management ' +
  'delegated permission "user_impersonation" (https://management.azure.com/user_impersonation) ' +
  'so the picker can query with each user\'s own RBAC; and/or ' +
  '(2) Grant the Loom user-assigned managed identity (LOOM_UAMI_CLIENT_ID) the ' +
  '"Reader" role at the tenant root management group (scope /providers/Microsoft.Management/managementGroups/<tenantRootGroupId>) ' +
  'so the UAMI fallback can enumerate resources across every subscription. ' +
  'Once either is in place, resources you have access to will appear here.';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'unauthenticated', error: 'Not signed in.' }, { status: 401 });
  }

  const type = (req.nextUrl.searchParams.get('type') || '').trim();
  const kind = (req.nextUrl.searchParams.get('kind') || '').trim() || undefined;
  if (!type) {
    return NextResponse.json(
      { ok: false, code: 'bad_request', error: 'Missing required query param `type` (ARM resource type, e.g. Microsoft.DataFactory/factories).' },
      { status: 400 },
    );
  }
  if (!isSafeArgLiteral(type) || (kind && !isSafeArgLiteral(kind))) {
    return NextResponse.json(
      { ok: false, code: 'bad_request', error: 'Invalid characters in `type` or `kind`.' },
      { status: 400 },
    );
  }

  const query = buildQuery(type, kind);

  // ---- (a) User ARM token (per-user RBAC) -------------------------------
  let userArgError: { status: number; error: string } | null = null;
  try {
    const userToken = await getUserArmToken(session.claims.oid);
    if (userToken) {
      const r = await runArg(userToken, query);
      if (r.ok) {
        return NextResponse.json({ ok: true, resources: r.rows, via: 'user' });
      }
      // Auth/expiry on the user path: remember it, then fall through to UAMI.
      userArgError = { status: r.status, error: r.error };
    }
  } catch {
    // Ignore — fall through to UAMI.
  }

  // ---- (b) UAMI fallback -------------------------------------------------
  try {
    const tok = await uamiCredential().getToken(ARM_SCOPE);
    if (tok?.token) {
      const r = await runArg(tok.token, query);
      if (r.ok) {
        if (r.rows.length === 0 && userArgError) {
          // Both paths reachable but nothing visible → honest gate.
          return NextResponse.json({ ok: false, code: 'no_access', error: GATE_MESSAGE }, { status: 200 });
        }
        return NextResponse.json({ ok: true, resources: r.rows, via: 'uami' });
      }
      // UAMI ARG call itself failed (e.g. UAMI has no read scope anywhere).
      return NextResponse.json(
        { ok: false, code: 'no_access', error: `${GATE_MESSAGE} (Resource Graph error via UAMI: ${r.error})` },
        { status: 200 },
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, code: 'no_access', error: `${GATE_MESSAGE} (Could not acquire a UAMI ARM token: ${sanitize(e?.message || String(e))})` },
      { status: 200 },
    );
  }

  // Neither path produced a usable token.
  return NextResponse.json({ ok: false, code: 'no_access', error: GATE_MESSAGE }, { status: 200 });
}
