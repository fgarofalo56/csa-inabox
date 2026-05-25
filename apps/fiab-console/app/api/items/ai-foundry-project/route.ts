/**
 * GET  /api/items/ai-foundry-project — list Foundry projects under the hub
 * POST /api/items/ai-foundry-project — create project { name, displayName, description? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listProjects, createProject, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) {
    return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  }
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const projects = await listProjects();
    return NextResponse.json({ ok: true, projects });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.name || !body?.displayName) {
      return NextResponse.json({ ok: false, error: 'name and displayName required' }, { status: 400 });
    }
    const project = await createProject(body.name, body.displayName, body.description);
    return NextResponse.json({ ok: true, project });
  } catch (e: any) { return err(e); }
}
