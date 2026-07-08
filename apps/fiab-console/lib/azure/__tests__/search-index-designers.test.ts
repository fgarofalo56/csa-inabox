/**
 * Contract tests for the AI Search index-designer shaping (scoring profiles,
 * custom analyzers, CORS, CMK) — lib/azure/search-index-designers.ts (AIF-16).
 * These lock the exact wire shape each visual designer round-trips to
 * PUT /indexes/{name}, replacing the raw-JSON path, per no-vaporware.md.
 *
 * Grounded in Microsoft Learn:
 *   - Scoring profiles: https://learn.microsoft.com/azure/search/index-add-scoring-profiles
 *   - Custom analyzers: https://learn.microsoft.com/azure/search/index-add-custom-analyzers
 *   - CORS + CMK: https://learn.microsoft.com/azure/search/search-security-manage-encryption-keys
 */
import { describe, it, expect } from 'vitest';
import {
  buildScoringProfile, buildScoringProfiles, parseScoringProfiles, defaultScoringFunction,
  buildCustomAnalyzer, buildCustomAnalyzers, parseCustomAnalyzers, emptyCustomAnalyzer,
  buildCorsOptions, parseCorsOptions, buildEncryptionKey, parseEncryptionKey,
  applyDesignerSections,
  type ScoringProfileRow,
} from '../search-index-designers';

describe('scoring profiles', () => {
  it('builds text weights + a freshness function with aggregation', () => {
    const p: ScoringProfileRow = {
      name: 'boost-recent',
      weights: [{ fieldName: 'title', weight: 3 }, { fieldName: 'body', weight: 1 }],
      functions: [{ ...defaultScoringFunction('freshness'), fieldName: 'updatedAt', boost: 2, boostingDuration: 'P30D' }],
      functionAggregation: 'sum',
    };
    const wire = buildScoringProfile(p);
    expect(wire.name).toBe('boost-recent');
    expect(wire.text.weights).toEqual({ title: 3, body: 1 });
    expect(wire.functions[0]).toMatchObject({ type: 'freshness', fieldName: 'updatedAt', boost: 2, freshness: { boostingDuration: 'P30D' } });
    expect(wire.functionAggregation).toBe('sum');
  });

  it('drops profiles without a name and functions without a field', () => {
    expect(buildScoringProfile({ name: '', weights: [], functions: [], functionAggregation: 'sum' })).toBeNull();
    const wire = buildScoringProfile({ name: 'p', weights: [], functions: [defaultScoringFunction('magnitude')], functionAggregation: 'sum' });
    // magnitude function has empty fieldName → filtered → no functions key
    expect(wire.functions).toBeUndefined();
  });

  it('round-trips magnitude/distance/tag through parse → build', () => {
    const rows: ScoringProfileRow[] = [{
      name: 'p1',
      weights: [{ fieldName: 'name', weight: 2 }],
      functions: [
        { ...defaultScoringFunction('magnitude'), fieldName: 'rating', boostingRangeStart: 1, boostingRangeEnd: 5, constantBoostBeyondRange: true },
        { ...defaultScoringFunction('distance'), fieldName: 'geo', referencePointParameter: 'loc', boostingDistance: 50 },
        { ...defaultScoringFunction('tag'), fieldName: 'tags', tagsParameter: 'usertags' },
      ],
      functionAggregation: 'average',
    }];
    const built = buildScoringProfiles(rows);
    const reparsed = parseScoringProfiles({ scoringProfiles: built });
    expect(reparsed[0].functions.map((f) => f.type)).toEqual(['magnitude', 'distance', 'tag']);
    expect(reparsed[0].functions[0].constantBoostBeyondRange).toBe(true);
    expect(reparsed[0].functions[1].boostingDistance).toBe(50);
    expect(reparsed[0].functionAggregation).toBe('average');
  });
});

describe('custom analyzers', () => {
  it('builds a CustomAnalyzer referencing a tokenizer + filters', () => {
    const wire = buildCustomAnalyzer({ name: 'my-an', tokenizer: 'standard_v2', tokenFilters: ['lowercase', 'asciifolding'], charFilters: ['html_strip'] });
    expect(wire).toEqual({
      '@odata.type': '#Microsoft.Azure.Search.CustomAnalyzer',
      name: 'my-an', tokenizer: 'standard_v2',
      tokenFilters: ['lowercase', 'asciifolding'], charFilters: ['html_strip'],
    });
  });

  it('omits empty filter arrays and drops nameless analyzers', () => {
    const wire = buildCustomAnalyzer({ name: 'a', tokenizer: 'keyword_v2', tokenFilters: [], charFilters: [] });
    expect(wire.tokenFilters).toBeUndefined();
    expect(buildCustomAnalyzer(emptyCustomAnalyzer())).toBeNull();
  });

  it('parses only custom analyzers (ignores built-ins)', () => {
    const idx = { analyzers: [
      { '@odata.type': '#Microsoft.Azure.Search.CustomAnalyzer', name: 'c1', tokenizer: 'whitespace', tokenFilters: ['lowercase'] },
      { '@odata.type': '#Microsoft.Azure.Search.PatternAnalyzer', name: 'builtinish' },
    ] };
    const rows = parseCustomAnalyzers(idx);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('c1');
  });
});

describe('CORS', () => {
  it('builds allowedOrigins + maxAge, returns null when disabled/empty', () => {
    expect(buildCorsOptions({ enabled: false, allowedOrigins: ['*'] })).toBeNull();
    expect(buildCorsOptions({ enabled: true, allowedOrigins: [] })).toBeNull();
    expect(buildCorsOptions({ enabled: true, allowedOrigins: ['https://a.com', ' https://b.com '], maxAgeInSeconds: 300 }))
      .toEqual({ allowedOrigins: ['https://a.com', 'https://b.com'], maxAgeInSeconds: 300 });
  });
  it('parses corsOptions', () => {
    expect(parseCorsOptions({ corsOptions: { allowedOrigins: ['*'], maxAgeInSeconds: 60 } }))
      .toEqual({ enabled: true, allowedOrigins: ['*'], maxAgeInSeconds: 60 });
    expect(parseCorsOptions({}).enabled).toBe(false);
  });
});

describe('customer-managed key', () => {
  it('builds encryptionKey with an optional UAMI identity', () => {
    expect(buildEncryptionKey({ enabled: false, keyVaultUri: 'x', keyVaultKeyName: 'y' })).toBeNull();
    expect(buildEncryptionKey({ enabled: true, keyVaultUri: 'https://v.vault.azure.net', keyVaultKeyName: 'k' }))
      .toEqual({ keyVaultUri: 'https://v.vault.azure.net', keyVaultKeyName: 'k' });
    const withId = buildEncryptionKey({ enabled: true, keyVaultUri: 'https://v.vault.azure.net', keyVaultKeyName: 'k', keyVaultKeyVersion: 'v1', userAssignedIdentity: '/subs/x/uami' });
    expect(withId.keyVaultKeyVersion).toBe('v1');
    expect(withId.identity).toEqual({ '@odata.type': '#Microsoft.Azure.Search.DataUserAssignedIdentity', userAssignedIdentity: '/subs/x/uami' });
  });
  it('parses encryptionKey', () => {
    expect(parseEncryptionKey({ encryptionKey: { keyVaultUri: 'u', keyVaultKeyName: 'k', identity: { userAssignedIdentity: '/id' } } }))
      .toMatchObject({ enabled: true, keyVaultUri: 'u', keyVaultKeyName: 'k', userAssignedIdentity: '/id' });
    expect(parseEncryptionKey({}).enabled).toBe(false);
  });
});

describe('applyDesignerSections', () => {
  const idx = {
    '@odata.context': 'ctx', '@odata.etag': 'e',
    name: 'i', fields: [{ name: 'id', type: 'Edm.String', key: true }],
    vectorSearch: { algorithms: [] },
    analyzers: [{ '@odata.type': '#Microsoft.Azure.Search.PatternAnalyzer', name: 'keep' }],
  };

  it('preserves fields/vector, strips odata, and replaces only the passed sections', () => {
    const out = applyDesignerSections(idx, {
      scoringProfiles: [{ name: 'p' }],
      corsOptions: { allowedOrigins: ['*'] },
    });
    expect(out['@odata.context']).toBeUndefined();
    expect(out['@odata.etag']).toBeUndefined();
    expect(out.fields).toBe(idx.fields);
    expect(out.vectorSearch).toBe(idx.vectorSearch);
    expect(out.scoringProfiles).toEqual([{ name: 'p' }]);
    expect(out.corsOptions).toEqual({ allowedOrigins: ['*'] });
  });

  it('merges custom analyzers while preserving non-custom ones', () => {
    const out = applyDesignerSections(idx, { analyzers: [{ '@odata.type': '#Microsoft.Azure.Search.CustomAnalyzer', name: 'new' }] });
    expect(out.analyzers.map((a: any) => a.name)).toEqual(['keep', 'new']);
  });

  it('removes cors/encryptionKey when passed null', () => {
    const withCmk = { ...idx, corsOptions: { allowedOrigins: ['*'] }, encryptionKey: { keyVaultUri: 'u' } };
    const out = applyDesignerSections(withCmk, { corsOptions: null, encryptionKey: null });
    expect(out.corsOptions).toBeUndefined();
    expect(out.encryptionKey).toBeUndefined();
  });
});
