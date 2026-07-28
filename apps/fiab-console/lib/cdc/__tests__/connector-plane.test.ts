import { describe, it, expect } from 'vitest';
import {
  CDC_SOURCES, cdcSource, isKeyVaultReference, validateConnectorWizard,
  connectorToEngineSource, deriveConnectorHealth, diffSchemas, foldSchemaCapture,
  SCHEMA_LOG_CAP,
} from '../connector-plane';

describe('CDC source registry', () => {
  it('exposes exactly the five Debezium families with engine mappings', () => {
    expect(CDC_SOURCES.map((s) => s.kind).sort()).toEqual(['mongodb', 'mysql', 'oracle', 'postgres', 'sqlserver']);
  });
  it('maps postgres + sqlserver to built-in engine source types', () => {
    expect(cdcSource('postgres')?.engineSourceType).toBe('AzurePostgreSql');
    expect(cdcSource('postgres')?.builtIn).toBe(true);
    expect(cdcSource('sqlserver')?.engineSourceType).toBe('SqlServer2025');
    expect(cdcSource('sqlserver')?.builtIn).toBe(true);
  });
  it('flags mysql/mongodb/oracle as ADF-copy (not built-in) but still mapped', () => {
    for (const k of ['mysql', 'mongodb', 'oracle']) {
      const d = cdcSource(k)!;
      expect(d.builtIn).toBe(false);
      expect(d.engineSourceType.length).toBeGreaterThan(0);
      expect(d.connectorClass).toContain('io.debezium');
    }
  });
});

describe('isKeyVaultReference', () => {
  it('accepts a bare secret name', () => {
    expect(isKeyVaultReference('my-source-password')).toBe(true);
  });
  it('accepts a vault-secret URI (commercial + gov hosts)', () => {
    expect(isKeyVaultReference('https://kv1.vault.azure.net/secrets/pw')).toBe(true);
    expect(isKeyVaultReference('https://kv1.vault.usgovcloudapi.net/secrets/pw')).toBe(true);
  });
  it('rejects an inline password (symbols outside the KV-name charset)', () => {
    expect(isKeyVaultReference('P@ssw0rd!123')).toBe(false);
    expect(isKeyVaultReference('super secret value')).toBe(false);
    expect(isKeyVaultReference('')).toBe(false);
  });
});

describe('validateConnectorWizard', () => {
  it('produces engine-consumable state for a valid Postgres connector', () => {
    const v = validateConnectorWizard({
      displayName: 'Orders', kind: 'postgres', server: 'h.postgres.database.azure.com',
      database: 'appdb', syncMode: 'incremental', tables: [{ schema: 'public', table: 'orders' }],
    });
    expect(v.ok).toBe(true);
    expect(v.state).toMatchObject({
      cdcConnector: true, kind: 'postgres', sourceType: 'AzurePostgreSql',
      server: 'h.postgres.database.azure.com', database: 'appdb', syncMode: 'incremental',
      mirroringStatus: 'NotStarted',
    });
    expect(v.state!.tables).toEqual([{ schema: 'public', table: 'orders' }]);
  });
  it('requires a name, a source kind, and a database', () => {
    const v = validateConnectorWizard({ kind: 'postgres', server: 'h', database: '' });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/name/i);
    expect(v.errors.join(' ')).toMatch(/database/i);
  });
  it('rejects an unknown source kind', () => {
    const v = validateConnectorWizard({ displayName: 'x', kind: 'db2', server: 'h', database: 'd' });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/source type/i);
  });
  it('rejects an inline password in the credential field', () => {
    const v = validateConnectorWizard({ displayName: 'x', kind: 'mysql', server: 'h', database: 'd', secretRef: 'P@ss w0rd!' });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/Key Vault/i);
  });
  it('accepts a Key Vault reference credential', () => {
    const v = validateConnectorWizard({ displayName: 'x', kind: 'mysql', server: 'h', database: 'd', secretRef: 'mysql-pw' });
    expect(v.ok).toBe(true);
    expect(v.state!.secretRef).toBe('mysql-pw');
  });
  it('coerces an unknown sync mode to incremental', () => {
    const v = validateConnectorWizard({ displayName: 'x', kind: 'postgres', server: 'h', database: 'd', syncMode: 'bogus' });
    expect(v.state!.syncMode).toBe('incremental');
  });
});

describe('connectorToEngineSource', () => {
  it('maps a stored state to the flat MirrorSource shape', () => {
    const src = connectorToEngineSource({
      sourceType: 'AzurePostgreSql', server: 'h', database: 'd',
      tables: [{ schema: 'public', table: 't' }], syncMode: 'incremental',
    } as any);
    expect(src).toEqual({ sourceType: 'AzurePostgreSql', server: 'h', database: 'd', tables: [{ schema: 'public', table: 't' }], syncMode: 'incremental' });
  });
  it('tolerates an empty/undefined state', () => {
    expect(connectorToEngineSource(undefined)).toEqual({ sourceType: '', server: '', database: '', tables: [], syncMode: undefined });
  });
});

describe('deriveConnectorHealth', () => {
  const now = Date.parse('2026-07-24T12:00:00Z');

  it('is not-started with no status', () => {
    const h = deriveConnectorHealth({ mirroringStatus: 'NotStarted', selectedTables: 3, tablesStatus: [], now });
    expect(h.phase).toBe('not-started');
    expect(h.snapshotPercent).toBe(0);
  });
  it('is snapshotting at 30% when 3 of 10 tables replicated', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ schema: 's', table: `t${i}`, status: 'replicated', mode: 'snapshot', lastSync: '2026-07-24T11:59:00Z' }));
    const h = deriveConnectorHealth({ mirroringStatus: 'Running', selectedTables: 10, tablesStatus: rows, now });
    expect(h.phase).toBe('snapshotting');
    expect(h.snapshotPercent).toBe(30);
  });
  it('is streaming with measured lag once all tables replicated incrementally', () => {
    const rows = [{ schema: 's', table: 't', status: 'replicated', mode: 'incremental', lastSync: '2026-07-24T11:59:00Z' }];
    const h = deriveConnectorHealth({ mirroringStatus: 'Running', selectedTables: 1, tablesStatus: rows, now });
    expect(h.phase).toBe('streaming');
    expect(h.streamingLagSeconds).toBe(60);
    expect(h.tablesStreaming).toBe(1);
  });
  it('is stopped when the engine reports Stopped', () => {
    const h = deriveConnectorHealth({ mirroringStatus: 'Stopped', selectedTables: 1, tablesStatus: [{ status: 'replicated', mode: 'incremental', lastSync: '2026-07-24T11:00:00Z' }], now });
    expect(h.phase).toBe('stopped');
  });
  it('is error when a run errored with no replicated tables', () => {
    const h = deriveConnectorHealth({ mirroringStatus: 'Error', selectedTables: 1, tablesStatus: [{ status: 'error', error: 'login failed' }], now });
    expect(h.phase).toBe('error');
    expect(h.message).toMatch(/login failed/);
  });
});

describe('diffSchemas / foldSchemaCapture', () => {
  it('is silent on the first capture (baseline), loud on drift', () => {
    const first = diffSchemas({}, { 'public.orders': ['id', 'total'] }, 't0');
    expect(first).toEqual([]);
    const drift = diffSchemas({ 'public.orders': ['id', 'total'] }, { 'public.orders': ['id', 'total', 'currency'] }, 't1');
    expect(drift).toEqual([{ at: 't1', kind: 'column-added', dataset: 'public.orders', column: 'currency', detail: 'Column currency added to public.orders.' }]);
  });
  it('detects table add/remove and column removal', () => {
    const events = diffSchemas(
      { 'public.a': ['x'], 'public.b': ['y'] },
      { 'public.a': [], 'public.c': ['z'] },
      't2',
    );
    const kinds = events.map((e) => `${e.kind}:${e.dataset}${e.column ? '.' + e.column : ''}`);
    expect(kinds).toContain('column-removed:public.a.x');
    expect(kinds).toContain('table-removed:public.b');
    expect(kinds).toContain('table-added:public.c');
  });
  it('folds captures into a capped, newest-first log', () => {
    let bag = foldSchemaCapture(undefined, { 't': ['a'] }, 't0');
    expect(bag.log).toEqual([]);
    bag = foldSchemaCapture(bag, { 't': ['a', 'b'] }, 't1');
    expect(bag.log[0]).toMatchObject({ kind: 'column-added', column: 'b' });
    expect(bag.tables).toEqual({ t: ['a', 'b'] });
  });
  it('caps the log length', () => {
    let bag = foldSchemaCapture(undefined, { t: ['c0'] }, 't0');
    for (let i = 1; i <= SCHEMA_LOG_CAP + 20; i++) {
      bag = foldSchemaCapture(bag, { t: [`c${i}`] }, `t${i}`);
    }
    expect(bag.log.length).toBeLessThanOrEqual(SCHEMA_LOG_CAP);
  });
});
