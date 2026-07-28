/**
 * LU-5 — Loom-native GOVERNED TAG vocabulary (controlled values), per tenant.
 *
 *   GET  /api/catalog/unity/governed-tags → { ok, tags, updatedAt? }
 *   POST /api/catalog/unity/governed-tags  body { tags: [{key, description?, allowedValues[]}] }
 *          → { ok, tags }   (tenant admin only — this is a tenant vocabulary)
 *
 * NOT the same surface as `/api/databricks/unity-catalog/governed-tags`, which
 * executes real `CREATE GOVERNED TAG … ALLOWED VALUES` DDL on a Databricks SQL
 * warehouse and is honestly gated at the Gov boundary. THIS route is the
 * Azure-native default that works on BOTH backends (including the OSS Unity
 * Catalog server in Azure Government, which has no tag DDL at all): the
 * vocabulary lives in Cosmos next to the tenant's attribute groups and DLP
 * policies, and the governance overlay route enforces it on every assignment.
 *
 * Writes are whole-document (the admin authoring UI edits the list and saves),
 * matching `/api/attribute-groups`. Validation is the shared
 * `validateGovernedTagDefs` so the UI and the route can never disagree.
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiOk } from '@/lib/api/respond';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { tenantScopeId } from '@/lib/auth/session';
import { validateGovernedTagDefs, type UcGovernedTagDef } from '@/lib/governance/uc-overlay/model';
import { readGovernedTags, writeGovernedTags } from '@/lib/governance/uc-overlay/store';
import { writeUcGovernanceDenial, writeVocabularyAudit } from '@/lib/governance/uc-overlay/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req: NextRequest, { session }) => {
  const tags = await readGovernedTags(tenantScopeId(session));
  return apiOk({ tags });
});

/**
 * Whole-document vocabulary save (tenant admin only).
 *
 * Deliberately NOT wrapped in `withTenantAdmin`: the 403 has to be AUDITED, and
 * every rejection recorded, so the gate is called explicitly here. The response
 * body is byte-identical either way — `withTenantAdmin` returns the very same
 * `requireTenantAdmin(session)` envelope.
 */
export const POST = withSession(async (req: NextRequest, { session }) => {
  const tenantId = tenantScopeId(session);
  const who = session.claims.upn || session.claims.oid;

  let body: { tags?: unknown };
  try {
    body = (await req.json()) as { tags?: unknown };
  } catch {
    return apiBadRequest('invalid JSON body');
  }

  const gate = requireTenantAdmin(session);
  if (gate) {
    await writeUcGovernanceDenial({
      tenantId, who, surface: 'catalog/unity/governed-tags', status: 403,
      reason: 'the governed-tag vocabulary is tenant-wide state; tenant admin required',
      attempted: { tagCount: Array.isArray(body.tags) ? body.tags.length : 0 },
    });
    return gate;
  }

  if (!Array.isArray(body.tags)) {
    await writeUcGovernanceDenial({
      tenantId, who, surface: 'catalog/unity/governed-tags', status: 400,
      reason: 'tags[] is required',
    });
    return apiBadRequest('tags[] is required');
  }

  const defs: UcGovernedTagDef[] = (body.tags as Array<Record<string, unknown>>).map((t) => ({
    key: String(t?.key ?? ''),
    description: t?.description ? String(t.description) : undefined,
    allowedValues: Array.isArray(t?.allowedValues)
      ? (t.allowedValues as unknown[]).map((v) => String(v ?? ''))
      : [],
  }));

  const problem = validateGovernedTagDefs(defs);
  if (problem) {
    await writeUcGovernanceDenial({
      tenantId, who, surface: 'catalog/unity/governed-tags', status: 400, reason: problem,
      attempted: { keys: defs.map((d) => d.key) },
    });
    return apiBadRequest(problem);
  }

  // A whole-document overwrite can silently delete every governed tag the
  // tenant has, and `updatedBy` is last-writer-wins — so the BEFORE state is
  // captured and audited, which is the only way to reconstruct it.
  const before = await readGovernedTags(tenantId);
  const doc = await writeGovernedTags(tenantId, defs, who);
  await writeVocabularyAudit({ tenantId, who, before, after: doc.tags });
  return apiOk({ tags: doc.tags, updatedAt: doc.updatedAt });
});
