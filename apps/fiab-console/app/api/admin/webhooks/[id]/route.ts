/**
 * GET    /api/admin/webhooks/[id] — one hook + its recent delivery log
 *   → { ok, hook: WebhookRegistrationView, deliveries: WebhookDelivery[] }
 * PATCH  /api/admin/webhooks/[id] — update name/url/events/enabled/secret
 *   → { ok, hook }
 * DELETE /api/admin/webhooks/[id] — remove the registration
 *   → { ok }
 *
 * HARD admin gate + tenant scoping — the id is only ever resolved inside the
 * caller's own tenant partition (getHook checks tenantId), so a signed-in
 * non-owner can't read another tenant's hook.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  getHook,
  updateHook,
  deleteHook,
  listDeliveries,
  redactHook,
  validateRegistrationInput,
} from '@/lib/events/webhook-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const hook = await getHook(s.claims.oid, id);
    if (!hook) return apiNotFound('webhook not found');
    const deliveries = await listDeliveries(id);
    return apiOk({ hook: redactHook(hook), deliveries });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};

  // Enable/disable is a first-class quick toggle (default-ON/opt-out).
  if (body?.enabled !== undefined) patch.enabled = body.enabled !== false;

  // Full-field edits reuse the same validation as create (only when those
  // fields are present, so a bare enable/disable stays lightweight).
  if (body?.name !== undefined || body?.url !== undefined || body?.events !== undefined || body?.secret) {
    const existing = await getHook(s.claims.oid, id);
    if (!existing) return apiNotFound('webhook not found');
    const v = validateRegistrationInput({
      name: body?.name ?? existing.name,
      url: body?.url ?? existing.url,
      events: body?.events ?? existing.events,
      secret: body?.secret,
      enabled: patch.enabled ?? existing.enabled,
    });
    if (!v.ok) return apiError(v.error, 400);
    patch.name = v.name;
    patch.url = v.url;
    patch.events = v.events;
    if (v.secret) patch.secret = v.secret;
  }

  if (Object.keys(patch).length === 0) return apiError('no updatable fields supplied', 400);

  try {
    const hook = await updateHook(s.claims.oid, id, patch);
    if (!hook) return apiNotFound('webhook not found');
    emitAuditEvent({
      actorOid: s.claims.oid,
      actorUpn: s.claims.upn || s.claims.email || s.claims.oid,
      action: 'webhook.update',
      targetType: 'webhook',
      targetId: id,
      tenantId: s.claims.tid || s.claims.oid,
      detail: { fields: Object.keys(patch) },
    });
    return apiOk({ hook: redactHook(hook) });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const ok = await deleteHook(s.claims.oid, id);
    if (!ok) return apiNotFound('webhook not found');
    emitAuditEvent({
      actorOid: s.claims.oid,
      actorUpn: s.claims.upn || s.claims.email || s.claims.oid,
      action: 'webhook.delete',
      targetType: 'webhook',
      targetId: id,
      tenantId: s.claims.tid || s.claims.oid,
    });
    return apiOk({});
  } catch (e) {
    return apiServerError(e);
  }
}
