/**
 * GET  /api/marketplace/sharing/recipients   → list recipients
 * POST /api/marketplace/sharing/recipients    → create a recipient
 *
 * TWO backends (LU-9), selected by `sharingBackend()`:
 *
 *   loom (Azure-native DEFAULT wherever loom-sharing is deployed)
 *     POST { name, principalIds: string[] | principalId: 'guid[,guid]', comment? }
 *     A recipient IS a set of Entra principals — the object id of a guest/B2B
 *     user or the application id of a federated service principal. There is no
 *     activation URL and no long-lived bearer profile: a file that is both the
 *     identity and the credential cannot be revoked for one recipient without
 *     rotating it for all of them, and it leaves no per-caller audit trail.
 *     Recipients present an Entra token to /api/delta-sharing/* instead.
 *
 *   databricks
 *     POST { name, authentication_type: 'TOKEN'|'DATABRICKS', comment?,
 *            data_recipient_global_metastore_id? }
 *     - TOKEN: open Delta Sharing — the response carries an activation_url the
 *       share owner sends to the recipient (surfaced once; never logged).
 *     - DATABRICKS: Databricks-to-Databricks — requires the consumer
 *       metastore's global sharing id.
 */
import { NextResponse } from 'next/server';
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { listRecipients, createRecipient } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../_lib';
import {
  isLoomSharingBackend, loomListRecipients, loomCreateRecipient, loomSharingErrorResponse,
} from '../_loom-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req, { session }) => {
  try {
    // A recipient's Entra principal ids are only disclosed to a tenant admin.
    if (isLoomSharingBackend()) return await loomListRecipients({ full: isTenantAdmin(session) });
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const recipients = await listRecipients(host);
    return NextResponse.json({ ok: true, backend: 'databricks', host, recipients });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});

// Registering an external identity that may read estate data is a tenant-admin
// act on the Loom backend (the Databricks path's real gate has always been the
// metastore's own CREATE RECIPIENT privilege).
export const POST = withTenantAdmin(async (req, { session }) => {
  try {
    const body = await req.json().catch(() => ({}));
    if (isLoomSharingBackend()) {
      return await loomCreateRecipient(body, session.claims.upn || session.claims.oid || 'unknown');
    }
    const name = String(body?.name || '').trim();
    const authType = body?.authentication_type === 'DATABRICKS' ? 'DATABRICKS' : 'TOKEN';
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    if (authType === 'DATABRICKS' && !body?.data_recipient_global_metastore_id) {
      return NextResponse.json(
        { ok: false, error: 'data_recipient_global_metastore_id is required for DATABRICKS recipients' },
        { status: 400 },
      );
    }
    const host = await resolveShareHost(body?.host);
    const recipient = await createRecipient(host, {
      name,
      authentication_type: authType,
      comment: body?.comment,
      data_recipient_global_metastore_id: body?.data_recipient_global_metastore_id,
    });
    return NextResponse.json({ ok: true, backend: 'databricks', host, recipient });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});
