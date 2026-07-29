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
 *              / changes)                   only for a table resolved INSIDE the
 *                                           recipient's own granted share
 *
 * ── The rule that keeps A out of B's data ─────────────────────────────────
 * THE AUTHORIZED PATH AND THE PROXIED PATH ARE THE SAME PATH, structurally.
 *
 * Authorizing `seg[1]` and then proxying `seg.join('/')` is NOT that, and was
 * the defect this route first shipped with: Next.js percent-DECODES each
 * catch-all segment before the handler sees it, so `%2E%2E%2F%2E%2E%2Fshares%2Fshare-b`
 * arrives as a literal `../../shares/share-b` inside ONE segment, and the WHATWG
 * URL parser collapses the dot-segments when the upstream URL is built. The
 * authorized share name and the proxied share name then differ, and the
 * reference server — holding the global bearer — serves the other recipient's
 * table.
 *
 * The data-plane branch therefore forwards no caller text at all. It resolves
 * the (schema, table) pair against the table list of the AUTHORIZED share record
 * and rebuilds the upstream path from that record (`upstreamTablePath`), with
 * every component percent-encoded and the sub-resource taken from a closed
 * literal set. A path naming anything outside the granted share cannot be
 * constructed, however it is spelled — it 404s at table resolution instead.
 *
 * ── Audit ─────────────────────────────────────────────────────────────────
 * Every outcome is written, allow AND deny, including 401s: on a surface whose
 * whole purpose is moving data outside the boundary, the refusals are the rows
 * an investigation starts from. Allow rows record what was actually SERVED (the
 * resolved share/schema/table and the exact upstream path), never what the
 * caller asked for — a row that says "share-a" for a read that returned
 * share-b's bytes is worse than no row.
 *
 * Deny rows are THROTTLED (see shouldWriteDeny), because a refusal that costs
 * the caller nothing and costs us a Cosmos write is an amplifier. The throttle
 * has a per-key window AND a per-window global ceiling: the first alone was not
 * enough, because the key was derived from a header the CALLER supplies.
 * Source attribution comes from a hop we control (lib/azure/client-ip); the
 * caller's own claim is recorded separately, never keyed on.
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
import { trustedClientIp, claimedClientIp } from '@/lib/azure/client-ip';
import { checkRate } from '@/lib/azure/rate-limiter';
import { authenticateRecipient, assertShareAccess, sharingOwnerTenantId } from '@/lib/sharing/recipient-auth';
import { listShares, getShare, loomSharingFetch, LoomSharingNotConfiguredError } from '@/lib/sharing/store';
import {
  toProtocolShare,
  toProtocolSchemas,
  toProtocolTables,
  visibleShares,
  findSharedTable,
  upstreamTablePath,
  safeUpstreamQuery,
  isDataPlaneResource,
  type DataPlaneResource,
  type LoomRecipient,
  type LoomShare,
} from '@/lib/sharing/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Delta Sharing protocol error body (NOT the Loom envelope — see the header).
 *
 * `hint` is passed ONLY for a caller that has already authenticated. Operator
 * remediation (env var names, bicep module paths, Key Vault wiring) goes to the
 * log instead: this route is reachable from the internet with no credential at
 * all, and configuration state is itself something an attacker should not be
 * handed for free.
 */
function protocolError(status: number, errorCode: string, message: string, hint?: string) {
  return NextResponse.json({ errorCode, message: hint ? `${message} ${hint}` : message }, { status });
}

/** Best-effort source attribution for the audit row.
 *
 *  Uses only values a hop WE control wrote (see lib/azure/client-ip). This used
 *  to be `x-forwarded-for.split(',')[0]` — the CLIENT-most hop, i.e. a string the
 *  caller types — on a route with no middleware and no rate limiter. That made
 *  the burst guard below a no-op (rotate the header, get a fresh key every
 *  request) and stamped attacker-chosen addresses into the audit trail. */
function callerIp(req: NextRequest): string {
  return trustedClientIp(req.headers);
}

/** What the caller CLAIMED (`x-azure-clientip` / leftmost XFF). Recorded next to
 *  the trusted value under a name that says it is not attribution. */
function claimedIp(req: NextRequest): string {
  return claimedClientIp(req.headers);
}

/** Source fields for an audit row: the trusted address, plus the caller's own
 *  claim when it disagrees (a mismatch is itself worth seeing in the trail). */
function sourceDetail(req: NextRequest): Record<string, string> {
  const sourceIp = callerIp(req);
  const claimed = claimedIp(req);
  return claimed && claimed !== sourceIp
    ? { sourceIp, claimedClientIpUntrusted: claimed }
    : { sourceIp };
}

/**
 * Burst guard for DENIALS.
 *
 * Auditing refusals is the point (credential stuffing and stolen-token replay
 * look like nothing else in the trail), but a caller must not be able to turn a
 * cheap refusal into an unbounded Cosmos write amplifier. Two independent
 * brakes, because the first one alone was not enough:
 *
 *   1. per-KEY window — identical refusals from one source coalesce into one row
 *      per window, carrying the suppressed count so the burst stays visible;
 *   2. per-BUCKET global budget — a hard cap on rows written per window
 *      REGARDLESS of key. This is the backstop that survives a key the caller can
 *      influence (a spoofed source header) or genuinely cannot control (a
 *      distributed flood from real addresses). Without it, "throttled per source"
 *      is only as strong as our ability to identify the source.
 *
 * Buckets are separate so an anonymous flood cannot starve the higher-signal
 * authenticated-but-not-a-recipient rows out of the trail.
 */
const DENY_WINDOW_MS = 10_000;
const DENY_KEYS_MAX = 500;
/** Rows per 10 s window, per bucket. Anonymous refusals are cheap to generate
 *  and low-signal; a refusal that required a VERIFIED estate token is neither, so
 *  it gets a larger budget. Both are hard ceilings. */
const DENY_GLOBAL_MAX: Record<DenyBucket, number> = { anonymous: 20, principal: 40 };
type DenyBucket = 'anonymous' | 'principal';

const denyWindows = new Map<string, { until: number; suppressed: number }>();
const denyGlobal = new Map<DenyBucket, { until: number; written: number; suppressed: number }>();

function shouldWriteDeny(bucket: DenyBucket, key: string): { write: boolean; suppressed: number } {
  const now = Date.now();
  let global = denyGlobal.get(bucket);
  if (!global || global.until <= now) {
    global = { until: now + DENY_WINDOW_MS, written: 0, suppressed: 0 };
    denyGlobal.set(bucket, global);
  }
  for (const [k, v] of denyWindows) {
    if (v.until <= now) denyWindows.delete(k);
  }
  const scoped = `${bucket}|${key}`;
  const open = denyWindows.get(scoped);
  if (open && open.until > now) {
    open.suppressed += 1;
    global.suppressed += 1;
    return { write: false, suppressed: open.suppressed };
  }
  // THE backstop. Independent of the key, so a source-rotating flood cannot
  // buy itself more writes by looking like more callers.
  if (global.written >= DENY_GLOBAL_MAX[bucket]) {
    global.suppressed += 1;
    return { write: false, suppressed: global.suppressed };
  }
  // Bounded: a key-rotating flood evicts the oldest window rather than growing
  // the map without limit.
  if (denyWindows.size >= DENY_KEYS_MAX) {
    const oldest = denyWindows.keys().next().value;
    if (oldest !== undefined) denyWindows.delete(oldest);
  }
  const suppressed = open?.suppressed || 0;
  denyWindows.set(scoped, { until: now + DENY_WINDOW_MS, suppressed: 0 });
  global.written += 1;
  return { write: true, suppressed };
}

/** Test hook: the deny-throttle is module state, so a spec that asserts on the
 *  audit rows of successive refusals must be able to start from a clean window. */
export function __resetDenyThrottleForTest(): void {
  denyWindows.clear();
  denyGlobal.clear();
}

/**
 * Request-rate ceiling for the whole endpoint.
 *
 * This was the ONLY internet-reachable, credential-free route in the tree with
 * no rate limiter at all (no middleware, no route toolkit, no `withSession`), and
 * that is what made every other finding on this surface amplifiable: each
 * refusal still costs a Cosmos read on the authenticated path and a JWKS lookup
 * on the anonymous one. The tier-1 (in-process, zero-I/O) bucket is used
 * deliberately — the durable tier writes a Cosmos counter per request, which on
 * an anonymous flood is the very cost we are trying to bound.
 *
 * Keyed on the trusted source (never a caller-supplied header) and answered in
 * the PROTOCOL's error shape, not the Loom envelope, so a conforming client
 * (delta-sharing-python, the Spark connector) can still parse the refusal.
 */
function rateLimit(req: NextRequest): NextResponse | null {
  const gate = checkRate(trustedClientIp(req.headers), 'delta-sharing', { ratePerSec: 20, burst: 200 });
  if (gate.ok) return null;
  const res = protocolError(429, 'RESOURCE_EXHAUSTED', 'Too many requests. Retry after a short delay.');
  res.headers.set('retry-after', String(Math.max(1, gate.retryAfter)));
  return res;
}

/**
 * Append-only record of one recipient's access. Data leaving the boundary is
 * exactly the event that must be attributable later, so it is written for
 * refusals too — a denied cross-recipient probe is the interesting row.
 * Best-effort: an audit hiccup must not become a data-availability incident,
 * and the outcome itself has already happened by the time we get here.
 */
async function auditRecipientAccess(input: {
  recipient: string;
  principal: string;
  action: string;
  /** The share actually SERVED (allow) or refused (deny) — never an unvalidated
   *  path segment. */
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

/** Proxy one data-plane call to the internal sharing server and stream the body
 *  back untouched. `path` comes from {@link upstreamTablePath} — built from the
 *  authorized share record, never from the request URL. */
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
 *
 * EVERY refusal is audited here — the 401 for a forged/expired/foreign-tenant
 * token, the 403 for a valid token whose principal is not a recipient, and the
 * 403 for a recipient reaching outside its grants. The first two identify a
 * compromised or probing credential; leaving them unwritten was the gap this
 * route first shipped with.
 */
async function authorize(
  req: NextRequest,
  shareName: string | undefined,
  action: string,
): Promise<{ error: NextResponse } | { recipient: LoomRecipient; principal: string }> {
  const auth = await authenticateRecipient(req.headers.get('authorization'));
  if (!auth.ok) {
    const source = sourceDetail(req);
    if (auth.status === 401 || auth.status === 503) {
      // No verified principal exists, so attribution is by source + reason and
      // bursts coalesce (see shouldWriteDeny).
      const gate = shouldWriteDeny('anonymous', `${source.sourceIp}|${auth.reason}|${auth.status}`);
      if (gate.write) {
        await auditRecipientAccess({
          recipient: '(unauthenticated)', principal: '',
          action, share: '', outcome: 'deny',
          detail: {
            status: auth.status, reason: auth.reason, ...source,
            requestedShare: String(shareName || '').slice(0, 256),
            suppressedSincePrevious: gate.suppressed,
          },
        });
      }
      if (auth.operatorHint) {
        // Operator remediation is LOGGED, never returned: an anonymous caller
        // must not be able to read this estate's configuration state.
        console.warn(`[delta-sharing] ${auth.status} ${auth.reason}: ${auth.operatorHint}`);
      }
    } else {
      // 403: authenticated, but not a registered recipient — the single most
      // interesting probe event on this surface. Throttled too, but keyed on the
      // VERIFIED principal (cryptographically attested, unlike a source header)
      // and in its own budget, so an anonymous flood cannot starve these rows.
      // "Written on every request" was itself an amplifier: any holder of a
      // valid estate token could drive unbounded Cosmos writes.
      const principal = auth.principal || '';
      const gate = shouldWriteDeny('principal', `${principal}|${auth.reason}`);
      if (gate.write) {
        await auditRecipientAccess({
          recipient: '(not-a-recipient)',
          principal,
          action, share: '', outcome: 'deny',
          detail: {
            status: 403, reason: auth.reason, ...source,
            requestedShare: String(shareName || '').slice(0, 256),
            suppressedSincePrevious: gate.suppressed,
          },
        });
      }
    }
    return {
      error: protocolError(
        auth.status,
        auth.status === 401 ? 'UNAUTHENTICATED' : auth.status === 403 ? 'PERMISSION_DENIED' : 'UNAVAILABLE',
        auth.error,
        // Set only on authenticated refusals; `operatorHint` never leaves the process.
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
        detail: { status: 403, reason: denied.reason, ...sourceDetail(req) },
      });
      return { error: protocolError(403, 'PERMISSION_DENIED', denied.error, denied.hint) };
    }
  }
  return { recipient: auth.recipient, principal: auth.principal };
}

/**
 * The data-plane branch, shared by GET (version/metadata/changes) and POST
 * (query). Everything that reaches the upstream server is derived from the
 * authorized `share` record and the table record resolved inside it.
 */
async function serveDataPlane(
  req: NextRequest,
  seg: string[],
  resource: DataPlaneResource,
  body?: string,
): Promise<NextResponse> {
  const authed = await authorize(req, seg[1], resource);
  if ('error' in authed) return authed.error;

  const share: LoomShare | null = await getShare(sharingOwnerTenantId(), seg[1]);
  if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);

  // THE structural check. seg[3]/seg[5] are caller-controlled strings and are
  // used ONLY as lookup keys; they never reach the upstream URL. A traversal
  // payload matches no table and stops here.
  const table = findSharedTable(share, seg[3], seg[5]);
  if (!table) {
    await auditRecipientAccess({
      recipient: authed.recipient.id, principal: authed.principal,
      action: resource, share: share.id, outcome: 'deny',
      detail: {
        status: 404, reason: 'table-not-in-share', ...sourceDetail(req),
        requestedSchema: String(seg[3] || '').slice(0, 256),
        requestedTable: String(seg[5] || '').slice(0, 256),
      },
    });
    return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', 'Unknown table in this share.');
  }

  const upstream = `${upstreamTablePath(share, table, resource)}${resource === 'query' ? '' : safeUpstreamQuery(req.nextUrl.search)}`;
  await auditRecipientAccess({
    recipient: authed.recipient.id, principal: authed.principal,
    action: resource, share: share.id, outcome: 'allow',
    // What was SERVED, taken from the authorized record — not what was typed.
    detail: {
      schema: table.schema, table: table.name, tableId: table.id,
      upstreamPath: upstream, ...sourceDetail(req),
      ...(body !== undefined ? { bytes: body.length } : {}),
    },
  });
  return resource === 'query'
    ? proxyToServer(upstream, { method: 'POST', body: body || '{}' })
    : proxyToServer(upstream, { method: 'GET' });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const limited = rateLimit(req);
  if (limited) return limited;
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
        detail: { count: mine.length, ...sourceDetail(req) },
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
      await auditRecipientAccess({
        recipient: authed.recipient.id, principal: authed.principal,
        action: 'get-share', share: share.id, outcome: 'allow',
        detail: { ...sourceDetail(req) },
      });
      return NextResponse.json({ share: toProtocolShare(share) }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{share}/schemas
    if (seg.length === 3 && seg[0] === 'shares' && seg[2] === 'schemas') {
      const authed = await authorize(req, seg[1], 'list-schemas');
      if ('error' in authed) return authed.error;
      const share = await getShare(sharingOwnerTenantId(), seg[1]);
      if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);
      const items = toProtocolSchemas(share);
      await auditRecipientAccess({
        recipient: authed.recipient.id, principal: authed.principal,
        action: 'list-schemas', share: share.id, outcome: 'allow',
        detail: { count: items.length, ...sourceDetail(req) },
      });
      return NextResponse.json({ items }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{share}/all-tables
    if (seg.length === 3 && seg[0] === 'shares' && seg[2] === 'all-tables') {
      const authed = await authorize(req, seg[1], 'list-all-tables');
      if ('error' in authed) return authed.error;
      const share = await getShare(sharingOwnerTenantId(), seg[1]);
      if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);
      const items = toProtocolTables(share);
      await auditRecipientAccess({
        recipient: authed.recipient.id, principal: authed.principal,
        action: 'list-all-tables', share: share.id, outcome: 'allow',
        detail: { count: items.length, ...sourceDetail(req) },
      });
      return NextResponse.json({ items }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{share}/schemas/{schema}/tables
    if (seg.length === 5 && seg[0] === 'shares' && seg[2] === 'schemas' && seg[4] === 'tables') {
      const authed = await authorize(req, seg[1], 'list-tables');
      if ('error' in authed) return authed.error;
      const share = await getShare(sharingOwnerTenantId(), seg[1]);
      if (!share) return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Share "${seg[1]}" no longer exists.`);
      const items = toProtocolTables(share, seg[3]);
      await auditRecipientAccess({
        recipient: authed.recipient.id, principal: authed.principal,
        action: 'list-tables', share: share.id, outcome: 'allow',
        detail: { schema: String(seg[3] || '').slice(0, 256), count: items.length, ...sourceDetail(req) },
      });
      return NextResponse.json({ items }, { headers: { 'cache-control': 'no-store' } });
    }

    // /shares/{s}/schemas/{sc}/tables/{t}/{version|metadata|changes} — data plane.
    if (seg.length === 7 && seg[0] === 'shares' && seg[2] === 'schemas' && seg[4] === 'tables') {
      const tail = seg[6];
      // `query` is POST-only; GET must not reach it.
      if (!isDataPlaneResource(tail) || tail === 'query') {
        return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', `Unsupported Delta Sharing resource "${tail}".`);
      }
      return await serveDataPlane(req, seg, tail);
    }

    return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', 'Unknown Delta Sharing resource.');
  } catch (e) {
    if (e instanceof LoomSharingNotConfiguredError) {
      // The remediation names bicep modules and env vars — log it, never return it.
      console.warn(`[delta-sharing] not configured: ${e.message} — ${e.hint.followUp}`);
      return protocolError(503, 'UNAVAILABLE', 'Delta Sharing is unavailable in this deployment.');
    }
    console.error('[delta-sharing] GET failed', e);
    return protocolError(500, 'INTERNAL_ERROR', 'The Delta Sharing endpoint failed to serve this request.');
  }
}

/** POST is the protocol's table QUERY (predicate hints + limit + version). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const limited = rateLimit(req);
  if (limited) return limited;
  const seg = await segments(ctx);
  try {
    if (seg.length === 7 && seg[0] === 'shares' && seg[2] === 'schemas' && seg[4] === 'tables' && seg[6] === 'query') {
      const body = await req.text();
      return await serveDataPlane(req, seg, 'query', body);
    }
    return protocolError(404, 'RESOURCE_DOES_NOT_EXIST', 'Unknown Delta Sharing resource.');
  } catch (e) {
    if (e instanceof LoomSharingNotConfiguredError) {
      console.warn(`[delta-sharing] not configured: ${e.message} — ${e.hint.followUp}`);
      return protocolError(503, 'UNAVAILABLE', 'Delta Sharing is unavailable in this deployment.');
    }
    console.error('[delta-sharing] POST failed', e);
    return protocolError(500, 'INTERNAL_ERROR', 'The Delta Sharing endpoint failed to serve this request.');
  }
}
