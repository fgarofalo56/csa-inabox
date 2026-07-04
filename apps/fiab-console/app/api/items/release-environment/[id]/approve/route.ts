/**
 * GET  /api/items/release-environment/[id]/approve → { ok, pending }
 *   The pending-approvals queue: promotions awaiting gate clearance.
 * POST /api/items/release-environment/[id]/approve { promotionId, decision: 'approve'|'reject', comment? }
 *   → { ok, promotion, promotions, deployedEnvironment? }
 *
 * Records an approve/reject decision (with comment + audit) against a pending
 * promotion. When the approval count reaches the edge's approvalsRequired the
 * promotion completes — and, if it named an environment definition, the REAL
 * Azure Deployment Environment is created at that moment and the target
 * environment's currentVersion is updated. Real Cosmos persistence; Azure-native;
 * no Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { deployForPromotion, type DeployedEnv } from '../../_shared';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'release-environment';
function err(error: string, status: number, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}

interface ApprovalRecord { by: string; at: string; decision: 'approve' | 'reject'; comment?: string }
interface ReleaseEnv { id: string; name: string; currentVersion?: string; [k: string]: unknown }
interface Promotion {
  id: string; fromStage: string; toStage: string; note?: string;
  environmentDefinition?: string; version?: string;
  status?: 'completed' | 'pending' | 'rejected';
  approvalsRequired?: number; approvals?: ApprovalRecord[];
  promotedAt: string; promotedBy?: string; deployedEnvironment?: DeployedEnv;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, pending: [] });
  const env = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!env) return err('release-environment not found', 404, 'not_found');
  const state = (env.state || {}) as Record<string, unknown>;
  const promotions: Promotion[] = Array.isArray(state.promotions) ? (state.promotions as Promotion[]) : [];
  return NextResponse.json({ ok: true, pending: promotions.filter((p) => p.status === 'pending') });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('no id yet', 400, 'no_id');
  const env = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!env) return err('release-environment not found', 404, 'not_found');
  const body = await req.json().catch(() => ({} as any));
  const promotionId = String(body?.promotionId || '').trim();
  const decision = String(body?.decision || '').trim() as 'approve' | 'reject';
  const comment = String(body?.comment || '').trim() || undefined;
  if (!promotionId) return err('promotionId is required', 400, 'missing_id');
  if (decision !== 'approve' && decision !== 'reject') return err('decision must be approve or reject', 400, 'bad_decision');

  const state = { ...((env.state || {}) as Record<string, unknown>) };
  const promotions: Promotion[] = Array.isArray(state.promotions) ? (state.promotions as Promotion[]) : [];
  const environments: ReleaseEnv[] = Array.isArray(state.environments) ? (state.environments as ReleaseEnv[]) : [];
  const p = promotions.find((x) => x.id === promotionId);
  if (!p) return err('promotion not found', 404, 'not_found');
  if (p.status !== 'pending') return err(`promotion is already ${p.status || 'completed'}`, 409, 'not_pending');

  const by = s.claims.upn || s.claims.email || s.claims.oid;
  p.approvals = [...(p.approvals || []), { by, at: new Date().toISOString(), decision, comment }];

  let deployedEnvironment: DeployedEnv | undefined;
  if (decision === 'reject') {
    p.status = 'rejected';
  } else {
    const approved = p.approvals.filter((a) => a.decision === 'approve').length;
    if (approved >= Math.max(1, Number(p.approvalsRequired) || 1)) {
      // Threshold met → run the real deploy now, then complete.
      const outcome = await deployForPromotion({ displayName: env.displayName, id, toStage: p.toStage, environmentDefinition: p.environmentDefinition });
      if (outcome.gate || outcome.error) {
        // Persist the approval but keep pending so the gate can be remediated.
        state.promotions = promotions.map((x) => (x.id === p.id ? p : x));
        await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
        if (outcome.gate) return NextResponse.json({ ok: false, code: 'devcenter_gate', gate: outcome.gate, error: outcome.error, promotions: state.promotions }, { status: outcome.status || 409 });
        return err(outcome.error || 'deploy failed', outcome.status || 502, 'devcenter_error');
      }
      deployedEnvironment = outcome.deployedEnvironment;
      p.status = 'completed';
      if (deployedEnvironment) p.deployedEnvironment = deployedEnvironment;
      if (p.version && environments.length) {
        state.environments = environments.map((e) => (e.name === p.toStage ? { ...e, currentVersion: p.version } : e));
      }
    }
  }

  state.promotions = promotions.map((x) => (x.id === p.id ? p : x));
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
  return NextResponse.json({ ok: true, promotion: p, promotions: state.promotions, deployedEnvironment });
}
