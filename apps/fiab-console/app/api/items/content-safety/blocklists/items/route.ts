/**
 * Blocklist items (terms / regexes) for a custom Content Safety blocklist.
 *
 * GET    /api/items/content-safety/blocklists/items?name=<blocklist>      — list items
 * POST   /api/items/content-safety/blocklists/items?name=<blocklist>      — add items
 *   body: { items: [{ text, description?, isRegex? }] }
 * DELETE /api/items/content-safety/blocklists/items?name=<blocklist>&id=<itemId>[&id=...] — remove items
 *
 * Backed by the Content Safety data-plane (:addOrUpdateBlocklistItems /
 * :removeBlocklistItems / blocklistItems, api-version 2024-09-01). Max 100 items
 * per add call, max 128 chars per term, 10,000 terms total across all lists.
 *
 * Route-toolkit: the `withSession` wrapper [R3] — see ../../route.ts for the 401-equivalence note.
 * #3578: transport failures are diagnosed by _lib/transport-error.ts, not relayed
 * verbatim as undici's bare "fetch failed".
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import {
  listBlocklistItems,
  addBlocklistItems,
  removeBlocklistItems,
  FoundryError,
  NotDeployedError,
  type AddBlocklistItemInput,
} from '@/lib/azure/foundry-client';
import { diagnoseTransportFailure, transportErrorResponse } from '../../_lib/transport-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const transport = diagnoseTransportFailure(e);
  if (transport) return transportErrorResponse(transport);
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export const GET = withSession(async (req: NextRequest) => {
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    const items = await listBlocklistItems(name);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) { return err(e); }
});

export const POST = withSession(async (req: NextRequest) => {
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    const body = await req.json();
    const raw = Array.isArray(body?.items) ? body.items : (body?.text ? [body] : []);
    const items: AddBlocklistItemInput[] = raw
      .filter((i: any) => i && String(i.text || '').trim())
      .map((i: any) => ({
        text: String(i.text),
        description: i.description ? String(i.description) : undefined,
        isRegex: i.isRegex === true,
      }));
    if (items.length === 0) return NextResponse.json({ ok: false, error: 'at least one item with text is required' }, { status: 400 });
    if (items.length > 100) return NextResponse.json({ ok: false, error: 'at most 100 items can be added per request' }, { status: 400 });
    if (items.some((i) => i.text.length > 128)) return NextResponse.json({ ok: false, error: 'each blocklist term must be 128 characters or fewer' }, { status: 400 });
    const added = await addBlocklistItems(name, items);
    return NextResponse.json({ ok: true, items: added });
  } catch (e: any) { return err(e); }
});

export const DELETE = withSession(async (req: NextRequest) => {
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    const ids = req.nextUrl.searchParams.getAll('id').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return NextResponse.json({ ok: false, error: 'at least one id required' }, { status: 400 });
    await removeBlocklistItems(name, ids);
    return NextResponse.json({ ok: true, removed: ids });
  } catch (e: any) { return err(e); }
});
