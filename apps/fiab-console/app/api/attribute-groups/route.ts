/**
 * /api/attribute-groups  (F17 — Custom attributes / Attribute groups)
 *
 * Admin-defined, per-domain attribute schemas that drive the Create wizard's
 * "Custom attributes" step and item Edit dialogs. Azure-native: stored in the
 * Cosmos `attribute-groups` container (PK /tenantId). No live Microsoft
 * Purview / Fabric account is required.
 *
 *   GET    /api/attribute-groups[?domain=<domainId>]
 *            List the tenant's attribute groups. When ?domain is supplied,
 *            return only groups that apply to that domain (domainIds includes
 *            it, OR the group is unscoped — domainIds empty = all domains).
 *   POST   /api/attribute-groups          body { name, description?, domainIds? }
 *            Create an empty group.
 *   PATCH  /api/attribute-groups?groupId=  body { name?, description?, domainIds?, attributes? }
 *            Update group metadata and/or replace the full attributes array
 *            (handles add / edit / delete / reorder — client sends the whole
 *            sorted array).
 *   DELETE /api/attribute-groups?groupId=
 *            Remove a group (and therefore its attributes) from all domains.
 *
 * All responses are { ok, ... } with proper HTTP status codes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { attributeGroupsContainer } from '@/lib/azure/cosmos-client';
import {
  type AttributeGroupDoc,
  type AttributeDef,
  type AttributeType,
  ATTRIBUTE_TYPES,
  kebab,
  validateAttributes,
} from '@/lib/types/attribute-groups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Coerce an arbitrary client attribute payload into a clean AttributeDef. */
function normalizeAttribute(a: any, index: number): AttributeDef {
  const type = (a?.type ?? 'string') as AttributeType;
  const def: AttributeDef = {
    id: typeof a?.id === 'string' && a.id ? a.id : `attr-${Math.random().toString(36).slice(2, 10)}`,
    name: (a?.name ?? '').toString().trim(),
    description: a?.description ? a.description.toString() : undefined,
    type: ATTRIBUTE_TYPES.includes(type) ? type : 'string',
    required: !!a?.required,
    order: typeof a?.order === 'number' ? a.order : index,
  };
  if (def.type === 'enum') {
    const vals: string[] = Array.isArray(a?.enumValues) ? a.enumValues : [];
    def.enumValues = Array.from(
      new Set(vals.map((v) => (v ?? '').toString().trim()).filter(Boolean)),
    );
  }
  return def;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const domain = req.nextUrl.searchParams.get('domain');
  try {
    const c = await attributeGroupsContainer();
    const { resources } = await c.items
      .query<AttributeGroupDoc>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name',
        parameters: [{ name: '@t', value: tenantId }],
      }, { partitionKey: tenantId })
      .fetchAll();
    // Normalize attribute ordering on read so the form is deterministic.
    for (const g of resources) {
      g.attributes = (g.attributes || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    const groups = domain
      ? resources.filter((g) => (g.domainIds?.length ?? 0) === 0 || g.domainIds.includes(domain))
      : resources;
    return NextResponse.json({ ok: true, groups });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const body = await req.json().catch(() => ({}));
  const name = (body?.name ?? '').toString().trim();
  if (!name) return err('name is required', 400);
  const domainIds = Array.isArray(body?.domainIds)
    ? body.domainIds.map((d: any) => d.toString()).filter(Boolean)
    : [];

  try {
    const c = await attributeGroupsContainer();
    const groupId = `${kebab(name)}-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const doc: AttributeGroupDoc = {
      id: `attr-group:${tenantId}:${groupId}`,
      tenantId,
      groupId,
      name,
      description: body?.description ? body.description.toString() : undefined,
      domainIds,
      attributes: [],
      createdAt: now,
      createdBy: who,
      updatedAt: now,
      updatedBy: who,
    };
    const { resource } = await c.items.create<AttributeGroupDoc>(doc);
    return NextResponse.json({ ok: true, group: resource }, { status: 201 });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function PATCH(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const groupId = req.nextUrl.searchParams.get('groupId');
  if (!groupId) return err('groupId query param required', 400);
  const body = await req.json().catch(() => ({}));

  try {
    const c = await attributeGroupsContainer();
    const docId = `attr-group:${tenantId}:${groupId}`;
    let doc: AttributeGroupDoc | undefined;
    try {
      const read = await c.item(docId, tenantId).read<AttributeGroupDoc>();
      doc = read.resource;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    if (!doc) return err('group not found', 404);

    if (body?.name !== undefined) {
      const n = (body.name ?? '').toString().trim();
      if (!n) return err('name cannot be empty', 400);
      doc.name = n;
    }
    if (body?.description !== undefined) {
      doc.description = body.description ? body.description.toString() : undefined;
    }
    if (body?.domainIds !== undefined) {
      doc.domainIds = Array.isArray(body.domainIds)
        ? body.domainIds.map((d: any) => d.toString()).filter(Boolean)
        : [];
    }
    if (body?.attributes !== undefined) {
      if (!Array.isArray(body.attributes)) return err('attributes must be an array', 400);
      const existingById = new Map(doc.attributes.map((a) => [a.id, a]));
      const normalized = body.attributes.map((a: any, i: number) => {
        const n = normalizeAttribute(a, i);
        // Type is immutable once an attribute exists — preserve the stored type.
        const prev = existingById.get(n.id);
        if (prev) n.type = prev.type;
        return n;
      });
      const verr = validateAttributes(normalized);
      if (verr) return err(verr, 400);
      // Reassign contiguous order to keep the array canonical.
      normalized.forEach((a: AttributeDef, i: number) => { a.order = i; });
      doc.attributes = normalized;
    }
    doc.updatedAt = new Date().toISOString();
    doc.updatedBy = who;
    const { resource } = await c.item(docId, tenantId).replace<AttributeGroupDoc>(doc);
    return NextResponse.json({ ok: true, group: resource });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const groupId = req.nextUrl.searchParams.get('groupId');
  if (!groupId) return err('groupId query param required', 400);
  try {
    const c = await attributeGroupsContainer();
    const docId = `attr-group:${tenantId}:${groupId}`;
    await c.item(docId, tenantId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return err('group not found', 404);
    return err(e?.message || String(e), 500);
  }
}
