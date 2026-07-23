/**
 * L4 — Purview column-level lineage (classic Data Map process column lineage).
 * Push (columnMapping attribute + column sub-entities) + read (parse back).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-token-purview', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class { constructor(..._creds: any[]) {} async getToken() { return { token: 'fake-token-purview', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

describe('purview-client — L4 column lineage', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    process.env.LOOM_UAMI_CLIENT_ID = 'test-uami';
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  // ── pure helpers (no network) ──
  it('buildColumnMappingAttribute serializes the ADF-standard columnMapping shape', async () => {
    const mod = await import('../purview-client');
    const attr = mod.buildColumnMappingAttribute([
      { sourceDatasetQualifiedName: 'loom://t/w/azure-sql/src', sinkDatasetQualifiedName: 'loom://t/w/lakehouse/dst', columns: [{ source: 'Id', sink: 'id' }, { source: 'Name', sink: 'full_name' }] },
    ]);
    expect(JSON.parse(attr)).toEqual([
      {
        DatasetMapping: { Source: 'loom://t/w/azure-sql/src', Sink: 'loom://t/w/lakehouse/dst' },
        ColumnMapping: [{ Source: 'Id', Sink: 'id' }, { Source: 'Name', Sink: 'full_name' }],
      },
    ]);
  });

  it('buildColumnMappingAttribute drops empty/mapping-less blocks', async () => {
    const mod = await import('../purview-client');
    expect(mod.buildColumnMappingAttribute([
      { sourceDatasetQualifiedName: 's', sinkDatasetQualifiedName: 'd', columns: [] },
      { sourceDatasetQualifiedName: '', sinkDatasetQualifiedName: 'd', columns: [{ source: 'a', sink: 'b' }] },
    ])).toBe('[]');
  });

  it('parseAtlasColumnMapping parses a JSON string and an already-parsed array; tolerant of junk', async () => {
    const mod = await import('../purview-client');
    const raw = JSON.stringify([
      { DatasetMapping: { Source: 'srcQN', Sink: 'sinkQN' }, ColumnMapping: [{ Source: 'a', Sink: 'A' }, { Source: 'b', Sink: 'B' }] },
    ]);
    const edges = mod.parseAtlasColumnMapping(raw, 'proc-guid');
    expect(edges).toEqual([
      { processGuid: 'proc-guid', sourceDatasetQualifiedName: 'srcQN', sinkDatasetQualifiedName: 'sinkQN', fromColumn: 'a', toColumn: 'A' },
      { processGuid: 'proc-guid', sourceDatasetQualifiedName: 'srcQN', sinkDatasetQualifiedName: 'sinkQN', fromColumn: 'b', toColumn: 'B' },
    ]);
    // already-parsed array works too
    expect(mod.parseAtlasColumnMapping(JSON.parse(raw))).toHaveLength(2);
    // junk → []
    expect(mod.parseAtlasColumnMapping('not json')).toEqual([]);
    expect(mod.parseAtlasColumnMapping(undefined)).toEqual([]);
    expect(mod.parseAtlasColumnMapping('[{"DatasetMapping":{}}]')).toEqual([]);
  });

  // ── push ──
  it('createAtlasColumnLineage POSTs a Process with the columnMapping attribute', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ guidAssignments: { '-1': 'proc-123' } }), { status: 200 }));
    const mod = await import('../purview-client');
    const guid = await mod.createAtlasColumnLineage({
      inputs: ['g-src'], outputs: ['g-dst'],
      processQualifiedName: 'loom://process/edge_1', processName: 'src → dst (adf-copy)',
      datasetColumnMappings: [{ sourceDatasetQualifiedName: 'srcQN', sinkDatasetQualifiedName: 'sinkQN', columns: [{ source: 'a', sink: 'A' }] }],
    });
    expect(guid).toBe('proc-123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/datamap/api/atlas/v2/entity');
    const body = JSON.parse(init.body);
    expect(body.entity.typeName).toBe('Process');
    expect(body.entity.attributes.inputs).toEqual([{ guid: 'g-src' }]);
    expect(body.entity.attributes.outputs).toEqual([{ guid: 'g-dst' }]);
    const cm = JSON.parse(body.entity.attributes.columnMapping);
    expect(cm[0].DatasetMapping).toEqual({ Source: 'srcQN', Sink: 'sinkQN' });
    expect(cm[0].ColumnMapping).toEqual([{ Source: 'a', Sink: 'A' }]);
  });

  it('createAtlasColumnLineage omits columnMapping when there is no resolvable column (falls back to entity-grain)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ guidAssignments: { '-1': 'proc-9' } }), { status: 200 }));
    const mod = await import('../purview-client');
    await mod.createAtlasColumnLineage({
      inputs: ['g-src'], outputs: ['g-dst'],
      processQualifiedName: 'loom://process/e', processName: 'p',
      datasetColumnMappings: [{ sourceDatasetQualifiedName: 's', sinkDatasetQualifiedName: 'd', columns: [] }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.entity.attributes.columnMapping).toBeUndefined();
  });

  it('ensureColumnEntities bulk-POSTs column sub-entities; returns 0 on a 400 type mismatch', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ mutatedEntities: {} }), { status: 200 }));
    const mod = await import('../purview-client');
    const n = await mod.ensureColumnEntities('azure_sql_table', 'loom://t/w/azure-sql/src', ['Id', 'Name', 'Id']);
    expect(n).toBe(2); // deduped
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/datamap/api/atlas/v2/entity/bulk');
    const body = JSON.parse(init.body);
    expect(body.entities).toHaveLength(2);
    expect(body.entities[0]).toMatchObject({
      typeName: 'azure_sql_table_column',
      attributes: { qualifiedName: 'loom://t/w/azure-sql/src#Id', name: 'Id' },
      relationshipAttributes: { table: { typeName: 'azure_sql_table', uniqueAttributes: { qualifiedName: 'loom://t/w/azure-sql/src' } } },
    });
    // 400 → best-effort 0
    fetchMock.mockResolvedValueOnce(new Response('bad type', { status: 400 }));
    expect(await mod.ensureColumnEntities('weird_type', 'qn', ['x'])).toBe(0);
  });

  // ── read ──
  it('getLineageSubgraph parses an inline Process columnMapping into columnEdges', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      baseEntityGuid: 'g-base',
      guidEntityMap: {
        'g-base': { typeName: 'azure_sql_table', attributes: { qualifiedName: 'srcQN', name: 'src' } },
        'g-dst': { typeName: 'azure_datalake_gen2_path', attributes: { qualifiedName: 'sinkQN', name: 'dst' } },
        'g-proc': { typeName: 'Process', attributes: { qualifiedName: 'loom://process/e', name: 'copy', columnMapping: JSON.stringify([{ DatasetMapping: { Source: 'srcQN', Sink: 'sinkQN' }, ColumnMapping: [{ Source: 'a', Sink: 'A' }] }]) } },
      },
      relations: [{ fromEntityId: 'g-base', toEntityId: 'g-proc' }, { fromEntityId: 'g-proc', toEntityId: 'g-dst' }],
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const graph = await mod.getLineageSubgraph('g-base');
    expect(graph.relations).toHaveLength(2);
    expect(graph.columnEdges).toEqual([
      { processGuid: 'g-proc', sourceDatasetQualifiedName: 'srcQN', sinkDatasetQualifiedName: 'sinkQN', fromColumn: 'a', toColumn: 'A' },
    ]);
  });

  it('getLineageSubgraph leaves columnEdges undefined on an entity-grain-only graph (backward compatible)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      baseEntityGuid: 'g1', guidEntityMap: { g1: { typeName: 'azure_sql_table', attributes: { qualifiedName: 'q' } } }, relations: [],
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const graph = await mod.getLineageSubgraph('g1');
    expect(graph.columnEdges).toBeUndefined();
  });

  it('getProcessColumnMappings reads a process entity and parses its columnMapping', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      entity: { attributes: { columnMapping: JSON.stringify([{ DatasetMapping: { Source: 's', Sink: 'd' }, ColumnMapping: [{ Source: 'x', Sink: 'y' }] }]) } },
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const edges = await mod.getProcessColumnMappings('proc-g');
    expect(edges).toEqual([{ processGuid: 'proc-g', sourceDatasetQualifiedName: 's', sinkDatasetQualifiedName: 'd', fromColumn: 'x', toColumn: 'y' }]);
  });
});
