/**
 * GET  /api/items/release-environment/[id]/promote → { ok, stages, promotions, devCenterConfigured }
 * POST /api/items/release-environment/[id]/promote { fromStage, toStage, note?, environmentDefinition? }
 *   → { ok, promotion, promotions }
 *
 * Records a promotion between two stages on the release-environment item's
 * state (real Cosmos persistence). When LOOM_DEVCENTER_PROJECT is set the body
 * may name an Azure Deployment Environments definition to target. Azure-native;
 * no Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import {
  createDeploymentEnvironment, devCenterConfigured, readDevCenterConfig,
  DevCenterError, DevCenterNotConfiguredError,
} from '@/lib/azure/devcenter-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'release-environment';
function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

interface DeployedEnv {
  name: string; provisioningState: string; environmentType: string;
  environmentDefinitionName: string; resourceGroupId?: string; operationLocation?: string;
}

interface Promotion {
  id: string; fromStage: string; toStage: string; note?: string;
  environmentDefinition?: string; promotedAt: string; promotedBy?: string;
  /** Real Azure Deployment Environments result when DevCenter is configured. */
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
  const environmentDefinition = String(body?.environmentDefinition || '').trim() || undefined;

  // When a DevCenter project is configured AND the promotion names an
  // environment definition, create the REAL Azure Deployment Environment.
  let deployedEnvironment: DeployedEnv | undefined;
  if (environmentDefinition) {
    if (!devCenterConfigured()) {
      return NextResponse.json({
        ok: false,
        code: 'devcenter_gate',
        gate: {
          reason: 'An environment definition was named, but Azure Deployment Environments is not configured.',
          remediation: 'Set LOOM_DEVCENTER_PROJECT, LOOM_DEVCENTER_URI, and LOOM_DEVCENTER_CATALOG on the Console, and grant the Console UAMI the "Deployment Environments User" role on the project. No Microsoft Fabric required.',
          link: 'https://learn.microsoft.com/azure/deployment-environments/',
        },
        error: 'Azure Deployment Environments not configured (LOOM_DEVCENTER_PROJECT).',
      }, { status: 409 });
    }
    try {
      const r = await createDeploymentEnvironment({
        environmentName: `${env.displayName || id}-${toStage}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63),
        environmentDefinitionName: environmentDefinition,
        environmentType: toStage,
      });
      deployedEnvironment = r;
    } catch (e) {
      if (e instanceof DevCenterNotConfiguredError) {
        try { readDevCenterConfig(); } catch { /* surfaced below */ }
        return NextResponse.json({
          ok: false,
          code: 'devcenter_gate',
          gate: {
            reason: 'Azure Deployment Environments is partially configured.',
            remediation: `Set the missing env var(s): ${e.missing.join(', ')} on the Console. No Microsoft Fabric required.`,
            link: 'https://learn.microsoft.com/azure/deployment-environments/',
          },
          error: e.message,
        }, { status: 409 });
      }
      const status = e instanceof DevCenterError ? e.status : 502;
      return err(`Azure Deployment Environments create failed: ${(e as Error).message}`, status, 'devcenter_error');
    }
  }

  const promotion: Promotion = {
    id: `promo_${Date.now()}`,
    fromStage, toStage,
    note: String(body?.note || '').trim() || undefined,
    environmentDefinition,
    promotedAt: new Date().toISOString(),
    promotedBy: s.claims.upn || s.claims.email || s.claims.oid,
    ...(deployedEnvironment ? { deployedEnvironment } : {}),
  };
  state.promotions = [promotion, ...promotions].slice(0, 200);
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
  return NextResponse.json({ ok: true, promotion, promotions: state.promotions, deployedEnvironment });
}
