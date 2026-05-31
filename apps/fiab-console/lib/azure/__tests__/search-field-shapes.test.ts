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
  type FieldRow,
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
});
