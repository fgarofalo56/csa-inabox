/**
 * GET /api/data-products/[id]/certification  (DP-5)
 *
 * The LIVE certification score for a data product: every automated check
 * evaluated against real Cosmos state + the tenant's DQ rules, plus the derived
 * certification state (draft → validated → certified) and any recorded sign-off.
 * Read-only + not ownership-gated (the trust signal is discoverable), so the
 * catalog card and marketplace listing can show the same badge the owner sees.
 *
 * Azure-native: reads only Cosmos + the tenant DQ-rules doc. No Fabric / Power
 * BI dependency (.claude/rules/no-fabric-dependency.md); real data, no mocks
 * (.claude/rules/no-vaporware.md) — a missing DQ score honest-gates one check
 * rather than fabricating a pass.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  evaluateCertification, deriveCertificationState, resolveEndorsement,
  type CertificationInputs, type CertificationRecord,
} from '@/lib/dataproducts/certification';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

async function findItem(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: itemId }, { name: '@t', value: ITEM_TYPE }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

interface DqRule { enabled: boolean }
interface DqRulesDoc { items?: DqRule[] }

/** Real DQ score from the caller's tenant rules (enabled ÷ total); null → honest-gate. */
async function computeDqScore(tenantId: string): Promise<number | null> {
  try {
    const ts = await tenantSettingsContainer();
    const { resource } = await ts.item(`dq-rules:${tenantId}`, tenantId).read<DqRulesDoc>();
    const rules = resource?.items ?? [];
    if (rules.length > 0) return Math.round((rules.filter((r) => r.enabled).length / rules.length) * 100);
  } catch { /* 404 → no rules → honest-gate */ }
  return null;
}

/** Gather the live certification inputs from an item's Cosmos state. Shared with
 *  the POST /certify enforcement so the checks can never drift apart. */
export function gatherCertInputs(item: WorkspaceItem, dqScore: number | null): CertificationInputs {
  const st = (item.state || {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const owners = arr(st.owners);
  const contract = (st.contract && typeof st.contract === 'object' ? st.contract : {}) as Record<string, unknown>;
  const schema = arr(contract.schema);
  const slo = contract.slo && typeof contract.slo === 'object' ? contract.slo as Record<string, unknown> : {};
  return {
    ownerCount: owners.length > 0 ? owners.length : (typeof st.owner === 'string' && st.owner.trim() ? 1 : 0),
    descriptionLength: (item.description || '').trim().length,
    useCaseLength: (typeof st.useCase === 'string' ? st.useCase : '').trim().length,
    glossaryCount: arr(st.glossaryLinks).length + arr(st.glossaryTerms).length,
    cdeCount: arr(st.CDEs).length,
    assetCount: arr(st.datasets).length + arr(st.dataAssets).length,
    dqScore,
    sloCount: Object.values(slo).filter((v) => v !== undefined && v !== null && v !== '').length,
    hasContractSchema: schema.length > 0,
    accessConfigured: !!st.accessPolicy || st.accessModel === 'self-serve',
    hasSampleData: !!st.sampleData || !!st.sampleDataset,
  };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiError('Unauthorized', 401, { code: 'unauthorized' });
  try {
    const item = await findItem(id);
    if (!item) return apiError('Data product not found', 404, { code: 'not_found' });

    const st = (item.state || {}) as Record<string, unknown>;
    const dqScore = await computeDqScore(session.claims.oid);
    const evaluation = evaluateCertification(gatherCertInputs(item, dqScore));
    const existing = (st.certification && typeof st.certification === 'object'
      ? st.certification as CertificationRecord
      : undefined);
    const state = deriveCertificationState(evaluation, existing);
    const endorsement = resolveEndorsement({
      certificationState: state,
      endorsed: !!st.endorsed,
      legacyCertified: !!st.certified,
    });

    return NextResponse.json({
      ok: true,
      certification: {
        state,
        score: evaluation.score,
        certifiedBy: state === 'certified' ? existing?.certifiedBy : undefined,
        certifiedAt: state === 'certified' ? existing?.certifiedAt : undefined,
      },
      endorsement,
      checks: evaluation.checks,
      validated: evaluation.validated,
      certifiable: evaluation.certifiable,
      // A reviewer must be DISTINCT from the creator (Power BI reviewer-pool
      // parity); the client disables the Certify action for the creator.
      isCreator: item.createdBy === session.claims.oid,
    });
  } catch (e: any) {
    return apiError(e?.message || 'Failed to evaluate certification', 500, { code: 'cosmos_error' });
  }
}
