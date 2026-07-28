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
import { getRecipient, deleteRecipient } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../../_lib';
import {
  isLoomSharingBackend, loomListRecipients, loomDeleteRecipient, loomSharingErrorResponse,
} from '../../_loom-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ name: string }>(async (req, { params }) => {
  try {
    const name = decodeURIComponent(params.name);
    if (isLoomSharingBackend()) {
      // The Loom list is a single-partition read, so filtering it here costs
      // nothing and keeps one code path for the UI-facing recipient shape.
      const res = await loomListRecipients();
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
