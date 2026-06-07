/**
 * POST /api/items/eventhouse/[id]/ingest/preview
 *
 * Schema-preview step for the Get-Data wizard. Returns the detected columns +
 * a few sample rows BEFORE the real `.ingest` runs, so the operator can confirm
 * the shape. Three modes (selected the same way as the sibling ingest route):
 *
 *   1. multipart/form-data:  field `file` → parse first bytes, return schema.
 *   2. application/json { url, format? }: peek the first ~16 KB of an ADLS Gen2
 *        / Blob object. SAS URLs (sig=) fetch directly; otherwise the Console
 *        UAMI mints a storage bearer token (managed identity). abfss:// is
 *        rewritten to the https:// DFS form.
 *   3. application/json { kind:'eventhub', eventHubName, consumerGroup }: streams
 *        have no static schema, so we return an honest summary instead of rows.
 *
 * Per .claude/rules/no-vaporware.md — real file bytes / real blob fetch, never
 * a mock array. A blob that the cluster/UAMI can't read returns the storage
 * error verbatim so the operator knows exactly which RBAC grant is missing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { detectSchema, abfssToHttps, isSasUrl } from '@/lib/ingest/schema-detect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PREVIEW_BYTES = 16 * 1024; // 16 KB is plenty for header + a few rows
const STORAGE_SCOPE = 'https://storage.azure.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function handleFile(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ ok: false, error: 'file is required' }, { status: 400 });
  const slice = file.slice(0, PREVIEW_BYTES);
  const text = new TextDecoder().decode(await slice.arrayBuffer());
  const preview = detectSchema(text, file.name || '');
  if (!preview.columns.length) {
    return NextResponse.json({ ok: false, error: 'could not detect any columns in the file' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, ...preview });
}

async function handleUrl(body: any): Promise<NextResponse> {
  const rawUrl = String(body?.url || '').trim();
  if (!rawUrl) return NextResponse.json({ ok: false, error: 'url is required' }, { status: 400 });
  if (!/^(abfss|https):\/\//i.test(rawUrl)) {
    return NextResponse.json({ ok: false, error: 'url must be an abfss:// or https:// path' }, { status: 400 });
  }
  const nameHint = String(body?.format || '') === 'json' ? 'x.json' : rawUrl;
  const httpsUrl = abfssToHttps(rawUrl);

  const headers: Record<string, string> = { Range: `bytes=0-${PREVIEW_BYTES - 1}` };
  if (!isSasUrl(httpsUrl)) {
    // Managed-identity auth against the DFS / Blob endpoint.
    const tok = await credential.getToken(STORAGE_SCOPE);
    if (!tok?.token) {
      return NextResponse.json({ ok: false, error: 'failed to acquire storage token (managed identity)' }, { status: 401 });
    }
    headers['Authorization'] = `Bearer ${tok.token}`;
    headers['x-ms-version'] = '2021-08-06';
  }

  let res: Response;
  try {
    res = await fetch(httpsUrl, { headers, cache: 'no-store' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `fetch failed: ${e?.message || String(e)}` }, { status: 502 });
  }
  if (!res.ok && res.status !== 206) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    const hint = res.status === 403
      ? ' (the Console UAMI / ADX cluster MI likely lacks "Storage Blob Data Reader" on this account — run scripts/csa-loom/grant-adx-storage-rbac.sh)'
      : '';
    return NextResponse.json(
      { ok: false, error: `storage read failed (${res.status})${hint}: ${detail}`, status: res.status },
      { status: res.status },
    );
  }
  const text = await res.text();
  const preview = detectSchema(text, nameHint);
  if (!preview.columns.length) {
    return NextResponse.json({ ok: false, error: 'could not detect any columns in the object preview' }, { status: 422 });
  }
  return NextResponse.json({ ok: true, ...preview });
}

function handleEventHub(body: any): NextResponse {
  const eventHubName = String(body?.eventHubName || '').trim();
  const consumerGroup = String(body?.consumerGroup || '$Default').trim() || '$Default';
  if (!eventHubName) {
    return NextResponse.json({ ok: false, error: 'eventHubName is required' }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    kind: 'eventhub',
    streaming: true,
    summary:
      `Streaming connection to "${eventHubName}" / consumer group "${consumerGroup}". ` +
      'Schema is inferred from the first arriving JSON events once the data connection warms up (typically <60s) — no static preview.',
  });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    try { return await handleFile(req); }
    catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 }); }
  }
  const body = await req.json().catch(() => ({}));
  const kind = String(body?.kind || '').toLowerCase();
  if (kind === 'eventhub') return handleEventHub(body);
  // default: URL (onelake / blob) preview
  try { return await handleUrl(body); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 }); }
}
