/**
 * POST /api/admin/webhooks/[id]/test — fire a REAL signed test event at the
 * registered endpoint (BR-WEBHOOK) and return the awaited delivery result.
 *   → { ok, delivery: WebhookDelivery }
 *
 * Sends the system `webhook.test` event (delivered regardless of the hook's
 * subscribed filter) through the configured transport (direct HTTPS + HMAC, or
 * Event Grid when LOOM_EVENTGRID_TOPIC_ENDPOINT is set), logs it to the hook's
 * delivery history, and returns the terminal status/attempts so the admin sees
 * a live receipt. No-vaporware: this is an actual outbound POST, not a stub.
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getHook } from '@/lib/events/webhook-registry';
import { deliverToHook } from '@/lib/events/webhook-emitter';
import { WEBHOOK_TEST_EVENT } from '@/lib/events/event-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const hook = await getHook(s.claims.oid, id);
    if (!hook) return apiNotFound('webhook not found');

    const envelope = {
      id: crypto.randomUUID(),
      type: WEBHOOK_TEST_EVENT,
      tenantId: hook.tenantId,
      subject: hook.id,
      subjectName: hook.name,
      actor: { oid: s.claims.oid, upn: s.claims.upn || s.claims.email },
      data: {
        message: 'This is a signed CSA Loom test event. Verify the X-Loom-Signature header.',
        firedBy: s.claims.upn || s.claims.email || s.claims.oid,
        firedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    };

    // Await the single delivery so the admin gets a live receipt.
    const delivery = await deliverToHook(hook, envelope);
    return apiOk({ delivery });
  } catch (e) {
    return apiServerError(e);
  }
}
