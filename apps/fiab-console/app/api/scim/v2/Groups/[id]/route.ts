/**
 * SCIM 2.0 single-group resource (BR-SCIM).
 *
 *   GET    /api/scim/v2/Groups/{id}   → the group
 *   PUT    /api/scim/v2/Groups/{id}   → replace (incl. full member set)
 *   PATCH  /api/scim/v2/Groups/{id}   → add/remove/replace members, rename
 *   DELETE /api/scim/v2/Groups/{id}   → delete (204)
 *
 * Auth: the SCIM provisioning bearer (LOOM_SCIM_BEARER_TOKEN).
 */

import { requireScim, scimJson, scimErr, originOf } from '@/lib/scim/respond';
import { groupDocToScim } from '@/lib/scim/core';
import type { ScimGroup, ScimPatchRequest } from '@/lib/scim/types';
import { getGroup, replaceGroup, saveGroup, deleteGroup } from '@/lib/scim/store';
import { applyGroupPatch } from '@/lib/scim/patch';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getGroup(id);
  if (!doc) return scimErr(404, `Group ${id} not found.`);
  return scimJson(groupDocToScim(doc, originOf(req)));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getGroup(id);
  if (!doc) return scimErr(404, `Group ${id} not found.`);
  let body: ScimGroup;
  try {
    body = (await req.json()) as ScimGroup;
  } catch {
    return scimErr(400, 'Invalid JSON body.', 'invalidSyntax');
  }
  const updated = await replaceGroup(doc, body);
  return scimJson(groupDocToScim(updated, originOf(req)));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getGroup(id);
  if (!doc) return scimErr(404, `Group ${id} not found.`);
  let body: ScimPatchRequest;
  try {
    body = (await req.json()) as ScimPatchRequest;
  } catch {
    return scimErr(400, 'Invalid JSON body.', 'invalidSyntax');
  }
  if (!body || !Array.isArray(body.Operations)) {
    return scimErr(400, 'PatchOp requires an Operations array.', 'invalidValue');
  }
  const before = [...doc.memberIds];
  const patched = applyGroupPatch(doc, body.Operations);
  const saved = await saveGroup(patched, before);
  return scimJson(groupDocToScim(saved, originOf(req)));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getGroup(id);
  if (!doc) return scimErr(404, `Group ${id} not found.`);
  await deleteGroup(doc);
  return new NextResponse(null, { status: 204 });
}
