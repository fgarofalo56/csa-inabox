/**
 * /api/delta-sharing/[...path] — the RECIPIENT-facing Delta Sharing endpoint (LU-9).
 *
 * This is the address an external recipient puts in their `.share` profile:
 *
 *   { "shareCredentialsVersion": 1,
 *     "endpoint": "https://<loom-console>/api/delta-sharing",
 *     "bearerToken": "<a Microsoft Entra access token>" }
 *
 * ── Why the Console serves the protocol instead of exposing the server ─────
 * The OSS Delta Sharing reference server (`loom-sharing`) authenticates with a
 * SINGLE global bearer and has no concept of a recipient: whoever holds that
 * token sees every share on the server. Publishing it — even behind a gateway
 * that checks Entra — would mean every authenticated recipient could read every
 * other recipient's data.
 *
 * So Loom splits the protocol:
 *
 *   discovery (shares / schemas / tables)   answered from Loom's own record,
 *                                           filtered to THIS recipient's grants
 *   data plane (version / metadata / query  proxied to the internal server, but
 *              / changes)                   only after the share in the URL is
 *                                           confirmed to be granted
 *
 * Every request therefore passes two checks in order: authenticate the Entra
 * bearer to a recipient (401/403), then authorize the share named in the path
 * against that recipient's grants (403). Recipient A asking for recipient B's
 * share is refused here, before any byte reaches the sharing server.
 *
 * ── Response shape ────────────────────────────────────────────────────────
 * Deliberately NOT the Loom `{ok,...}` envelope: this route implements a public
 * wire protocol whose clients (delta-sharing-python, the Spark connector,
 * PowerBI's connector) parse `{errorCode, message}` and newline-delimited JSON.
 * A Loom envelope here would break every conforming client.
 *
 * Azure-native only: the tables are ADLS Gen2 Delta, the same lake the lakehouse
 * item type writes (.claude/rules/no-fabric-dependency.md). No Databricks, no
 * Fabric, no Power BI workspace is involved on this path.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { authenticateRecipient, assertShareAccess, sharingOwnerTenantId } from '@/lib/sharing/recipient-auth';
import { listShares, getShare, loomSharingFetch, LoomSharingNotConfiguredError } from '@/lib/sharing/store';
import {
  toProtocolShare,
  toProtocolSchemas,
  toProtocolTables,
  visibleShares,
  type LoomRecipient,
} from '@/lib/sharing/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Delta Sharing protocol error body (NOT the Loom envelope — see the header). */
function protocolError(status: number, errorCode: string, message: string, hint?: string) {
  return NextResponse.json({ errorCode, message: hint ? `${message} ${hint}` : message }, { status });
}

/**
 * Append-only record of one recipient's access. Data leaving the boundary is
 * exactly the event that must be attributable later, so it is written for
 * refusals too — a denied cross-recipient probe is the interesting row.
 * Best-effort: an audit hiccup must not become a data-availability incident,
 * and the refusal itself has already happened by the time we get here.
 */
async function auditRecipientAccess(input: {
  recipient: string;
  principal: string;
  action: string;
  share: string;
  detail?: Record<string, unknown>;
  outcome: 'allow' | 'deny';
}): Promise<void> {
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `delta-sharing:${input.share || '*'}`,
        tenantId: sharingOwnerTenantId(),
        who: `recipient:${input.recipient}`,
        actorOid: input.principal,
        at: new Date().toISOString(),
        kind: 'delta-sharing',
        action: input.action,
        target: input.share,
        outcome: input.outcome,
        detail: input.detail || {},
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
}

/** Proxy one data-plane call to the internal sharing server and stream the
 *  body back untouched. Called ONLY after the share has been authorized. */
async function proxyToServer(path: string, init: { method?: string; body?: string }): Promise<NextResponse> {
  const upstream = await loomSharingFetch(path, init);
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      // The protocol's table endpoints return newline-delimited JSON; preserve
      // whatever the server declared rather than guessing.
      'content-type': upstream.headers.get('content-type') || 'application/json',
      // A capability-bearing response (it may embed short-lived file URLs) must
      // never be cached by an intermediary.
      'cache-control': 'no-store',
    },
  });
}

/** Segments after /api/delta-sharing, e.g. ['shares','fin','schemas']. */
async function segments(ctx: { params: Promise<{ path?: string[] }> }): Promise<string[]> {
  const p = await ctx.params;
  return (p?.path || []).filter(Boolean);
}

/**
 * Resolve + authorize the share named in the path. Returns either the refusal
 * response or the recipient/share pair the handler may use.
 */
async function authorize(
  req: NextRequest,
  shareName: string | undefined,
  action: string,
): Promise<{ error: NextResponse } | { recipient: LoomRecipient; principal: string }> {
  const auth = await authenticateRecipient(req.headers.get('authorization'));
  if (!auth.ok) {
    return {
      error: protocolError(
        auth.status,
        auth.status === 401 ? 'UNAUTHENTICATED' : auth.status === 403 ? 'PERMISSION_DENIED' : 'UNAVAILABLE',
        auth.error,
        auth.hint,
      ),
    };
  }
  if (shareName) {
    const denied = assertShareAccess(auth.recipient, shareName);
    if (denied && !denied.ok) {
      await auditRecipientAccess({
        recipient: auth.recipient.id,
        principal: auth.principal,
        action,
        share: shareName,
        outcome: 'deny',
      });
      return { error: protocolError(403, 'PERMISSION_DENIED', denied.error, denied.hint) };
    }
  }
  return { recipient: auth.recipient, principal: auth.principal };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const seg = await segments(ctx);
  try {
    // /shares
    if (seg.length === 1 && seg[0] === 'shares') {
      const authed = await authorize(req, undefined, 'list-shares');
      if ('error' in authed) return authed.error;
      const all = await listShares(sharingOwnerTenantId());
      const mine = visibleShares(authed.recipient, all);
      await auditRecipientAccess({
        recipient: authed.recipient.id, principal: authed.principal,
        action: 'list-shares', share: '', outcome: 'allow',
        detail: { count: mine.length },
      });
      return NextResponse.json({ items: mine.map(toProtocolShare) }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{share}
    if (seg.length === 2 && seg[0] === 'shares') {
      const authed = await authorize(req, seg[1], 'get-share');
      if ('error' in authed) return authed.error;
      const share = await getShare(sharingOwnerTenantId(), seg[1]);
      // Granted but absent = the grant references a deleted share. Say so
      // plainly; a granted recipient is not being probed for existence.
      if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);
      return NextResponse.json({ share: toProtocolShare(share) }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{share}/schemas
    if (seg.length === 3 && seg[0] === 'shares' && seg[2] === 'schemas') {
      const authed = await authorize(req, seg[1], 'list-schemas');
      if ('error' in authed) return authed.error;
      const share = await getShare(sharingOwnerTenantId(), seg[1]);
      if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);
      return NextResponse.json({ items: toProtocolSchemas(share) }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{share}/all-tables
    if (seg.length === 3 && seg[0] === 'shares' && seg[2] === 'all-tables') {
      const authed = await authorize(req, seg[1], 'list-all-tables');
      if ('error' in authed) return authed.error;
      const share = await getShare(sharingOwnerTenantId(), seg[1]);
      if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);
      return NextResponse.json({ items: toProtocolTables(share) }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{share}/schemas/{schema}/tables
    if (seg.length === 5 && seg[0] === 'shares' && seg[2] === 'schemas' && seg[4] === 'tables') {
      const authed = await authorize(req, seg[1], 'list-tables');
      if ('error' in authed) return authed.error;
      const share = await getShare(sharingOwnerTenantId(), seg[1]);
      if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);
      return NextResponse.json({ items: toProtocolTables(share, seg[3]) }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{s}/schemas/{sc}/tables/{t}/{version|metadata|changes} — data plane.
    if (seg.length === 7 && seg[0] === 'shares' && seg[2] === 'schemas' && seg[4] === 'tables') {
      const tail = seg[6];
      if (tail !== 'version' && tail !== 'metadata' && tail !== 'changes') {
        return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Unsupported Delta Sharing resource "${tail}".`);
      }
      const authed = await authorize(req, seg[1], tail);
      if ('error' in authed) return authed.error;
      await auditRecipientAccess({
        recipient: authed.recipient.id, principal: authed.principal,
        action: tail, share: seg[1], outcome: 'allow',
        detail: { schema: seg[3], table: seg[5] },
      });
      const qs = req.nextUrl.search || '';
      return proxyToServer(`/${seg.join('/')}${qs}`, { method: 'GET' });
    }

    return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', 'Unknown Delta Sharing resource.');
  } catch (e) {
    if (e instanceof LoomSharingNotConfiguredError) {
      return protocolError(503, 'UNAVAILABLE', e.message, e.hint.followUp);
    }
    console.error('[delta-sharing] GET failed', e);
    return protocolError(500, 'INTERNAL_ERROR', 'The Delta Sharing endpoint failed to serve this request.');
  }
}

/** POST is the protocol's table QUERY (predicate hints + limit + version). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const seg = await segments(ctx);
  try {
    if (seg.length === 7 && seg[0] === 'shares' && seg[2] === 'schemas' && seg[4] === 'tables' && seg[6] === 'query') {
      const authed = await authorize(req, seg[1], 'query');
      if ('error' in authed) return authed.error;
      const body = await req.text();
      await auditRecipientAccess({
        recipient: authed.recipient.id, principal: authed.principal,
        action: 'query', share: seg[1], outcome: 'allow',
        detail: { schema: seg[3], table: seg[5], bytes: body.length },
      });
      return proxyToServer(`/${seg.join('/')}`, { method: 'POST', body: body || '{}' });
    }
    return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', 'Unknown Delta Sharing resource.');
  } catch (e) {
    if (e instanceof LoomSharingNotConfiguredError) {
      return protocolError(503, 'UNAVAILABLE', e.message, e.hint.followUp);
    }
    console.error('[delta-sharing] POST failed', e);
    return protocolError(500, 'INTERNAL_ERROR', 'The Delta Sharing endpoint failed to serve this request.');
  }
}
