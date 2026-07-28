/**
 * GET    /api/marketplace/sharing/recipients/[name]   → recipient details
 * DELETE /api/marketplace/sharing/recipients/[name]   → delete the recipient
 *
 * Two backends (LU-9). On the Loom backend a recipient is Entra principals +
 * granted share names (no activation token exists to surface); on Databricks it
 * is the UC recipient with its activation token(s).
 */
import { NextResponse } from 'next/server';
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { getRecipient, deleteRecipient } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../../_lib';
import {
  isLoomSharingBackend, loomListRecipients, loomDeleteRecipient, loomSetRecipientDisabled, loomSharingErrorResponse,
} from '../../_loom-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ name: string }>(async (req, { params, session }) => {
  try {
    const name = decodeURIComponent(params.name);
    if (isLoomSharingBackend()) {
      // The Loom list is a single-partition read, so filtering it here costs
      // nothing and keeps one code path for the UI-facing recipient shape.
      const res = await loomListRecipients({ full: isTenantAdmin(session) });
      const body = (await res.clone().json()) as { recipients?: Array<{ name: string }> };
      const recipient = (body.recipients || []).find((r) => r.name === name) || null;
      if (!recipient) return NextResponse.json({ ok: false, error: `Recipient "${name}" not found.` }, { status: 404 });
      return NextResponse.json({ ok: true, backend: 'loom', recipient });
    }
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const recipient = await getRecipient(host, name);
    return NextResponse.json({ ok: true, backend: 'databricks', host, recipient });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});

// Deleting a recipient revokes every grant it held — an estate-level act.
export const DELETE = withTenantAdmin<{ name: string }>(async (req, { params }) => {
  try {
    const name = decodeURIComponent(params.name);
    if (isLoomSharingBackend()) return await loomDeleteRecipient(name);
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    await deleteRecipient(host, name);
    return NextResponse.json({ ok: true, backend: 'databricks' });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});

/**
 * PATCH { disabled: boolean } — suspend or restore a recipient (Loom backend).
 *
 * This is the kill-switch's write path. Without it `LoomRecipient.disabled` was
 * a field the authorization code honoured and nothing could ever set — a
 * protection that could not be invoked is not a protection. Suspending keeps the
 * record and its grants (so an investigation can still answer "what did this
 * recipient have access to?") while stopping every protocol call immediately.
 *
 * Databricks recipients have no equivalent flag — UC revokes by deleting the
 * recipient or its grants — so that backend gets an honest 501.
 */
export const PATCH = withTenantAdmin<{ name: string }>(async (req, { params }) => {
  try {
    const name = decodeURIComponent(params.name);
    const body = await req.json().catch(() => ({}));
    if (typeof body?.disabled !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'disabled (boolean) is required.' }, { status: 400 });
    }
    if (isLoomSharingBackend()) return await loomSetRecipientDisabled(name, body.disabled);
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        backend: 'databricks',
        error: 'Unity Catalog recipients have no suspend flag. Revoke the share grant or delete the recipient instead.',
      },
      { status: 501 },
    );
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});
