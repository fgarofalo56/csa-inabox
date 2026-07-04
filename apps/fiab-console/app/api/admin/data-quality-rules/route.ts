/**
 * /api/admin/data-quality-rules
 *
 * Loom-native data-quality rule CRUD. Rules are stored in the tenant-settings
 * container under id="dq-rules:<tenantId>" and include:
 *   - id: unique rule id
 *   - name: descriptive name
 *   - scope: "table:table_name" or "column:table.column"
 *   - check: "not-null" | "unique" | "range" | "regex" | "freshness"
 *   - threshold: numeric (% for not-null/unique, days for freshness, etc.)
 *   - pattern?: regex pattern (for regex check)
 *   - min/max?: numeric (for range check)
 *   - enabled: boolean
 *   - createdAt: ISO string
 *   - createdBy: user UPN
 *   - updatedAt: ISO string
 *
 * GET  → list all rules
 * POST → create a new rule { name, scope, check, threshold, pattern?, min?, max?, enabled? }
 * PUT  → update a rule { id, ...updates }
 * DELETE → delete by id
 *
 * Rules execute on next scan (honest note in UI). No Purview dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DataQualityRule {
  id: string;
  name: string;
  scope: string; // "table:name" or "column:table.column"
  check: 'not-null' | 'unique' | 'range' | 'regex' | 'freshness';
  threshold: number;
  pattern?: string; // for regex check
  min?: number; // for range check
  max?: number; // for range check
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

interface DataQualityRulesDoc {
  id: string;
  tenantId: string;
  kind: 'dq-rules';
  items: DataQualityRule[];
  updatedAt: string;
}

async function loadOrSeed(tenantId: string): Promise<DataQualityRulesDoc> {
  const c = await tenantSettingsContainer();
  const docId = `dq-rules:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<DataQualityRulesDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: DataQualityRulesDoc = {
    id: docId, tenantId, kind: 'dq-rules', items: [],
    updatedAt: new Date().toISOString(),
  };
  await c.items.create(seed);
  return seed;
}

function validateRule(body: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!body?.name || typeof body.name !== 'string') errors.push('name is required and must be a string');
  if (!body?.scope || typeof body.scope !== 'string') errors.push('scope is required (e.g., "table:my_table" or "column:my_table.my_col")');
  if (!body?.check || !['not-null', 'unique', 'range', 'regex', 'freshness'].includes(body.check)) {
    errors.push('check must be one of: not-null, unique, range, regex, freshness');
  }
  if (typeof body?.threshold !== 'number' || body.threshold < 0 || body.threshold > 100) {
    errors.push('threshold must be a number between 0 and 100');
  }
  if (body.check === 'regex' && !body?.pattern) errors.push('pattern is required for regex check');
  if (body.check === 'range' && (typeof body?.min !== 'number' || typeof body?.max !== 'number')) {
    errors.push('min and max are required for range check');
  }
  return { valid: errors.length === 0, errors };
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId);
    return NextResponse.json({ ok: true, rules: doc.items, updatedAt: doc.updatedAt });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));

  const { valid, errors } = validateRule(body);
  if (!valid) return NextResponse.json({ ok: false, errors }, { status: 400 });

  try {
    const c = await tenantSettingsContainer();
    const docId = `dq-rules:${tenantId}`;
    const doc = await loadOrSeed(tenantId);

    const id = `dq-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const now = new Date().toISOString();
    const rule: DataQualityRule = {
      id,
      name: String(body.name).trim(),
      scope: String(body.scope).trim(),
      check: body.check,
      threshold: body.threshold,
      ...(body.pattern ? { pattern: String(body.pattern) } : {}),
      ...(typeof body.min === 'number' ? { min: body.min } : {}),
      ...(typeof body.max === 'number' ? { max: body.max } : {}),
      enabled: body.enabled !== false,
      createdAt: now,
      createdBy: s.claims.upn || tenantId,
      updatedAt: now,
    };
    doc.items.push(rule);
    doc.updatedAt = now;
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, rule, rules: doc.items });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const id = body?.id;
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });

  try {
    const c = await tenantSettingsContainer();
    const docId = `dq-rules:${tenantId}`;
    const doc = await loadOrSeed(tenantId);

    const idx = doc.items.findIndex((r) => r.id === id);
    if (idx < 0) return NextResponse.json({ ok: false, error: 'rule not found' }, { status: 404 });

    const now = new Date().toISOString();
    const updates: any = { ...body };
    delete updates.id; // prevent id changes
    delete updates.createdAt; // prevent creation-time changes
    delete updates.createdBy;

    // Validate if check or threshold changed
    if (updates.check || updates.threshold !== undefined) {
      const merged = { ...doc.items[idx], ...updates };
      const { valid, errors } = validateRule(merged);
      if (!valid) return NextResponse.json({ ok: false, errors }, { status: 400 });
    }

    doc.items[idx] = { ...doc.items[idx], ...updates, updatedAt: now };
    doc.updatedAt = now;
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, rule: doc.items[idx], rules: doc.items });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });

  try {
    const c = await tenantSettingsContainer();
    const docId = `dq-rules:${tenantId}`;
    const doc = await loadOrSeed(tenantId);
    const before = doc.items.length;
    doc.items = doc.items.filter((r) => r.id !== id);
    if (doc.items.length === before) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, rules: doc.items });
  } catch (e: any) {
    return apiServerError(e);
  }
}
