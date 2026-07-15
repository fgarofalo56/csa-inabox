/**
 * SCIM 2.0 single-user resource (BR-SCIM).
 *
 *   GET    /api/scim/v2/Users/{id}   → the user
 *   PUT    /api/scim/v2/Users/{id}   → replace
 *   PATCH  /api/scim/v2/Users/{id}   → partial update (e.g. deactivate)
 *   DELETE /api/scim/v2/Users/{id}   → deprovision (204)
 *
 * Auth: the SCIM provisioning bearer (LOOM_SCIM_BEARER_TOKEN).
 */

import { requireScim, scimJson, scimErr, originOf } from '@/lib/scim/respond';
import { userDocToScim } from '@/lib/scim/core';
import type { ScimUser, ScimPatchRequest } from '@/lib/scim/types';
import { getUser, replaceUser, saveUser, deleteUser } from '@/lib/scim/store';
import { applyUserPatch } from '@/lib/scim/patch';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getUser(id);
  if (!doc) return scimErr(404, `User ${id} not found.`);
  return scimJson(userDocToScim(doc, originOf(req)));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getUser(id);
  if (!doc) return scimErr(404, `User ${id} not found.`);
  let body: ScimUser;
  try {
    body = (await req.json()) as ScimUser;
  } catch {
    return scimErr(400, 'Invalid JSON body.', 'invalidSyntax');
  }
  const updated = await replaceUser(doc, body);
  return scimJson(userDocToScim(updated, originOf(req)));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getUser(id);
  if (!doc) return scimErr(404, `User ${id} not found.`);
  let body: ScimPatchRequest;
  try {
    body = (await req.json()) as ScimPatchRequest;
  } catch {
    return scimErr(400, 'Invalid JSON body.', 'invalidSyntax');
  }
  if (!body || !Array.isArray(body.Operations)) {
    return scimErr(400, 'PatchOp requires an Operations array.', 'invalidValue');
  }
  const patched = applyUserPatch(doc, body.Operations);
  const saved = await saveUser(patched);
  return scimJson(userDocToScim(saved, originOf(req)));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireScim(req);
  if (gate) return gate;
  const { id } = await params;
  const doc = await getUser(id);
  if (!doc) return scimErr(404, `User ${id} not found.`);
  await deleteUser(doc);
  return new NextResponse(null, { status: 204 });
}
