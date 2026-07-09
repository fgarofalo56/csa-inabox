/**
 * GET  /api/admin/webhooks — list the tenant's registered outbound webhooks
 *   → { ok, hooks: WebhookRegistrationView[], eventGrid: boolean }
 * POST /api/admin/webhooks — register a new endpoint (BR-WEBHOOK)
 *   body: { name, url (https), events: string[]|['*'], secret?, enabled? }
 *   → { ok, hook: WebhookRegistrationView } (201). Signing secret is generated
 *     server-side when omitted and NEVER returned (redactHook).
 *
 * HARD admin gate (requireTenantAdmin) — outbound webhooks exfiltrate tenant
 * events to an arbitrary URL, so only a tenant admin may register them. Real
 * Cosmos persistence (webhook-subscriptions container); no mocks.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { eventGridConfig } from '@/lib/events/webhook-emitter';
import {
  listHooks,
  createHook,
  redactHook,
  validateRegistrationInput,
} from '@/lib/events/webhook-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const hooks = await listHooks(s.claims.oid);
    return apiOk({ hooks: hooks.map(redactHook), eventGrid: !!eventGridConfig() });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const v = validateRegistrationInput(body);
  if (!v.ok) return apiError(v.error, 400);

  try {
    const who = s.claims.upn || s.claims.email || s.claims.oid;
    const hook = await createHook(s.claims.oid, who, {
      name: v.name,
      url: v.url,
      events: v.events,
      secret: v.secret,
      enabled: v.enabled,
    });
    // Audit the registration itself (also fans out as admin.mutation to any
    // OTHER already-registered hook — the same choke point BR-SIEM instruments).
    emitAuditEvent({
      actorOid: s.claims.oid,
      actorUpn: who,
      action: 'webhook.register',
      targetType: 'webhook',
      targetId: hook.id,
      tenantId: s.claims.tid || s.claims.oid,
      detail: { name: hook.name, url: hook.url, events: hook.events },
    });
    return apiOk({ hook: redactHook(hook) }, { status: 201 });
  } catch (e) {
    return apiServerError(e);
  }
}
