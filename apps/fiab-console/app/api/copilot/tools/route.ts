/** GET /api/copilot/tools — registered orchestrator tools, grouped by service. */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getRegistry } from '@/lib/azure/copilot-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const reg = getRegistry();
  const tools = reg.list().map((t) => ({
    name: t.name,
    description: t.description,
    service: t.service,
    parameters: t.parameters,
    // Optional self-explanatory metadata (audit-T121) — undefined when a tool
    // hasn't set it; the UI falls back to `description`.
    whenToUse: t.whenToUse,
    readsContext: t.readsContext,
  }));
  const grouped: Record<string, typeof tools> = {};
  for (const t of tools) {
    if (!grouped[t.service]) grouped[t.service] = [];
    grouped[t.service].push(t);
  }
  return NextResponse.json({ ok: true, count: tools.length, tools, grouped });
}
