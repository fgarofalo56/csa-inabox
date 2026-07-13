/**
 * Server-side validation + notification for the sign-in-boundary onboarding
 * queue. Kept out of the route handler so the pure validation is unit-testable
 * without pulling Cosmos / fetch into the test graph.
 */
import crypto from 'node:crypto';

/** Raw, untrusted shape posted by the (unauthenticated) Request-access form. */
export interface RawSigninAccessRequest {
  displayName?: unknown;
  email?: unknown;
  organization?: unknown;
  reason?: unknown;
  aadObjectId?: unknown;
  aadTenantId?: unknown;
  /** Honeypot — a hidden field a human never fills. Any value ⇒ silently drop. */
  company_website?: unknown;
}

export interface ValidatedSigninAccessRequest {
  displayName: string;
  email: string;
  organization?: string;
  reason: string;
  aadObjectId?: string;
  aadTenantId?: string;
}

export type ValidationResult =
  | { ok: true; value: ValidatedSigninAccessRequest }
  | { ok: false; error: string }
  | { ok: false; honeypot: true };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A permissive GUID check for the optional Entra ids (we never trust these for
// authz — they are hints the admin verifies before onboarding).
const GUID_RE = /^[0-9a-fA-F-]{36}$/;

const MAX = { displayName: 120, email: 200, organization: 160, reason: 500 } as const;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate + normalize a raw submission. Returns `{ honeypot: true }` when the
 * hidden honeypot field is populated (the caller should return a 200 as if it
 * succeeded, never persisting — so bots get no signal). Never throws.
 */
export function validateSigninAccessRequest(raw: RawSigninAccessRequest): ValidationResult {
  // Honeypot: a real user never sees / fills `company_website`. Treat any value
  // as a bot and short-circuit (the route returns a benign 200, persists nothing).
  if (str(raw.company_website) !== '') return { ok: false, honeypot: true };

  const displayName = str(raw.displayName);
  if (!displayName) return { ok: false, error: 'Your name is required.' };
  if (displayName.length > MAX.displayName) return { ok: false, error: 'Name is too long.' };

  const email = str(raw.email).toLowerCase();
  if (!email) return { ok: false, error: 'A work email is required.' };
  if (email.length > MAX.email || !EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid work email address.' };
  }

  const organization = str(raw.organization) || undefined;
  if (organization && organization.length > MAX.organization) {
    return { ok: false, error: 'Organization is too long.' };
  }

  const reason = str(raw.reason);
  if (!reason) return { ok: false, error: 'Tell the administrator why you need access.' };
  if (reason.length > MAX.reason) return { ok: false, error: 'Reason must be 500 characters or fewer.' };

  const aadObjectId = str(raw.aadObjectId) || undefined;
  if (aadObjectId && !GUID_RE.test(aadObjectId)) {
    return { ok: false, error: 'Entra object id must be a GUID.' };
  }
  const aadTenantId = str(raw.aadTenantId) || undefined;
  if (aadTenantId && !GUID_RE.test(aadTenantId)) {
    return { ok: false, error: 'Entra tenant id must be a GUID.' };
  }

  return {
    ok: true,
    value: { displayName, email, organization, reason, aadObjectId, aadTenantId },
  };
}

/** Non-reversible IP fingerprint for the audit trail (never store the raw IP). */
export function hashClientIp(ip: string): string {
  const salt = process.env.SESSION_SECRET || 'loom-access-request';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 12);
}

/**
 * Deployment tenant bucket used as the Cosmos partition key. These submissions
 * are unauthenticated so there is no per-user oid to key on; every request in a
 * deployment lands in one logical partition the admin queue reads in a single
 * hop. Hashed so the raw tenant id never becomes a partition-key value.
 */
export function deploymentTenantBucket(): string {
  const tenant = process.env.AZURE_TENANT_ID || 'unknown';
  return crypto.createHash('sha256').update(tenant).digest('hex').slice(0, 16);
}

/**
 * Best-effort outbound notification for a new request. POSTs a compact summary
 * to LOOM_ACCESS_REQUEST_WEBHOOK (a Teams / Logic App incoming webhook) when
 * set. When unset this is a silent no-op — the admin queue is the source of
 * truth. Never throws; a webhook failure never fails the request submission.
 */
export async function notifyNewAccessRequest(summary: {
  id: string;
  displayName: string;
  email: string;
  organization?: string;
  reason: string;
  adminUrl?: string;
}): Promise<boolean> {
  const url = process.env.LOOM_ACCESS_REQUEST_WEBHOOK;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Teams incoming webhooks accept a MessageCard; Logic Apps / generic
      // endpoints accept arbitrary JSON — send a plain summary that both can read.
      body: JSON.stringify({
        type: 'loom.access-request.created',
        text:
          `New CSA Loom access request from **${summary.displayName}** (${summary.email})` +
          (summary.organization ? ` · ${summary.organization}` : '') +
          `\nReason: ${summary.reason}` +
          (summary.adminUrl ? `\nReview: ${summary.adminUrl}` : ''),
        request: summary,
      }),
    });
    return res.ok;
  } catch {
    // Webhook unreachable — the request is already persisted to the admin queue.
    return false;
  }
}
