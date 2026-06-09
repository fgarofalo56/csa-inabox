/**
 * Phase 2 — Install-time provisioning engine.
 *
 * Orchestrates the per-item-type provisioners that turn a Cosmos workspace
 * item (created by the Phase-1 install path) into REAL Azure / Fabric /
 * ADX / Synapse / AI Search resources.
 *
 * Every step:
 *   1. Dispatches to the right provisioner based on `itemType`.
 *   2. Wraps the call in try-catch with explicit retry + remediation
 *      semantics — known remediation gates surface to the wizard with
 *      the exact admin action; unexpected errors surface verbatim.
 *   3. Never throws — always returns a partial-install report so the
 *      wizard can choose Skip + continue, Retry, or Cancel per row.
 *
 * Provisioning is opt-in via the wizard's "Deploy artifacts to live
 * services" checkbox (default ON).  When OFF, every item gets
 * status:'skipped' with no Azure side-effect.
 *
 * Per .claude/rules/no-vaporware.md — every provisioner here calls real
 * REST.  Status:'remediation' is the ONLY surface that defers work back
 * to the user, and it carries the precise env var / role / portal step.
 */
import type { Provisioner, ProvisionerInput, ProvisionResult, ProvisionTarget, DeploymentMode } from './provisioners/types';
import { notebookProvisioner } from './provisioners/notebook';
import { lakehouseProvisioner } from './provisioners/lakehouse';
import { warehouseProvisioner } from './provisioners/warehouse';
import { kqlDatabaseProvisioner } from './provisioners/kql-db';
import { aiSearchProvisioner } from './provisioners/ai-search';
import { semanticModelProvisioner } from './provisioners/semantic-model';
import { activatorProvisioner } from './provisioners/activator';
import { dataPipelineProvisioner } from './provisioners/data-pipeline';
import { eventstreamProvisioner } from './provisioners/eventstream';
import { kqlDashboardProvisioner } from './provisioners/kql-dashboard';
import { mirroredDatabaseProvisioner } from './provisioners/mirrored-database';
import { databricksNotebookProvisioner } from './provisioners/databricks-notebook';
import { reportProvisioner } from './provisioners/report';
import { dataProductProvisioner } from './provisioners/data-product';
import { mlModelProvisioner } from './provisioners/ml-model';
import { promptFlowProvisioner } from './provisioners/prompt-flow';
import { evaluationProvisioner } from './provisioners/evaluation';
import { logicAppProvisioner } from './provisioners/logic-app';
import { synapsePipelineProvisioner } from './provisioners/synapse-pipeline';
import { adfPipelineProvisioner } from './provisioners/adf-pipeline';
import { databricksJobProvisioner } from './provisioners/databricks-job';
import { synapseSqlPoolProvisioner } from './provisioners/synapse-serverless-sql-pool';
import { workspaceMonitorProvisioner } from './provisioners/workspace-monitor';
import { ITEM_PAIRING_RULES } from '@/lib/items/registry';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { getPoolState, resumePool } from '@/lib/azure/synapse-pool-arm';

/** Mapping from editor item type → provisioner.  Item types not listed
 * here are Cosmos-only (no Phase-2 backend side-effect). Exported so the
 * deployment-pipeline selective-deploy route can re-run the same real
 * provisioner per item when promoting content between stages. */
export const PROVISIONERS: Record<string, Provisioner> = {
  'notebook': notebookProvisioner,
  'lakehouse': lakehouseProvisioner,
  'warehouse': warehouseProvisioner,
  'kql-database': kqlDatabaseProvisioner,
  'kql-queryset': kqlDatabaseProvisioner, // queryset rides on top of the parent DB
  'eventhouse': kqlDatabaseProvisioner,   // eventhouse = kql cluster, same surface for install
  'workspace-monitor': workspaceMonitorProvisioner, // read-only ADX usage/perf DB fed by Azure Monitor diag-settings export (no Fabric)
  'kql-dashboard': kqlDashboardProvisioner, // Real-Time Dashboard item (Fabric kqlDashboards)
  'ai-search-index': aiSearchProvisioner,
  'semantic-model': semanticModelProvisioner,
  'activator': activatorProvisioner,
  'data-pipeline': dataPipelineProvisioner,
  'eventstream': eventstreamProvisioner,
  'mirrored-database': mirroredDatabaseProvisioner, // replicate legacy SQL → Bronze (Fabric Mirroring)
  'databricks-notebook': databricksNotebookProvisioner, // import + run the Silver/Gold medallion notebooks
  'report': reportProvisioner, // create the PBIR report bound byConnection to the semantic model
  'data-product': dataProductProvisioner, // create Purview Unified Catalog data products + glossary terms
  'ml-model': mlModelProvisioner, // import + run the bundle's training script → trains & registers the model in MLflow/UC
  'prompt-flow': promptFlowProvisioner, // create the grounded RAG flow in the AI Foundry project (AML data-plane)
  'evaluation': evaluationProvisioner, // submit a real AI Foundry evaluation run (no hard-coded scores)
  'logic-app': logicAppProvisioner, // PUT Microsoft.Logic/workflows + fire manual trigger run + poll run history (real ARM)
  'synapse-pipeline': synapsePipelineProvisioner, // PUT Synapse Studio pipeline + createRun + poll status (real Synapse dev REST)
  'adf-pipeline': adfPipelineProvisioner, // PUT ADF pipeline (ARM) + createRun + poll status (real ARM)
  'databricks-job': databricksJobProvisioner, // create/reset multi-task job w/ shared cluster + run-now + poll (real Jobs 2.1)
  'synapse-serverless-sql-pool': synapseSqlPoolProvisioner, // lakehouse SQL analytics endpoint: external data source over the lake abfss root + SELECT 1 (real TDS)
};

/** Item types that have a Phase-2 provisioner — exposed for the wizard
 * UI so it can list which items will hit Azure vs which are Cosmos-only. */
export function provisionerSupportsItemType(itemType: string): boolean {
  return itemType in PROVISIONERS;
}

export function listSupportedItemTypes(): string[] {
  return Object.keys(PROVISIONERS);
}

export interface ProvisionStep {
  itemType: string;
  displayName: string;
  cosmosItemId: string;
  result: ProvisionResult;
}

export interface ProvisionReport {
  /** Aggregate status — 'all-created', 'partial', 'all-remediation', 'skipped'. */
  outcome: 'all-created' | 'partial' | 'all-remediation' | 'skipped';
  /** Per-item results. */
  steps: ProvisionStep[];
  /** Deployment mode the install was run under. */
  mode: DeploymentMode;
  /** Effective target descriptor (post-resolution). */
  target: ProvisionTarget;
}

/** Resolve the effective ProvisionTarget for an install.  In shared mode
 * (the default) this pulls from env vars; in dedicated mode it expects
 * the wizard to have pre-provisioned the resources via bicep and passes
 * them in via the body.target overrides. */
export function resolveTarget(mode: DeploymentMode, overrides?: Partial<ProvisionTarget>): ProvisionTarget {
  const base: ProvisionTarget = {
    mode,
    fabricWorkspaceId: process.env.LOOM_DEFAULT_FABRIC_WORKSPACE,
    kustoClusterUri: process.env.LOOM_KUSTO_CLUSTER_URI,
    kustoDatabase: process.env.LOOM_KUSTO_DEFAULT_DB,
    synapseWorkspace: process.env.LOOM_SYNAPSE_WORKSPACE,
    warehouseServer: process.env.LOOM_WAREHOUSE_SERVER,
    warehouseDatabase: process.env.LOOM_WAREHOUSE_DB,
    aiSearchService: process.env.LOOM_AI_SEARCH_SERVICE,
    adlsAccount: process.env.LOOM_ADLS_ACCOUNT,
    adlsContainer: process.env.LOOM_ADLS_CONTAINER,
    // Per-item backends DEFAULT to Azure-native (no-fabric-dependency.md).
    // Fabric is opt-in only via LOOM_<ITEM>_BACKEND=fabric.
    pipelineBackend: (process.env.LOOM_PIPELINE_BACKEND as ProvisionTarget['pipelineBackend']) || 'synapse',
    eventBackend: (process.env.LOOM_EVENT_BACKEND as ProvisionTarget['eventBackend']) || 'eventhubs',
    activatorBackend: (process.env.LOOM_ACTIVATOR_BACKEND as ProvisionTarget['activatorBackend']) || 'azure-monitor',
    dashboardBackend: (process.env.LOOM_DASHBOARD_BACKEND as ProvisionTarget['dashboardBackend']) || 'adx',
    mirrorBackend: (process.env.LOOM_MIRROR_BACKEND as ProvisionTarget['mirrorBackend']) || 'adf-cdc',
    lakehouseBackend: (process.env.LOOM_LAKEHOUSE_BACKEND as ProvisionTarget['lakehouseBackend']) || 'adls',
    semanticBackend: (process.env.LOOM_SEMANTIC_BACKEND as ProvisionTarget['semanticBackend']) || 'loom-native',
    eventhubsNamespace: process.env.LOOM_EVENTHUB_NAMESPACE,
  };
  return { ...base, ...(overrides || {}) };
}

/** Run a single provisioner with an explicit one-shot retry on transient
 * failures (429, 502, 503, 504). */
async function runWithRetry(p: Provisioner, input: ProvisionerInput): Promise<ProvisionResult> {
  const first = await safeRun(p, input);
  if (first.status === 'failed' && first.error && /\b(429|502|503|504|timeout|ECONNRESET)\b/i.test(first.error)) {
    // brief backoff then retry once.
    await new Promise((r) => setTimeout(r, 1500));
    const second = await safeRun(p, input);
    if (second.status !== 'failed') return second;
    return { ...second, steps: [...(first.steps || []), '— retry —', ...(second.steps || [])] };
  }
  return first;
}

async function safeRun(p: Provisioner, input: ProvisionerInput): Promise<ProvisionResult> {
  try {
    return await p(input);
  } catch (e: any) {
    return { status: 'failed', error: e?.message || String(e), steps: ['unexpected exception'] };
  }
}

export interface RunProvisioningOpts {
  /** When true (default), call provisioners; when false, return all-skipped. */
  deploy: boolean;
  mode: DeploymentMode;
  /** Per-tenant target overrides — typically empty in shared mode. */
  targetOverrides?: Partial<ProvisionTarget>;
}

/** Max number of items provisioned concurrently. Bounds the fan-out so a
 * large app (10-12 items) finishes well under the gateway timeout without
 * hammering the Fabric/ARM/AI-Search control planes (which throttle at 429).
 * Each item still runs its own one-shot transient retry. */
const PROVISION_CONCURRENCY = 6;

/** Provision a single installed item. Pure per-item logic extracted from the
 * old serial loop so it can run inside a bounded-concurrency pool. Never
 * throws (runWithRetry → safeRun guarantee), so a rejected slot can never
 * sink the whole batch. The per-item provisioner contract and the returned
 * ProvisionStep shape are unchanged. */
async function provisionOne(
  it: { itemType: string; id?: string; displayName: string; content?: unknown },
  session: ProvisionerInput['session'],
  appId: string,
  workspaceId: string,
  target: ProvisionTarget,
): Promise<ProvisionStep> {
  const p = PROVISIONERS[it.itemType];
  if (!p) {
    return {
      itemType: it.itemType,
      displayName: it.displayName,
      cosmosItemId: it.id || '',
      result: { status: 'skipped', steps: [`No Phase-2 provisioner for itemType '${it.itemType}' (Cosmos-only).`] },
    };
  }
  if (!it.id) {
    return {
      itemType: it.itemType,
      displayName: it.displayName,
      cosmosItemId: '',
      result: { status: 'failed', error: 'Cosmos item not created; cannot provision.', steps: [] },
    };
  }
  const input: ProvisionerInput = {
    session,
    target,
    cosmosItemId: it.id,
    workspaceId,
    displayName: it.displayName,
    content: it.content || {},
    appId,
  };
  const result = await runWithRetry(p, input);
  return { itemType: it.itemType, displayName: it.displayName, cosmosItemId: it.id, result };
}

/**
 * Pre-warm the Synapse dedicated SQL pool at the very START of an install that
 * includes a warehouse on the dedicated backend.
 *
 * A dedicated pool auto-pauses on idle and refuses TDS while offline, so the
 * warehouse provisioner otherwise has to fire the resume only when ITS step
 * runs — and a cold resume takes 1-3 min (far past the gateway window), forcing
 * a "Retry" round-trip on essentially every install. Firing the resume here,
 * before the batched fan-out, starts the resume clock as early as possible so
 * the pool is warming through the lakehouse / KQL / notebook / semantic-model
 * steps. In the common case it's Online (or nearly) by the time the warehouse
 * step runs, so the DDL + seed lands inline with no Retry. Best-effort and
 * fully non-blocking: any failure (no ARM role, missing env) is swallowed — the
 * warehouse provisioner still handles the resume + honest gate on its own.
 */
async function prewarmDedicatedPool(
  installed: Array<{ itemType: string }>,
  steps: string[],
): Promise<void> {
  const backend = process.env.LOOM_WAREHOUSE_BACKEND || 'synapse-dedicated';
  if (backend !== 'synapse-dedicated') return;
  if (!installed.some((it) => it.itemType === 'warehouse')) return;
  try {
    const { state } = await getPoolState();
    if (state === 'Online') {
      steps.push('Pre-warm: dedicated SQL pool already Online.');
      return;
    }
    if (state === 'Paused' || state === 'Pausing' || state === 'Unknown') {
      await resumePool();
      steps.push(`Pre-warm: dedicated SQL pool was ${state}; fired ARM resume at install start (non-blocking).`);
    } else {
      steps.push(`Pre-warm: dedicated SQL pool already ${state}; resume in progress.`);
    }
  } catch (e: any) {
    steps.push(`Pre-warm skipped (${e?.message || String(e)}); warehouse step will handle resume.`);
  }
}

/**
 * Post-provision pairing pass. For every step that provisioned successfully,
 * consult ITEM_PAIRING_RULES and auto-create + provision each declared sibling.
 * Each sibling is a real Cosmos item (createOwnedItem) whose state.content is
 * derived from the parent's result, then run through the sibling's provisioner.
 * Mutates `out` (appends sibling steps) and the parent step's `steps` log.
 * Never throws — pairing is best-effort and must not sink the install.
 */
async function runPairingPass(
  out: ProvisionStep[],
  installed: Array<{ itemType: string; id?: string; displayName: string; content?: unknown }>,
  session: ProvisionerInput['session'],
  appId: string,
  workspaceId: string,
  target: ProvisionTarget,
): Promise<void> {
  // Snapshot — we append to `out` inside the loop, so iterate over a copy of the
  // primary steps only (siblings are never themselves re-paired).
  const primary = [...out];
  for (const step of primary) {
    if (step.result.status !== 'created' && step.result.status !== 'exists') continue;
    const rules = ITEM_PAIRING_RULES[step.itemType];
    if (!rules || rules.length === 0) continue;

    const srcItem = installed.find((it) => it.id === step.cosmosItemId);
    if (!srcItem) continue;
    const parentInput: ProvisionerInput = {
      session,
      target,
      cosmosItemId: step.cosmosItemId,
      workspaceId,
      displayName: step.displayName,
      content: srcItem.content || {},
      appId,
    };

    for (const rule of rules) {
      const pairedProvisioner = PROVISIONERS[rule.pairedType];
      if (!pairedProvisioner) {
        step.result.steps = [
          ...(step.result.steps || []),
          `Pairing skipped: no provisioner registered for '${rule.pairedType}'.`,
        ];
        continue;
      }
      const pairedContent = rule.deriveContent(step.result, parentInput);
      if (pairedContent === null) continue; // rule opted out (no data to pair on)
      const pairedName = rule.deriveName?.(parentInput) ?? `${step.displayName} SQL Analytics`;

      // 1. Create the paired Cosmos item (state.content mirrors bundle items).
      let pairedItemId: string | undefined;
      try {
        const created = await createOwnedItem(session, rule.pairedType, {
          workspaceId,
          displayName: pairedName,
          state: { content: pairedContent },
        });
        if (created.ok) {
          pairedItemId = created.item.id;
          step.result.steps = [
            ...(step.result.steps || []),
            `Auto-created paired ${rule.pairedType} item "${pairedName}" (id ${pairedItemId}).`,
          ];
        } else {
          step.result.steps = [
            ...(step.result.steps || []),
            `Paired ${rule.pairedType} item creation failed (${created.status}): ${created.error}`,
          ];
          continue;
        }
      } catch (e: any) {
        step.result.steps = [
          ...(step.result.steps || []),
          `Paired ${rule.pairedType} item creation threw: ${e?.message || String(e)}`,
        ];
        continue;
      }

      // 2. Provision the paired item immediately (real backend, one-shot retry).
      const pairedInput: ProvisionerInput = {
        session,
        target,
        cosmosItemId: pairedItemId!,
        workspaceId,
        displayName: pairedName,
        content: pairedContent,
        appId,
      };
      const pairedResult = await runWithRetry(pairedProvisioner, pairedInput);
      out.push({
        itemType: rule.pairedType,
        displayName: pairedName,
        cosmosItemId: pairedItemId!,
        result: pairedResult,
      });
    }
  }
}

/** Run provisioning across an installed app's Cosmos items.  Each
 * `installed[i]` is an item just created by createOwnedItem(). */
export async function runProvisioning(
  session: ProvisionerInput['session'],
  appId: string,
  workspaceId: string,
  installed: Array<{ itemType: string; id?: string; displayName: string; content?: unknown }>,
  opts: RunProvisioningOpts,
): Promise<ProvisionReport> {
  const target = resolveTarget(opts.mode, opts.targetOverrides);

  if (!opts.deploy) {
    return {
      outcome: 'skipped',
      mode: opts.mode,
      target,
      steps: installed.map((it) => ({
        itemType: it.itemType,
        displayName: it.displayName,
        cosmosItemId: it.id || '',
        result: { status: 'skipped', steps: ['User opted out of live-service provisioning.'] },
      })),
    };
  }

  // Pre-warm the dedicated SQL pool BEFORE the fan-out so a warehouse install
  // doesn't pay a cold 1-3 min resume + Retry round-trip on its own step.
  const prewarmSteps: string[] = [];
  await prewarmDedicatedPool(installed, prewarmSteps);

  // Provision items CONCURRENTLY in bounded batches. Serial provisioning of a
  // 10-12 item app blew the ~30s gateway timeout (504); fanning out
  // PROVISION_CONCURRENCY at a time cuts wall-clock to roughly the slowest
  // item per batch. Results are written back by their original index so the
  // returned `steps` order is deterministic and identical to the input order
  // regardless of which item finishes first.
  const out: ProvisionStep[] = new Array(installed.length);
  for (let start = 0; start < installed.length; start += PROVISION_CONCURRENCY) {
    const batch = installed.slice(start, start + PROVISION_CONCURRENCY);
    const settled = await Promise.all(
      batch.map((it) => provisionOne(it, session, appId, workspaceId, target)),
    );
    settled.forEach((step, j) => {
      out[start + j] = step;
    });
  }

  // Post-provision PAIRING pass — after every primary item is provisioned,
  // auto-create + provision any 1:1 paired siblings declared in the item
  // pairing registry (e.g. each lakehouse gets a synapse-serverless-sql-pool so
  // F3/F14 share one Serverless SQL endpoint). Runs only for items that
  // actually provisioned (created/exists); each paired item is a REAL Cosmos
  // item + a REAL provisioner call. Best-effort: a pairing failure is logged on
  // the parent step and never sinks the install.
  await runPairingPass(out, installed, session, appId, workspaceId, target);

  // Surface the pre-warm log on the warehouse step so the report explains the
  // early resume that ran before this item's own provisioner.
  if (prewarmSteps.length > 0) {
    const wh = out.find((s) => s.itemType === 'warehouse');
    if (wh) wh.result.steps = [...prewarmSteps, ...(wh.result.steps || [])];
  }

  // Aggregate outcome.
  const statuses = out.map((s) => s.result.status);
  const hasCreated = statuses.some((s) => s === 'created' || s === 'exists');
  const hasRemediation = statuses.some((s) => s === 'remediation');
  const hasFailed = statuses.some((s) => s === 'failed');
  let outcome: ProvisionReport['outcome'] = 'partial';
  if (statuses.every((s) => s === 'skipped')) outcome = 'skipped';
  else if (!hasFailed && !hasRemediation) outcome = 'all-created';
  else if (!hasCreated && hasRemediation) outcome = 'all-remediation';

  return { outcome, mode: opts.mode, target, steps: out };
}
