/**
 * Task-flow RUN store (F11 execution) — pure Cosmos CRUD for the run documents
 * produced by the "Run flow" action. Mirrors taskflow-client.ts: pure functions,
 * no HTTP, no session — the caller authorizes, this layer just talks to Cosmos.
 *
 * Backed by the `task-flow-runs` container (PK /workspaceId, see cosmos-client).
 * One doc per invocation, holding the ordered per-step / per-item run fan-out the
 * floating driver advances. Loom-native (no Fabric dependency).
 */
import { taskFlowRunsContainer } from '@/lib/azure/cosmos-client';
import type { FlowRunDoc } from '@/lib/taskflow/step-runner';

/** Create the initial run document. */
export async function dbCreateFlowRun(doc: FlowRunDoc): Promise<FlowRunDoc> {
  const c = await taskFlowRunsContainer();
  const { resource } = await c.items.create(doc);
  return resource as FlowRunDoc;
}

/** Replace (upsert) a run document as the driver advances it. */
export async function dbSaveFlowRun(doc: FlowRunDoc): Promise<FlowRunDoc> {
  const c = await taskFlowRunsContainer();
  const { resource } = await c.item(doc.id, doc.workspaceId).replace(doc);
  return resource as FlowRunDoc;
}

/** Point-read one run document. Returns null on 404. */
export async function dbGetFlowRun(workspaceId: string, runId: string): Promise<FlowRunDoc | null> {
  const c = await taskFlowRunsContainer();
  try {
    const { resource } = await c.item(runId, workspaceId).read<FlowRunDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** List recent runs for a flow, newest first (default 20). */
export async function dbListFlowRuns(
  workspaceId: string,
  flowId: string,
  max = 20,
): Promise<FlowRunDoc[]> {
  const c = await taskFlowRunsContainer();
  const { resources } = await c.items
    .query<FlowRunDoc>(
      {
        query:
          'SELECT * FROM c WHERE c.workspaceId = @w AND c.flowId = @f ORDER BY c.startedAt DESC OFFSET 0 LIMIT @n',
        parameters: [
          { name: '@w', value: workspaceId },
          { name: '@f', value: flowId },
          { name: '@n', value: max },
        ],
      },
      { partitionKey: workspaceId },
    )
    .fetchAll();
  return resources;
}
