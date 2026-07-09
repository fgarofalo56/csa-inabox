/**
 * adf-resource-ops.ts — shared factory-object delete/remove helpers.
 *
 * Destructive factory operations (delete a pipeline, remove a dataset / linked
 * service / trigger / integration runtime / …) are consumed from TWO surfaces:
 *   1. the Factory Resources tree right-click context menu, and
 *   2. the Pipeline Copilot + cross-item orchestrator delete/remove tools.
 *
 * Both must hit the SAME real REST calls, so the dispatch table lives here in
 * one place — no mock, no `return`-nothing stub (no-vaporware.md), Azure-native
 * by default (ADF ARM REST / Synapse dev REST, never a Fabric workspace —
 * no-fabric-dependency.md). The two branches that add each consumer can land
 * independently and converge on this module without colliding.
 *
 * Every deleter is the real `delete*` export already shipped in adf-client /
 * synapse-dev-client (each already backing a live `/api/adf/*` DELETE route the
 * tree uses). This module adds only: a normalized object-kind vocabulary, a
 * per-backend capability map, an honest config gate, and a single
 * `deleteFactoryObject()` dispatch — the primitives the Copilot delete tools
 * and the context menu both call.
 */

import * as adf from './adf-client';
import * as synapseDev from './synapse-dev-client';

export type FactoryBackend = 'adf' | 'synapse';

/** The factory object kinds a user can remove from a pipeline factory. */
export type FactoryObjectKind =
  | 'pipeline'
  | 'dataset'
  | 'dataflow'
  | 'trigger'
  | 'linked-service'
  | 'integration-runtime'
  | 'cdc'
  | 'managed-private-endpoint';

/** Canonical kind list (drives tool enums + honest "supported types" copy). */
export const FACTORY_OBJECT_KINDS: readonly FactoryObjectKind[] = [
  'pipeline',
  'dataset',
  'dataflow',
  'trigger',
  'linked-service',
  'integration-runtime',
  'cdc',
  'managed-private-endpoint',
];

/** Human labels for tool results / MessageBar copy. */
export const FACTORY_OBJECT_KIND_LABELS: Record<FactoryObjectKind, string> = {
  'pipeline': 'pipeline',
  'dataset': 'dataset',
  'dataflow': 'data flow',
  'trigger': 'trigger',
  'linked-service': 'linked service',
  'integration-runtime': 'integration runtime',
  'cdc': 'change data capture',
  'managed-private-endpoint': 'managed private endpoint',
};

/**
 * Loose aliases → canonical kind. The model (and a human typing into chat) says
 * "linked service", "dataflow", "IR", "connection" — normalize them all so the
 * tool never rejects a valid intent on a spelling difference.
 */
const KIND_ALIASES: Record<string, FactoryObjectKind> = {
  'pipeline': 'pipeline',
  'pipelines': 'pipeline',
  'dataset': 'dataset',
  'datasets': 'dataset',
  'dataflow': 'dataflow',
  'dataflows': 'dataflow',
  'data-flow': 'dataflow',
  'data flow': 'dataflow',
  'mapping-dataflow': 'dataflow',
  'trigger': 'trigger',
  'triggers': 'trigger',
  'linked-service': 'linked-service',
  'linked service': 'linked-service',
  'linkedservice': 'linked-service',
  'linked-services': 'linked-service',
  'ls': 'linked-service',
  'connection': 'linked-service',
  'connections': 'linked-service',
  'integration-runtime': 'integration-runtime',
  'integration runtime': 'integration-runtime',
  'integrationruntime': 'integration-runtime',
  'ir': 'integration-runtime',
  'cdc': 'cdc',
  'change-data-capture': 'cdc',
  'change data capture': 'cdc',
  'managed-private-endpoint': 'managed-private-endpoint',
  'managed private endpoint': 'managed-private-endpoint',
  'managedprivateendpoint': 'managed-private-endpoint',
  'mpe': 'managed-private-endpoint',
  'private-endpoint': 'managed-private-endpoint',
};

/** Resolve a free-form object-type string to a canonical kind, or null. */
export function normalizeFactoryObjectKind(raw: string): FactoryObjectKind | null {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  return KIND_ALIASES[key] ?? null;
}

/** Friendly backend label for tool results / gate copy. */
export function backendLabel(backend: FactoryBackend): string {
  return backend === 'adf' ? 'Azure Data Factory' : 'Synapse';
}

type DeleteFn = (name: string) => Promise<void>;

/** ADF ARM-REST deleters — the full factory object surface. */
const ADF_DELETERS: Record<FactoryObjectKind, DeleteFn> = {
  'pipeline': (n) => adf.deletePipeline(n),
  'dataset': (n) => adf.deleteDataset(n),
  'dataflow': (n) => adf.deleteDataFlow(n),
  'trigger': (n) => adf.deleteTrigger(n),
  'linked-service': (n) => adf.deleteLinkedService(n),
  'integration-runtime': (n) => adf.deleteIntegrationRuntime(n),
  'cdc': (n) => adf.deleteAdfCdc(n),
  'managed-private-endpoint': (n) => adf.deleteManagedPrivateEndpoint(n),
};

/**
 * Synapse dev-REST deleters — the workspace exposes delete for pipelines,
 * triggers and integration runtimes. Dataset / linked-service / data-flow /
 * CDC / MPE removal is not wired through the Synapse client in Loom yet, so
 * those honest-gate below instead of pretending (no-vaporware.md).
 */
const SYNAPSE_DELETERS: Partial<Record<FactoryObjectKind, DeleteFn>> = {
  'pipeline': (n) => synapseDev.deletePipeline(n),
  'trigger': (n) => synapseDev.deleteTrigger(n),
  'integration-runtime': (n) => synapseDev.deleteSynapseIr(n),
};

/** True when `kind` can be deleted on `backend` through a real Loom REST client. */
export function isFactoryObjectDeletable(backend: FactoryBackend, kind: FactoryObjectKind): boolean {
  return backend === 'adf'
    ? Object.prototype.hasOwnProperty.call(ADF_DELETERS, kind)
    : Object.prototype.hasOwnProperty.call(SYNAPSE_DELETERS, kind);
}

/**
 * Honest config gate for factory delete/remove ops. Reuses the same env-var
 * gates the list routes use (`LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` /
 * `LOOM_ADF_NAME` for ADF; `LOOM_SYNAPSE_WORKSPACE` for Synapse). Returns the
 * exact missing env var, or null when configured.
 */
export function factoryOpsGate(backend: FactoryBackend): { missing: string } | null {
  return backend === 'adf' ? adf.adfConfigGate() : synapseDev.synapseConfigGate();
}

/**
 * Delete a factory object by kind + name against the real backend. Throws an
 * honest Error when the kind is not deletable on the selected backend (never a
 * silent no-op). The caller is responsible for the config gate + confirm-intent
 * guard (see lib/copilot/pipeline-tools.ts).
 */
export async function deleteFactoryObject(
  backend: FactoryBackend,
  kind: FactoryObjectKind,
  name: string,
): Promise<void> {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('A resource name is required to delete.');
  const table = backend === 'adf' ? ADF_DELETERS : SYNAPSE_DELETERS;
  const fn = table[kind];
  if (!fn) {
    throw new Error(
      `Removing a ${FACTORY_OBJECT_KIND_LABELS[kind]} is not supported on the ${backendLabel(
        backend,
      )} backend in CSA Loom — remove it from Synapse Studio instead.`,
    );
  }
  await fn(trimmed);
}
