/**
 * Pure unit coverage for the mirror-source wizard's source catalog + the
 * cross-cloud (BigQuery / Oracle) credential surface. These are plain exported
 * constants with no React/DOM dependency, so this suite runs even while the
 * worktree's shared jest-dom setup is broken (documented store corruption).
 */
import { describe, it, expect } from 'vitest';
import { MIRROR_SOURCES, CREDENTIALED_SOURCES, SOURCE_FIELD_HINTS } from '../mirror-source-catalog';

describe('mirror-source wizard — BigQuery + Oracle source catalog', () => {
  const byId = (id: string) => MIRROR_SOURCES.find((s) => s.id === id);

  it('surfaces Google BigQuery backed by a bigquery connection type', () => {
    const bq = byId('GoogleBigQuery');
    expect(bq).toBeTruthy();
    expect(bq!.name).toBe('Google BigQuery');
    expect(bq!.connTypes).toContain('bigquery');
  });

  it('surfaces Oracle Database backed by an oracle connection type', () => {
    const ora = byId('Oracle');
    expect(ora).toBeTruthy();
    expect(ora!.name).toBe('Oracle Database');
    expect(ora!.connTypes).toContain('oracle');
  });

  it('keeps the original SQL/Snowflake/Cosmos sources intact', () => {
    for (const id of ['AzureSqlDatabase', 'AzureSqlMI', 'AzurePostgreSql', 'CosmosDb', 'Snowflake', 'MSSQL', 'GenericMirror']) {
      expect(byId(id), `missing source ${id}`).toBeTruthy();
    }
  });

  it('does not let BigQuery/Oracle reuse a SQL connection type', () => {
    // The credential forms differ — they must NOT accept azure-sql/generic-sql
    // connections, which would hand the wrong auth shape to the source.
    expect(byId('GoogleBigQuery')!.connTypes).not.toContain('generic-sql');
    expect(byId('Oracle')!.connTypes).not.toContain('azure-sql');
  });

  it('marks BigQuery + Oracle as own-credential sources with field hints', () => {
    expect(CREDENTIALED_SOURCES.has('GoogleBigQuery')).toBe(true);
    expect(CREDENTIALED_SOURCES.has('Oracle')).toBe(true);
    // BigQuery's server/database slots are relabeled project/dataset.
    expect(SOURCE_FIELD_HINTS.GoogleBigQuery.serverLabel).toMatch(/project/i);
    expect(SOURCE_FIELD_HINTS.GoogleBigQuery.dbLabel).toMatch(/dataset/i);
    // Oracle's server slot accepts a TNS/connect-descriptor.
    expect(SOURCE_FIELD_HINTS.Oracle.serverLabel).toMatch(/TNS|connect descriptor/i);
  });
});
