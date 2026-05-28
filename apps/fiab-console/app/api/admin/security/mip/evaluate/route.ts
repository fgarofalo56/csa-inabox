/**
 * /api/admin/security/mip/evaluate
 *
 * POST → ask Microsoft Graph which sensitivity label would apply to a
 *        given Loom item (or arbitrary text). Used by the "Apply label
 *        to a Loom item" inline action in the MIP panel.
 *
 * Body shape:
 *   {
 *     itemId?: string,    // for audit/correlation only
 *     contentSample: string,    // up to ~4kb of text from the item
 *     metadata?: { key, value }[]
 *   }
 *
 * Returns the raw evaluation response from Graph. The panel maps the
 * recommended label id back to a label name + color from the cached
 * /api/admin/security/mip/labels list.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { evaluateLabel } from '@/lib/azure/mip-graph-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CONTENT_BYTES = 64 * 1024;   // hard cap to keep Graph latency sane

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const sample: string = (body?.contentSample || '').toString();
  if (!sample.trim()) return NextResponse.json({ ok: false, error: 'contentSample is required' }, { status: 400 });
  if (Buffer.byteLength(sample, 'utf8') > MAX_CONTENT_BYTES) {
    return NextResponse.json({ ok: false, error: `contentSample exceeds ${MAX_CONTENT_BYTES} bytes` }, { status: 413 });
  }

  const metadata = Array.isArray(body?.metadata) ? body.metadata : [];
  metadata.push({ key: 'Loom.Item.Id', value: body?.itemId || 'unknown' });
  metadata.push({ key: 'Loom.User.Upn', value: s.claims.upn || s.claims.email || 'unknown' });

  try {
    const result = await evaluateLabel({
      contentInfo: {
        format: 'default',
        identifier: body?.itemId || 'loom-item',
        metadata,
      },
      contentToProcess: {
        contentEntries: [{ id: 'loom-content-1', content: sample }],
      },
    });
    return NextResponse.json({ ok: true, evaluation: result });
  } catch (e) { return handleSecurityError(e); }
}
