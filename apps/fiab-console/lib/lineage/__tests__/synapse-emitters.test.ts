/**
 * LU-8 — Synapse OpenLineage emitters (pure half).
 *
 * Asserts spec conformance (OpenLineage RunEvent 1.0.5 shape + the naming
 * conventions), the status→eventType rules that stop a failed run from
 * stamping lineage, and that the emitters never invent a dataset they cannot
 * anchor to a real physical location.
 */
import { describe, it, expect } from 'vitest';
import {
  deterministicRunId,
  pipelineRunEvents,
  parseSparkDatasets,
  sparkBatchRunEvent,
  translatorColumnMappings,
  adfDatasetRef,
  SPARK_CONF_INPUTS,
  SPARK_CONF_OUTPUTS,
} from '@/lib/lineage/synapse-emitters';
import { mapRunEventToEdges, type OpenLineageRunEvent } from '@/lib/azure/openlineage-ingest';
import { LOOM_OL_PRODUCER, OL_RUNEVENT_SCHEMA_URL } from '@/lib/lineage/openlineage';

const LS = 'https://stloom.dfs.core.windows.net';

const bronze = {
  name: 'ds_bronze',
  type: 'DelimitedText',
  location: { type: 'AzureBlobFSLocation', fileSystem: 'data', folderPath: 'bronze/sales' },
  linkedServiceUrl: LS,
  columns: ['id', 'amount'],
};
const silver = {
  name: 'ds_silver',
  type: 'Parquet',
  location: { type: 'AzureBlobFSLocation', fileSystem: 'data', folderPath: 'silver/sales' },
  linkedServiceUrl: LS,
  columns: ['id', 'total'],
};

describe('deterministicRunId', () => {
  it('is a stable RFC-4122 v5 UUID — re-harvesting a run yields the SAME run id', () => {
    const a = deterministicRunId('adf:f1:run-1:Copy');
    expect(a).toBe(deterministicRunId('adf:f1:run-1:Copy'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('matches its FROZEN wire value — the namespace UUID is part of the contract', () => {
    // Asserting the function against itself (`f(x) === f(x)`) is true by
    // construction for any pure function and cannot catch a changed namespace
    // UUID or a changed digest. These goldens can: they are the ids already
    // emitted to downstream OpenLineage consumers, so changing either input to
    // the hash is a breaking change and must fail here first.
    expect(deterministicRunId('adf:f1:run-1:Copy')).toBe('ffe6c217-7ab9-5962-8f44-a61c66945f03');
    expect(deterministicRunId('synapse-spark:syn-loom:loompool:42:2026-07-28T02:00:00.000Z'))
      .toBe('c553babf-72f6-5c62-8a64-a0000e85cfcd');
  });

  it('separates different runs and different activities of one run', () => {
    expect(deterministicRunId('adf:f1:run-1:Copy')).not.toBe(deterministicRunId('adf:f1:run-2:Copy'));
    expect(deterministicRunId('adf:f1:run-1:Copy')).not.toBe(deterministicRunId('adf:f1:run-1:Copy2'));
  });
});

describe('pipelineRunEvents', () => {
  const base = {
    factoryName: 'adf-loom',
    pipelineName: 'nightly-load',
    runId: 'run-1',
    runEnd: '2026-07-28T02:00:00.000Z',
  };

  it('emits a spec-shaped COMPLETE RunEvent per succeeded Copy activity', () => {
    const [ev] = pipelineRunEvents({
      ...base,
      activities: [{ activityName: 'CopySales', activityType: 'Copy', source: bronze, sink: silver, status: 'Succeeded' }],
    });
    expect(ev.eventType).toBe('COMPLETE');
    expect(ev.producer).toBe(LOOM_OL_PRODUCER);
    expect(ev.schemaURL).toBe(OL_RUNEVENT_SCHEMA_URL);
    expect(ev.eventTime).toBe(base.runEnd);
    expect(ev.job).toMatchObject({ namespace: 'adf://adf-loom', name: 'nightly-load.CopySales' });
    expect((ev.job.facets as any).jobType.integration).toBe('SYNAPSE_PIPELINE');
    expect(ev.inputs[0]).toMatchObject({ namespace: 'abfss://data@stloom.dfs.core.windows.net', name: '/bronze/sales' });
    expect(ev.outputs[0]).toMatchObject({ namespace: 'abfss://data@stloom.dfs.core.windows.net', name: '/silver/sales' });
    expect((ev.inputs[0].facets as any).schema.fields).toEqual([{ name: 'id' }, { name: 'amount' }]);
    expect((ev.run.facets as any).loomRun.adfPipelineRunId).toBe('run-1');
  });

  it('does NOT stamp lineage for a failed or cancelled activity', () => {
    const failed = pipelineRunEvents({
      ...base,
      activities: [{ activityName: 'C', activityType: 'Copy', source: bronze, sink: silver, status: 'Failed' }],
    });
    expect(failed[0].eventType).toBe('FAIL');
    // The L2 mapper is what enforces it — a non-COMPLETE event writes no edges.
    expect((mapRunEventToEdges(failed[0] as unknown as OpenLineageRunEvent) as any).edges).toEqual([]);

    const cancelled = pipelineRunEvents({
      ...base,
      activities: [{ activityName: 'C', activityType: 'Copy', source: bronze, sink: silver, status: 'Cancelled' }],
    });
    expect(cancelled[0].eventType).toBe('ABORT');
  });

  it('turns a Copy translator into a columnLineage facet that maps to real edges', () => {
    const [ev] = pipelineRunEvents({
      ...base,
      activities: [{
        activityName: 'C',
        activityType: 'Copy',
        source: bronze,
        sink: silver,
        status: 'Succeeded',
        columnMappings: [{ fromColumn: 'amount', toColumn: 'total' }],
      }],
    });
    const facet = (ev.outputs[0].facets as any).columnLineage;
    expect(facet.fields.total.inputFields[0]).toMatchObject({
      namespace: 'abfss://data@stloom.dfs.core.windows.net',
      name: '/bronze/sales',
      field: 'amount',
    });
    // Round-trip through the REAL L2 mapper: the facet must actually resolve.
    const mapped = mapRunEventToEdges(ev as unknown as OpenLineageRunEvent);
    expect(mapped.ok).toBe(true);
    const edge = (mapped as any).edges[0];
    expect(edge.fromUri).toBe('abfss://data@stloom.dfs.core.windows.net/bronze/sales');
    expect(edge.toUri).toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(edge.columnMappings).toEqual([
      { fromColumn: 'amount', toColumn: 'total', confidence: 'declared' },
    ]);
  });

  it('skips an activity whose dataset cannot be anchored to a physical location', () => {
    const events = pipelineRunEvents({
      ...base,
      activities: [
        { activityName: 'NoLs', activityType: 'Copy', source: { ...bronze, linkedServiceUrl: undefined }, sink: silver, status: 'Succeeded' },
        { activityName: 'Ok', activityType: 'Copy', source: bronze, sink: silver, status: 'Succeeded' },
      ],
    });
    expect(events.map((e) => e.job.name)).toEqual(['nightly-load.Ok']);
  });

  it('emits a SQL sink as a 3-part relation dataset', () => {
    const ref = adfDatasetRef({
      name: 'ds_dw',
      type: 'AzureSqlDWTable',
      sqlServer: 'syn.sql.azuresynapse.net',
      sqlDatabase: 'loomdw',
      sqlSchema: 'sales',
      sqlTable: 'orders',
    });
    expect(ref).toEqual({ namespace: 'sqlserver://syn.sql.azuresynapse.net:1433', name: 'loomdw.sales.orders' });
  });
});

describe('translatorColumnMappings', () => {
  it('reads TabularTranslator name and hierarchical path mappings', () => {
    expect(
      translatorColumnMappings({
        type: 'TabularTranslator',
        mappings: [
          { source: { name: 'amount' }, sink: { name: 'total' } },
          { source: { path: "$['order']['qty']" }, sink: { name: 'qty' } },
          { source: { name: 'orphan' } }, // no sink → dropped, never guessed
          { sink: { name: 'orphan2' } },
        ],
      }),
    ).toEqual([
      { fromColumn: 'amount', toColumn: 'total' },
      { fromColumn: 'qty', toColumn: 'qty' },
    ]);
  });

  it('is empty for a non-tabular / absent translator', () => {
    expect(translatorColumnMappings(undefined)).toEqual([]);
    expect(translatorColumnMappings({ type: 'TabularTranslator' })).toEqual([]);
  });
});

describe('parseSparkDatasets', () => {
  const base = { workspaceName: 'syn-loom', poolName: 'loompool', batchId: 7, jobName: 'etl' };

  it('reads --flag value and --flag=value argv forms', () => {
    const r = parseSparkDatasets({
      ...base,
      args: [
        '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
        '--output=https://stloom.dfs.core.windows.net/data/silver/sales',
      ],
    });
    expect(r.inputs.map((d) => `${d.namespace}${d.name}`)).toEqual(['abfss://data@stloom.dfs.core.windows.net/bronze/sales']);
    // The https output normalizes to the SAME namespace/name a pipeline emits.
    expect(r.outputs).toEqual([{ namespace: 'abfss://data@stloom.dfs.core.windows.net', name: '/silver/sales' }]);
  });

  it('reads the explicit Loom conf declaration and de-dupes against argv', () => {
    const r = parseSparkDatasets({
      ...base,
      conf: {
        [SPARK_CONF_INPUTS]: 'abfss://data@st.dfs.core.windows.net/a, abfss://data@st.dfs.core.windows.net/b',
        [SPARK_CONF_OUTPUTS]: 'abfss://data@st.dfs.core.windows.net/c',
      },
      args: ['--input', 'abfss://data@st.dfs.core.windows.net/a'],
    });
    expect(r.inputs).toHaveLength(2);
    expect(r.outputs).toHaveLength(1);
  });

  it('ignores non-storage argument values instead of inventing a node', () => {
    const r = parseSparkDatasets({ ...base, args: ['--input', 'customers', '--output', '/tmp/out', '--mode', 'overwrite'] });
    expect(r.inputs).toEqual([]);
    expect(r.outputs).toEqual([]);
  });

  it('ignores flags it does not recognise (a value is never grabbed blindly)', () => {
    const r = parseSparkDatasets({ ...base, args: ['--checkpoint', 'abfss://data@st.dfs.core.windows.net/ckpt'] });
    expect(r.inputs).toEqual([]);
    expect(r.outputs).toEqual([]);
  });
});

describe('sparkBatchRunEvent', () => {
  const base = {
    workspaceName: 'syn-loom',
    poolName: 'loompool',
    batchId: 42,
    jobName: 'bronze-to-silver',
    args: [
      '--input', 'abfss://data@stloom.dfs.core.windows.net/bronze/sales',
      '--output', 'abfss://data@stloom.dfs.core.windows.net/silver/sales/_delta_log',
    ],
    eventTime: '2026-07-28T03:00:00.000Z',
  };

  it('builds a COMPLETE event on success, folding the Delta log to the table folder', () => {
    const ev = sparkBatchRunEvent({ ...base, state: 'success' })!;
    expect(ev.eventType).toBe('COMPLETE');
    expect(ev.job.namespace).toBe('synapse://syn-loom/sparkPools/loompool');
    expect((ev.job.facets as any).jobType.integration).toBe('SYNAPSE_SPARK');
    expect(ev.outputs[0].name).toBe('/silver/sales');
    expect((ev.run.facets as any).loomRun.livyBatchId).toBe('42');
  });

  it('maps a dead/killed batch to FAIL/ABORT so no edge is written', () => {
    expect(sparkBatchRunEvent({ ...base, state: 'dead' })!.eventType).toBe('FAIL');
    expect(sparkBatchRunEvent({ ...base, state: 'killed' })!.eventType).toBe('ABORT');
    const running = sparkBatchRunEvent({ ...base, state: 'running' })!;
    expect((mapRunEventToEdges(running as unknown as OpenLineageRunEvent) as any).edges).toEqual([]);
  });

  it('returns null when the batch declared no input+output pair', () => {
    expect(sparkBatchRunEvent({ ...base, args: ['--input', 'abfss://data@st.dfs.core.windows.net/a'], state: 'success' })).toBeNull();
    expect(sparkBatchRunEvent({ ...base, args: [], state: 'success' })).toBeNull();
  });
});
