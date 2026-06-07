/**
 * Data Science experience home — landing aggregator.
 *
 * GET /api/items/data-science/home
 *   → 401 { ok:false, error:'unauthenticated' }
 *   → 200 {
 *       ok: true,
 *       notebooks:    DsNotebook[]    // ≤5, Cosmos workspace-items (Azure-native)
 *       experiments:  DsExperiment[]  // ≤5, real AML ARM /jobs
 *       models:       DsModel[]       // ≤5, real AML ARM /models
 *       amlConfigured: boolean
 *       amlHint?:      string         // exact env/role guidance when AML is absent
 *       counts: { notebooks, experiments, models }
 *     }
 *
 * Backends (Azure-native DEFAULT — no Fabric dependency, see
 * .claude/rules/no-fabric-dependency.md):
 *   - notebooks   → Cosmos `items` container (cross-partition over the user's
 *                   own workspaces), itemType ∈ {notebook, synapse-notebook,
 *                   databricks-notebook}
 *   - experiments → Azure Machine Learning ARM jobs (foundry-client.listJobs)
 *   - models      → Azure Machine Learning ARM model registry
 *                   (foundry-client.listModels)
 *
 * The three reads fan out with Promise.allSettled so a missing/denied AML
 * workspace never blocks the notebooks list, and vice-versa. AML absence is an
 * HONEST Azure infra-gate (precise env var + role), never a Fabric gate.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { listJobs, listModels, FoundryError } from '@/lib/azure/foundry-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOTEBOOK_TYPES = ['notebook', 'synapse-notebook', 'databricks-notebook'];
const TOP = 5;

const AML_HINT =
  'Connect an Azure Machine Learning workspace: set LOOM_SUBSCRIPTION_ID, ' +
  'LOOM_FOUNDRY_RG and LOOM_FOUNDRY_NAME on the Console app, then grant the ' +
  'Console UAMI the "AzureML Data Scientist" role on that workspace. Until ' +
  'then, experiments and model registrations read empty; notebooks are ' +
  'unaffected (they live in Cosmos).';

export interface DsNotebook {
  id: string;
  displayName: string;
  itemType: string;
  workspaceId: string;
  updatedAt?: string;
}

export interface DsExperiment {
  name: string;
  displayName?: string;
  experimentName?: string;
  status?: string;
  jobType?: string;
  startTimeUtc?: string;
}

export interface DsModel {
  name: string;
  description?: string;
  latestVersion?: string;
  createdAt?: string;
  lastModifiedAt?: string;
}

/** Recent notebooks across the signed-in user's own workspaces. */
async function recentNotebooks(tenantId: string): Promise<DsNotebook[]> {
  const wsc = await workspacesContainer();
  const { resources: workspaces } = await wsc.items
    .query<Workspace>({
      query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId })
    .fetchAll();
  const wsIds = workspaces.map((w) => w.id);
  if (wsIds.length === 0) return [];

  const wsParams = wsIds.map((id, i) => ({ name: `@w${i}`, value: id }));
  const wsExpr = wsParams.map((p) => p.name).join(',');
  const typeParams = NOTEBOOK_TYPES.map((t, i) => ({ name: `@t${i}`, value: t }));
  const typeExpr = typeParams.map((p) => p.name).join(',');

  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query:
        `SELECT TOP ${TOP} c.id, c.displayName, c.itemType, c.workspaceId, c.updatedAt ` +
        `FROM c WHERE c.workspaceId IN (${wsExpr}) AND c.itemType IN (${typeExpr}) ` +
        `ORDER BY c.updatedAt DESC`,
      parameters: [...wsParams, ...typeParams],
    })
    .fetchAll();

  return resources.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    itemType: r.itemType,
    workspaceId: r.workspaceId,
    updatedAt: r.updatedAt,
  }));
}

/** Most recent AML jobs (experiment runs), newest first. */
async function recentExperiments(): Promise<DsExperiment[]> {
  const jobs = await listJobs();
  return [...jobs]
    .sort((a, b) => (b.startTimeUtc || '').localeCompare(a.startTimeUtc || ''))
    .slice(0, TOP)
    .map((j) => ({
      name: j.name,
      displayName: j.displayName,
      experimentName: j.experimentName,
      status: j.status,
      jobType: j.jobType,
      startTimeUtc: j.startTimeUtc,
    }));
}

/** Most recent AML registered models, newest registration first. */
async function recentModels(): Promise<DsModel[]> {
  const models = await listModels();
  return [...models]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, TOP)
    .map((m) => ({
      name: m.name,
      description: m.description,
      latestVersion: m.latestVersion,
      createdAt: m.createdAt,
      lastModifiedAt: m.lastModifiedAt,
    }));
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const amlConfigured = Boolean(process.env.LOOM_SUBSCRIPTION_ID);

  const [nbRes, expRes, mdlRes] = await Promise.allSettled([
    recentNotebooks(s.claims.oid),
    amlConfigured ? recentExperiments() : Promise.resolve([] as DsExperiment[]),
    amlConfigured ? recentModels() : Promise.resolve([] as DsModel[]),
  ]);

  const notebooks = nbRes.status === 'fulfilled' ? nbRes.value : [];
  const experiments = expRes.status === 'fulfilled' ? expRes.value : [];
  const models = mdlRes.status === 'fulfilled' ? mdlRes.value : [];

  // Surface a precise reason when AML reads were attempted but failed (denied
  // role / wrong workspace name) — distinct from "AML not wired at all".
  let amlHint: string | undefined;
  if (!amlConfigured) {
    amlHint = AML_HINT;
  } else {
    const amlError = [expRes, mdlRes].find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (amlError) {
      const reason = amlError.reason;
      if (reason instanceof FoundryError) {
        amlHint =
          `Azure Machine Learning returned ${reason.status}. Confirm ` +
          `LOOM_FOUNDRY_RG / LOOM_FOUNDRY_NAME point at a real workspace and ` +
          `that the Console UAMI has the "AzureML Data Scientist" role on it.`;
      } else {
        amlHint = reason instanceof Error ? reason.message : String(reason);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    amlConfigured: amlConfigured && !amlHint,
    amlHint,
    notebooks,
    experiments,
    models,
    counts: {
      notebooks: notebooks.length,
      experiments: experiments.length,
      models: models.length,
    },
  });
}
