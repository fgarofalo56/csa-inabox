/**
 * /api/data-products/[id]/okrs
 *
 * F10 "Linked resources" — OKRs section. Loom-native Objectives & Key Results
 * store for a data product. Persists to the Cosmos `okrs` container (PK
 * /dataProductId). No Fabric/Power BI dependency — pure Azure Cosmos.
 *
 *   GET    → { ok, okrs }                                  — OKRs for this product
 *   POST   { name, description?, metric?, target?, current?, status? } → { ok, okr }
 *   DELETE ?okrId=<id>                                     — remove one OKR
 *
 * Ownership: the caller must own the parent data-product item (tenant-scoped)
 * before reading or mutating its OKRs.
 *
 * Status: 200/201 ok · 401 unauthenticated · 404 item not found · 422 bad body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { okrsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem } from '../../../items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const STATUSES = ['on-track', 'behind', 'at-risk'] as const;
type OkrStatus = (typeof STATUSES)[number];

interface OkrDoc {
  id: string;
  dataProductId: string;
  name: string;
  description?: string;
  metric?: string;
  target?: string;
  current?: string;
  status: OkrStatus;
  createdAt: string;
  updatedAt: string;
}

function err(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

async function ownsProduct(id: string, tenantId: string): Promise<boolean> {
  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  return !!item;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const id = (await ctx.params).id;
  if (!(await ownsProduct(id, session.claims.oid))) return err('data-product item not found', 404);

  const c = await okrsContainer();
  const { resources } = await c.items
    .query<OkrDoc>({
      query: 'SELECT * FROM c WHERE c.dataProductId = @id ORDER BY c.createdAt',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  return NextResponse.json({ ok: true, okrs: resources });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const id = (await ctx.params).id;
  if (!(await ownsProduct(id, session.claims.oid))) return err('data-product item not found', 404);

  let body: any;
  try { body = await req.json(); } catch { return err('invalid JSON', 400); }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return err('OKR name is required', 422, { field: 'name' });
  const status: OkrStatus = STATUSES.includes(body?.status) ? body.status : 'on-track';

  const now = new Date().toISOString();
  const doc: OkrDoc = {
    id: crypto.randomUUID(),
    dataProductId: id,
    name,
    description: typeof body?.description === 'string' ? body.description.trim() || undefined : undefined,
    metric: typeof body?.metric === 'string' ? body.metric.trim() || undefined : undefined,
    target: body?.target != null && String(body.target).trim() ? String(body.target).trim() : undefined,
    current: body?.current != null && String(body.current).trim() ? String(body.current).trim() : undefined,
    status,
    createdAt: now,
    updatedAt: now,
  };
  const c = await okrsContainer();
  const { resource } = await c.items.create<OkrDoc>(doc);
  return NextResponse.json({ ok: true, okr: resource }, { status: 201 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const id = (await ctx.params).id;
  if (!(await ownsProduct(id, session.claims.oid))) return err('data-product item not found', 404);

  const okrId = req.nextUrl.searchParams.get('okrId');
  if (!okrId) return err('okrId query param is required', 422);

  const c = await okrsContainer();
  try {
    // okrs is partitioned by /dataProductId, so the parent product id is the PK.
    await c.item(okrId, id).delete();
  } catch (e: any) {
    if (e?.code === 404) return err('OKR not found', 404);
    throw e;
  }
  return NextResponse.json({ ok: true });
}
