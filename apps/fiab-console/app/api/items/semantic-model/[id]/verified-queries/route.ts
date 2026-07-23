/**
 * /api/items/semantic-model/[id]/verified-queries — N9 Verified Semantic
 * Contract authoring surface (the semantic-model editor's "Verified Queries" tab).
 *
 * Manages the owner's GOVERNED CONTRACT — persisted Azure-native in the
 * `loom-semantic-contract` Cosmos container (PK /tenantId = owner oid, mirroring
 * Prep-for-AI owner scoping). Two doc kinds: `metric` (the governed metric
 * registry) and `vqr` (approved question→query pairs). The data-agent-reasoning
 * loop retrieves verified queries FIRST, grounds unmatched questions on a matched
 * metric, and REFUSES out-of-contract questions (refuse-not-guess). NO Power BI /
 * Microsoft Fabric dependency (.claude/rules/no-fabric-dependency.md).
 *
 *   GET                                            → { ok, metrics, verifiedQueries }
 *   POST { op:'register-metric', metric:{…} }      → upsert a governed metric
 *   POST { op:'add-verified-query', vq:{…} }       → add a DRAFT verified query
 *   POST { op:'approve-verified-query', id }       → approve (AUDITED) + version bump
 *   POST { op:'delete-verified-query', id }        → remove a verified query
 *
 * AUTH: owner-scoped — the caller's oid is the partition key and the ownership
 * check (loadOwnedItem) guards the model. A privileged mutation (approve) writes
 * an `_auditLog` row `{ kind:'semantic.vqr.approve', who, oid, … }` (AUDIT std).
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  registerMetric,
  listMetrics,
  addVerifiedQuery,
  approveVerifiedQuery,
  listVerifiedQueries,
  deleteVerifiedQuery,
  type ContractActor,
} from '@/lib/azure/semantic-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';

interface Body {
  op?: string;
  metric?: Record<string, unknown>;
  vq?: Record<string, unknown>;
  id?: unknown;
}

/** Build the audit actor from the session claims (UPN → email → name → oid). */
function actorFrom(session: NonNullable<ReturnType<typeof getSession>>): ContractActor {
  const c = session.claims as { oid: string; upn?: string; email?: string; name?: string; tid?: string };
  return {
    oid: c.oid,
    who: c.upn || c.email || c.name || c.oid,
    tenantId: c.tid || c.oid,
  };
}

export const GET = withSession(async (_req, { session, params }) => {
  const { id } = params;
  const tenantId = session.claims.oid;
  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!item) return apiError('Semantic model not found or not owned by you.', 404);
  try {
    const [metrics, verifiedQueries] = await Promise.all([
      listMetrics(tenantId),
      listVerifiedQueries(tenantId),
    ]);
    return apiOk({ metrics, verifiedQueries, modelName: item.displayName });
  } catch (e) {
    return apiServerError(e, 'Failed to read the semantic contract.');
  }
});

export const POST = withSession(async (req, { session, params }) => {
  const { id } = params;
  const tenantId = session.claims.oid;
  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!item) return apiError('Semantic model not found or not owned by you.', 404);

  const body = (await req.json().catch(() => ({}))) as Body;
  const op = String(body?.op || '').trim();

  try {
    // ── register / update a governed metric ─────────────────────────────────
    if (op === 'register-metric') {
      const m = body.metric || {};
      const metricId = String(m.metricId || '').trim();
      const label = String(m.label || '').trim();
      if (!metricId || !label) return apiError('A metric requires a metricId and a label.', 400);
      const doc = await registerMetric(tenantId, {
        metricId,
        label,
        owner: String(m.owner || actorFrom(session).who),
        description: String(m.description || ''),
        synonyms: Array.isArray(m.synonyms)
          ? m.synonyms.map((s: unknown) => String(s))
          : m.synonyms
            ? [String(m.synonyms)]
            : undefined,
        grain: String(m.grain || ''),
        sourceKind: m.sourceKind === 'measure' ? 'measure' : 'metric-view',
        sourceRef: String(m.sourceRef || id),
      });
      return apiOk({ metric: doc, note: `Registered governed metric "${doc.label}".` });
    }

    // ── add a verified query (DRAFT until approved) ─────────────────────────
    if (op === 'add-verified-query') {
      const v = body.vq || {};
      const question = String(v.question || '').trim();
      const query = String(v.query || '').trim();
      if (!question || !query) return apiError('A verified query requires a question and a query.', 400);
      const doc = await addVerifiedQuery(tenantId, {
        question,
        query,
        queryLang: (['sql', 'kql', 'dax', 'sparksql'].includes(String(v.queryLang))
          ? String(v.queryLang)
          : 'sql') as 'sql' | 'kql' | 'dax' | 'sparksql',
        sourceName: String(v.sourceName || item.displayName || ''),
        metricId: v.metricId ? String(v.metricId) : undefined,
      });
      return apiOk({ verifiedQuery: doc, note: 'Saved as a DRAFT — approve it to make the agent retrieve it.' });
    }

    // ── approve a verified query (AUDITED) ──────────────────────────────────
    if (op === 'approve-verified-query') {
      const vqrId = String(body.id || '').trim();
      if (!vqrId) return apiError('id is required to approve a verified query.', 400);
      const doc = await approveVerifiedQuery(tenantId, vqrId, actorFrom(session));
      return apiOk({ verifiedQuery: doc, note: `Approved (v${doc.version}). The agent will now retrieve it first.` });
    }

    // ── delete a verified query ─────────────────────────────────────────────
    if (op === 'delete-verified-query') {
      const vqrId = String(body.id || '').trim();
      if (!vqrId) return apiError('id is required to delete a verified query.', 400);
      const removed = await deleteVerifiedQuery(tenantId, vqrId);
      if (!removed) return apiError('Verified query not found.', 404);
      return apiOk({ note: 'Verified query deleted.' });
    }

    return apiError(
      `unknown op "${op}" — expected register-metric | add-verified-query | approve-verified-query | delete-verified-query`,
      400,
    );
  } catch (e) {
    return apiServerError(e, 'Verified-queries operation failed.');
  }
});
