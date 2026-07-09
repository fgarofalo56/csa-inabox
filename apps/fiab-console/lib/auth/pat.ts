/**
 * pat — scoped API tokens (Personal Access Tokens) for NON-INTERACTIVE access
 * to the Loom BFF (BR-PAT, Wave 6). The foundation the whole developer-platform
 * track (BR-OPENAPI / BR-TERRAFORM / BR-SCIM) rides on.
 *
 * ## Why
 *
 * Until now Loom was session-cookie-only: `/api/auth/cli-session` mints a
 * browser-identical encrypted `loom_session` cookie and every route reads it —
 * "there is NO separate API-key / bearer auth scheme". That works for a CLI
 * replaying a cookie, but not for CI systems, Terraform, or SCIM provisioners
 * that want a long-lived, revocable, SCOPED credential. This module adds one.
 *
 * ## Shape of a token
 *
 *   loom_pat_<id>_<secret>
 *     <id>     = 24 hex chars (the PUBLIC token id — also the Cosmos doc id/PK)
 *     <secret> = 43 base64url chars (32 bytes of entropy — shown ONCE at create)
 *
 * We store the token doc in the `loom-pat-tokens` Cosmos container keyed by
 * `<id>` and persist a **SHA-256 hash of the secret only** — never the secret.
 * A lost token is unrecoverable (regenerate), exactly like GitHub/Azure DevOps
 * PATs. `resolvePat()` re-hashes the presented secret and compares in constant
 * time.
 *
 * ## Scopes (typed — no free-form strings)
 *
 *   read-only   — GET/HEAD/OPTIONS only. Any mutating verb is rejected.
 *   read-write  — full data-plane access as the creator (NO admin surfaces).
 *   admin       — read-write PLUS admin surfaces, but ONLY when the creator is a
 *                 tenant admin at RESOLVE time (see enforcePatAccess). An
 *                 admin-scoped token minted by a since-demoted user gets no
 *                 admin power.
 *
 * A PAT can NEVER mint or revoke further tokens (patCannotMint) regardless of
 * scope — token management is a human, cookie-session-only surface.
 *
 * ## Expiry
 *
 *   default 30 days, hard max 90 days. Enforced at create + re-checked on every
 *   resolve (an expired token is a denied use, audited).
 *
 * The real backend here is Cosmos (per no-vaporware.md): create/list/revoke/
 * resolve are real container ops; there is no mock path.
 */

import crypto from 'node:crypto';
import { loomPatTokensContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import type { SessionPayload, PatSessionContext } from '@/lib/auth/session';
import type { UserClaims } from '@/lib/auth/msal';

// ── Constants ────────────────────────────────────────────────────────────────

/** Bearer prefix. `loom_pat_<id>_<secret>`. */
export const PAT_PREFIX = 'loom_pat_';
/** Hard ceiling on token lifetime (days). A create request above this clamps. */
export const PAT_MAX_TTL_DAYS = 90;
/** Default token lifetime (days) when the caller doesn't specify one. */
export const PAT_DEFAULT_TTL_DAYS = 30;

/** Typed scopes — the create wizard offers exactly these (no free-form input). */
export type PatScope = 'read-only' | 'read-write' | 'admin';
export const PAT_SCOPES: PatScope[] = ['read-only', 'read-write', 'admin'];
export function isPatScope(v: unknown): v is PatScope {
  return typeof v === 'string' && (PAT_SCOPES as string[]).includes(v);
}

/** HTTP verbs a read-only token is permitted to use. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ── Persisted doc ────────────────────────────────────────────────────────────

/** One PAT row in the `loom-pat-tokens` container (id == partition key). */
export interface PatTokenDoc {
  /** Public token id — the `<id>` in the bearer AND the Cosmos doc id/PK. */
  id: string;
  /** SHA-256 hex of the secret. The secret itself is NEVER stored. */
  hash: string;
  /** Tenant the token belongs to (creator `tid`, falling back to `oid`). */
  tenantId: string;
  /** Human-friendly label set at create time. */
  name: string;
  /** Typed scope. */
  scope: PatScope;
  /** Snapshot of the creator's claims — used to reconstruct a session on resolve. */
  createdByOid: string;
  createdByUpn: string;
  createdByName: string;
  createdByTid?: string;
  /** Group snapshot at create time — feeds the admin-scope check on resolve. */
  createdByGroups?: string[];
  createdAt: string; // ISO-8601
  expiresAt: string; // ISO-8601
  lastUsedAt?: string; // ISO-8601
  revoked: boolean;
  revokedAt?: string;
  revokedByOid?: string;
}

/** The safe projection returned to the UI — NEVER includes `hash`. */
export interface PatTokenView {
  id: string;
  name: string;
  scope: PatScope;
  createdByOid: string;
  createdByUpn: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  revokedAt?: string;
  expired: boolean;
}

export function toView(d: PatTokenDoc): PatTokenView {
  return {
    id: d.id,
    name: d.name,
    scope: d.scope,
    createdByOid: d.createdByOid,
    createdByUpn: d.createdByUpn,
    createdByName: d.createdByName,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    lastUsedAt: d.lastUsedAt,
    revoked: d.revoked,
    revokedAt: d.revokedAt,
    expired: isExpired(d),
  };
}

// ── Pure crypto / parsing (unit-tested, no I/O) ──────────────────────────────

/** Generate a fresh token id (24 hex chars — never contains `_`). */
export function generateTokenId(): string {
  return crypto.randomBytes(12).toString('hex');
}

/** Generate a fresh secret (43 base64url chars = 32 bytes of entropy). */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA-256 hex of a secret. Deterministic — the stored + compared form. */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time compare of a presented secret against a stored hash. */
export function verifySecret(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Assemble the one-time full token string from its parts. */
export function formatToken(id: string, secret: string): string {
  return `${PAT_PREFIX}${id}_${secret}`;
}

/**
 * Parse a bearer/token string into `{ id, secret }`, or null when malformed.
 * The id is EXACTLY 24 hex chars (no `_`), so the `_` after it unambiguously
 * separates it from the base64url secret (which may itself contain `_`/`-`).
 */
export function parseToken(token: string | null | undefined): { id: string; secret: string } | null {
  if (!token) return null;
  const m = /^loom_pat_([0-9a-f]{24})_([A-Za-z0-9_-]{43})$/.exec(token.trim());
  if (!m) return null;
  return { id: m[1], secret: m[2] };
}

/**
 * Extract a token from an `Authorization` header value. Accepts `Bearer
 * loom_pat_...` (case-insensitive scheme) or the bare token. Returns the parsed
 * parts or null.
 */
export function parseAuthHeader(authorization: string | null | undefined): { id: string; secret: string } | null {
  if (!authorization) return null;
  const trimmed = authorization.trim();
  const bearer = /^bearer\s+(.+)$/i.exec(trimmed);
  const raw = bearer ? bearer[1].trim() : trimmed;
  return parseToken(raw);
}

/** Clamp a requested TTL (days) into (0, PAT_MAX_TTL_DAYS], defaulting when absent/invalid. */
export function clampTtlDays(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return PAT_DEFAULT_TTL_DAYS;
  return Math.min(Math.floor(n), PAT_MAX_TTL_DAYS);
}

/** Whether a token doc is past its expiry. Pure — takes an optional `now`. */
export function isExpired(d: Pick<PatTokenDoc, 'expiresAt'>, now: number = Date.now()): boolean {
  const exp = Date.parse(d.expiresAt);
  return Number.isFinite(exp) ? exp <= now : true;
}

/** Whether a scope permits an HTTP method. read-only ⇒ GET/HEAD/OPTIONS only. */
export function scopeAllowsMethod(scope: PatScope, method: string): boolean {
  if (scope === 'read-only') return READ_METHODS.has((method || 'GET').toUpperCase());
  return true;
}

// ── Session-shaped result of a resolve ───────────────────────────────────────

function claimsFromDoc(d: PatTokenDoc): UserClaims {
  return {
    oid: d.createdByOid,
    tid: d.createdByTid,
    name: d.createdByName,
    upn: d.createdByUpn,
    groups: d.createdByGroups,
  };
}

/**
 * Resolve an `Authorization` header to a session-equivalent {@link SessionPayload}
 * carrying a {@link PatSessionContext} `pat` marker + the creator's claims — or
 * null when the header carries no valid, live PAT. NEVER throws.
 *
 * Denials that are security-relevant (an unknown id, a bad secret, a revoked or
 * expired token being presented) emit a `pat.use-denied` audit event so a SIEM
 * can alert on token misuse (use-after-revoke in particular). A successful
 * resolve best-effort-stamps `lastUsedAt` (fire-and-forget; never blocks).
 */
export async function resolvePat(authorization: string | null | undefined): Promise<SessionPayload | null> {
  const parsed = parseAuthHeader(authorization);
  if (!parsed) return null; // not a PAT header at all — silent (cookie path may still apply)

  let doc: PatTokenDoc | undefined;
  try {
    const c = await loomPatTokensContainer();
    const { resource } = await c.item(parsed.id, parsed.id).read<PatTokenDoc>();
    doc = resource;
  } catch {
    doc = undefined;
  }
  if (!doc) {
    // Unknown id — do NOT audit (unauthenticated noise / enumeration); just deny.
    return null;
  }

  // Verify the secret BEFORE trusting any field on the doc.
  if (!verifySecret(parsed.secret, doc.hash)) {
    return null;
  }

  // From here the caller PROVED possession of a real token — a revoked/expired
  // presentation is a meaningful, auditable "use-after-revoke / expired" event.
  if (doc.revoked) {
    auditUseDenied(doc, 'revoked');
    return null;
  }
  if (isExpired(doc)) {
    auditUseDenied(doc, 'expired');
    return null;
  }

  // Best-effort lastUsedAt stamp — never block the request on it.
  void stampLastUsed(doc.id).catch(() => { /* best-effort telemetry */ });

  const pat: PatSessionContext = { tokenId: doc.id, scope: doc.scope };
  return {
    claims: claimsFromDoc(doc),
    // A PAT session's logical expiry is the token's expiry (seconds).
    exp: Math.floor(Date.parse(doc.expiresAt) / 1000),
    pat,
  };
}

async function stampLastUsed(id: string): Promise<void> {
  const c = await loomPatTokensContainer();
  await c.item(id, id).patch([{ op: 'set', path: '/lastUsedAt', value: new Date().toISOString() }]);
}

function auditUseDenied(doc: PatTokenDoc, reason: 'revoked' | 'expired'): void {
  emitAuditEvent({
    actorOid: doc.createdByOid,
    actorUpn: doc.createdByUpn,
    action: 'pat.use-denied',
    targetType: 'api-token',
    targetId: doc.id,
    outcome: 'denied',
    detail: { reason, scope: doc.scope, name: doc.name },
    tenantId: doc.tenantId,
  });
}

// ── Guards a PAT-aware route uses ────────────────────────────────────────────

/** True when the session is a PAT (vs a browser cookie session). */
export function isPatSession(session: SessionPayload | null | undefined): boolean {
  return !!session?.pat;
}

/**
 * A PAT can NEVER mint/revoke tokens — token management is human-only. Returns
 * true when the session is a PAT (so the caller should reject with 403).
 */
export function patCannotMint(session: SessionPayload | null | undefined): boolean {
  return isPatSession(session);
}

/**
 * Whether a PAT session may reach an admin surface: it must be `admin`-scoped
 * AND its creator must STILL be a tenant admin at resolve time. A non-PAT
 * (cookie) session is out of scope here — callers gate those with the normal
 * `isTenantAdmin`/`requireTenantAdmin`.
 */
export function patCanAdmin(session: SessionPayload): boolean {
  if (!session.pat) return false;
  return session.pat.scope === 'admin' && isTenantAdmin(session);
}

// ── Create / list / revoke (Cosmos-backed) ───────────────────────────────────

export interface CreatePatInput {
  name: string;
  scope: PatScope;
  ttlDays?: number;
  creator: UserClaims;
}

export interface CreatePatResult {
  view: PatTokenView;
  /** The one-time full token string. Returned ONCE — the caller shows it, then it's gone. */
  token: string;
}

/**
 * Create a token: generate id + secret, store the HASH + metadata, and return
 * the one-time full token string alongside the safe view. Audited.
 */
export async function createPatToken(input: CreatePatInput): Promise<CreatePatResult> {
  const id = generateTokenId();
  const secret = generateSecret();
  const ttlDays = clampTtlDays(input.ttlDays);
  const now = new Date();
  const expires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const tenantId = input.creator.tid || input.creator.oid;

  const doc: PatTokenDoc = {
    id,
    hash: hashSecret(secret),
    tenantId,
    name: (input.name || '').trim().slice(0, 120) || 'Untitled token',
    scope: input.scope,
    createdByOid: input.creator.oid,
    createdByUpn: input.creator.upn,
    createdByName: input.creator.name,
    createdByTid: input.creator.tid,
    createdByGroups: input.creator.groups,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    revoked: false,
  };

  const c = await loomPatTokensContainer();
  await c.items.create(doc);

  emitAuditEvent({
    actorOid: input.creator.oid,
    actorUpn: input.creator.upn,
    action: 'pat.create',
    targetType: 'api-token',
    targetId: id,
    outcome: 'success',
    detail: { name: doc.name, scope: doc.scope, expiresAt: doc.expiresAt, ttlDays },
    tenantId,
  });

  return { view: toView(doc), token: formatToken(id, secret) };
}

/** List a single user's tokens (the Developer settings surface). */
export async function listPatTokensForUser(oid: string): Promise<PatTokenView[]> {
  const c = await loomPatTokensContainer();
  const { resources } = await c.items
    .query<PatTokenDoc>({
      query: 'SELECT * FROM c WHERE c.createdByOid = @oid ORDER BY c.createdAt DESC',
      parameters: [{ name: '@oid', value: oid }],
    })
    .fetchAll();
  return resources.map(toView);
}

/** List every token in a tenant (the admin surface). */
export async function listPatTokensForTenant(tenantId: string): Promise<PatTokenView[]> {
  const c = await loomPatTokensContainer();
  const { resources } = await c.items
    .query<PatTokenDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources.map(toView);
}

/** Point-read a token doc by id (partition == id). null when absent. */
export async function getPatToken(id: string): Promise<PatTokenDoc | null> {
  try {
    const c = await loomPatTokensContainer();
    const { resource } = await c.item(id, id).read<PatTokenDoc>();
    return resource ?? null;
  } catch {
    return null;
  }
}

export type RevokeOutcome = 'revoked' | 'not-found' | 'forbidden' | 'already-revoked';

/**
 * Revoke a token. `byAdmin` lets a tenant admin revoke any token in their
 * tenant; otherwise the caller may only revoke their OWN token. Idempotent-ish:
 * re-revoking returns `already-revoked`. Audited on a real state change.
 */
export async function revokePatToken(
  id: string,
  actor: { oid: string; upn: string; tid?: string },
  byAdmin: boolean,
): Promise<RevokeOutcome> {
  const doc = await getPatToken(id);
  if (!doc) return 'not-found';

  const actorTenant = actor.tid || actor.oid;
  if (byAdmin) {
    // A tenant admin may only revoke tokens within THEIR tenant.
    if (doc.tenantId !== actorTenant) return 'forbidden';
  } else if (doc.createdByOid !== actor.oid) {
    return 'forbidden';
  }
  if (doc.revoked) return 'already-revoked';

  doc.revoked = true;
  doc.revokedAt = new Date().toISOString();
  doc.revokedByOid = actor.oid;
  const c = await loomPatTokensContainer();
  await c.item(id, id).replace(doc);

  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.upn,
    action: 'pat.revoke',
    targetType: 'api-token',
    targetId: id,
    outcome: 'success',
    detail: { name: doc.name, scope: doc.scope, byAdmin, ownerOid: doc.createdByOid },
    tenantId: doc.tenantId,
  });
  return 'revoked';
}
