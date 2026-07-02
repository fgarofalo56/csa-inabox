/**
 * /api/admin/sensitivity-labels
 *
 * SENSITIVITY LABELS — name + color + protection note (DLP rule hint).
 * These are Loom-native labels (not tied to Microsoft Purview MIP).
 *
 * GET  /api/admin/sensitivity-labels — list tenant sensitivity labels
 * POST /api/admin/sensitivity-labels   body: { name, color, protectionNote? }
 * DELETE /api/admin/sensitivity-labels?id=...
 *
 * Backed by Cosmos tenant-settings container under id="sensitivity-labels:<tenantId>".
 * Applied on next scan; users are notified of this in the UI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SensitivityLabel {
  id: string;
  name: string;
  color: string;
  protectionNote?: string;
  createdAt: string;
  createdBy: string;
}

interface SensitivityLabelsDoc {
  id: string;
  tenantId: string;
  kind: 'sensitivity-labels';
  labels: SensitivityLabel[];
  updatedAt: string;
}

async function loadOrSeed(tenantId: string, _who: string): Promise<SensitivityLabelsDoc> {
  const c = await tenantSettingsContainer();
  const docId = `sensitivity-labels:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<SensitivityLabelsDoc>();
    if (resource) return resource;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  // Deploy-readiness (#229): inherit the GLOBAL default label set seeded by
  // scripts/csa-loom/seed-governance.sh so the surface is POPULATED on first
  // login. Cloned only at doc-creation (this 404 path); never re-seeds after a
  // user edits/deletes labels. Absent GLOBAL doc → falls back to [].
  let seededLabels: SensitivityLabel[] = [];
  try {
    const { resource: global } = await c
      .item('sensitivity-labels:GLOBAL', 'GLOBAL')
      .read<SensitivityLabelsDoc>();
    if (global?.labels?.length) {
      seededLabels = global.labels.map((l) => ({
        ...l,
        createdAt: new Date().toISOString(),
        createdBy: 'csa-loom-default',
      }));
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const seed: SensitivityLabelsDoc = {
    id: docId,
    tenantId,
    kind: 'sensitivity-labels',
    labels: seededLabels,
    updatedAt: new Date().toISOString(),
  } as any;
  await c.items.create(seed);
  return seed;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    return NextResponse.json({ ok: true, labels: doc.labels, updatedAt: doc.updatedAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  const color = (body?.color || '').toString().trim();
  const protectionNote = body?.protectionNote ? (body.protectionNote).toString().trim() : undefined;

  if (!name || !color) {
    return NextResponse.json({ ok: false, error: 'name and color required' }, { status: 400 });
  }

  try {
    const c = await tenantSettingsContainer();
    const docId = `sensitivity-labels:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);

    const id = `label-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    doc.labels.push({
      id,
      name,
      color,
      protectionNote,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);

    return NextResponse.json({ ok: true, label: doc.labels[doc.labels.length - 1], labels: doc.labels });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const tenantId = s.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });

  try {
    const c = await tenantSettingsContainer();
    const docId = `sensitivity-labels:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const before = doc.labels.length;
    doc.labels = doc.labels.filter((l) => l.id !== id);
    if (doc.labels.length === before) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, labels: doc.labels });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
