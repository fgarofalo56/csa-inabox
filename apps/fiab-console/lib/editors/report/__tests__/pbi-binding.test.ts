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
  REPORT_CONN_TO_RDL,
  rdlFillFromReportSource,
  mExprFromReportSource,
  type PbiBindingLite,
} from '../pbi-binding';
import type { ReportDataSource } from '../report-data-source';

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

// ── W3 — GetDataGallery reuse mappers ─────────────────────────────────────────

function conn(connType: any, objectRef: any): ReportDataSource {
  return { kind: 'connection', connectionId: 'c1', connType, objectRef } as ReportDataSource;
}

describe('rdlFillFromReportSource', () => {
  it('fills AzureSQL from an azure-sql connection with real host/database', () => {
    const fill = rdlFillFromReportSource(
      conn('azure-sql', { mode: 'table', table: 'Customer' }),
      { host: 'srv.database.windows.net', database: 'salesdb', name: 'Sales' },
    );
    expect(fill).toEqual({ ok: true, type: 'AzureSQL', server: 'srv.database.windows.net', database: 'salesdb', name: 'Sales' });
  });

  it('maps synapse-serverless → Synapse and cosmos → Cosmos', () => {
    expect(rdlFillFromReportSource(conn('synapse-serverless', { mode: 'table', table: 't' }), { host: 'ws-ondemand.sql.azuresynapse.net', database: 'lake' }))
      .toMatchObject({ ok: true, type: 'Synapse' });
    expect(rdlFillFromReportSource(conn('cosmos', { mode: 'table', table: 'orders' }), { host: 'acct.documents.azure.com', database: 'db' }))
      .toMatchObject({ ok: true, type: 'Cosmos' });
  });

  it('gates a connection with no host recorded', () => {
    const fill = rdlFillFromReportSource(conn('azure-sql', { mode: 'table', table: 't' }), { database: 'db' });
    expect(fill.ok).toBe(false);
  });

  it('gates a connType with no RDL analog (databricks / postgres / adx)', () => {
    expect(rdlFillFromReportSource(conn('databricks-sql', { mode: 'table', table: 't' }), { host: 'h', database: 'd' }).ok).toBe(false);
    expect(rdlFillFromReportSource(conn('postgres', { mode: 'table', table: 't' }), { host: 'h', database: 'd' }).ok).toBe(false);
  });

  it('gates a file-upload / adls-file pick', () => {
    expect(rdlFillFromReportSource({ kind: 'file-upload', fileName: 'f.csv', format: 'csv', containerPath: 'abfss://x/f.csv' } as ReportDataSource).ok).toBe(false);
    expect(rdlFillFromReportSource({ kind: 'adls-file', container: 'bronze', path: 'a/b', format: 'parquet' } as ReportDataSource).ok).toBe(false);
  });

  it('REPORT_CONN_TO_RDL maps the SQL-family + Cosmos, not storage/databricks', () => {
    expect(REPORT_CONN_TO_RDL['azure-sql']).toBe('AzureSQL');
    expect(REPORT_CONN_TO_RDL['synapse-dedicated']).toBe('Synapse');
    expect(REPORT_CONN_TO_RDL['cosmos']).toBe('Cosmos');
    expect(REPORT_CONN_TO_RDL['storage-adls']).toBeUndefined();
    expect(REPORT_CONN_TO_RDL['databricks-sql']).toBeUndefined();
  });
});

describe('mExprFromReportSource — connections', () => {
  it('emits a schema-qualified Sql.Database step for a SQL table', () => {
    const res = mExprFromReportSource(
      conn('azure-sql', { mode: 'table', schema: 'sales', table: 'Orders' }),
      { host: 'srv', database: 'db' },
    );
    expect(res).toEqual({ ok: true, m: 'Sql.Database("srv", "db"){[Schema="sales", Item="Orders"]}[Data]' });
  });

  it('defaults schema to dbo and supports a custom query', () => {
    expect(mExprFromReportSource(conn('synapse-serverless', { mode: 'table', table: 'T' }), { host: 'h', database: 'd' }))
      .toEqual({ ok: true, m: 'Sql.Database("h", "d"){[Schema="dbo", Item="T"]}[Data]' });
    expect(mExprFromReportSource(conn('azure-sql', { mode: 'query', sql: 'SELECT 1 AS x' }), { host: 'h', database: 'd' }))
      .toEqual({ ok: true, m: 'Sql.Database("h", "d", [Query="SELECT 1 AS x"])' });
  });

  it('emits PostgreSQL.Database for a postgres connection', () => {
    expect(mExprFromReportSource(conn('postgres', { mode: 'table', table: 't' }), { host: 'h', database: 'd' }))
      .toEqual({ ok: true, m: 'PostgreSQL.Database("h", "d"){[Schema="dbo", Item="t"]}[Data]' });
  });

  it('gates a SQL connection with no host/database', () => {
    expect(mExprFromReportSource(conn('azure-sql', { mode: 'table', table: 't' }), {}).ok).toBe(false);
  });

  it('gates cosmos / databricks / adx connections (no ingest M yet)', () => {
    expect(mExprFromReportSource(conn('cosmos', { mode: 'table', table: 't' }), { host: 'h', database: 'd' }).ok).toBe(false);
    expect(mExprFromReportSource(conn('databricks-sql', { mode: 'table', table: 't' }), { host: 'h', database: 'd' }).ok).toBe(false);
  });

  it('builds a real file document from a storage-connection file (host = account)', () => {
    const res = mExprFromReportSource(
      conn('storage-adls', { mode: 'file', containerPath: 'bronze/sales/data.parquet', format: 'parquet' }),
      { host: 'acct.dfs.core.windows.net', database: '' },
    );
    expect(res).toEqual({ ok: true, m: 'Parquet.Document(AzureStorage.DataLakeContents("https://acct.dfs.core.windows.net/bronze/sales/data.parquet"))' });
  });
});

describe('mExprFromReportSource — files', () => {
  it('emits Csv.Document / Parquet.Document from an uploaded file real path', () => {
    expect(mExprFromReportSource({ kind: 'file-upload', fileName: 'a.csv', format: 'csv', containerPath: 'https://acct.dfs.core.windows.net/landing/a.csv' } as ReportDataSource))
      .toMatchObject({ ok: true });
    const parquet = mExprFromReportSource({ kind: 'file-upload', fileName: 'a.parquet', format: 'parquet', containerPath: 'abfss://landing@acct.dfs.core.windows.net/a.parquet' } as ReportDataSource);
    expect(parquet).toEqual({ ok: true, m: 'Parquet.Document(AzureStorage.DataLakeContents("abfss://landing@acct.dfs.core.windows.net/a.parquet"))' });
  });

  it('gates a delta upload (no direct Power Query delta reader)', () => {
    expect(mExprFromReportSource({ kind: 'file-upload', fileName: 'd', format: 'delta', containerPath: 'abfss://x/d' } as ReportDataSource).ok).toBe(false);
  });

  it('gates a bare adls-file pick (no storage account)', () => {
    expect(mExprFromReportSource({ kind: 'adls-file', container: 'bronze', path: 'a/b', format: 'parquet' } as ReportDataSource).ok).toBe(false);
  });
});
