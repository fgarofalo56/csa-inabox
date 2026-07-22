/**
 * GET /api/copilot/sessions/[id]/trace — CTS-03 admin deep-trace (Tier 3).
 *
 * Returns the per-turn deep trace for one Copilot session: phase timings
 * (classify / prompt-build / llm / tools), the tool roll-up, citations, the
 * context meter, and routing — derived from the session's persisted steps. This
 * is the operator-only debug surface, distinct from the always-visible metadata
 * bar (CTS-01) and the per-message detail badge (CTS-02).
 *
 * Tenant-admin gated: raw step payloads can carry data values, so the trace is
 * NOT a per-user surface. Secrets are redacted by default; a tenant admin may pass
 * `?raw=1` to see un-redacted payloads. Read-only Cosmos query over
 * `copilot-sessions`. No Fabric / Power BI.
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { copilotSessionsContainer } from '@/lib/azure/cosmos-client';
import { deriveTurnTraces, type TurnTrace } from '@/lib/copilot/turn-trace';
import { redact } from '@/lib/feedback/redaction';
import { withTenantAdmin } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Deep-redact secrets from an arbitrary value by round-tripping through the
 *  string redactor (PII / tokens / hosts / GUIDs). */
function redactDeep<T>(value: T): T {
  try {
    return JSON.parse(redact(JSON.stringify(value))) as T;
  } catch {
    return value;
  }
}

export const GET = withTenantAdmin<{ id: string }>(async (req: NextRequest, { params }) => {

  const { id } = await params;
  if (!id) return apiError('session id is required', 400);
  const raw = new URL(req.url).searchParams.get('raw') === '1';

  try {
    const c = await copilotSessionsContainer();
    const { resource } = await c.item(id, id).read<{ steps?: unknown[]; prompt?: string; createdAt?: string; updatedAt?: string }>();
    if (!resource) return apiError('session not found', 404);

    let turns: TurnTrace[] = deriveTurnTraces(resource.steps);
    if (!raw) turns = turns.map((t) => ({ ...t, steps: redactDeep(t.steps) }));

    return apiOk({
      sessionId: id,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
      redacted: !raw,
      turns,
    });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500, { code: 'trace_failed' });
  }
});
