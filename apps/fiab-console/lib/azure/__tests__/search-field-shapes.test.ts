/**
 * Contract tests for the Search Explorer query-options builder + the visual
 * index field-designer shaping (lib/azure/search-field-shapes.ts).
 *
 * These lock the EXACT wire shape the new Search-tab query options and the new
 * Schema-tab field designer round-trip to the Azure AI Search data-plane REST,
 * per .claude/rules/no-vaporware.md (real REST contract, no mocks pretending to
 * be a backend). The functions under test are the same ones the `'use client'`
 * editor and the server data-plane client both call, so a green here proves the
 * UI controls build a real, valid POST /docs/search and PUT /indexes payload.
 *
 * Grounded in Microsoft Learn:
 *   - Search - POST (queryType=semantic + semanticConfiguration; vectorQueries
 *     kind=text|vector): https://learn.microsoft.com/azure/search/semantic-how-to-query-request
 *     + https://learn.microsoft.com/azure/search/vector-search-how-to-query
 *   - Create/Update Index field attributes; vector fields ignore filterable/
 *     sortable/facetable/analyzer and require dimensions + vectorSearchProfile:
 *     https://learn.microsoft.com/azure/search/search-how-to-create-search-index#configure-field-definitions
 */
import { describe, it, expect } from 'vitest';
import {
  buildSearchBody,
  fieldRowToApiField,
  apiFieldToRow,
  applyFieldRows,
  isVectorFieldType,
  semanticConfigNames,
  vectorProfileNames,
  scoringProfileNames,
  facetableFieldNames,
  validateScheduleInterval,
  describeScheduleInterval,
  buildSemanticSection,
  parseSemanticSection,
  semanticEligibleFieldNames,
  buildVectorSearchSection,
  parseVectorSearchSection,
  indexHasVectorField,
  defaultHnswParameters,
  type FieldRow,
  type SemanticConfig,
  type VectorAlgorithm,
  type VectorProfile,
} from '../search-field-shapes';

describe('buildSearchBody — Search Explorer query options', () => {
  it('defaults an empty search to * and only emits provided options', () => {
    const body = buildSearchBody({ search: '' });
    expect(body).toEqual({ search: '*' });
  });

  it('shapes a simple/full text query with select, orderby, searchFields, top, count, facets', () => {
    const body = buildSearchBody({
      search: 'lake view',
      queryType: 'full',
      filter: "category eq 'docs'",
      select: 'id,name',
      orderby: 'created desc',
      searchFields: 'name,description',
      top: 10,
      count: true,
      facets: ['category'],
    });
    expect(body).toMatchObject({
      search: 'lake view',
      queryType: 'full',
      filter: "category eq 'docs'",
      select: 'id,name',
      orderby: 'created desc',
      searchFields: 'name,description',
      top: 10,
      count: true,
      facets: ['category'],
    });
  });

  it('attaches semanticConfiguration + answers/captions ONLY for a semantic query', () => {
    const body = buildSearchBody({
      search: 'how do clouds form',
      queryType: 'semantic',
      semanticConfiguration: 'my-semantic-config',
      answers: 'extractive',
      captions: 'extractive',
    });
    expect(body.queryType).toBe('semantic');
    expect(body.semanticConfiguration).toBe('my-semantic-config');
    expect(body.answers).toBe('extractive');
    expect(body.captions).toBe('extractive');
  });

  it('drops semantic-only params when the query is NOT semantic', () => {
    const body = buildSearchBody({
      search: 'x',
      queryType: 'simple',
      // these should be ignored because queryType !== 'semantic'
      semanticConfiguration: 'cfg',
      answers: 'extractive',
      captions: 'extractive',
    });
    expect(body.queryType).toBe('simple');
    expect(body.semanticConfiguration).toBeUndefined();
    expect(body.answers).toBeUndefined();
    expect(body.captions).toBeUndefined();
  });

  it('shapes a kind=text (integrated vectorization) vector query', () => {
    const body = buildSearchBody({
      vectorQueries: [{ kind: 'text', text: 'mystery novel set in London', fields: 'descriptionVector', k: 5 }],
    });
    expect(body.vectorQueries).toHaveLength(1);
    expect(body.vectorQueries[0]).toEqual({ kind: 'text', fields: 'descriptionVector', text: 'mystery novel set in London', k: 5 });
    // a text vector query must NOT carry a raw vector
    expect(body.vectorQueries[0].vector).toBeUndefined();
  });

  it('shapes a kind=vector (raw k-NN) vector query and omits the text field', () => {
    const body = buildSearchBody({
      vectorQueries: [{ kind: 'vector', vector: [0.1, 0.2, 0.3], fields: 'embedding', k: 7, exhaustive: true }],
    });
    expect(body.vectorQueries[0]).toEqual({ kind: 'vector', fields: 'embedding', vector: [0.1, 0.2, 0.3], k: 7, exhaustive: true });
    expect(body.vectorQueries[0].text).toBeUndefined();
  });

  it('emits searchMode, scoringProfile + scoringParameters, facets, and highlight with custom tags', () => {
    const body = buildSearchBody({
      search: 'hotel',
      searchMode: 'all',
      scoringProfile: 'geo',
      scoringParameters: ['mylocation--122.2,44.8'],
      facets: ['category', 'rating'],
      highlight: 'title-3,description-10',
      highlightPreTag: '<b>',
      highlightPostTag: '</b>',
    });
    expect(body.searchMode).toBe('all');
    expect(body.scoringProfile).toBe('geo');
    expect(body.scoringParameters).toEqual(['mylocation--122.2,44.8']);
    expect(body.facets).toEqual(['category', 'rating']);
    expect(body.highlight).toBe('title-3,description-10');
    expect(body.highlightPreTag).toBe('<b>');
    expect(body.highlightPostTag).toBe('</b>');
  });

  it('drops highlight tags when no highlight field is set', () => {
    const body = buildSearchBody({
      search: 'x',
      highlightPreTag: '<b>', // dangling — no `highlight`, so tags must be dropped
    });
    expect(body.highlight).toBeUndefined();
    expect(body.highlightPreTag).toBeUndefined();
    expect(body.highlightPostTag).toBeUndefined();
  });

  it('supports a hybrid query (search text + vector query together)', () => {
    const body = buildSearchBody({
      search: 'historic hotel near restaurants',
      vectorQueries: [{ kind: 'text', text: 'historic hotel near restaurants', fields: 'descriptionVector', k: 50 }],
      top: 5,
      count: true,
    });
    expect(body.search).toBe('historic hotel near restaurants');
    expect(body.vectorQueries[0].fields).toBe('descriptionVector');
    expect(body.top).toBe(5);
  });
});

describe('isVectorFieldType', () => {
  it('recognizes Collection(Edm.Single) and narrow vector types', () => {
    expect(isVectorFieldType('Collection(Edm.Single)')).toBe(true);
    expect(isVectorFieldType('Collection(Edm.Half)')).toBe(true);
    expect(isVectorFieldType('Collection(Edm.Byte)')).toBe(true);
  });
  it('rejects non-vector types', () => {
    expect(isVectorFieldType('Edm.String')).toBe(false);
    expect(isVectorFieldType('Collection(Edm.String)')).toBe(false);
    expect(isVectorFieldType('Edm.Int32')).toBe(false);
  });
});

describe('fieldRowToApiField — visual field designer → REST', () => {
  it('shapes a plain string field with its attributes + analyzer', () => {
    const f = fieldRowToApiField({
      name: 'title', type: 'Edm.String',
      searchable: true, filterable: true, sortable: true, facetable: false,
      retrievable: true, analyzer: 'en.microsoft',
    });
    expect(f).toEqual({
      name: 'title', type: 'Edm.String', key: false, retrievable: true,
      searchable: true, filterable: true, sortable: true, facetable: false,
      analyzer: 'en.microsoft',
    });
  });

  it('forces a key field to retrievable (per Learn: key must be retrievable)', () => {
    const f = fieldRowToApiField({ name: 'id', type: 'Edm.String', key: true, retrievable: false });
    expect(f.key).toBe(true);
    expect(f.retrievable).toBe(true);
  });

  it('omits analyzer when the field is not searchable', () => {
    const f = fieldRowToApiField({ name: 'code', type: 'Edm.String', searchable: false, analyzer: 'keyword' });
    expect(f.analyzer).toBeUndefined();
  });

  it('drops the ignored attributes on a vector field and emits dimensions + profile', () => {
    const f = fieldRowToApiField({
      name: 'contentVector', type: 'Collection(Edm.Single)',
      searchable: true, dimensions: 1536, vectorSearchProfile: 'my-vector-profile',
      // these are ignored for vector fields and must not survive
      filterable: true, sortable: true, facetable: true, analyzer: 'en.microsoft',
    });
    expect(f).toEqual({
      name: 'contentVector', type: 'Collection(Edm.Single)', key: false,
      retrievable: true, searchable: true,
      filterable: false, sortable: false, facetable: false,
      dimensions: 1536, vectorSearchProfile: 'my-vector-profile',
    });
    expect(f.analyzer).toBeUndefined();
  });
});

describe('applyFieldRows — round-trip preserving non-field sections', () => {
  it('rebuilds fields from rows while preserving vectorSearch + semantic + scoringProfiles', () => {
    const existing = {
      name: 'hotels',
      fields: [{ name: 'old', type: 'Edm.String' }],
      vectorSearch: { profiles: [{ name: 'p' }], algorithms: [{ name: 'a', kind: 'hnsw' }] },
      semantic: { configurations: [{ name: 'sc' }] },
      scoringProfiles: [{ name: 'sp' }],
    };
    const rows: FieldRow[] = [
      { name: 'id', type: 'Edm.String', key: true },
      { name: 'vec', type: 'Collection(Edm.Single)', searchable: true, dimensions: 768, vectorSearchProfile: 'p' },
    ];
    const merged = applyFieldRows(existing, rows);
    expect(merged.name).toBe('hotels');
    expect(merged.fields).toHaveLength(2);
    expect(merged.fields[0]).toMatchObject({ name: 'id', key: true, retrievable: true });
    expect(merged.fields[1]).toMatchObject({ name: 'vec', type: 'Collection(Edm.Single)', dimensions: 768, vectorSearchProfile: 'p' });
    // non-field sections survive the round-trip
    expect(merged.vectorSearch).toEqual(existing.vectorSearch);
    expect(merged.semantic).toEqual(existing.semantic);
    expect(merged.scoringProfiles).toEqual(existing.scoringProfiles);
  });

  it('apiFieldToRow ↔ fieldRowToApiField round-trips a representative field', () => {
    const apiField = {
      name: 'desc', type: 'Edm.String', key: false,
      searchable: true, filterable: false, sortable: false, facetable: false,
      retrievable: true, analyzer: 'standard.lucene',
    };
    const row = apiFieldToRow(apiField);
    const back = fieldRowToApiField(row);
    expect(back).toMatchObject({
      name: 'desc', type: 'Edm.String', searchable: true,
      retrievable: true, analyzer: 'standard.lucene',
    });
  });
});

describe('semanticConfigNames / vectorProfileNames — picker sources', () => {
  it('lists semantic configuration names from an index definition', () => {
    expect(semanticConfigNames({ semantic: { configurations: [{ name: 'a' }, { name: 'b' }] } })).toEqual(['a', 'b']);
    expect(semanticConfigNames({})).toEqual([]);
    expect(semanticConfigNames(null)).toEqual([]);
  });
  it('lists vector profile names from an index definition', () => {
    expect(vectorProfileNames({ vectorSearch: { profiles: [{ name: 'vp' }] } })).toEqual(['vp']);
    expect(vectorProfileNames({})).toEqual([]);
  });
  it('lists scoring profile names from an index definition', () => {
    expect(scoringProfileNames({ scoringProfiles: [{ name: 'geo' }, { name: 'boost' }] })).toEqual(['geo', 'boost']);
    expect(scoringProfileNames({})).toEqual([]);
    expect(scoringProfileNames(null)).toEqual([]);
  });
  it('lists only facetable, non-vector fields as faceting targets', () => {
    const index = {
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'category', type: 'Edm.String', facetable: true },
        { name: 'rating', type: 'Edm.Int32', facetable: true },
        { name: 'descriptionVector', type: 'Collection(Edm.Single)', facetable: true }, // vector → excluded
        { name: 'body', type: 'Edm.String', facetable: false },
      ],
    };
    expect(facetableFieldNames(index)).toEqual(['category', 'rating']);
    expect(facetableFieldNames({})).toEqual([]);
  });
});

describe('validateScheduleInterval — indexer schedule designer', () => {
  it('accepts valid ISO-8601 durations within 5min..24h', () => {
    expect(validateScheduleInterval('PT5M')).toBeNull();
    expect(validateScheduleInterval('PT30M')).toBeNull();
    expect(validateScheduleInterval('PT2H')).toBeNull();
    expect(validateScheduleInterval('P1D')).toBeNull();
    expect(validateScheduleInterval('pt1h')).toBeNull(); // case-insensitive
  });
  it('rejects sub-5-minute intervals', () => {
    expect(validateScheduleInterval('PT4M')).toMatch(/5 minutes/);
  });
  it('rejects intervals longer than 24 hours', () => {
    expect(validateScheduleInterval('P2D')).toMatch(/24 hours/);
    expect(validateScheduleInterval('PT25H')).toMatch(/24 hours/);
  });
  it('rejects empty or malformed durations', () => {
    expect(validateScheduleInterval('')).toMatch(/required/);
    expect(validateScheduleInterval('2 hours')).toMatch(/ISO-8601/);
    expect(validateScheduleInterval('P')).toMatch(/ISO-8601/);
  });
  it('describeScheduleInterval maps presets and echoes custom intervals', () => {
    expect(describeScheduleInterval('PT1H')).toBe('Hourly');
    expect(describeScheduleInterval('P1D')).toBe('Daily');
    expect(describeScheduleInterval('PT45M')).toBe('PT45M');
    expect(describeScheduleInterval(undefined)).toBe('—');
  });
});

describe('buildSemanticSection / parseSemanticSection — semantic designer', () => {
  it('builds index.semantic.configurations from designer configs, dropping empties', () => {
    const configs: SemanticConfig[] = [{
      name: 'sc1',
      prioritizedFields: {
        titleField: { fieldName: 'title' },
        prioritizedContentFields: [{ fieldName: 'content' }, { fieldName: '' as any }],
        prioritizedKeywordsFields: [{ fieldName: 'tags' }],
      },
    }];
    const out = buildSemanticSection(configs);
    expect(out.configurations).toHaveLength(1);
    expect(out.configurations[0].name).toBe('sc1');
    expect(out.configurations[0].prioritizedFields.titleField).toEqual({ fieldName: 'title' });
    expect(out.configurations[0].prioritizedFields.prioritizedContentFields).toEqual([{ fieldName: 'content' }]);
    expect(out.configurations[0].prioritizedFields.prioritizedKeywordsFields).toEqual([{ fieldName: 'tags' }]);
  });
  it('round-trips through parseSemanticSection', () => {
    const idx = { semantic: { configurations: [{ name: 'a', prioritizedFields: { titleField: { fieldName: 't' }, prioritizedContentFields: [{ fieldName: 'c' }], prioritizedKeywordsFields: [] } }] } };
    const parsed = parseSemanticSection(idx);
    expect(parsed[0].name).toBe('a');
    expect(parsed[0].prioritizedFields.titleField).toEqual({ fieldName: 't' });
    expect(parsed[0].prioritizedFields.prioritizedContentFields).toEqual([{ fieldName: 'c' }]);
    expect(parseSemanticSection({})).toEqual([]);
  });
  it('semanticEligibleFieldNames lists only searchable string fields', () => {
    const idx = { fields: [
      { name: 'id', type: 'Edm.String', key: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'vec', type: 'Collection(Edm.Single)', searchable: true },
      { name: 'count', type: 'Edm.Int32', searchable: false },
    ] };
    expect(semanticEligibleFieldNames(idx)).toEqual(['title']);
  });
});

describe('buildVectorSearchSection / parseVectorSearchSection — vector designer', () => {
  it('emits hnsw parameters with defaults and binds profiles to algorithms', () => {
    const algos: VectorAlgorithm[] = [{ name: 'hnsw-1', kind: 'hnsw', hnswParameters: { m: 8, metric: 'dotProduct' } }];
    const profiles: VectorProfile[] = [{ name: 'p1', algorithm: 'hnsw-1' }];
    const out = buildVectorSearchSection(algos, profiles);
    expect(out.algorithms[0]).toEqual({ name: 'hnsw-1', kind: 'hnsw', hnswParameters: { m: 8, efConstruction: 400, efSearch: 500, metric: 'dotProduct' } });
    expect(out.profiles[0]).toEqual({ name: 'p1', algorithm: 'hnsw-1' });
  });
  it('emits exhaustiveKnn parameters (metric only)', () => {
    const out = buildVectorSearchSection([{ name: 'ek', kind: 'exhaustiveKnn', exhaustiveKnnParameters: { metric: 'euclidean' } }], []);
    expect(out.algorithms[0]).toEqual({ name: 'ek', kind: 'exhaustiveKnn', exhaustiveKnnParameters: { metric: 'euclidean' } });
  });
  it('drops profiles missing a name or algorithm', () => {
    const out = buildVectorSearchSection([{ name: 'a', kind: 'hnsw', hnswParameters: defaultHnswParameters() }], [{ name: '', algorithm: 'a' }, { name: 'p', algorithm: '' }]);
    expect(out.profiles).toEqual([]);
  });
  it('round-trips through parseVectorSearchSection', () => {
    const idx = { vectorSearch: { algorithms: [{ name: 'h', kind: 'hnsw', hnswParameters: { m: 4, efConstruction: 400, efSearch: 500, metric: 'cosine' } }], profiles: [{ name: 'p', algorithm: 'h' }] } };
    const parsed = parseVectorSearchSection(idx);
    expect(parsed.algorithms[0].kind).toBe('hnsw');
    expect(parsed.algorithms[0].hnswParameters?.m).toBe(4);
    expect(parsed.profiles[0]).toEqual({ name: 'p', algorithm: 'h', vectorizer: undefined });
  });
  it('indexHasVectorField gates the vector designer', () => {
    expect(indexHasVectorField({ fields: [{ name: 'v', type: 'Collection(Edm.Single)' }] })).toBe(true);
    expect(indexHasVectorField({ fields: [{ name: 's', type: 'Edm.String' }] })).toBe(false);
    expect(indexHasVectorField({})).toBe(false);
  });
});
