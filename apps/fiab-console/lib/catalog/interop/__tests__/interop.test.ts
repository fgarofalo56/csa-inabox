/**
 * B-N19g — catalog-interop tests: DataHub MCE + OpenMetadata encode/decode
 * round-trips, the N17 identity contract, and the ingest planner's
 * additive/non-destructive merge semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCatalogAssets,
  buildLineageEdges,
  columnsForItem,
  dataHubDatasetUrn,
  itemIdFromUri,
  itemTypeFromUri,
  ownersForItem,
  parseDataHubDatasetUrn,
  tagsForItem,
  type CatalogAsset,
  type RawLoomItem,
} from '@/lib/catalog/interop/model';
import { assetsToDataHubMces, parseDataHubMces } from '@/lib/catalog/interop/datahub';
import { assetsToOpenMetadata, parseOpenMetadata, omFqn, parseOmFqn } from '@/lib/catalog/interop/openmetadata';
import { planIngest, isLoomItemUri } from '@/lib/catalog/interop/ingest';
import { datasetUriForItem } from '@/lib/lineage/openlineage';

const ITEMS: RawLoomItem[] = [
  {
    id: 'lh-1',
    itemType: 'lakehouse',
    displayName: 'Bronze lake',
    workspaceId: 'ws-1',
    updatedAt: '2026-07-01T00:00:00.000Z',
    state: {
      description: 'Raw landing zone',
      owner: 'ana@contoso.com',
      tags: ['bronze'],
      classifications: ['PII', 'bronze'],
      sensitivityLabel: 'Confidential',
      columns: ['id', 'payload'],
    },
  },
  {
    id: 'wh-1',
    itemType: 'warehouse',
    displayName: 'Gold warehouse',
    workspaceId: 'ws-1',
    state: { certified: true, schema: [{ name: 'customer_id' }, { name: 'revenue' }] },
  },
];

const EDGES = [
  { fromItemId: 'lh-1', fromType: 'lakehouse', toItemId: 'wh-1', toType: 'warehouse', action: 'openlineage-pipeline' },
  // Tombstoned + external + dangling edges must never reach an importing catalog.
  { fromItemId: 'lh-1', fromType: 'lakehouse', toItemId: 'wh-1', toType: 'warehouse', deletedAt: '2026-07-02T00:00:00Z' },
  { fromItemId: 'lh-1', fromType: 'lakehouse', toItemId: 'pbi-x', toType: 'report', toExternal: true },
  { fromItemId: 'lh-1', fromType: 'lakehouse', toItemId: 'missing', toType: 'lakehouse' },
];

const WS = new Map([['ws-1', 'Analytics']]);

describe('model — N17 identity + projection', () => {
  it('names every asset with the SAME URI the OpenLineage emitter stamps', () => {
    const [bronze] = buildCatalogAssets(ITEMS, WS);
    expect(bronze.uri).toBe(datasetUriForItem({ itemId: 'lh-1', itemType: 'lakehouse', name: 'Bronze lake' }));
    expect(bronze.uri).toBe('loom://items/lakehouse/lh-1');
    expect(itemIdFromUri(bronze.uri)).toBe('lh-1');
    expect(itemTypeFromUri(bronze.uri)).toBe('lakehouse');
    expect(isLoomItemUri(bronze.uri)).toBe(true);
  });

  it('merges tags with classifications, de-duped case-insensitively', () => {
    expect(tagsForItem(ITEMS[0])).toEqual(['bronze', 'PII']);
  });

  it('reads owners in governance-KPI order and columns from either shape', () => {
    expect(ownersForItem(ITEMS[0])).toEqual(['ana@contoso.com']);
    expect(columnsForItem(ITEMS[0])).toEqual(['id', 'payload']);
    expect(columnsForItem(ITEMS[1])).toEqual(['customer_id', 'revenue']);
  });

  it('maps state.certified onto the Fabric-style endorsement', () => {
    const [, gold] = buildCatalogAssets(ITEMS, WS);
    expect(gold.endorsement).toBe('Certified');
    expect(gold.workspaceName).toBe('Analytics');
  });

  it('drops tombstoned, external, dangling, and duplicate lineage edges', () => {
    const assets = buildCatalogAssets(ITEMS, WS);
    const lineage = buildLineageEdges(EDGES, assets);
    expect(lineage).toHaveLength(1);
    expect(lineage[0].fromUri).toBe('loom://items/lakehouse/lh-1');
    expect(lineage[0].toUri).toBe('loom://items/warehouse/wh-1');
  });
});

describe('DataHub MCE', () => {
  const assets = buildCatalogAssets(ITEMS, WS);
  const lineage = buildLineageEdges(EDGES, assets);
  const mces = assetsToDataHubMces(assets, lineage);

  it('emits one dataset snapshot per asset with a Loom-platform URN', () => {
    expect(mces).toHaveLength(2);
    const urn = mces[0].proposedSnapshot['com.linkedin.metadata.snapshot.DatasetSnapshot'].urn;
    expect(urn).toBe(dataHubDatasetUrn('loom://items/lakehouse/lh-1'));
    expect(parseDataHubDatasetUrn(urn)).toBe('loom://items/lakehouse/lh-1');
  });

  it('carries properties, ownership, tags, glossary terms, and schema aspects', () => {
    const aspects = mces[0].proposedSnapshot['com.linkedin.metadata.snapshot.DatasetSnapshot'].aspects;
    const keys = aspects.flatMap((a) => Object.keys(a));
    expect(keys).toContain('com.linkedin.dataset.DatasetProperties');
    expect(keys).toContain('com.linkedin.common.Ownership');
    expect(keys).toContain('com.linkedin.common.GlobalTags');
    expect(keys).toContain('com.linkedin.common.GlossaryTerms');
    expect(keys).toContain('com.linkedin.schema.SchemaMetadata');
  });

  it('rides upstream lineage on the DOWNSTREAM dataset (DataHub semantics)', () => {
    const gold = mces[1].proposedSnapshot['com.linkedin.metadata.snapshot.DatasetSnapshot'];
    const upstream = gold.aspects.find((a) => a['com.linkedin.dataset.UpstreamLineage']);
    expect(upstream).toBeTruthy();
    const list = (upstream!['com.linkedin.dataset.UpstreamLineage'] as { upstreams: Array<{ dataset: string }> }).upstreams;
    expect(list[0].dataset).toBe(dataHubDatasetUrn('loom://items/lakehouse/lh-1'));
    // The bronze (upstream) snapshot must NOT carry an upstream aspect.
    const bronze = mces[0].proposedSnapshot['com.linkedin.metadata.snapshot.DatasetSnapshot'];
    expect(bronze.aspects.find((a) => a['com.linkedin.dataset.UpstreamLineage'])).toBeUndefined();
  });

  it('round-trips back to ingest records with owners, tags, and upstreams', () => {
    const { records, skipped } = parseDataHubMces({ mces });
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[0].uri).toBe('loom://items/lakehouse/lh-1');
    expect(records[0].owners).toEqual(['ana@contoso.com']);
    expect(records[0].tags).toEqual(['bronze', 'PII']);
    expect(records[0].sensitivityLabel).toBe('Confidential');
    expect(records[1].upstreamUris).toEqual(['loom://items/lakehouse/lh-1']);
  });

  it('reports a foreign-platform URN as skipped instead of dropping it silently', () => {
    const { records, skipped } = parseDataHubMces([
      {
        proposedSnapshot: {
          'com.linkedin.metadata.snapshot.DatasetSnapshot': {
            urn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,db.sch.tbl,PROD)',
            aspects: [],
          },
        },
      },
    ]);
    expect(records).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

describe('OpenMetadata', () => {
  const assets = buildCatalogAssets(ITEMS, WS);
  const lineage = buildLineageEdges(EDGES, assets);
  const om = assetsToOpenMetadata(assets, lineage);

  it('fully-qualifies every entity under the loom service using the N17 URI', () => {
    expect(om.entities).toHaveLength(2);
    expect(om.entities[0].fullyQualifiedName).toBe(omFqn('loom://items/lakehouse/lh-1'));
    expect(parseOmFqn(om.entities[0].fullyQualifiedName)).toBe('loom://items/lakehouse/lh-1');
    expect(om.entities[0].extension.loomItemId).toBe('lh-1');
  });

  it('encodes sensitivity + endorsement as classification tags and emits lineage edges', () => {
    const tags = om.entities[0].tags.map((t) => t.tagFQN);
    expect(tags).toContain('Sensitivity.Confidential');
    expect(om.entities[1].tags.map((t) => t.tagFQN)).toContain('Endorsement.Certified');
    expect(om.lineage).toHaveLength(1);
    expect(om.lineage[0].edge.fromEntity.id).toBe(omFqn('loom://items/lakehouse/lh-1'));
  });

  it('round-trips back to ingest records with lineage resolved to upstream URIs', () => {
    const { records, skipped } = parseOpenMetadata(om);
    expect(skipped).toEqual([]);
    expect(records[0].uri).toBe('loom://items/lakehouse/lh-1');
    expect(records[0].tags).toEqual(['bronze', 'PII']);
    expect(records[0].sensitivityLabel).toBe('Confidential');
    expect(records[1].upstreamUris).toEqual(['loom://items/lakehouse/lh-1']);
  });

  it('reports a non-Loom entity as skipped', () => {
    const { records, skipped } = parseOpenMetadata({ entities: [{ name: 'foreign', fullyQualifiedName: 'snowflake.db.tbl' }] });
    expect(records).toEqual([]);
    expect(skipped).toEqual(['snowflake.db.tbl']);
  });
});

describe('planIngest — additive, non-destructive merge', () => {
  const assets: CatalogAsset[] = buildCatalogAssets(ITEMS, WS);

  it('adds new owners/tags but never re-adds what Loom already has', () => {
    const plan = planIngest(
      [{ uri: 'loom://items/lakehouse/lh-1', owners: ['ana@contoso.com', 'bo@contoso.com'], tags: ['BRONZE', 'gold'], upstreamUris: [] }],
      assets,
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].addOwners).toEqual(['bo@contoso.com']);
    expect(plan.changes[0].addTags).toEqual(['gold']);
    expect(plan.totals.itemsToUpdate).toBe(1);
  });

  it('never overwrites an existing description or sensitivity label', () => {
    const plan = planIngest(
      [{ uri: 'loom://items/lakehouse/lh-1', owners: [], tags: [], description: 'FROM DATAHUB', sensitivityLabel: 'Public', upstreamUris: [] }],
      assets,
    );
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped).toEqual([{ uri: 'loom://items/lakehouse/lh-1', reason: 'no-change' }]);
  });

  it('writes a description/label only when Loom has none', () => {
    const plan = planIngest(
      [{ uri: 'loom://items/warehouse/wh-1', owners: [], tags: [], description: 'Curated gold', sensitivityLabel: 'Internal', upstreamUris: [] }],
      assets,
    );
    expect(plan.changes[0].description).toBe('Curated gold');
    expect(plan.changes[0].sensitivityLabel).toBe('Internal');
    expect(plan.totals.descriptionsSet).toBe(1);
    expect(plan.totals.labelsSet).toBe(1);
  });

  it('resolves upstream lineage and ignores self-edges and unknown upstreams', () => {
    const plan = planIngest(
      [{
        uri: 'loom://items/warehouse/wh-1',
        owners: [], tags: [],
        upstreamUris: ['loom://items/lakehouse/lh-1', 'loom://items/warehouse/wh-1', 'loom://items/lakehouse/nope'],
      }],
      assets,
    );
    expect(plan.changes[0].addUpstreamItemIds).toEqual(['lh-1']);
    expect(plan.totals.lineageEdges).toBe(1);
  });

  it('reports an unresolvable asset honestly instead of inventing an item', () => {
    const plan = planIngest(
      [{ uri: 'loom://items/lakehouse/ghost', owners: ['x@y.com'], tags: [], upstreamUris: [] }],
      assets,
      ['urn:li:dataset:(urn:li:dataPlatform:snowflake,a.b.c,PROD)'],
    );
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([{ uri: 'loom://items/lakehouse/ghost', reason: 'unknown-item' }]);
    expect(plan.unresolved).toHaveLength(1);
  });
});
