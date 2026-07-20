/**
 * A single approval policy (access-governance W2). Tenant-admin only.
 *   GET / PUT / DELETE /api/approval-policies/[id]
 * PK is /tenantId, so mutations resolve the doc by id first. Backed by
 * `approval-policies`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { approvalPoliciesContainer } from '@/lib/azure/cosmos-client';
import type { ApprovalPolicy } from '@/lib/types/approval-policy';
import { apiServerError } from '@/lib/api/respond';
import { sanitizePolicy } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readById(id: string): Promise<ApprovalPolicy | null> {
  const c = await approvalPoliciesContainer();
  const { resources } = await c.items
    .query<ApprovalPolicy>({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    .fetchAll();
  return resources[0] || null;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const pol = await readById(id);
    if (!pol) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, policy: pol });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const existing = await readById(id);
    if (!existing) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const { pol, error } = sanitizePolicy(body, existing);
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
    const updated: ApprovalPolicy = {
      ...existing,
      ...pol!,
      id: existing.id,
      tenantId: existing.tenantId,
      kind: 'approval-policy',
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const c = await approvalPoliciesContainer();
    const { resource } = await c.item(existing.id, existing.tenantId).replace(updated);
    return NextResponse.json({ ok: true, policy: resource });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const existing = await readById(id);
    if (!existing) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const c = await approvalPoliciesContainer();
    await c.item(existing.id, existing.tenantId).delete();
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e: any) {
    return apiServerError(e);
  }
}
