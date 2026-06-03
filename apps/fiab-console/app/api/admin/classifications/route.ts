/**
 * /api/admin/classifications
 *
 * Custom CLASSIFICATION rules — name + match strategy (column-name-regex | data-regex | dictionary)
 * + the classification it applies (PII/PHI/PCI/Confidential/etc.).
 *
 * GET  /api/admin/classifications — list tenant classification rules
 * POST /api/admin/classifications   body: { name, matchStrategy, matchValue, classification }
 * DELETE /api/admin/classifications?id=...
 *
 * Backed by Cosmos tenant-settings container under id="classifications:<tenantId>".
 * Applied on next catalog scan run; users are notified of this in the UI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ClassificationRule {
  id: string;
  name: string;
  matchStrategy: 'column-name-regex' | 'data-regex' | 'dictionary';
  matchValue: string;
  classification: string;
  createdAt: string;
  createdBy: string;
}

interface ClassificationsDoc {
  id: string;
  tenantId: string;
  kind: 'classifications';
  rules: ClassificationRule[];
  updatedAt: string;
}

async function loadOrSeed(tenantId: string, _who: string): Promise<ClassificationsDoc> {
  const c = await tenantSettingsContainer();
  const docId = `classifications:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<ClassificationsDoc>();
    if (resource) return resource;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const seed: ClassificationsDoc = {
    id: docId,
    tenantId,
    kind: 'classifications',
    rules: [],
    updatedAt: new Date().toISOString(),
  } as any;
  await c.items.create(seed);
  return seed;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    return NextResponse.json({ ok: true, rules: doc.rules, updatedAt: doc.updatedAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  const matchStrategy = (body?.matchStrategy || '').toString().trim();
  const matchValue = (body?.matchValue || '').toString().trim();
  const classification = (body?.classification || '').toString().trim();

  if (!name || !matchStrategy || !matchValue || !classification) {
    return NextResponse.json(
      { ok: false, error: 'name, matchStrategy, matchValue, and classification required' },
      { status: 400 }
    );
  }

  const validStrategies = ['column-name-regex', 'data-regex', 'dictionary'];
  if (!validStrategies.includes(matchStrategy)) {
    return NextResponse.json(
      { ok: false, error: `invalid matchStrategy; must be one of: ${validStrategies.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const c = await tenantSettingsContainer();
    const docId = `classifications:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);

    const id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    doc.rules.push({
      id,
      name,
      matchStrategy: matchStrategy as ClassificationRule['matchStrategy'],
      matchValue,
      classification,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);

    return NextResponse.json({ ok: true, rule: doc.rules[doc.rules.length - 1], rules: doc.rules });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });

  try {
    const c = await tenantSettingsContainer();
    const docId = `classifications:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const before = doc.rules.length;
    doc.rules = doc.rules.filter((r) => r.id !== id);
    if (doc.rules.length === before) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, rules: doc.rules });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
