/**
 * Unit tests for rayfin-model-binding.ts pure helpers — the DAX read-view
 * builder + the data-plane server resolver. These back the model-bound Rayfin
 * app builder (Fabric Apps Build 2026 #28). @azure/identity is stubbed so the
 * module's AasError import (which transitively pulls identity) loads under node.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { buildReadViewDax, resolveAasDataPlaneServer } from '../rayfin-model-binding';

describe('buildReadViewDax', () => {
  it('builds SUMMARIZECOLUMNS with group-by + measures wrapped in TOPN', () => {
    const dax = buildReadViewDax({
      groupBy: [{ table: 'Sales', column: 'Region' }],
      measures: ['Total Sales'],
      topN: 50,
    });
    expect(dax).toContain('EVALUATE');
    expect(dax).toContain('TOPN(');
    expect(dax).toContain('50');
    expect(dax).toContain('SUMMARIZECOLUMNS(');
    expect(dax).toContain("'Sales'[Region]");
    expect(dax).toContain('"Total Sales", [Total Sales]');
  });

  it('emits a single-row ROW() projection when only measures are selected', () => {
    const dax = buildReadViewDax({ groupBy: [], measures: ['Revenue'] });
    expect(dax).toContain('ROW(');
    expect(dax).toContain('"Revenue", [Revenue]');
    expect(dax).not.toContain('SUMMARIZECOLUMNS');
    expect(dax).not.toContain('TOPN');
  });

  it('builds a grouped query with no measures (distinct dimension values)', () => {
    const dax = buildReadViewDax({ groupBy: [{ table: 'Date', column: 'Year' }], measures: [] });
    expect(dax).toContain('SUMMARIZECOLUMNS(');
    expect(dax).toContain("'Date'[Year]");
  });

  it('clamps topN to 1000 and defaults to 100', () => {
    expect(buildReadViewDax({ groupBy: [{ table: 'T', column: 'C' }], measures: [], topN: 99999 })).toContain('1000');
    expect(buildReadViewDax({ groupBy: [{ table: 'T', column: 'C' }], measures: [] })).toContain('100');
  });

  it('escapes single quotes in table names and strips brackets from columns/measures', () => {
    const dax = buildReadViewDax({
      groupBy: [{ table: "O'Brien", column: 'Co]l' }],
      measures: ['Me]asure'],
    });
    expect(dax).toContain("'O''Brien'[Col]");
    expect(dax).toContain('[Measure]');
  });

  it('throws when nothing is selected', () => {
    expect(() => buildReadViewDax({ groupBy: [], measures: [] })).toThrow(/at least one measure or group-by/i);
  });
});

describe('resolveAasDataPlaneServer', () => {
  const saved = { name: process.env.LOOM_AAS_SERVER_NAME, region: process.env.LOOM_AAS_REGION, suffix: process.env.LOOM_AAS_HOST_SUFFIX };
  afterEach(() => {
    process.env.LOOM_AAS_SERVER_NAME = saved.name;
    process.env.LOOM_AAS_REGION = saved.region;
    process.env.LOOM_AAS_HOST_SUFFIX = saved.suffix;
  });

  it('composes <region>.<suffix>/<server> from env', () => {
    process.env.LOOM_AAS_SERVER_NAME = 'aas-loom';
    process.env.LOOM_AAS_REGION = 'eastus2';
    process.env.LOOM_AAS_HOST_SUFFIX = 'asazure.windows.net';
    expect(resolveAasDataPlaneServer()).toBe('eastus2.asazure.windows.net/aas-loom');
  });

  it('throws an honest 503 when AAS env is unset', () => {
    delete process.env.LOOM_AAS_SERVER_NAME;
    delete process.env.LOOM_AAS_REGION;
    expect(() => resolveAasDataPlaneServer()).toThrow(/Azure Analysis Services not configured/i);
  });
});
