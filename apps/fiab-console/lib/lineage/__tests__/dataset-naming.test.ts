/**
 * LU-8 — canonical dataset naming.
 *
 * These tests are the guard on the ONE thing that silently breaks a lineage
 * graph: two producers spelling the same physical dataset differently. Every
 * case below asserts an equivalence (or a deliberate NON-equivalence) between
 * spellings, not a value against itself.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStorageUri,
  canonicalStorageUri,
  storagePartsToUri,
  foldToTableFolder,
  canonicalDatasetIdentity,
} from '@/lib/lineage/dataset-naming';

const ABFSS = 'abfss://data@stloom.dfs.core.windows.net/silver/sales';

describe('parseStorageUri / canonicalStorageUri', () => {
  it('reduces every Azure storage spelling of ONE folder to ONE canonical URI', () => {
    // The four spellings Loom's own producers really emit.
    const spellings = [
      'abfss://data@stloom.dfs.core.windows.net/silver/sales',
      'abfs://data@stloom.dfs.core.windows.net/silver/sales/',
      'wasbs://data@stloom.blob.core.windows.net/silver/sales',
      'https://stloom.dfs.core.windows.net/data/silver/sales',
      'https://stloom.blob.core.windows.net/data/silver/sales',
      'ABFSS://Data@STLoom.dfs.core.windows.net/silver/sales',
    ];
    const canonical = spellings.map(canonicalStorageUri);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe(ABFSS);
  });

  it('keeps sovereign-cloud suffixes instead of assuming core.windows.net', () => {
    expect(canonicalStorageUri('https://stgov.dfs.core.usgovcloudapi.net/data/bronze'))
      .toBe('abfss://data@stgov.dfs.core.usgovcloudapi.net/bronze');
  });

  it('does NOT collapse different accounts, containers, or paths', () => {
    const a = canonicalStorageUri('abfss://data@acctA.dfs.core.windows.net/silver/sales');
    const b = canonicalStorageUri('abfss://data@acctB.dfs.core.windows.net/silver/sales');
    const c = canonicalStorageUri('abfss://other@acctA.dfs.core.windows.net/silver/sales');
    const d = canonicalStorageUri('abfss://data@acctA.dfs.core.windows.net/silver/returns');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('does not fold a path prefix into its parent (sales vs sales_archive)', () => {
    expect(canonicalStorageUri('abfss://data@st.dfs.core.windows.net/s/sales'))
      .not.toBe(canonicalStorageUri('abfss://data@st.dfs.core.windows.net/s/sales_archive'));
  });

  it('case-folds the identity so /Bronze and /bronze are one node', () => {
    expect(canonicalStorageUri('abfss://C@Acct.dfs.core.windows.net/Bronze/Sales'))
      .toBe('abfss://c@acct.dfs.core.windows.net/bronze/sales');
    // …while the case-faithful form stays available for the emitted OL name.
    expect(storagePartsToUri(parseStorageUri('abfss://c@acct.dfs.core.windows.net/Bronze')!))
      .toBe('abfss://c@acct.dfs.core.windows.net/Bronze');
  });

  it('returns null (and passes the string through) for non-Azure locations', () => {
    expect(parseStorageUri('s3://bucket/key')).toBeNull();
    expect(canonicalStorageUri('S3://Bucket/Key')).toBe('s3://bucket/key');
    expect(parseStorageUri('')).toBeNull();
  });

  it('round-trips parts → URI', () => {
    const p = parseStorageUri(ABFSS)!;
    expect(p).toEqual({ account: 'stloom', container: 'data', suffix: 'core.windows.net', path: 'silver/sales' });
    expect(storagePartsToUri(p)).toBe(ABFSS);
  });

  it('handles a container root (no path)', () => {
    expect(canonicalStorageUri('https://stloom.dfs.core.windows.net/data'))
      .toBe('abfss://data@stloom.dfs.core.windows.net');
  });
});

describe('foldToTableFolder', () => {
  it('folds Delta log + engine part files onto the table folder', () => {
    expect(foldToTableFolder('silver/sales/_delta_log')).toBe('silver/sales');
    expect(foldToTableFolder('silver/sales/_delta_log/00000000000000000001.json')).toBe('silver/sales');
    expect(foldToTableFolder('silver/sales/part-00000-abc.snappy.parquet')).toBe('silver/sales');
    expect(foldToTableFolder('silver/sales/_SUCCESS')).toBe('silver/sales');
    expect(foldToTableFolder('/silver/sales/')).toBe('silver/sales');
  });

  it('is idempotent and leaves a plain folder alone', () => {
    expect(foldToTableFolder(foldToTableFolder('silver/sales/_delta_log'))).toBe('silver/sales');
    expect(foldToTableFolder('silver/sales')).toBe('silver/sales');
  });

  it('makes a Spark _delta_log write and a pipeline folder sink the SAME dataset', () => {
    expect(canonicalStorageUri('abfss://data@stloom.dfs.core.windows.net/silver/sales/_delta_log'))
      .toBe(canonicalStorageUri('https://stloom.dfs.core.windows.net/data/silver/sales'));
  });
});

describe('canonicalDatasetIdentity — the value persisted as a thread-edge endpoint', () => {
  it('reduces a storage URI to the canonical abfss form', () => {
    expect(canonicalDatasetIdentity('wasbs://data@stloom.blob.core.windows.net/silver/sales/_delta_log'))
      .toBe(ABFSS);
  });

  it('reduces a SQL relation URI to the BARE 3-part name, not a sqlserver:// island', () => {
    // Only the bare 3-part form becomes a `uc:` key in normalizeIdentity, so it
    // is the only spelling that collapses onto the Unity Catalog overlay's and
    // the dbt manifest parser's node for the same relation. Persisting the full
    // `sqlserver://…` URI would create a node that joins to nothing.
    expect(canonicalDatasetIdentity('sqlserver://syn-loom.sql.azuresynapse.net:1433/loomdw.sales.orders'))
      .toBe('loomdw.sales.orders');
  });

  it('is credential-free — the identity is persisted AND rendered as a node label', () => {
    const id = canonicalDatasetIdentity(
      'https://stloom.dfs.core.windows.net/data/silver/sales?sv=2024-11-04&sig=SUPERSECRETSIGNATURE',
    );
    expect(id).toBe(ABFSS);
    expect(id.toLowerCase()).not.toContain('sig=');
  });
});

