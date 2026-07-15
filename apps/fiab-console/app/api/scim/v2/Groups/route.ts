/**
 * SCIM 2.0 Groups collection (BR-SCIM).
 *
 *   GET  /api/scim/v2/Groups   → ListResponse (supports ?filter, paging)
 *   POST /api/scim/v2/Groups   → provision a group
 *
 * Auth: the SCIM provisioning bearer (LOOM_SCIM_BEARER_TOKEN).
 */

import { requireScim, scimJson, scimErr, originOf } from '@/lib/scim/respond';
import { scimListResponse, groupDocToScim } from '@/lib/scim/core';
import { SCIM_GROUP_SCHEMA, type ScimGroup } from '@/lib/scim/types';
import { createGroup, listGroups } from '@/lib/scim/store';
import { parseScimFilter, evaluateScimFilter } from '@/lib/scim/filter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gate = requireScim(req);
  if (gate) return gate;

  const url = new URL(req.url);
  const filterStr = url.searchParams.get('filter');
  const startIndex = Math.max(1, Number(url.searchParams.get('startIndex')) || 1);
  const count = Math.max(0, Number(url.searchParams.get('count')) || 100);

  const base = originOf(req);
  const all = (await listGroups()).map((d) => groupDocToScim(d, base));

  const filter = parseScimFilter(filterStr);
  const matched = filter
    ? all.filter((g) => evaluateScimFilter(filter, g as unknown as Record<string, unknown>))
    : all;

  const page = matched.slice(startIndex - 1, startIndex - 1 + count);
  return scimJson(
    scimListResponse(page, { totalResults: matched.length, startIndex, itemsPerPage: page.length }),
  );
}

export async function POST(req: Request) {
  const gate = requireScim(req);
  if (gate) return gate;

  let body: ScimGroup;
  try {
    body = (await req.json()) as ScimGroup;
  } catch {
    return scimErr(400, 'Invalid JSON body.', 'invalidSyntax');
  }
  if (!body || typeof body.displayName !== 'string' || !body.displayName.trim()) {
    return scimErr(400, 'displayName is required.', 'invalidValue');
  }
  const doc = await createGroup({ ...body, schemas: body.schemas ?? [SCIM_GROUP_SCHEMA] });
  const resource = groupDocToScim(doc, originOf(req));
  return scimJson(resource, 201, { Location: resource.meta!.location });
}
