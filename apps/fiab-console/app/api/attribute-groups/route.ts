/**
 * GET  /api/attribute-groups?domainId=<id>  — custom attribute-group SCHEMA for
 *      the data-product wizard's "Custom attributes" page (page 3).
 * POST /api/attribute-groups                 — upsert the tenant's attribute-group
 *      schema (admin authoring; one doc per tenant).
 *
 * What this is, in Purview terms
 * ------------------------------------------------------------------------------
 * In Microsoft Purview Unified Catalog, custom "business concept attributes" are
 * defined by an admin under Catalog management > Custom metadata > Business
 * concept attributes, scoped per governance domain. There is no GA Unified
 * Catalog REST endpoint to read that schema, so Loom keeps the schema in its own
 * Cosmos store (tenant-settings doc `attribute-groups:<tenantId>`) and the
 * wizard renders a dynamic form from it. This is the Azure-native default — no
 * Purview, no Fabric required. When the schema is empty the wizard simply shows
 * "no custom attributes for this domain" and the create still works.
 *
 * Each attribute renders by `fieldType` exactly like the portal's per-type
 * inputs (Text / Single choice / Multiple choice / Date / Boolean / Integer /
 * Double / Rich text), grounded in:
 *   https://learn.microsoft.com/purview/unified-catalog-attributes-business-concept
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type AttributeFieldType =
  | 'Text'
  | 'Single choice'
  | 'Multiple choice'
  | 'Date'
  | 'Boolean'
  | 'Integer'
  | 'Double'
  | 'Rich text';

export interface AttributeDef {
  id: string;
  name: string;
  description?: string;
  fieldType: AttributeFieldType;
  required?: boolean;
  /** For Single/Multiple choice. */
  choices?: string[];
}

export interface AttributeGroup {
  id: string;
  name: string;
  description?: string;
  /** When set, the group only applies to these governance-domain ids. Empty/absent = all. */
  domainIds?: string[];
  attributes: AttributeDef[];
}

interface AttributeGroupsDoc {
  id: string;
  tenantId: string;
  kind: 'attribute-groups';
  groups: AttributeGroup[];
  updatedAt: string;
}

function docId(tenantId: string) { return `attribute-groups:${tenantId}`; }

async function loadDoc(tenantId: string): Promise<AttributeGroupsDoc | null> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(docId(tenantId), tenantId).read<AttributeGroupsDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;
  const domainId = req.nextUrl.searchParams.get('domainId') || '';
  try {
    const doc = await loadDoc(tenantId);
    if (!doc) {
      return NextResponse.json({ ok: true, groups: [], source: 'cosmos', note: 'No custom attribute groups are defined for this tenant yet.' });
    }
    let groups = doc.groups || [];
    // Filter to groups scoped to this domain (or unscoped/global groups).
    if (domainId) {
      groups = groups.filter((g) => !g.domainIds || g.domainIds.length === 0 || g.domainIds.includes(domainId));
    }
    return NextResponse.json({ ok: true, groups, source: 'cosmos', updatedAt: doc.updatedAt });
  } catch (e: any) {
    return apiServerError(e);
  }
}

const VALID_FIELD_TYPES: AttributeFieldType[] = [
  'Text', 'Single choice', 'Multiple choice', 'Date', 'Boolean', 'Integer', 'Double', 'Rich text',
];

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }

  const rawGroups = Array.isArray(body?.groups) ? body.groups : null;
  if (!rawGroups) return NextResponse.json({ ok: false, error: 'groups[] is required' }, { status: 400 });

  // Normalize + validate the incoming schema (no free-form junk persisted).
  const groups: AttributeGroup[] = rawGroups.map((g: any, gi: number) => ({
    id: String(g?.id || `grp-${gi + 1}`),
    name: String(g?.name || `Group ${gi + 1}`).trim(),
    description: g?.description ? String(g.description) : undefined,
    domainIds: Array.isArray(g?.domainIds) ? g.domainIds.map((d: any) => String(d)).filter(Boolean) : undefined,
    attributes: (Array.isArray(g?.attributes) ? g.attributes : []).map((a: any, ai: number) => {
      const fieldType: AttributeFieldType = VALID_FIELD_TYPES.includes(a?.fieldType) ? a.fieldType : 'Text';
      return {
        id: String(a?.id || `attr-${gi + 1}-${ai + 1}`),
        name: String(a?.name || `Attribute ${ai + 1}`).trim(),
        description: a?.description ? String(a.description) : undefined,
        fieldType,
        required: !!a?.required,
        choices: Array.isArray(a?.choices) ? a.choices.map((c: any) => String(c)).filter(Boolean) : undefined,
      };
    }),
  }));

  const next: AttributeGroupsDoc = {
    id: docId(tenantId),
    tenantId,
    kind: 'attribute-groups',
    groups,
    updatedAt: new Date().toISOString(),
  };
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.items.upsert<AttributeGroupsDoc>(next);
    return NextResponse.json({ ok: true, groups: resource?.groups || groups, updatedAt: next.updatedAt });
  } catch (e: any) {
    return apiServerError(e);
  }
}
