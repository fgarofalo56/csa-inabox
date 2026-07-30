/**
 * Vitest for the Purview auto-onboard / offboard hooks + loomTypeToAtlasTypeName.
 *
 * Both hooks are best-effort + non-blocking and a cheap no-op when
 * LOOM_PURVIEW_ACCOUNT is unset. offboardFromPurview is the symmetric delete
 * counterpart wired into item-crud's hard-delete + purge paths so the external
 * Atlas graph reconciles in lock-step with Loom's own Weave edges.
 *
 * GUID write-back: after a successful registerAtlasEntity call the returned
 * primaryGuid is best-effort patched onto the Cosmos item's state.purviewGuid
 * so lineage drawers can resolve the GUID without a separate Purview lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  registerAtlasEntity: vi.fn(),
  ensureClassificationDefs: vi.fn(),
  deleteAtlasEntityByQualifiedName: vi.fn(),
  ensureColumnEntities: vi.fn(),
  // Cosmos item operations
  cosmosRead: vi.fn(),
  cosmosReplace: vi.fn(),
  cosmosItem: vi.fn(),
  itemsContainer: vi.fn(),
}));

vi.mock('../purview-client', () => ({
  registerAtlasEntity: h.registerAtlasEntity,
  ensureClassificationDefs: h.ensureClassificationDefs,
  deleteAtlasEntityByQualifiedName: h.deleteAtlasEntityByQualifiedName,
  ensureColumnEntities: h.ensureColumnEntities,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: h.itemsContainer,
}));

import { autoOnboardToPurview, offboardFromPurview, loomTypeToAtlasTypeName } from '../purview-autoonboard';

const item = {
  id: 'i1', workspaceId: 'ws1', itemType: 'lakehouse',
  displayName: 'Sales LH', state: {}, createdBy: 'alice@contoso.com',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as any;

const ORIG = { ...process.env };
beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  process.env = { ...ORIG };
  // Default Cosmos mock: read returns the item, replace succeeds.
  h.cosmosRead.mockResolvedValue({ resource: { ...item, state: {} } });
  h.cosmosReplace.mockResolvedValue({ resource: item });
  h.cosmosItem.mockReturnValue({ read: h.cosmosRead, replace: h.cosmosReplace });
  h.itemsContainer.mockResolvedValue({ item: h.cosmosItem });
});

// ── loomTypeToAtlasTypeName ──────────────────────────────────────────────────

describe('loomTypeToAtlasTypeName', () => {
  it('maps lakehouse to fabric_lakehouse', () => {
    expect(loomTypeToAtlasTypeName('lakehouse')).toBe('fabric_lakehouse');
  });

  it('maps warehouse to fabric_warehouse', () => {
    expect(loomTypeToAtlasTypeName('warehouse')).toBe('fabric_warehouse');
  });

  it('maps kql-database to azure_data_explorer_database', () => {
    expect(loomTypeToAtlasTypeName('kql-database')).toBe('azure_data_explorer_database');
  });

  it('maps eventhouse to azure_data_explorer_database', () => {
    expect(loomTypeToAtlasTypeName('eventhouse')).toBe('azure_data_explorer_database');
  });

  it('maps azure-sql-database to azure_sql_db', () => {
    expect(loomTypeToAtlasTypeName('azure-sql-database')).toBe('azure_sql_db');
  });

  it('maps cosmos-gremlin-graph to azure_cosmos_db', () => {
    expect(loomTypeToAtlasTypeName('cosmos-gremlin-graph')).toBe('azure_cosmos_db');
  });

  it('maps vector-store to azure_cognitive_search', () => {
    expect(loomTypeToAtlasTypeName('vector-store')).toBe('azure_cognitive_search');
  });

  it('maps gql-graph to azure_data_explorer_database (ADX-native default)', () => {
    expect(loomTypeToAtlasTypeName('gql-graph')).toBe('azure_data_explorer_database');
  });

  it('falls back to DataSet for unknown types (pipeline, notebook, report…)', () => {
    expect(loomTypeToAtlasTypeName('data-pipeline')).toBe('DataSet');
    expect(loomTypeToAtlasTypeName('notebook')).toBe('DataSet');
    expect(loomTypeToAtlasTypeName('report')).toBe('DataSet');
    expect(loomTypeToAtlasTypeName('semantic-model')).toBe('DataSet');
    expect(loomTypeToAtlasTypeName('data-product')).toBe('DataSet');
    expect(loomTypeToAtlasTypeName('anything-unknown')).toBe('DataSet');
  });
});

// ── autoOnboardToPurview ─────────────────────────────────────────────────────

describe('autoOnboardToPurview', () => {
  it('is a no-op (no network) when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    await autoOnboardToPurview(item, 'tenant-1');
    expect(h.registerAtlasEntity).not.toHaveBeenCalled();
    expect(h.itemsContainer).not.toHaveBeenCalled();
  });

  it('uses loomTypeToAtlasTypeName (not hardcoded DataSet) for known item types', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
    const warehouseItem = { ...item, itemType: 'warehouse' };
    await autoOnboardToPurview(warehouseItem, 'tenant-1');
    expect(h.registerAtlasEntity).toHaveBeenCalledWith(
      expect.objectContaining({ typeName: 'fabric_warehouse' }),
    );
  });

  it('uses DataSet for unknown item types', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
    const pipelineItem = { ...item, itemType: 'data-pipeline' };
    await autoOnboardToPurview(pipelineItem, 'tenant-1');
    expect(h.registerAtlasEntity).toHaveBeenCalledWith(
      expect.objectContaining({ typeName: 'DataSet' }),
    );
  });

  it('writes back the primaryGuid to Cosmos state.purviewGuid when guid returned', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    const guid = 'atlas-guid-abc123';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: guid });
    await autoOnboardToPurview(item, 'tenant-1');
    expect(h.cosmosItem).toHaveBeenCalledWith('i1', 'ws1');
    expect(h.cosmosRead).toHaveBeenCalled();
    expect(h.cosmosReplace).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ purviewGuid: guid }) }),
    );
  });

  it('does NOT write back to Cosmos when primaryGuid is absent', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
    await autoOnboardToPurview(item, 'tenant-1');
    expect(h.cosmosReplace).not.toHaveBeenCalled();
  });

  it('GUID write-back failure does NOT propagate — item create still succeeds', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: 'guid-xyz' });
    h.cosmosRead.mockRejectedValue(new Error('Cosmos 503'));
    await expect(autoOnboardToPurview(item, 'tenant-1')).resolves.toBeUndefined();
  });

  it('swallows registerAtlasEntity errors (best-effort — never blocks item creation)', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockRejectedValue(new Error('403 Forbidden'));
    await expect(autoOnboardToPurview(item, 'tenant-1')).resolves.toBeUndefined();
  });

  // ── S4 class sweep: ACCOUNT-GLOBAL Atlas typedefs from TENANT-AUTHORED text.
  // Atlas classification typedefs are account-global and permanent, while a
  // Loom tenant is only a Cosmos partition. This hook used to pass
  // `state.classifications` / `state.sensitivityLabel` VERBATIM.
  describe('ATTACK: tenant-authored classification names must never reach Atlas raw', () => {
    const TA = '11111111-2222-3333-4444-555555555555';
    const TB = '99999999-8888-7777-6666-555555555555';

    it('namespaces state.classifications instead of creating a global `PII` typedef', async () => {
      process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
      h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
      const tagged = { ...item, state: { classifications: ['PII', 'Confidential'] } };
      await autoOnboardToPurview(tagged as any, TA);

      const names: string[] = h.ensureClassificationDefs.mock.calls[0][0];
      expect(names).not.toContain('PII');
      expect(names).not.toContain('Confidential');
      for (const n of names) expect(n).toMatch(/^LOOM\.CLASSIFICATION\.[0-9a-f]{8}\./);
      // …and the entity is tagged with the SAME namespaced names, not the raw ones.
      expect(h.registerAtlasEntity).toHaveBeenCalledWith(
        expect.objectContaining({ classifications: names }),
      );
    });

    it('two tenants with the SAME vocabulary word get DIFFERENT global typedefs', async () => {
      process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
      h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
      const tagged = { ...item, state: { classifications: ['PII'] } };
      await autoOnboardToPurview(tagged as any, TA);
      const a = h.ensureClassificationDefs.mock.calls[0][0][0];
      h.ensureClassificationDefs.mockClear();
      await autoOnboardToPurview(tagged as any, TB);
      const b = h.ensureClassificationDefs.mock.calls[0][0][0];
      expect(a).not.toBe(b);
    });

    it('a free-text sensitivityLabel becomes LOOM.LABEL.<t8>.*, never the raw label', async () => {
      process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
      h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
      const labelled = { ...item, state: { sensitivityLabel: 'Highly Confidential' } };
      await autoOnboardToPurview(labelled as any, TA);
      const names: string[] = h.ensureClassificationDefs.mock.calls[0][0];
      expect(names).not.toContain('Highly Confidential');
      expect(names[0]).toMatch(/^LOOM\.LABEL\.[0-9a-f]{8}\.HIGHLY_CONFIDENTIAL$/);
    });

    it('a MIP-GUID sensitivityLabelId uses the REAL MIP typedef the sensitivity route writes', async () => {
      process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
      h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
      const guid = 'defb2ab7-1b58-4e1e-9e88-0dd0a0ab8bbb';
      const labelled = { ...item, state: { sensitivityLabel: 'Secret', sensitivityLabelId: guid } };
      await autoOnboardToPurview(labelled as any, TA);
      expect(h.ensureClassificationDefs.mock.calls[0][0])
        .toEqual([`MICROSOFT.GOVERNANCE.LABELS.${guid}`]);
    });

    it('still onboards WITHOUT tags when the typedef create fails (unchanged contract)', async () => {
      process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
      h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
      h.ensureClassificationDefs.mockRejectedValue(new Error('403 Forbidden'));
      const tagged = { ...item, state: { classifications: ['PII'] } };
      await autoOnboardToPurview(tagged as any, TA);
      expect(h.registerAtlasEntity).toHaveBeenCalledWith(
        expect.objectContaining({ classifications: undefined }),
      );
    });

    it('does not call the typedef API at all when the item carries no classifications', async () => {
      process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
      h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
      await autoOnboardToPurview(item, TA);
      expect(h.ensureClassificationDefs).not.toHaveBeenCalled();
    });
  });
});

// ── offboardFromPurview ──────────────────────────────────────────────────────

describe('offboardFromPurview', () => {
  it('is a no-op (no network) when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    await offboardFromPurview(item, 'tenant-1');
    expect(h.deleteAtlasEntityByQualifiedName).not.toHaveBeenCalled();
  });

  it('soft-deletes using the SAME loom:// qualifiedName as onboard', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    const expectedQn = 'loom://tenant-1/ws1/lakehouse/i1';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
    await autoOnboardToPurview(item, 'tenant-1');
    expect(h.registerAtlasEntity).toHaveBeenCalledWith(expect.objectContaining({ qualifiedName: expectedQn }));
    await offboardFromPurview(item, 'tenant-1');
    // typeName from loomTypeToAtlasTypeName('lakehouse') = 'fabric_lakehouse'
    expect(h.deleteAtlasEntityByQualifiedName).toHaveBeenCalledWith('fabric_lakehouse', expectedQn);
  });

  it('uses the type-specific Atlas typeName on delete (matches onboard typeName)', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    const sqlItem = { ...item, itemType: 'azure-sql-database' };
    await offboardFromPurview(sqlItem, 'tenant-1');
    expect(h.deleteAtlasEntityByQualifiedName).toHaveBeenCalledWith(
      'azure_sql_db',
      expect.stringContaining('azure-sql-database'),
    );
  });

  it('swallows backend errors (best-effort — never blocks the delete)', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.deleteAtlasEntityByQualifiedName.mockRejectedValue(new Error('403'));
    await expect(offboardFromPurview(item, 'tenant-1')).resolves.toBeUndefined();
  });
});

// ── L4 — column sub-entities (onboard + LIN-GC purge) ────────────────────────

describe('column sub-entities (L4)', () => {
  const colItem = { ...item, itemType: 'azure-sql-database', state: { columns: ['Id', 'Name', 'Id'] } } as any;

  it('registers column sub-entities on onboard when the item carries a schema', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
    await autoOnboardToPurview(colItem, 'tenant-1');
    expect(h.ensureColumnEntities).toHaveBeenCalledWith(
      'azure_sql_db',
      'loom://tenant-1/ws1/azure-sql-database/i1',
      ['Id', 'Name'], // deduped by itemColumnNames
    );
  });

  it('does NOT register column entities when the item has no schema', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
    await autoOnboardToPurview(item, 'tenant-1'); // state: {}
    expect(h.ensureColumnEntities).not.toHaveBeenCalled();
  });

  it('purges column sub-entities (per column) before the parent on offboard', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    await offboardFromPurview(colItem, 'tenant-1');
    const qn = 'loom://tenant-1/ws1/azure-sql-database/i1';
    expect(h.deleteAtlasEntityByQualifiedName).toHaveBeenCalledWith('azure_sql_db_column', `${qn}#Id`);
    expect(h.deleteAtlasEntityByQualifiedName).toHaveBeenCalledWith('azure_sql_db_column', `${qn}#Name`);
    // and the parent dataset entity itself
    expect(h.deleteAtlasEntityByQualifiedName).toHaveBeenCalledWith('azure_sql_db', qn);
  });

  it('onboard still succeeds when ensureColumnEntities throws (enrichment only)', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.registerAtlasEntity.mockResolvedValue({ primaryGuid: undefined });
    h.ensureColumnEntities.mockRejectedValue(new Error('no column type'));
    await expect(autoOnboardToPurview(colItem, 'tenant-1')).resolves.toBeUndefined();
  });
});
