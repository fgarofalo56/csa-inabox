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

/** Mapping from editor item type → provisioner.  Item types not listed
 * here are Cosmos-only (no Phase-2 backend side-effect). */
const PROVISIONERS: Record<string, Provisioner> = {
  'notebook': notebookProvisioner,
  'lakehouse': lakehouseProvisioner,
  'warehouse': warehouseProvisioner,
  'kql-database': kqlDatabaseProvisioner,
  'kql-queryset': kqlDatabaseProvisioner, // queryset rides on top of the parent DB
  'eventhouse': kqlDatabaseProvisioner,   // eventhouse = kql cluster, same surface for install
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

  const out: ProvisionStep[] = [];
  for (const it of installed) {
    const p = PROVISIONERS[it.itemType];
    if (!p) {
      out.push({
        itemType: it.itemType,
        displayName: it.displayName,
        cosmosItemId: it.id || '',
        result: { status: 'skipped', steps: [`No Phase-2 provisioner for itemType '${it.itemType}' (Cosmos-only).`] },
      });
      continue;
    }
    if (!it.id) {
      out.push({
        itemType: it.itemType,
        displayName: it.displayName,
        cosmosItemId: '',
        result: { status: 'failed', error: 'Cosmos item not created; cannot provision.', steps: [] },
      });
      continue;
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
    out.push({ itemType: it.itemType, displayName: it.displayName, cosmosItemId: it.id, result });
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
