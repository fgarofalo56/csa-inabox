/**
 * GET  /api/items/release-environment/[id]/promote → { ok, stages, promotions, devCenterConfigured }
 * POST /api/items/release-environment/[id]/promote { fromStage, toStage, note?, version?, environmentDefinition? }
 *   → { ok, promotion, promotions, pending?, deployedEnvironment? }
 *
 * Records a promotion between two stages on the release-environment item's
 * state (real Cosmos persistence). If a pipeline edge from→to declares an
 * approval gate (approvalsRequired > 0) the promotion is recorded as `pending`
 * and NOT deployed until the approvals queue clears it (see ./approve). When no
 * gate applies and a definition is named, the real Azure Deployment Environment
 * is created. On completion the target environment's currentVersion is updated
 * (the "what's where" matrix). Azure-native; no Fabric required.
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
interface PipelineEdge { id: string; from: string; to: string; mode?: 'manual' | 'auto'; approvalsRequired?: number; approvers?: string }
interface ReleaseEnv { id: string; name: string; currentVersion?: string; [k: string]: unknown }

interface Promotion {
  id: string; fromStage: string; toStage: string; note?: string;
  environmentDefinition?: string; version?: string;
  status?: 'completed' | 'pending' | 'rejected';
  approvalsRequired?: number; approvals?: ApprovalRecord[];
  promotedAt: string; promotedBy?: string;
  deployedEnvironment?: DeployedEnv;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  const devCenterConfigured = !!process.env.LOOM_DEVCENTER_PROJECT;
  if (!id || id === 'new') return NextResponse.json({ ok: true, stages: [], promotions: [], devCenterConfigured });
  const env = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!env) return err('release-environment not found', 404, 'not_found');
  const state = (env.state || {}) as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    stages: Array.isArray(state.stages) ? state.stages : [],
    promotions: Array.isArray(state.promotions) ? state.promotions : [],
    devCenterConfigured,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the environment before promoting (no id yet)', 400, 'no_id');
  const env = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!env) return err('release-environment not found', 404, 'not_found');
  const body = await req.json().catch(() => ({} as any));
  const fromStage = String(body?.fromStage || '').trim();
  const toStage = String(body?.toStage || '').trim();
  if (!fromStage || !toStage) return err('fromStage and toStage are required', 400, 'missing_stage');
  if (fromStage === toStage) return err('fromStage and toStage must differ', 400, 'same_stage');

  const state = { ...((env.state || {}) as Record<string, unknown>) };
  const promotions: Promotion[] = Array.isArray(state.promotions) ? (state.promotions as Promotion[]) : [];
  const pipeline: PipelineEdge[] = Array.isArray(state.pipeline) ? (state.pipeline as PipelineEdge[]) : [];
  const environments: ReleaseEnv[] = Array.isArray(state.environments) ? (state.environments as ReleaseEnv[]) : [];
  const environmentDefinition = String(body?.environmentDefinition || '').trim() || undefined;
  const version = String(body?.version || '').trim() || undefined;
  const note = String(body?.note || '').trim() || undefined;
  const promotedBy = s.claims.upn || s.claims.email || s.claims.oid;

  // Approval gate: a matching pipeline edge with approvalsRequired > 0 records
  // the promotion as pending; the approvals queue (./approve) deploys on clear.
  const edge = pipeline.find((e) => e.from === fromStage && e.to === toStage);
  const approvalsRequired = Math.max(0, Number(edge?.approvalsRequired) || 0);

  if (approvalsRequired > 0) {
    const promotion: Promotion = {
      id: `promo_${Date.now()}`, fromStage, toStage, note, environmentDefinition, version,
      status: 'pending', approvalsRequired, approvals: [],
      promotedAt: new Date().toISOString(), promotedBy,
    };
    state.promotions = [promotion, ...promotions].slice(0, 200);
    await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
    return NextResponse.json({ ok: true, promotion, promotions: state.promotions, pending: true });
  }

  // No gate → run the real deploy (when a definition is named) and complete.
  const outcome = await deployForPromotion({ displayName: env.displayName, id, toStage, environmentDefinition });
  if (outcome.gate) {
    return NextResponse.json({ ok: false, code: 'devcenter_gate', gate: outcome.gate, error: outcome.error }, { status: outcome.status || 409 });
  }
  if (outcome.error) return err(outcome.error, outcome.status || 502, 'devcenter_error');

  const promotion: Promotion = {
    id: `promo_${Date.now()}`, fromStage, toStage, note, environmentDefinition, version,
    status: 'completed', promotedAt: new Date().toISOString(), promotedBy,
    ...(outcome.deployedEnvironment ? { deployedEnvironment: outcome.deployedEnvironment } : {}),
  };
  state.promotions = [promotion, ...promotions].slice(0, 200);
  if (version && environments.length) {
    state.environments = environments.map((e) => (e.name === toStage ? { ...e, currentVersion: version } : e));
  }
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
  return NextResponse.json({ ok: true, promotion, promotions: state.promotions, deployedEnvironment: outcome.deployedEnvironment });
}
