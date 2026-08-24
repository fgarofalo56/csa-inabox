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
 *
 * Route-toolkit: the `withSession` wrapper [R3] — see ../route.ts for the 401-equivalence note.
 * #3578: transport failures are diagnosed by _lib/transport-error.ts, not relayed
 * verbatim as undici's bare "fetch failed".
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import {
  listBlocklists,
  upsertBlocklist,
  deleteBlocklist,
  FoundryError,
  NotDeployedError,
} from '@/lib/azure/foundry-client';
import { diagnoseTransportFailure, transportErrorResponse } from '../_lib/transport-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const transport = diagnoseTransportFailure(e);
  if (transport) return transportErrorResponse(transport);
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export const GET = withSession(async () => {
  try {
    const blocklists = await listBlocklists();
    return NextResponse.json({ ok: true, blocklists });
  } catch (e: any) { return err(e); }
});

export const POST = withSession(async (req: NextRequest) => {
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
});

export const DELETE = withSession(async (req: NextRequest) => {
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    await deleteBlocklist(name);
    return NextResponse.json({ ok: true, deleted: name });
  } catch (e: any) { return err(e); }
});
