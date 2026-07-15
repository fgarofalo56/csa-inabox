/**
 * SCIM 2.0 ResourceTypes (RFC 7643 §6) — the resource types this endpoint
 * exposes (User, Group). Auth: the SCIM provisioning bearer.
 */

import { requireScim, scimJson, originOf } from '@/lib/scim/respond';
import { scimListResponse } from '@/lib/scim/core';
import { SCIM_USER_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_RESOURCE_TYPE_SCHEMA } from '@/lib/scim/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gate = requireScim(req);
  if (gate) return gate;
  const base = originOf(req).replace(/\/+$/, '');
  const types = [
    {
      schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: SCIM_USER_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${base}/api/scim/v2/ResourceTypes/User` },
    },
    {
      schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: SCIM_GROUP_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${base}/api/scim/v2/ResourceTypes/Group` },
    },
  ];
  return scimJson(scimListResponse(types, { totalResults: types.length, startIndex: 1, itemsPerPage: types.length }));
}
