/**
 * help-receipts — the "auto-error-detect" input layer for the Help Copilot.
 *
 * Gathers the three persisted/live receipt sources a tutorial-aware Copilot
 * reasons over when a step fails:
 *
 *   1. provisioning — the per-item `state.provisioning` envelope stamped by the
 *      install engine (status / gate.reason / gate.remediation / gate.link /
 *      error). This is the single richest fix-signal: a `status:'remediation'`
 *      already carries the exact env var / role / portal step to unblock.
 *   2. audit — the last N audit-log entries for the item (action / summary /
 *      at / upn), same query the audit route uses.
 *   3. runs — live Azure Data Factory pipeline + activity run status for the
 *      item's bound pipeline. Azure-native by default (per
 *      .claude/rules/no-fabric-dependency.md): we call the ADF monitoring REST
 *      and gate honestly via adfConfigGate() when the factory env vars are
 *      unset. The Fabric pipeline run API is NEVER called here — the
 *      Azure-native path is the default and works with
 *      LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Pure data-gathering — no AOAI, no model. Returns structured receipts the
 * orchestrator tool turns into citations + a remediation recommendation. All
 * reads are best-effort: a failure in one source never throws past the caller,
 * it surfaces as an honest `error` field so the Copilot can say what it
 * couldn't read rather than fabricate.
 */

import { itemsContainer, auditLogContainer } from './cosmos-client';
import { listPipelineRuns, listActivityRuns, adfConfigGate } from './adf-client';

export type ReceiptSource = 'provisioning' | 'audit' | 'runs' | 'all';

export interface ProvisioningReceipt {
  found: boolean;
  status?: string;
  resourceId?: string;
  secondaryIds?: Record<string, string>;
  gate?: { reason?: string; remediation?: string; link?: string };
  error?: string;
  mode?: string;
  at?: string;
}

export interface AuditReceipt {
  action: string;
  summary?: string;
  at?: string;
  upn?: string;
}

export interface RunReceipt {
  runId: string;
  pipelineName: string;
  status?: string;
  message?: string;
  runStart?: string;
  runEnd?: string;
}

export interface ActivityFailureReceipt {
  activityName: string;
  status?: string;
  errorCode?: string;
  message?: string;
}

export interface RunsReceipt {
  /** False when the ADF factory env vars are unset → honest infra gate. */
  configured: boolean;
  /** Present when not configured: the exact missing env var to set. */
  gate?: { missing: string; remediation: string };
  /** The pipeline name the item is bound to (if any). */
  pipelineName?: string;
  /** Failed pipeline runs in the recent window (most-recent first). */
  failedRuns?: RunReceipt[];
  /** Failed activities of the most recent failed run, with the real ADF error. */
  failedActivities?: ActivityFailureReceipt[];
  /** Human note when there's nothing to report or the item isn't pipeline-bound. */
  note?: string;
  /** Set when the ADF REST call itself errored (surfaced honestly, not hidden). */
  error?: string;
}

export interface ReceiptsResult {
  itemId: string;
  itemType?: string;
  workspaceId?: string;
  /** True when no item with this id/type exists in Cosmos. */
  itemNotFound?: boolean;
  provisioning?: ProvisioningReceipt;
  audit?: AuditReceipt[];
  runs?: RunsReceipt;
}

interface OwnedItem {
  id: string;
  itemType?: string;
  workspaceId?: string;
  state?: Record<string, any>;
}

/** Read the Cosmos item by id (+ optional itemType). Cross-partition query —
 *  mirrors the audit route's assertOwnedItem lookup. Returns null when absent. */
async function readItem(itemId: string, itemType?: string): Promise<OwnedItem | null> {
  const items = await itemsContainer();
  const query = itemType
    ? {
        query: 'SELECT * FROM c WHERE c.id = @i AND c.itemType = @t',
        parameters: [
          { name: '@i', value: itemId },
          { name: '@t', value: itemType },
        ],
      }
    : {
        query: 'SELECT * FROM c WHERE c.id = @i',
        parameters: [{ name: '@i', value: itemId }],
      };
  const { resources } = await items.items.query(query).fetchAll();
  return (resources[0] as OwnedItem) || null;
}

function toProvisioningReceipt(item: OwnedItem | null): ProvisioningReceipt {
  const p = item?.state?.provisioning as Record<string, any> | undefined;
  if (!p) return { found: false };
  return {
    found: true,
    status: p.status,
    resourceId: p.resourceId,
    secondaryIds: p.secondaryIds,
    gate: p.gate
      ? { reason: p.gate.reason, remediation: p.gate.remediation, link: p.gate.link }
      : undefined,
    error: p.error,
    mode: p.mode,
    at: p.at,
  };
}

async function readAudit(itemId: string, limit = 8): Promise<AuditReceipt[]> {
  const c = await auditLogContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT TOP @n c.action, c.summary, c.at, c.upn FROM c WHERE c.itemId = @i ORDER BY c._ts DESC',
      parameters: [
        { name: '@n', value: limit },
        { name: '@i', value: itemId },
      ],
    })
    .fetchAll();
  return (resources as AuditReceipt[]) || [];
}

/** The pipeline name an item is bound to, from either the provisioning receipt
 *  secondaryIds or the editor binding state. Undefined when not pipeline-bound. */
function boundPipelineName(item: OwnedItem | null): string | undefined {
  const sec = (item?.state?.provisioning?.secondaryIds || {}) as Record<string, string>;
  return sec.pipelineName || (item?.state?.pipelineName as string | undefined);
}

/**
 * Azure-native run receipts. Honest-gates on the ADF factory env vars; never
 * touches the Fabric pipeline run API. When the item is bound to a pipeline we
 * filter to it; otherwise we surface the most-recent failed runs factory-wide.
 */
async function readRuns(item: OwnedItem | null): Promise<RunsReceipt> {
  const gate = adfConfigGate();
  if (gate) {
    return {
      configured: false,
      gate: {
        missing: gate.missing,
        remediation: `Set ${gate.missing} in the Loom Console app settings (platform/fiab/bicep/modules/admin-plane/main.bicep) so run history can be read from Azure Data Factory.`,
      },
    };
  }
  const pipelineName = boundPipelineName(item);
  try {
    const runs = await listPipelineRuns(pipelineName, 7);
    const failed = runs.filter((r) => r.status === 'Failed');
    if (failed.length === 0) {
      return {
        configured: true,
        pipelineName,
        failedRuns: [],
        note: pipelineName
          ? `No failed runs for pipeline "${pipelineName}" in the last 7 days.`
          : 'No failed pipeline runs in the last 7 days.',
      };
    }
    const failedRuns: RunReceipt[] = failed.slice(0, 5).map((r) => ({
      runId: r.runId,
      pipelineName: r.pipelineName,
      status: r.status,
      message: r.message,
      runStart: r.runStart,
      runEnd: r.runEnd,
    }));
    // Drill into the most-recent failed run for the real per-activity error.
    let failedActivities: ActivityFailureReceipt[] | undefined;
    try {
      const acts = await listActivityRuns(failed[0].runId, 7);
      failedActivities = acts
        .filter((a) => a.status === 'Failed')
        .map((a) => ({
          activityName: a.activityName,
          status: a.status,
          errorCode: a.error?.errorCode,
          message: a.error?.message,
        }));
    } catch {
      /* activity drill-down is best-effort */
    }
    return { configured: true, pipelineName, failedRuns, failedActivities };
  } catch (e: any) {
    return { configured: true, pipelineName, error: e?.message || String(e) };
  }
}

/**
 * Gather the requested receipt source(s) for an item. `source==='all'` returns
 * every source. Each source is independently best-effort.
 */
export async function gatherReceipts(opts: {
  itemId: string;
  itemType?: string;
  source?: ReceiptSource;
}): Promise<ReceiptsResult> {
  const source = opts.source || 'all';
  const out: ReceiptsResult = { itemId: opts.itemId, itemType: opts.itemType };

  let item: OwnedItem | null = null;
  try {
    item = await readItem(opts.itemId, opts.itemType);
  } catch {
    item = null;
  }
  if (!item) out.itemNotFound = true;
  out.workspaceId = item?.workspaceId;

  if (source === 'all' || source === 'provisioning') {
    out.provisioning = toProvisioningReceipt(item);
  }
  if (source === 'all' || source === 'audit') {
    try {
      out.audit = await readAudit(opts.itemId);
    } catch {
      out.audit = [];
    }
  }
  if (source === 'all' || source === 'runs') {
    out.runs = await readRuns(item);
  }
  return out;
}
