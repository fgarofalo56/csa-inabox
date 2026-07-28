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
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiOk } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { validateGovernedTagDefs, type UcGovernedTagDef } from '@/lib/governance/uc-overlay/model';
import { readGovernedTags, writeGovernedTags } from '@/lib/governance/uc-overlay/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req: NextRequest, { session }) => {
  const tags = await readGovernedTags(tenantScopeId(session));
  return apiOk({ tags });
});

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  let body: { tags?: unknown };
  try {
    body = (await req.json()) as { tags?: unknown };
  } catch {
    return apiBadRequest('invalid JSON body');
  }
  if (!Array.isArray(body.tags)) return apiBadRequest('tags[] is required');

  const defs: UcGovernedTagDef[] = (body.tags as Array<Record<string, unknown>>).map((t) => ({
    key: String(t?.key ?? ''),
    description: t?.description ? String(t.description) : undefined,
    allowedValues: Array.isArray(t?.allowedValues)
      ? (t.allowedValues as unknown[]).map((v) => String(v ?? ''))
      : [],
  }));

  const problem = validateGovernedTagDefs(defs);
  if (problem) return apiBadRequest(problem);

  const doc = await writeGovernedTags(
    tenantScopeId(session),
    defs,
    session.claims.upn || session.claims.oid,
  );
  return apiOk({ tags: doc.tags, updatedAt: doc.updatedAt });
});
