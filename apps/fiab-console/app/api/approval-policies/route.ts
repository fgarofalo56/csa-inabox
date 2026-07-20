/**
 * Approval policies (access-governance W2).
 *
 *   GET  /api/approval-policies   → all policies (tenant-admin)
 *   POST /api/approval-policies   → create a policy (tenant-admin)
 *
 * A policy selects an ordered SUBSET of the four canonical approval stages and
 * binds named approvers, scoped default / resource-type / package. Consumed by
 * the F16 decision route via the request's approval-plan snapshot. Backed by the
 * `approval-policies` Cosmos container (PK /tenantId).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { approvalPoliciesContainer } from '@/lib/azure/cosmos-client';
import type { ApprovalPolicy, PolicyStage, ApproverBinding, ApprovalStageKey } from '@/lib/types/approval-policy';
import { CANONICAL_STAGES, FINAL_STAGE } from '@/lib/access/approval-policy';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPE_KINDS = new Set(['default', 'resource-type', 'package']);

/** Normalize the policy body — canonical stage order, final stage forced on. */
export function sanitizePolicy(body: any, base: Partial<ApprovalPolicy> = {}): { pol?: Omit<ApprovalPolicy, 'id' | 'tenantId' | 'kind' | 'createdAt' | 'updatedAt'>; error?: string } {
  const name = String(body?.name || '').trim().slice(0, 120);
  if (!name) return { error: 'name is required' };
  const kind = SCOPE_KINDS.has(body?.scope?.kind) ? body.scope.kind : (base.scope?.kind || 'default');
  const ref = kind === 'default' ? undefined : (body?.scope?.ref ? String(body.scope.ref).trim() : base.scope?.ref);
  if (kind !== 'default' && !ref) return { error: `scope.ref is required for a ${kind} policy` };

  const byKey = new Map<ApprovalStageKey, PolicyStage>();
  for (const raw of Array.isArray(body?.stages) ? body.stages : []) {
    const key = raw?.key as ApprovalStageKey;
    if (!CANONICAL_STAGES.includes(key)) continue;
    const approvers: ApproverBinding[] = (Array.isArray(raw?.approvers) ? raw.approvers : [])
      .map((a: any) => ({ type: a?.type === 'group' ? 'group' : 'user', id: String(a?.id || '').trim(), name: a?.name ? String(a.name).trim() : undefined }))
      .filter((a: ApproverBinding) => a.id);
    byKey.set(key, { key, enabled: raw?.enabled !== false, approvers: approvers.length ? approvers : undefined });
  }
  // Default when no stages provided: all four enabled (legacy sequence).
  if (byKey.size === 0) for (const k of CANONICAL_STAGES) byKey.set(k, { key: k, enabled: true });
  // The final grant stage is always enabled so a request can provision.
  byKey.set(FINAL_STAGE, { key: FINAL_STAGE, enabled: true, approvers: byKey.get(FINAL_STAGE)?.approvers });
  const stages = CANONICAL_STAGES.map((k) => byKey.get(k)).filter(Boolean) as PolicyStage[];

  return {
    pol: {
      name,
      description: body?.description ? String(body.description).trim().slice(0, 1000) : base.description,
      scope: { kind, ref },
      stages,
      enforceApprovers: body?.enforceApprovers !== undefined ? !!body.enforceApprovers : (base.enforceApprovers ?? false),
      enabled: body?.enabled !== undefined ? !!body.enabled : (base.enabled ?? true),
      createdBy: base.createdBy,
    },
  };
}

export async function GET() {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const c = await approvalPoliciesContainer();
    const { resources } = await c.items.query<ApprovalPolicy>({ query: 'SELECT * FROM c ORDER BY c.name' }).fetchAll();
    return NextResponse.json({ ok: true, policies: resources || [] });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const body = await req.json().catch(() => ({}));
    const { pol, error } = sanitizePolicy(body, { createdBy: s!.claims.upn || s!.claims.oid });
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
    const now = new Date().toISOString();
    const doc: ApprovalPolicy = {
      id: crypto.randomUUID(),
      tenantId: s!.claims.oid,
      kind: 'approval-policy',
      ...pol!,
      createdBy: s!.claims.upn || s!.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const c = await approvalPoliciesContainer();
    const { resource } = await c.items.create(doc);
    return NextResponse.json({ ok: true, policy: resource }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
