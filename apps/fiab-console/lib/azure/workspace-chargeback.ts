/**
 * WS-CHGBK — per-WORKSPACE chargeback ALLOCATION.
 *
 * Azure Cost Management meters spend per resource, and Loom tags each Data
 * Landing Zone resource with its governance DOMAIN (`loom-domain`) — so the
 * sibling FGC-28 report attributes REAL dollars per domain. Workspaces, however,
 * carry no direct Azure cost tag (many workspaces share a domain's DLZ
 * resources), so a workspace's spend cannot be metered directly. This module
 * ALLOCATES each domain's real spend across that domain's workspaces and is
 * HONEST that the workspace figure is allocated, not directly metered:
 *
 *   1. USAGE-weighted (basis 'usage') — when the workspaces in a domain have
 *      recorded per-execution compute (BR-COSTATTR LCU in the last window), the
 *      domain's real $ is split by each workspace's LCU share. Grounded in real
 *      consumption.
 *   2. ITEM-weighted (basis 'items') — no usage recorded yet, but the domain's
 *      workspaces hold catalog items: split by item count (a coarse proxy).
 *   3. EVEN (basis 'even') — neither signal exists: split evenly so the domain's
 *      real $ is still represented rather than silently dropped.
 *
 * The per-domain TOTALS remain the real Cost Management dollars (never inflated);
 * allocation only re-slices a domain's own real spend among its workspaces. A
 * domain with spend but ZERO workspaces mapped keeps its $ in `unallocatedCost`
 * (surfaced honestly, not hidden). No Fabric dependency — pure Azure Cost
 * Management + Cosmos (per no-fabric-dependency.md / no-vaporware.md).
 */
import type { CostTimeframe } from '@/lib/azure/cost-client';
import {
  getDomainChargeback,
  normalizeDomainTagValue,
  type DomainCostRow,
} from '@/lib/azure/domain-chargeback';
import { listAllWorkspacesAdmin } from '@/lib/clients/workspaces-client';
import { queryWorkspaceLcu } from '@/lib/azure/cost-attribution';

/** How a workspace row's allocated cost was derived (surfaced in the UI badge). */
export type AllocationBasis = 'usage' | 'items' | 'even';

/** Minimal per-workspace input for the pure allocation fold. */
export interface WorkspaceAllocInput {
  workspaceId: string;
  name: string;
  /** Normalized governance-domain id the workspace belongs to (or '(no domain)'). */
  domainId: string;
  /** Live catalog item count (item-weighted fallback signal). */
  itemCount: number;
}

export interface WorkspaceCostRow {
  workspaceId: string;
  name: string;
  domainId: string;
  domainName: string;
  /** Allocated cost (a slice of the domain's REAL Cost Management spend). */
  cost: number;
  /** This workspace's share of its domain's spend, 0–100. */
  pctOfDomain: number;
  basis: AllocationBasis;
}

export interface WorkspaceChargebackModel {
  currency: string;
  timeframe: CostTimeframe;
  rows: WorkspaceCostRow[];
  /** Sum of every allocated workspace row (≤ the domain report total). */
  totalCost: number;
  /** Real domain spend that could NOT be allocated (domains with no workspaces). */
  unallocatedCost: number;
  /** Window (days) of usage records used for usage-weighting. */
  usageWindowDays: number;
  generatedAt: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure allocation (unit-tested): re-slice each domain's real spend across its
 * workspaces by usage → item-count → even, in that preference order. No I/O.
 *
 * `domainRows`      — real per-domain $ from Cost Management (FGC-28).
 * `workspaces`      — every workspace with its domainId + item count.
 * `usageByWs`       — { workspaceId: recorded LCU } over the usage window.
 * `domainNames`     — display-name join for the domain column.
 */
export function allocateWorkspaceCosts(
  domainRows: Pick<DomainCostRow, 'domainId' | 'cost'>[],
  workspaces: WorkspaceAllocInput[],
  usageByWs: Record<string, number>,
  domainNames: Record<string, string> = {},
): { rows: WorkspaceCostRow[]; totalCost: number; unallocatedCost: number } {
  const domainCost = new Map<string, number>();
  for (const d of domainRows) domainCost.set(d.domainId, (domainCost.get(d.domainId) || 0) + (Number(d.cost) || 0));

  // Group workspaces by domain (only domains that actually have spend).
  const wsByDomain = new Map<string, WorkspaceAllocInput[]>();
  for (const w of workspaces) {
    if (!domainCost.has(w.domainId)) continue;
    const list = wsByDomain.get(w.domainId);
    if (list) list.push(w);
    else wsByDomain.set(w.domainId, [w]);
  }

  const rows: WorkspaceCostRow[] = [];
  let totalCost = 0;
  for (const [domainId, cost] of domainCost.entries()) {
    const list = wsByDomain.get(domainId);
    if (!list || list.length === 0) continue; // unallocated — accounted for below

    // Choose the weighting basis by signal availability (usage → items → even).
    const usageSum = list.reduce((s, w) => s + (Number(usageByWs[w.workspaceId]) || 0), 0);
    const itemSum = list.reduce((s, w) => s + (Number(w.itemCount) || 0), 0);
    let basis: AllocationBasis;
    let weightOf: (w: WorkspaceAllocInput) => number;
    if (usageSum > 0) { basis = 'usage'; weightOf = (w) => Number(usageByWs[w.workspaceId]) || 0; }
    else if (itemSum > 0) { basis = 'items'; weightOf = (w) => Number(w.itemCount) || 0; }
    else { basis = 'even'; weightOf = () => 1; }

    const weightTotal = basis === 'even' ? list.length : (basis === 'usage' ? usageSum : itemSum);
    for (const w of list) {
      const weight = weightOf(w);
      const share = weightTotal > 0 ? weight / weightTotal : 0;
      const allocated = round(cost * share);
      rows.push({
        workspaceId: w.workspaceId,
        name: w.name,
        domainId,
        domainName: domainNames[domainId] || domainId,
        cost: allocated,
        pctOfDomain: Math.round(share * 1000) / 10,
        basis,
      });
      totalCost += allocated;
    }
  }

  // Real domain spend with no workspace to receive it — kept honest, not hidden.
  let unallocatedCost = 0;
  for (const [domainId, cost] of domainCost.entries()) {
    if (!wsByDomain.get(domainId)?.length) unallocatedCost += cost;
  }

  rows.sort((a, b) => b.cost - a.cost);
  return { rows, totalCost: round(totalCost), unallocatedCost: round(unallocatedCost) };
}

/**
 * Build the per-workspace chargeback model: real per-domain Cost Management
 * spend (FGC-28) allocated across each domain's workspaces by recorded usage,
 * falling back to item-count / even weighting. Throws whatever
 * `getDomainChargeback` throws (MonitorError 401/403/404) so the route can
 * render the same honest Cost Management gate as the domain report.
 */
export async function getWorkspaceChargeback(opts: {
  tenantId: string;
  timeframe?: CostTimeframe;
  domainNames?: Record<string, string>;
  usageWindowDays?: number;
}): Promise<WorkspaceChargebackModel> {
  const timeframe: CostTimeframe = opts.timeframe || 'MonthToDate';
  const usageWindowDays = Math.max(1, Math.min(90, opts.usageWindowDays ?? 30));

  const domainModel = await getDomainChargeback({ timeframe, domainNames: opts.domainNames });

  // Workspace inventory + usage are best-effort — a blip degrades allocation
  // (fewer rows / item-weighting) but must not fail the report.
  const [{ workspaces }, usageByWs] = await Promise.all([
    listAllWorkspacesAdmin().catch(() => ({ workspaces: [] as Awaited<ReturnType<typeof listAllWorkspacesAdmin>>['workspaces'] })),
    queryWorkspaceLcu(opts.tenantId, usageWindowDays).catch(() => ({} as Record<string, number>)),
  ]);

  const inputs: WorkspaceAllocInput[] = workspaces.map((w) => ({
    workspaceId: w.id,
    name: w.name,
    domainId: normalizeDomainTagValue(w.domain || '') || '(no domain)',
    itemCount: w.itemCount,
  }));

  const domainNames = { ...(opts.domainNames || {}) };
  for (const d of domainModel.rows) if (!domainNames[d.domainId]) domainNames[d.domainId] = d.name;

  const { rows, totalCost, unallocatedCost } = allocateWorkspaceCosts(
    domainModel.rows,
    inputs,
    usageByWs,
    domainNames,
  );

  return {
    currency: domainModel.currency,
    timeframe,
    rows,
    totalCost,
    unallocatedCost,
    usageWindowDays,
    generatedAt: new Date().toISOString(),
  };
}
