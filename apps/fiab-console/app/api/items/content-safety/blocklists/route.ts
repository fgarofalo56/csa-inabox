/**
 * Custom text blocklists for the Content Safety editor.
 *
 * GET    /api/items/content-safety/blocklists           — list blocklists (real data-plane)
 * POST   /api/items/content-safety/blocklists           — create/update a blocklist
 *   body: { name, description? }
 * DELETE /api/items/content-safety/blocklists?name=<name> — delete a blocklist
 *
 * Backed by the Azure AI Content Safety data-plane
 * (/contentsafety/text/blocklists, api-version 2024-09-01). When the endpoint
 * env var is unset the client throws NotDeployedError → honest 503 gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listBlocklists,
  upsertBlocklist,
  deleteBlocklist,
  FoundryError,
  NotDeployedError,
} from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const blocklists = await listBlocklists();
    return NextResponse.json({ ok: true, blocklists });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    // Service-allowed characters: 0-9 A-Z a-z - . _ ~
    if (!/^[0-9A-Za-z._~-]+$/.test(name)) {
      return NextResponse.json({ ok: false, error: 'name may only contain 0-9, A-Z, a-z, and - . _ ~' }, { status: 400 });
    }
    const blocklist = await upsertBlocklist(name, body.description ? String(body.description) : undefined);
    return NextResponse.json({ ok: true, blocklist });
  } catch (e: any) { return err(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    await deleteBlocklist(name);
    return NextResponse.json({ ok: true, deleted: name });
  } catch (e: any) { return err(e); }
}
