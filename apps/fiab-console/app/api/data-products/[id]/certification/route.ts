/**
 * GET /api/data-products/[id]/certification  (DP-5)
 *
 * The certification score for a data product: every automated check evaluated
 * against real Cosmos state, plus the derived certification state (draft →
 * validated → certified) and any recorded sign-off. Read-only + not
 * ownership-gated (the trust signal is discoverable), so the catalog card and
 * marketplace listing can show the same badge the owner sees.
 *
 * The DQ input is READ from the last persisted measurement
 * (`state.dqMeasurement`), never re-executed here: executing the tenant's rules
 * is one live ADX round-trip PER RULE, and this route is reachable by any
 * authenticated user for any product id — measuring on read turned a Cosmos
 * point-read into unbounded serial KQL fan-out (#3493). Measurement happens on
 * the owner-gated writes (POST /certify, action `certify` / `revoke` /
 * `measure-dq`, and the Observability rerun), which persist the result. The
 * enforcement path re-measures live before any sign-off, so a certification is
 * never granted on a stale number — only the DISPLAY is read-through, and it
 * reports `measuredAt` + `stale` rather than implying "now".
 *
 * Azure-native: Cosmos for the item + the persisted measurement. No Fabric /
 * Power BI dependency (.claude/rules/no-fabric-dependency.md); real data, no
 * mocks (.claude/rules/no-vaporware.md) — an unmeasured DQ score honest-gates
 * the `dq` check rather than fabricating a pass.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  evaluateCertification, deriveCertificationState, resolveEndorsement,
  type CertificationInputs, type CertificationRecord,
} from '@/lib/dataproducts/certification';
import { readCertificationDq } from '@/lib/dataproducts/certification-dq';
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
    // PURE read of the last persisted measurement — no rule execution on a GET.
    const { dqScore, dqGate, dqGateId, dqMissing, dqResult, measuredAt, stale } = readCertificationDq(item);
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
      // The MEASURED data-quality input behind the `dq` check: the passing-rule
      // ratio, the per-rule breakdown, WHEN it was measured — and, when nothing
      // could be measured, the exact reason the check is gated rather than
      // passed (plus the registry gate id so the UI renders a real Fix-it).
      dq: {
        score: dqScore,
        gate: dqGate,
        gateId: dqGateId,
        missing: dqMissing,
        ruleCount: dqResult?.ruleCount ?? 0,
        passingRules: dqResult?.passingRules ?? 0,
        breakdown: dqResult?.breakdown ?? [],
        measuredAt,
        stale,
      },
      // A reviewer must be DISTINCT from the creator (Power BI reviewer-pool
      // parity); the client disables the Certify action for the creator.
      isCreator: item.createdBy === session.claims.oid,
    });
  } catch (e: any) {
    return apiError(e?.message || 'Failed to evaluate certification', 500, { code: 'cosmos_error' });
  }
}
