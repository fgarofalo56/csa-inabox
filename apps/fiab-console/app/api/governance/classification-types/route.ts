/**
 * GET/POST/DELETE /api/governance/classification-types — the tenant's
 * classification / sensitivity-LABEL taxonomy. Defines the standard set of
 * labels (name + sensitivity tier + color + description) that item editors
 * apply and the Classifications rollup reports against. Stored as a single doc
 * in the tenant-settings container (`classification-types:<tenantId>`), same
 * pattern as governance policies.
 *
 *   GET    → { ok, types: ClassificationType[] }
 *   POST   { name, sensitivity, color?, description? } → add (idempotent by name)
 *   DELETE ?id=<id> → remove
 *
 * Auth: session-required; tenantId = caller oid. Real Cosmos only (no mocks).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Sensitivity = 'Public' | 'Internal' | 'Confidential' | 'Highly Confidential' | 'Restricted';
const SENSITIVITIES: Sensitivity[] = ['Public', 'Internal', 'Confidential', 'Highly Confidential', 'Restricted'];

interface ClassificationType {
  id: string;
  name: string;
  sensitivity: Sensitivity;
  color?: string;
  description?: string;
  createdAt: string;
  createdBy: string;
}
interface TypesDoc { id: string; tenantId: string; kind: 'classification-types'; items: ClassificationType[]; updatedAt: string; }

/** Sensible default taxonomy seeded on first read so a fresh tenant isn't empty. */
const DEFAULTS: Array<Pick<ClassificationType, 'name' | 'sensitivity' | 'color' | 'description'>> = [
  { name: 'Public', sensitivity: 'Public', color: '#2e7d32', description: 'No restriction; safe to share externally.' },
  { name: 'Internal', sensitivity: 'Internal', color: '#1565c0', description: 'Internal use only.' },
  { name: 'Confidential', sensitivity: 'Confidential', color: '#e65100', description: 'Sensitive business data; need-to-know.' },
  { name: 'PII', sensitivity: 'Highly Confidential', color: '#c62828', description: 'Personally identifiable information.' },
  { name: 'Restricted', sensitivity: 'Restricted', color: '#6a1b9a', description: 'Highest tier; regulated/legal hold.' },
];

async function loadOrSeed(tenantId: string, createdBy: string): Promise<TypesDoc> {
  const c = await tenantSettingsContainer();
  const docId = `classification-types:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<TypesDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const now = new Date().toISOString();
  const seed: TypesDoc = {
    id: docId, tenantId, kind: 'classification-types', updatedAt: now,
    items: DEFAULTS.map((d, i) => ({ id: `ct-${i}-${now}`, ...d, createdAt: now, createdBy })),
  };
  await c.items.create(seed);
  return seed;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const doc = await loadOrSeed(s.claims.oid, s.claims.upn || s.claims.oid);
    return NextResponse.json({ ok: true, types: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const name = String(b?.name || '').trim();
  const sensitivity = (SENSITIVITIES.includes(b?.sensitivity) ? b.sensitivity : 'Internal') as Sensitivity;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    if (doc.items.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      return NextResponse.json({ ok: false, error: `A label named "${name}" already exists.` }, { status: 409 });
    }
    const type: ClassificationType = {
      id: crypto.randomUUID(), name, sensitivity,
      color: b?.color ? String(b.color) : undefined,
      description: b?.description ? String(b.description) : undefined,
      createdAt: new Date().toISOString(), createdBy: s.claims.upn || tenantId,
    };
    doc.items.push(type);
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, type, types: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const before = doc.items.length;
    doc.items = doc.items.filter((t) => t.id !== id);
    if (doc.items.length === before) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, types: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
