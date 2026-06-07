import { describe, it, expect, vi } from 'vitest';

// kusto-client constructs an @azure/identity credential at module load and
// imports cosmos-client (@azure/cosmos). Stub both so the pure command-builder
// guard logic can be unit-tested without the Azure SDK transitive deps, which
// don't resolve under this vitest/ESM harness.
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('../cosmos-client', () => ({
  itemsContainer: async () => ({}),
  workspacesContainer: async () => ({}),
}));

import {
  qName,
  createOrAlterExternalTableDelta,
  createOrAlterContinuousExport,
} from '../kusto-client';

describe('qName (KQL identifier quoting)', () => {
  it('bracket-quotes a plain name', () => {
    expect(qName('raw_events')).toBe('["raw_events"]');
  });
  it('escapes embedded double-quotes', () => {
    expect(qName('a"b')).toBe('["a\\"b"]');
  });
});

describe('createOrAlterExternalTableDelta input guards', () => {
  it('rejects an empty external-table name (no network)', async () => {
    await expect(
      createOrAlterExternalTableDelta('db', '   ', 'abfss://c@a.dfs.core.windows.net/p'),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('rejects a non-abfss URI (no network)', async () => {
    await expect(
      createOrAlterExternalTableDelta('db', 'ext_x', 'https://a.blob.core.windows.net/c/p'),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('createOrAlterContinuousExport input guards', () => {
  it('rejects missing required params (no network)', async () => {
    await expect(
      createOrAlterContinuousExport('db', '', 'src', 'ext_x', '1h'),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('rejects an interval that is not a KQL timespan (no network)', async () => {
    await expect(
      createOrAlterContinuousExport('db', 'exp', 'src', 'ext_x', 'hourly'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
