/**
 * backing-resolver - the W0-cited key table. A resolver that "finds something"
 * for a type with no documented key is a guess, so the no-key arms are asserted
 * as hard as the resolved ones.
 */
import { describe, it, expect } from 'vitest';
import {
  BACKED_WITHOUT_DOCUMENTED_KEY,
  BACKING_KEYS,
  allKeyPaths,
  classifyBackingId,
  resolveBacking,
} from '../backing-resolver';

describe('resolveBacking', () => {
  it('lakehouse: adlsRoot from the install receipt wins over a lower-priority container key', () => {
    const r = resolveBacking('lakehouse', {
      'provisioning.secondaryIds.adlsRoot': 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/Sales',
      'provisioning.secondaryIds.container': 'bronze',
    });
    // Break value: swapping the key order would return 'bronze' (a name) here.
    expect(r).toMatchObject({
      resolverStatus: 'resolved',
      backingService: 'ADLS Gen2',
      backingResourceId: 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/Sales',
      backingIdKind: 'url',
      backingKeyPath: 'state.provisioning.secondaryIds.adlsRoot',
      reason: null,
    });
  });

  it('eventstream: resolves from the flat ehId key and reports it as a name, not an ARM id', () => {
    const r = resolveBacking('eventstream', { ehId: 'es-hub-1' });
    expect(r).toMatchObject({ resolverStatus: 'resolved', backingKeyPath: 'state.ehId', backingIdKind: 'name-or-path' });
  });

  it('stream-analytics-job: an ARM id in provisioning.resourceId is classified arm-id', () => {
    const id = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.StreamAnalytics/streamingjobs/j1';
    const r = resolveBacking('stream-analytics-job', { 'provisioning.resourceId': id });
    expect(r.backingIdKind).toBe('arm-id');
    expect(r.backingResourceId).toBe(id);
  });

  it('a type WITH keys but an item that lacks them is no-backing-key / key-absent-on-item, never resolved', () => {
    // Blank and whitespace-only values must not count as a key.
    const r = resolveBacking('warehouse', { 'provisioning.secondaryIds.database': '   ', database: '' });
    expect(r).toMatchObject({
      resolverStatus: 'no-backing-key',
      reason: 'key-absent-on-item',
      backingService: 'Synapse dedicated SQL pool',
      backingResourceId: null,
      backingKeyPath: null,
    });
  });

  it('non-string values (objects, numbers) are not backing ids', () => {
    const r = resolveBacking('lakehouse', { 'provisioning.secondaryIds.adlsRoot': { x: 1 }, storageAccount: 42 });
    expect(r.resolverStatus).toBe('no-backing-key');
  });

  it('every type the PRP says is backed but W0 gave no key resolves to no-backing-key / type-has-no-documented-key, even if the item holds a plausible value', () => {
    // Break value: a heuristic "look for any abfss value" resolver (the old
    // loomItemToScanSource shape) would resolve semantic-model here.
    for (const t of Object.keys(BACKED_WITHOUT_DOCUMENTED_KEY)) {
      const r = resolveBacking(t, { 'provisioning.secondaryIds.adlsRoot': 'abfss://c@a.dfs.core.windows.net/x', ehId: 'h', database: 'd' });
      expect(r, t).toMatchObject({ resolverStatus: 'no-backing-key', reason: 'type-has-no-documented-key', backingResourceId: null });
    }
    expect(Object.keys(BACKED_WITHOUT_DOCUMENTED_KEY).sort()).toEqual([
      'evaluation', 'kql-queryset', 'prompt-flow', 'report', 'semantic-model', 'spark-environment', 'spark-job-definition', 'workspace-monitor',
    ]);
  });

  it('an unlisted type is not-applicable and carries no backing fields', () => {
    expect(resolveBacking('dashboard', { ehId: 'x' })).toEqual({
      resolverStatus: 'not-applicable',
      backingService: null,
      backingResourceId: null,
      backingIdKind: null,
      backingKeyPath: null,
      reason: null,
    });
  });

  it('a type cannot be in both tables (a keyed type must not also be listed as keyless)', () => {
    for (const t of Object.keys(BACKED_WITHOUT_DOCUMENTED_KEY)) expect(BACKING_KEYS[t], t).toBeUndefined();
  });

  it('truncates an over-long value so a row cannot blow the page budget', () => {
    const r = resolveBacking('ai-search-index', { indexName: 'i'.repeat(1000) });
    expect(r.backingResourceId!.length).toBeLessThanOrEqual(303);
  });
});

describe('allKeyPaths / classifyBackingId', () => {
  it('lists each path once and only characters the SQL projection accepts', () => {
    const paths = allKeyPaths();
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p, p).toMatch(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/);
    expect(paths).toContain('provisioning.secondaryIds.adlsRoot');
    expect(paths).toContain('ehId');
  });

  it('classifies ids', () => {
    expect(classifyBackingId('/subscriptions/x/resourceGroups/y')).toBe('arm-id');
    expect(classifyBackingId('abfss://a@b.dfs.core.windows.net/p')).toBe('url');
    expect(classifyBackingId('https://adx.kusto.windows.net')).toBe('url');
    expect(classifyBackingId('loompool')).toBe('name-or-path');
  });
});
