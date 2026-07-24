/**
 * /api/governance/data-contracts  (N6 — the governance registry surface)
 *
 * GET → every ODCS 3.1 contract in the caller's registry with:
 *        • its identity + status + version (from the stored ODCS document)
 *        • its ENFORCEMENT posture (default `warn-quarantine`, opt-in
 *          `hard-reject`) — the trust boundary Pillar-2 reports on
 *        • its ingestion BINDINGS (mirroring engine / pipeline sinks /
 *          eventstream) so "what is actually enforced" is visible, not implied
 *        • its pass/fail TREND (runs, quarantines, rejected batches, row-level
 *          pass rate) computed from the bounded run history each enforcement
 *          decision appends
 *      plus a tenant roll-up for the page KPIs.
 *
 * Real backend only (no-vaporware): one single-partition Cosmos query over
 * `loom-data-contracts`. An unregistered deployment returns an empty list — the
 * page renders its guided empty state, never fabricated rows.
 *
 * FLAG0: the surface is behind the `n6-data-contracts` runtime kill-switch
 * (default-ON); OFF returns `{ ok: true, disabled: true }` so the page renders
 * an honest "turned off in Admin → Runtime flags" state instead of erroring.
 *
 * **IL5**: Cosmos-only, fully in-boundary, air-gap capable.
 */
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { listContractDocs } from '@/lib/azure/data-contract-store';
import { contractTrend, DEFAULT_ENFORCEMENT_MODE } from '@/lib/azure/data-contract-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req, { session }) => {
  if (!(await runtimeFlag('n6-data-contracts', { default: true }))) {
    return apiOk({ disabled: true, contracts: [], summary: null });
  }
  try {
    const docs = await listContractDocs(session.claims.oid);
    const contracts = docs
      .map((d) => {
        const trend = contractTrend(d);
        const object = Array.isArray(d.odcs?.schema) ? d.odcs.schema[0] : undefined;
        const lastRun = (d.runs || [])[0] || null;
        return {
          itemId: d.itemId,
          displayName: d.displayName,
          workspaceId: d.workspaceId ?? null,
          odcsId: d.odcs?.id ?? d.itemId,
          apiVersion: d.odcs?.apiVersion ?? null,
          version: d.odcs?.version ?? null,
          status: d.odcs?.status ?? 'draft',
          objectName: object?.name ?? null,
          properties: object?.properties?.length ?? 0,
          slaCount: d.odcs?.slaProperties?.length ?? 0,
          enforcementEnabled: d.enforcement?.enabled !== false,
          enforcementMode: d.enforcement?.mode ?? DEFAULT_ENFORCEMENT_MODE,
          bindings: (d.bindings || []).map((b) => ({
            id: b.id, kind: b.kind, targetItemId: b.targetItemId,
            targetItemName: b.targetItemName ?? null, dataset: b.dataset, enabled: b.enabled,
          })),
          trend,
          lastRun: lastRun
            ? {
              at: lastRun.at, source: lastRun.source, dataset: lastRun.dataset,
              decision: lastRun.decision, evaluated: lastRun.evaluated,
              rejected: lastRun.rejected, deadLetterPath: lastRun.deadLetterPath ?? null,
            }
            : null,
          updatedAt: d.updatedAt,
        };
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    const summary = {
      total: contracts.length,
      active: contracts.filter((c) => c.status === 'active').length,
      enforcing: contracts.filter((c) => c.enforcementEnabled).length,
      hardReject: contracts.filter((c) => c.enforcementMode === 'hard-reject').length,
      bound: contracts.filter((c) => c.bindings.length > 0).length,
      unbound: contracts.filter((c) => c.bindings.length === 0).length,
      rowsEvaluated: contracts.reduce((n, c) => n + c.trend.rowsEvaluated, 0),
      rowsRejected: contracts.reduce((n, c) => n + c.trend.rowsRejected, 0),
      quarantinedRuns: contracts.reduce((n, c) => n + c.trend.quarantined, 0),
      rejectedRuns: contracts.reduce((n, c) => n + c.trend.rejected, 0),
    };
    return apiOk({ disabled: false, contracts, summary, defaultMode: DEFAULT_ENFORCEMENT_MODE });
  } catch (e) {
    return apiServerError(e, 'could not read the data-contract registry', 'data_contract_registry_failed');
  }
});
