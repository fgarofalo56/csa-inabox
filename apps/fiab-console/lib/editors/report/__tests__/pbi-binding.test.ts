/**
 * Unit tests for the pure Weave → Power BI binding mappers
 * (lib/editors/report/pbi-binding.ts) used by the W2 "Pick a Loom item" source
 * flow. Pure — no DOM, no network — so they run under the repo's node vitest env
 * where the render tests do not.
 */
import { describe, it, expect } from 'vitest';
import {
  mExprFromBinding,
  CONNECTOR_TO_RDL,
  type PbiBindingLite,
} from '../pbi-binding';

function binding(partial: Partial<PbiBindingLite> & Pick<PbiBindingLite, 'connector'>): PbiBindingLite {
  return {
    connector: partial.connector,
    server: partial.server,
    clusterUri: partial.clusterUri,
    database: partial.database ?? 'db',
    defaultTable: partial.defaultTable,
    behindPrivateEndpoint: partial.behindPrivateEndpoint ?? false,
    sourceItemId: partial.sourceItemId ?? 'item-1',
    sourceType: partial.sourceType ?? 'lakehouse',
    sourceLabel: partial.sourceLabel ?? 'Source',
  };
}

describe('mExprFromBinding — Synapse SQL', () => {
  it('emits a schema-qualified Sql.Database source when a default table is known', () => {
    const m = mExprFromBinding(binding({
      connector: 'synapse-sql',
      server: 'ws-ondemand.sql.azuresynapse.net',
      database: 'loom_lakehouse',
      defaultTable: 'gold.sales',
    }));
    expect(m).toBe(
      'Sql.Database("ws-ondemand.sql.azuresynapse.net", "loom_lakehouse"){[Schema="gold", Item="sales"]}[Data]',
    );
  });

  it('defaults the schema to dbo for a bare table name', () => {
    const m = mExprFromBinding(binding({
      connector: 'synapse-sql', server: 'srv', database: 'db', defaultTable: 'Orders',
    }));
    expect(m).toContain('[Schema="dbo", Item="Orders"]');
  });

  it('emits a database-only Sql.Database source when no default table is known', () => {
    const m = mExprFromBinding(binding({ connector: 'synapse-sql', server: 'srv', database: 'db' }));
    expect(m).toBe('Sql.Database("srv", "db")');
  });

  it('returns null when the Synapse server is unresolved', () => {
    expect(mExprFromBinding(binding({ connector: 'synapse-sql', database: 'db' }))).toBeNull();
  });

  it('escapes embedded double quotes in coordinates', () => {
    const m = mExprFromBinding(binding({
      connector: 'synapse-sql', server: 'sr"v', database: 'd"b', defaultTable: 'dbo.t"1',
    }));
    expect(m).toContain('Sql.Database("sr""v", "d""b")');
    expect(m).toContain('Item="t""1"');
  });
});

describe('mExprFromBinding — ADX', () => {
  it('emits an AzureDataExplorer.Contents source with the table', () => {
    const m = mExprFromBinding(binding({
      connector: 'adx', clusterUri: 'https://c.kusto.windows.net', database: 'telemetry', defaultTable: 'Events',
    }));
    expect(m).toBe('AzureDataExplorer.Contents("https://c.kusto.windows.net", "telemetry", "Events")');
  });

  it('emits an empty table arg when no default table is known', () => {
    const m = mExprFromBinding(binding({ connector: 'adx', clusterUri: 'https://c', database: 'db' }));
    expect(m).toBe('AzureDataExplorer.Contents("https://c", "db", "")');
  });

  it('returns null when the cluster URI is unresolved', () => {
    expect(mExprFromBinding(binding({ connector: 'adx', database: 'db' }))).toBeNull();
  });
});

describe('mExprFromBinding — non-M connectors', () => {
  it('returns null for adls (no account-complete M)', () => {
    expect(mExprFromBinding(binding({ connector: 'adls', database: 'bronze' }))).toBeNull();
  });
  it('returns null for azure-sql without a server', () => {
    expect(mExprFromBinding(binding({ connector: 'azure-sql', database: 'db' }))).toBeNull();
  });
});

describe('CONNECTOR_TO_RDL', () => {
  it('maps synapse-sql → Synapse, azure-sql → AzureSQL, adls → ADLS', () => {
    expect(CONNECTOR_TO_RDL['synapse-sql']).toBe('Synapse');
    expect(CONNECTOR_TO_RDL['azure-sql']).toBe('AzureSQL');
    expect(CONNECTOR_TO_RDL['adls']).toBe('ADLS');
  });
  it('has no RDL analog for adx (honest gate instead)', () => {
    expect(CONNECTOR_TO_RDL['adx']).toBeUndefined();
  });
});
