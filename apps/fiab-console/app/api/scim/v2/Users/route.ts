/**
 * SCIM 2.0 Users collection (BR-SCIM).
 *
 *   GET  /api/scim/v2/Users            → ListResponse (supports ?filter, paging)
 *   POST /api/scim/v2/Users            → provision a user
 *
 * Auth: the SCIM provisioning bearer (LOOM_SCIM_BEARER_TOKEN) — NOT a browser
 * session or PAT. Real Cosmos persistence (no mocks). RFC 7643/7644 shapes.
 */

import { requireScim, scimJson, scimErr, originOf } from '@/lib/scim/respond';
import { scimListResponse, userDocToScim } from '@/lib/scim/core';
import { SCIM_USER_SCHEMA, type ScimUser } from '@/lib/scim/types';
import { createUser, listUsers, findUserByUserName } from '@/lib/scim/store';
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
  const all = (await listUsers()).map((d) => userDocToScim(d, base));

  const filter = parseScimFilter(filterStr);
  const matched = filter
    ? all.filter((u) => evaluateScimFilter(filter, u as unknown as Record<string, unknown>))
    : all;

  const page = matched.slice(startIndex - 1, startIndex - 1 + count);
  return scimJson(
    scimListResponse(page, { totalResults: matched.length, startIndex, itemsPerPage: page.length }),
  );
}

export async function POST(req: Request) {
  const gate = requireScim(req);
  if (gate) return gate;

  let body: ScimUser;
  try {
    body = (await req.json()) as ScimUser;
  } catch {
    return scimErr(400, 'Invalid JSON body.', 'invalidSyntax');
  }
  if (!body || typeof body.userName !== 'string' || !body.userName.trim()) {
    return scimErr(400, 'userName is required.', 'invalidValue');
  }

  // SCIM uniqueness: a duplicate userName is a 409 (RFC 7644 §3.3).
  const existing = await findUserByUserName(body.userName);
  if (existing) {
    return scimErr(409, `A user with userName "${body.userName}" already exists.`, 'uniqueness');
  }

  const doc = await createUser({ ...body, schemas: body.schemas ?? [SCIM_USER_SCHEMA] });
  const resource = userDocToScim(doc, originOf(req));
  return scimJson(resource, 201, { Location: resource.meta!.location });
}
