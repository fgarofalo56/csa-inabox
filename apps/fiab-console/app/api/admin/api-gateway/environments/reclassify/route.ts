/**
 * POST /api/admin/api-gateway/environments/reclassify
 * body: { changes: [{ kind: 'gateway'|'endpoint'|'mcp', id, environmentKey: string|null }] }
 * One batch (a gateway and its endpoints move together): validated against the
 * final state, locked in ADR-008 order, written atomically, one audit event per
 * resource. Refused (409, with the publications listed) if it would block an
 * applied publication.
 */
import { withCapability } from '@/lib/api/route-toolkit';
import { PLANE_ADMIN_CAPABILITY, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';
import { apiBadRequest } from '@/lib/api/respond';
import { adminContext, readJson, respond, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { reclassify } from '@/lib/api-gateway/environments/service';
import type { ClassificationChange } from '@/lib/api-gateway/environments/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set(['gateway', 'endpoint', 'mcp']);

export const POST = withPlaneGroupHint(withCapability(PLANE_ADMIN_CAPABILITY, 'Admin', async (req, { session }) => {
  const ctx = adminContext(session);
  const body = await readJson(req);
  const raw = body?.changes;
  if (!Array.isArray(raw)) return apiBadRequest('changes (array) is required');
  const changes: ClassificationChange[] = [];
  for (const c of raw as Array<Partial<ClassificationChange> | null>) {
    const envOk = c != null && (c.environmentKey === null || typeof c.environmentKey === 'string');
    if (!c || typeof c !== 'object' || !KINDS.has(String(c.kind)) || typeof c.id !== 'string' || !envOk) {
      return apiBadRequest('each change needs kind (gateway|endpoint|mcp), id, and environmentKey (string or null)');
    }
    changes.push({ kind: c.kind as ClassificationChange['kind'], id: c.id, environmentKey: c.environmentKey as string | null });
  }
  try {
    return respond(await reclassify(ctx.deps, ctx.tenantId, ctx.actor, changes));
  } catch (e) {
    return serverError(e);
  }
}));
