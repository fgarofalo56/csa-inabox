/**
 * Lakehouse Spark job handle — the opaque `jobId` that the Livy-backed
 * lakehouse routes (`/api/lakehouse/transform-preview`,
 * `/api/lakehouse/table-stats`) hand back from a kick-off and accept on a poll.
 *
 * The handle carries the Livy coordinates (pool, session id, statement id) AND
 * the lakehouse-scoped context the kick-off authorized: the lakehouse item id,
 * the route purpose, the signed-in principal, and the container + path the job
 * reads. It is HMAC-signed, so a poll works only on a job this platform started
 * for this exact item, route and principal, and the poll reads its container and
 * path from the handle rather than from the request.
 *
 * Signing follows the pattern of `session.ts`, `embed-token.ts` and
 * `notebook-exec-scope.ts`: an HKDF key derived from the already-required
 * `SESSION_SECRET` under a DISTINCT `info` label, so this handle can never be
 * replayed as any of those tokens (or vice versa), and no new secret is added.
 */
import crypto from 'node:crypto';

export const LAKEHOUSE_JOB_PREFIX = 'lhjob1.';

/** How long a handle stays usable after it was minted. */
export const LAKEHOUSE_JOB_TTL_MS = 6 * 60 * 60 * 1000;

export type LakehouseJobPurpose = 'transform-preview' | 'table-stats';

/** What the POLLING request authorized: the item, the route, the principal. */
export interface LakehouseJobScope {
  lakehouseId: string;
  purpose: LakehouseJobPurpose;
  oid: string;
}

/** What the KICK-OFF recorded about the job. */
export interface LakehouseJobClaims {
  pool: string;
  sessionId: number;
  /** null while the pool was still warming at kick-off (no statement yet). */
  stmtId: number | null;
  container: string;
  path: string;
  /**
   * sha256 (base64url) of the candidate code, for a purpose whose statement is
   * submitted on a later poll: the code sent then must be the code the
   * kick-off accepted. Absent when the statement is built entirely server-side.
   */
  codeHash?: string;
  /**
   * The storage account the kick-off scoped the path on (the item's BOUND
   * account). A poll that builds the Spark URI uses this rather than the
   * deployment's primary account. Absent on the tenant-admin form.
   */
  account?: string;
}

function jobKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf-8'),
    Buffer.alloc(32),
    Buffer.from('loom-lakehouse-job-v1'),
    32,
  );
  return Buffer.from(ab as ArrayBuffer);
}

/** sha256 of the candidate code, base64url — the value `codeHash` carries. */
export function hashJobCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf-8').digest('base64url');
}

/**
 * Mint the handle for a job. `nowMs` is injectable for tests; production callers
 * omit it.
 *
 * Throws when `scope.oid` is empty: a handle is bound to the principal that
 * started the job, and a session without an object id names no principal, so
 * there is nothing to bind it to. Callers refuse such a session before minting.
 */
export function mintLakehouseJobHandle(
  scope: LakehouseJobScope,
  claims: LakehouseJobClaims,
  nowMs: number = Date.now(),
): string {
  if (!scope.oid) throw new Error('a lakehouse job handle needs the signed-in user object id');
  const body: Record<string, unknown> = {
    i: scope.lakehouseId,
    u: scope.purpose,
    o: scope.oid,
    p: claims.pool,
    s: claims.sessionId,
    t: claims.stmtId,
    c: claims.container,
    f: claims.path,
    at: nowMs,
  };
  if (claims.codeHash) body.h = claims.codeHash;
  if (claims.account) body.a = claims.account;
  const payload = Buffer.from(JSON.stringify(body), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', jobKey()).update(payload).digest('base64url');
  return `${LAKEHOUSE_JOB_PREFIX}${payload}.${sig}`;
}

/**
 * Verify a caller-supplied handle against the scope THIS request authorized and
 * return the recorded job, or null for ANY failure: missing, malformed, a bad
 * signature, a different item / purpose / principal, an empty principal in the
 * polling scope, or older than {@link LAKEHOUSE_JOB_TTL_MS}. Never throws.
 *
 * The scope fields are both signed and re-compared: the signature alone would
 * accept a handle minted for another item, and the comparison alone would be
 * forgeable.
 */
export function verifyLakehouseJobHandle(
  scope: LakehouseJobScope,
  handle: unknown,
  nowMs: number = Date.now(),
): LakehouseJobClaims | null {
  if (!scope.oid) return null;
  const raw = typeof handle === 'string' ? handle.trim() : '';
  if (!raw.startsWith(LAKEHOUSE_JOB_PREFIX)) return null;
  const rest = raw.slice(LAKEHOUSE_JOB_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot >= rest.length - 1) return null;
  const payload = rest.slice(0, dot);
  const providedB64 = rest.slice(dot + 1);

  let expected: Buffer;
  try {
    expected = crypto.createHmac('sha256', jobKey()).update(payload).digest();
  } catch {
    return null;
  }
  const provided = Buffer.from(providedB64, 'base64url');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  let b: Record<string, unknown>;
  try {
    b = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object') return null;
  if (b.i !== scope.lakehouseId || b.u !== scope.purpose || b.o !== scope.oid) return null;
  const at = typeof b.at === 'number' ? b.at : NaN;
  if (!Number.isFinite(at) || at > nowMs + 60_000 || nowMs - at > LAKEHOUSE_JOB_TTL_MS) return null;
  if (typeof b.p !== 'string' || !b.p) return null;
  if (typeof b.s !== 'number' || !Number.isInteger(b.s)) return null;
  if (b.t !== null && (typeof b.t !== 'number' || !Number.isInteger(b.t))) return null;
  if (typeof b.c !== 'string' || typeof b.f !== 'string') return null;
  if (b.a !== undefined && (typeof b.a !== 'string' || !b.a)) return null;
  return {
    pool: b.p,
    sessionId: b.s,
    stmtId: b.t as number | null,
    container: b.c,
    path: b.f,
    ...(typeof b.h === 'string' ? { codeHash: b.h } : {}),
    ...(typeof b.a === 'string' ? { account: b.a } : {}),
  };
}

/**
 * Synapse Spark pool names: a letter, then letters or digits, 15 characters at
 * most. A pool name goes into a Livy URL path, so anything else is refused.
 */
export const SPARK_POOL_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,14}$/;
