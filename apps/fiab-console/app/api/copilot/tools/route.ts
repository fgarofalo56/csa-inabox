/** GET /api/copilot/tools — registered orchestrator tools, grouped by service. */
import { getRegistry } from '@/lib/azure/copilot-orchestrator';
import { apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WS-D1: session-only route adopted onto `withSession` — the wrapper runs the
// exact `getSession()` 401 check; the body is pure work.
export const GET = withSession(() => {
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
  return apiOk({ count: tools.length, tools, grouped });
});
