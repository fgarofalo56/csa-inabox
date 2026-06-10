/**
 * Materialized Lake View provisioner (Azure-native, no Fabric).
 *
 * When an MLV item is installed from a bundle (or promoted between stages), this
 * provisioner materializes the Delta table on the internal DLZ ADLS Gen2 by
 * generating a PySpark refresh driver and submitting a Synapse Spark batch
 * (materialized-lake-view-engine), then records the MLV's source-dependency
 * lineage edges in Cosmos (mlv-lineage). There is NO dependency on a real
 * Microsoft Fabric / OneLake tenant — the Spark batch writes to abfss on the
 * DLZ lake, exactly as the lakehouse provisioner does (no-fabric-dependency.md).
 *
 * The bundle/content shape is `state.content.spec` (an MlvSpec). When no spec is
 * present the item is still created in Cosmos and the editor authors the
 * definition — this provisioner only does the install-time materialization when
 * a definition exists.
 *
 * Honest gates (no-vaporware.md): missing Synapse / ADLS env surfaces as a
 * structured remediation naming the exact env var / role; the item still
 * installs to Cosmos and materializes on the next pass once cleared.
 */
import type { Provisioner, ProvisionResult } from './types';
import { refreshMaterializedLakeView } from '@/lib/azure/materialized-lake-view-engine';
import { setMlvLineage, type MlvLineageEdgeInput } from '@/lib/thread/mlv-lineage';
import { deriveSources, mlvFqn, type MlvSpec } from '@/lib/azure/materialized-lake-view-model';

export const materializedLakeViewProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = (input.content || {}) as any;
  const spec: MlvSpec | undefined = content?.spec || content?.mlv || undefined;

  if (!spec || (!spec.sql && !spec.pyspark)) {
    // Cosmos-only install — no definition yet. The editor authors + refreshes it.
    steps.push('No MLV definition in the bundle — created the item; author the definition in the editor.');
    return { status: 'created', steps };
  }

  steps.push(`Materializing MLV ${mlvFqn(spec)} (${spec.language}) on the Azure-native DLZ lake.`);

  // 1. Record cross-workspace lineage from the definition's source references.
  const sources = deriveSources(spec);
  if (sources.length) {
    const edges: MlvLineageEdgeInput[] = sources.map((s) => ({
      mlvItemId: input.cosmosItemId,
      mlvName: input.displayName,
      workspaceId: input.workspaceId,
      source: s,
    }));
    const { written } = await setMlvLineage(input.session, {
      itemId: input.cosmosItemId,
      name: input.displayName,
      workspaceId: input.workspaceId,
    }, edges);
    steps.push(`Recorded ${written} lineage edge(s): ${sources.join(', ')}.`);
  } else {
    steps.push('No source tables derived from the definition (no lineage edges).');
  }

  // 2. Materialize the Delta table via a real Synapse Spark batch.
  const outcome = await refreshMaterializedLakeView(spec, { itemId: input.cosmosItemId, trigger: 'install' });
  if (!outcome.ok) {
    if ('gate' in outcome && outcome.gate) {
      return {
        status: 'remediation',
        gate: { reason: outcome.error, remediation: outcome.remediation, link: outcome.link },
        steps,
      };
    }
    return { status: 'failed', error: outcome.error, steps };
  }

  steps.push(
    `Submitted Spark batch #${outcome.batch.id} on pool '${outcome.sparkPool}' → ${outcome.deltaUrl}. ` +
      'The batch finishes server-side and the Delta table appears in the lake/serverless SQL endpoint.',
  );

  return {
    status: 'created',
    resourceId: outcome.deltaUrl,
    secondaryIds: {
      backend: 'azure-native-adls-delta',
      fqn: outcome.fqn,
      container: outcome.container,
      deltaUrl: outcome.deltaUrl,
      sparkPool: outcome.sparkPool,
      batchId: String(outcome.batch.id),
      driverPath: outcome.driverPath,
      ...(sources.length ? { sources: sources.join(',') } : {}),
    },
    steps,
  };
};
