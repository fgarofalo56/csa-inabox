/**
 * LU-11 — foreign-catalog inventory tests.
 *
 * The security-material properties here are (a) that a source with NO Trino
 * connector is never offered as federatable — a "register" affordance that
 * could not work is worse than an absent one — and (b) that a rendered catalog
 * properties block never carries a password literal.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyCatalog,
  trinoConnectorFor,
  unmountableReason,
  catalogNameFor,
  buildRegisterableSources,
  renderCatalogProperties,
  BUILTIN_CATALOGS,
  type TrinoCatalogEntry,
} from '../trino-catalogs';
import type { LoomConnectionView } from '../connections-store';

const conn = (over: Partial<LoomConnectionView>): LoomConnectionView => ({
  id: 'c1',
  tenantId: 't',
  name: 'Sales PG',
  type: 'postgres',
  authMethod: 'sql-password',
  hasSecret: true,
  createdAt: '2026-08-07T00:00:00Z',
  updatedAt: '2026-08-07T00:00:00Z',
  ...over,
} as LoomConnectionView);

describe('catalog classification', () => {
  it('classifies the in-process catalogs as built-in', () => {
    for (const b of BUILTIN_CATALOGS) expect(classifyCatalog(b, 'iceberg')).toBe('builtin');
  });

  it('classifies the deployment lake catalog as `lake`, honouring a rename', () => {
    expect(classifyCatalog('iceberg', 'iceberg')).toBe('lake');
    expect(classifyCatalog('loomlake', 'loomlake')).toBe('lake');
    // The default name is NOT special once the deployment renamed it.
    expect(classifyCatalog('iceberg', 'loomlake')).toBe('foreign');
  });

  it('classifies everything else as foreign (data outside the lake)', () => {
    expect(classifyCatalog('sales_pg', 'iceberg')).toBe('foreign');
  });
});

describe('connector mapping', () => {
  it('maps the TDS family onto sqlserver and postgres onto postgresql', () => {
    expect(trinoConnectorFor('postgres')).toBe('postgresql');
    expect(trinoConnectorFor('azure-sql')).toBe('sqlserver');
    expect(trinoConnectorFor('synapse-dedicated')).toBe('sqlserver');
    expect(trinoConnectorFor('synapse-serverless')).toBe('sqlserver');
  });

  it('refuses sources with no Trino connector, and SAYS WHY', () => {
    for (const t of ['adx', 'storage-adls', 'key-vault', 'service-bus'] as const) {
      expect(trinoConnectorFor(t)).toBeNull();
      expect(unmountableReason(t)).toBeTruthy();
    }
  });

  it('does not double-mount the lake through a storage connection', () => {
    expect(trinoConnectorFor('storage-adls')).toBeNull();
    expect(unmountableReason('storage-adls')).toMatch(/two governance identities/);
  });

  it('reports no reason for a source that CAN be mounted', () => {
    expect(unmountableReason('postgres')).toBeNull();
  });
});

describe('catalog naming (auto-bind: same name, deterministically sanitized)', () => {
  it('lower-cases and replaces characters Trino cannot carry', () => {
    expect(catalogNameFor('Sales PG')).toBe('sales-pg');
    expect(catalogNameFor('HR_Warehouse')).toBe('hr-warehouse');
    expect(catalogNameFor('  Finance.Prod  ')).toBe('finance-prod');
  });

  it('is deterministic (the mapping is inspectable, never guessed)', () => {
    expect(catalogNameFor('Sales PG')).toBe(catalogNameFor('Sales PG'));
  });
});

describe('registerable sources join', () => {
  const live: TrinoCatalogEntry[] = [
    { name: 'iceberg', connector: 'iceberg', kind: 'lake', allowed: true },
    { name: 'sales-pg', connector: 'postgresql', kind: 'foreign', allowed: true },
  ];

  it('marks a connection already mounted as a live catalog', () => {
    const [s] = buildRegisterableSources([conn({ name: 'Sales PG' })], live);
    expect(s.mounted).toBe(true);
    expect(s.mountedAs).toBe('sales-pg');
  });

  it('marks a mountable-but-unmounted connection as available', () => {
    const [s] = buildRegisterableSources([conn({ id: 'c2', name: 'HR PG' })], live);
    expect(s.mounted).toBe(false);
    expect(s.connector).toBe('postgresql');
    expect(s.unmountableReason).toBeUndefined();
  });

  it('lists an unfederatable source WITH its reason rather than dropping it', () => {
    const [s] = buildRegisterableSources([conn({ id: 'c3', name: 'Telemetry', type: 'adx' })], live);
    expect(s.connector).toBeNull();
    expect(s.unmountableReason).toBeTruthy();
    expect(s.mounted).toBe(false);
  });
});

describe('rendered catalog properties', () => {
  it('renders a real postgres connector block from the connection coordinates', () => {
    const out = renderCatalogProperties({
      connector: 'postgresql', host: 'pg.internal', database: 'sales', username: 'loom', secretRef: 'pg-sales-password',
    });
    expect(out).toContain('connector.name=postgresql');
    expect(out).toContain('connection-url=jdbc:postgresql://pg.internal:5432/sales');
    expect(out).toContain('connection-user=loom');
  });

  it('NEVER emits a password literal — only the Key Vault reference', () => {
    const out = renderCatalogProperties({
      connector: 'postgresql', host: 'h', database: 'd', username: 'u', secretRef: 'kv-secret',
    });
    expect(out).not.toMatch(/^connection-password=/m);
    expect(out).toMatch(/trinoCatalogSecrets/);
  });

  it('names the missing secret bag when the connection has no secretRef', () => {
    const out = renderCatalogProperties({ connector: 'sqlserver', host: 'h', database: 'd', username: 'u' });
    expect(out).toContain('connection-url=jdbc:sqlserver://h:1433;databaseName=d;encrypt=true');
    expect(out).toMatch(/add the Key Vault secret URI/);
  });

  it('renders kafka + mongodb blocks with their own property names', () => {
    expect(renderCatalogProperties({ connector: 'kafka', host: 'eh.servicebus' })).toContain('kafka.nodes=eh.servicebus:9093');
    expect(renderCatalogProperties({ connector: 'mongodb', host: 'cosmos' })).toContain('mongodb.connection-url=mongodb://cosmos:27017');
  });
});
