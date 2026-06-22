/**
 * GET  /api/marketplace/sharing/recipients   → list recipients
 * POST /api/marketplace/sharing/recipients    → create a recipient
 *
 * POST body:
 *   { name, authentication_type: 'TOKEN'|'DATABRICKS', comment?,
 *     data_recipient_global_metastore_id? }
 *   - TOKEN: open Delta Sharing — the response carries an activation_url the
 *     share owner sends to the recipient (surfaced once; never logged).
 *   - DATABRICKS: Databricks-to-Databricks — requires the consumer metastore's
 *     global sharing id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listRecipients, createRecipient } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const recipients = await listRecipients(host);
    return NextResponse.json({ ok: true, host, recipients });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
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
    return NextResponse.json({ ok: true, host, recipient });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}
