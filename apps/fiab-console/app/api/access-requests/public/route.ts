/**
 * POST /api/access-requests/public — the UNAUTHENTICATED sign-in-boundary
 * "Request access" endpoint.
 *
 * A person who can't get INTO Loom (not in the admin Entra group, no workspace)
 * fills in their Microsoft identity here so a tenant admin can onboard them.
 * There is NO session — this route is deliberately reachable pre-auth — so it
 * is hardened accordingly:
 *   - Strict server-side validation (name, work email, organization, reason ≤500,
 *     optional Entra oid/tenant GUIDs) via validateSigninAccessRequest.
 *   - Honeypot hidden field (`company_website`): any value ⇒ benign 200, nothing
 *     persisted (bots get no signal). NO captcha.
 *   - Per-IP AND per-email rate limit (durable + in-memory, 8/hr each) so the
 *     Cosmos write path can't be flooded anonymously.
 *   - Dedupe: an existing PENDING request for the same email returns 200
 *     idempotently rather than stacking duplicate rows for the admin.
 *   - Persists to the `signin-access-requests` container with status='pending',
 *     source='signin', a hashed client-IP (never the raw IP), createdAt/updatedAt.
 *   - Best-effort webhook notify (LOOM_ACCESS_REQUEST_WEBHOOK) — the admin queue
 *     at /admin/access-requests is the source of truth when it's unset.
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { signinAccessRequestsContainer } from '@/lib/azure/cosmos-client';
import { enforceRateLimitForKey, clientIp } from '@/lib/azure/rate-limiter';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  validateSigninAccessRequest,
  hashClientIp,
  deploymentTenantBucket,
  notifyNewAccessRequest,
  type RawSigninAccessRequest,
} from '@/lib/access/signin-access-request';
import type { SigninAccessRequest } from '@/lib/types/signin-access-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let raw: RawSigninAccessRequest;
  try {
    raw = (await req.json()) as RawSigninAccessRequest;
  } catch {
    return apiError('Invalid JSON', 400);
  }

  const result = validateSigninAccessRequest(raw);
  if (!result.ok) {
    // Honeypot tripped — respond exactly like success so bots learn nothing,
    // but persist NOTHING.
    if ('honeypot' in result) return apiOk({ status: 'received' });
    return apiError(result.error, 400);
  }
  const value = result.value;

  // Abuse control BEFORE the Cosmos write — bound both the sender's IP and the
  // claimed email so neither a single host nor a single address can flood the
  // onboarding queue. Over-budget callers get an honest 429 + Retry-After.
  const ip = clientIp(req.headers);
  const ipLimited = await enforceRateLimitForKey(`ar-ip:${ip}`, 'access-request');
  if (ipLimited) return ipLimited;
  const emailLimited = await enforceRateLimitForKey(`ar-email:${value.email}`, 'access-request');
  if (emailLimited) return emailLimited;

  const tenantId = deploymentTenantBucket();
  const now = new Date().toISOString();

  try {
    const c = await signinAccessRequestsContainer();

    // Dedupe: a pending request for this email already sitting in the queue ⇒
    // return 200 idempotently (don't stack duplicates for the admin to triage).
    const { resources: existing } = await c.items
      .query<SigninAccessRequest>({
        query:
          'SELECT TOP 1 c.id FROM c WHERE c.tenantId = @t AND c.email = @e AND c.status = "pending"',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@e', value: value.email },
        ],
      }, { partitionKey: tenantId })
      .fetchAll();
    if (existing.length > 0) {
      return apiOk({ status: 'already-pending', id: existing[0].id });
    }

    const doc: SigninAccessRequest = {
      id: crypto.randomUUID(),
      tenantId,
      displayName: value.displayName,
      email: value.email,
      organization: value.organization,
      reason: value.reason,
      aadObjectId: value.aadObjectId,
      aadTenantId: value.aadTenantId,
      status: 'pending',
      source: 'signin',
      createdAt: now,
      updatedAt: now,
      clientIpHash: hashClientIp(ip),
    };
    await c.items.create(doc);

    // Best-effort notify — never blocks / fails the submission.
    const origin =
      req.headers.get('x-forwarded-host')
        ? `https://${req.headers.get('x-forwarded-host')}`
        : req.nextUrl.origin;
    const notified = await notifyNewAccessRequest({
      id: doc.id,
      displayName: doc.displayName,
      email: doc.email,
      organization: doc.organization,
      reason: doc.reason,
      adminUrl: `${origin}/admin/access-requests`,
    });

    return apiOk({ status: 'received', id: doc.id, notified });
  } catch (e) {
    return apiServerError(e, 'Could not submit your request. Please try again.');
  }
}
