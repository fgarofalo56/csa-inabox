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
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listBlocklistItems,
  addBlocklistItems,
  removeBlocklistItems,
  FoundryError,
  NotDeployedError,
  type AddBlocklistItemInput,
} from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    const items = await listBlocklistItems(name);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    const ids = req.nextUrl.searchParams.getAll('id').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return NextResponse.json({ ok: false, error: 'at least one id required' }, { status: 400 });
    await removeBlocklistItems(name, ids);
    return NextResponse.json({ ok: true, removed: ids });
  } catch (e: any) { return err(e); }
}
