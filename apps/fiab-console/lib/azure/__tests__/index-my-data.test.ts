/**
 * Contract tests for the index-my-estate wizard's PURE artifact assembly
 * (lib/azure/index-my-data.ts) — AIF-3.
 *
 * These lock the EXACT wire shapes the coordinated import-and-vectorize pipeline
 * PUTs to the Azure AI Search data-plane (data source / index / skillset /
 * indexer), plus the deterministic artifact-name derivation, the source-support
 * matrix (lakehouse direct; warehouse / ADX honest-gated), and the schema-type
 * mapping. Per .claude/rules/no-vaporware.md — the functions under test are the
 * same ones the server orchestrator and the client preview both call, so green
 * here proves a real, valid pipeline is built (no mocks pretending to be a backend).
 *
 * Grounded in Microsoft Learn:
 *   - Import and vectorize data: https://learn.microsoft.com/azure/search/search-get-started-portal-import-vectors
 *   - Integrated vectorization (skillset + index projections + vectorizer):
 *     https://learn.microsoft.com/azure/search/vector-search-integrated-vectorization
 *   - Managed-identity ADLS Gen2 data source (ResourceId form):
 *     https://learn.microsoft.com/azure/search/search-howto-managed-identities-storage
 *   - Naming rules: https://learn.microsoft.com/rest/api/searchservice/naming-rules
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeSearchName,
  deriveArtifactNames,
  sourceSupport,
  mapSourceTypeToEdm,
  buildFieldMappingTable,
  embeddingDimensions,
  buildAdlsDataSourceDefinition,
  buildIndexDefinition,
  buildPresetSkillsetDefinition,
  buildIndexerDefinition,
  parseAbfss,
  storageAccountResourceId,
  PROJECTION_FIELDS,
} from '../index-my-data';

const EMBED = { resourceUri: 'https://aoai-loom.openai.azure.com', deploymentId: 'text-embedding-3-large', modelName: 'text-embedding-3-large' };

describe('sanitizeSearchName', () => {
  it('lowercases, collapses non-alnum to single dashes, trims edges', () => {
    expect(sanitizeSearchName('My Lakehouse!! 2024')).toBe('my-lakehouse-2024');
  });
  it('ensures the name starts with a letter', () => {
    expect(sanitizeSearchName('123-data')).toMatch(/^[a-z]/);
  });
  it('never ends with a dash and stays within length headroom', () => {
    const out = sanitizeSearchName('a'.repeat(200));
    expect(out.endsWith('-')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(96);
  });
  it('falls back when nothing usable remains', () => {
    expect(sanitizeSearchName('!!!', 'lakehouse')).toBe('lakehouse');
  });
});

describe('deriveArtifactNames', () => {
  it('is deterministic for the same item', () => {
    const a = deriveArtifactNames('lakehouse', 'Sales Data', 'abcdef12-3456');
    const b = deriveArtifactNames('lakehouse', 'Sales Data', 'abcdef12-3456');
    expect(a).toEqual(b);
  });
  it('produces four valid, distinct, id-suffixed names', () => {
    const n = deriveArtifactNames('lakehouse', 'Sales Data', 'abcdef12-3456');
    expect(n.indexName).toBe('idx-sales-data-abcdef');
    expect(n.dataSourceName).toBe('sales-data-abcdef-ds');
    expect(n.skillsetName).toBe('sales-data-abcdef-ss');
    expect(n.indexerName).toBe('sales-data-abcdef-ixr');
    const set = new Set(Object.values(n));
    expect(set.size).toBe(4);
    for (const v of Object.values(n)) expect(v).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });
  it('two same-named lakehouses get distinct names via the id fragment', () => {
    const a = deriveArtifactNames('lakehouse', 'Corpus', 'aaaaaa11');
    const b = deriveArtifactNames('lakehouse', 'Corpus', 'bbbbbb22');
    expect(a.indexName).not.toBe(b.indexName);
  });
});

describe('sourceSupport', () => {
  it('lakehouse is directly supported via adlsgen2', () => {
    const s = sourceSupport('lakehouse');
    expect(s.supported).toBe(true);
    expect(s.datasourceType).toBe('adlsgen2');
  });
  it('warehouse is honest-gated with a reason + recommended path', () => {
    const s = sourceSupport('warehouse');
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/Synapse/i);
    expect(s.recommended).toMatch(/lakehouse/i);
  });
  it('kql-database (ADX) is honest-gated with a reason + recommended path', () => {
    const s = sourceSupport('kql-database');
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/Data Explorer|Kusto/i);
    expect(s.recommended).toMatch(/export/i);
  });
});

describe('mapSourceTypeToEdm', () => {
  it('maps common SQL/Delta/JSON types to the right Edm type', () => {
    expect(mapSourceTypeToEdm('bit')).toBe('Edm.Boolean');
    expect(mapSourceTypeToEdm('bigint')).toBe('Edm.Int64');
    expect(mapSourceTypeToEdm('int')).toBe('Edm.Int32');
    expect(mapSourceTypeToEdm('float')).toBe('Edm.Double');
    expect(mapSourceTypeToEdm('datetime2')).toBe('Edm.DateTimeOffset');
    expect(mapSourceTypeToEdm('geography')).toBe('Edm.GeographyPoint');
    expect(mapSourceTypeToEdm('nvarchar(200)')).toBe('Edm.String');
  });
  it('maps decimal/numeric/money to Edm.String to preserve precision', () => {
    expect(mapSourceTypeToEdm('decimal(18,2)')).toBe('Edm.String');
    expect(mapSourceTypeToEdm('money')).toBe('Edm.String');
  });
  it('defaults unknown/empty to Edm.String', () => {
    expect(mapSourceTypeToEdm('')).toBe('Edm.String');
    expect(mapSourceTypeToEdm('weird_udt')).toBe('Edm.String');
  });
});

describe('buildFieldMappingTable', () => {
  it('maps source columns to sanitized targets + Edm types', () => {
    const t = buildFieldMappingTable([{ name: 'Order Id', type: 'bigint' }, { name: 'note', type: 'nvarchar' }]);
    expect(t[0]).toEqual({ source: 'Order Id', sourceType: 'bigint', target: 'order_id', edmType: 'Edm.Int64' });
    expect(t[1].target).toBe('note');
  });
});

describe('embeddingDimensions', () => {
  it('returns the known dimensions per model, defaults to 3072', () => {
    expect(embeddingDimensions('text-embedding-3-large')).toBe(3072);
    expect(embeddingDimensions('text-embedding-3-small')).toBe(1536);
    expect(embeddingDimensions('text-embedding-ada-002')).toBe(1536);
    expect(embeddingDimensions('mystery')).toBe(3072);
  });
});

describe('buildAdlsDataSourceDefinition', () => {
  it('emits an adlsgen2 keyless (ResourceId) managed-identity connection string', () => {
    const rid = '/subscriptions/s/resourceGroups/g/providers/Microsoft.Storage/storageAccounts/acct';
    const def = buildAdlsDataSourceDefinition({ name: 'corpus-ds', storageResourceId: rid, container: 'gold', query: 'lakehouses/corpus/' });
    expect(def.type).toBe('adlsgen2');
    expect(def.credentials.connectionString).toBe(`ResourceId=${rid};`);
    expect(def.credentials.connectionString).not.toMatch(/AccountKey|password/i);
    expect(def.container).toEqual({ name: 'gold', query: 'lakehouses/corpus' });
  });
  it('omits the query when no sub-path is given', () => {
    const def = buildAdlsDataSourceDefinition({ name: 'x-ds', storageResourceId: '/subscriptions/s', container: 'bronze' });
    expect(def.container.query).toBeUndefined();
  });
});

describe('buildIndexDefinition', () => {
  const def = buildIndexDefinition({ name: 'idx-corpus', dimensions: 3072, embedding: EMBED });

  it('creates the projection field set with chunk_id as the keyword key', () => {
    const names = def.fields.map((f: any) => f.name);
    expect(names).toEqual([PROJECTION_FIELDS.chunkId, PROJECTION_FIELDS.parentId, PROJECTION_FIELDS.title, PROJECTION_FIELDS.chunk, PROJECTION_FIELDS.vector]);
    const key = def.fields.find((f: any) => f.key);
    expect(key.name).toBe('chunk_id');
    expect(key.analyzer).toBe('keyword');
  });

  it('the vector field carries dimensions + a vectorSearchProfile', () => {
    const v = def.fields.find((f: any) => f.name === PROJECTION_FIELDS.vector);
    expect(v.type).toBe('Collection(Edm.Single)');
    expect(v.dimensions).toBe(3072);
    expect(v.vectorSearchProfile).toBeTruthy();
  });

  it('wires an azureOpenAI vectorizer referenced by the profile (query-time integrated vectorization)', () => {
    const prof = def.vectorSearch.profiles[0];
    const vec = def.vectorSearch.vectorizers[0];
    expect(vec.kind).toBe('azureOpenAI');
    expect(vec.azureOpenAIParameters.resourceUri).toBe(EMBED.resourceUri);
    expect(vec.azureOpenAIParameters.deploymentId).toBe(EMBED.deploymentId);
    expect(vec.azureOpenAIParameters.authIdentity).toBeNull(); // system-assigned MI
    expect(prof.vectorizer).toBe(vec.name);
    expect(prof.algorithm).toBe(def.vectorSearch.algorithms[0].name);
  });

  it('includes a semantic configuration over title + chunk', () => {
    const cfg = def.semantic.configurations[0];
    expect(cfg.prioritizedFields.titleField.fieldName).toBe(PROJECTION_FIELDS.title);
    expect(cfg.prioritizedFields.prioritizedContentFields[0].fieldName).toBe(PROJECTION_FIELDS.chunk);
  });
});

describe('buildPresetSkillsetDefinition', () => {
  it('documents preset: OCR + Merge + Split + Embed, projecting each chunk', () => {
    const ss = buildPresetSkillsetDefinition({ name: 'ss', targetIndexName: 'idx', preset: 'documents', embedding: EMBED, maximumPageLength: 1500, pageOverlapLength: 300 });
    const types = ss.skills.map((s: any) => s['@odata.type']);
    expect(types).toContain('#Microsoft.Skills.Vision.OcrSkill');
    expect(types).toContain('#Microsoft.Skills.Text.MergeSkill');
    expect(types).toContain('#Microsoft.Skills.Text.SplitSkill');
    expect(types).toContain('#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill');
    const split = ss.skills.find((s: any) => s['@odata.type'] === '#Microsoft.Skills.Text.SplitSkill');
    expect(split.inputs[0].source).toBe('/document/merged_content');
    expect(split.maximumPageLength).toBe(1500);
    expect(split.pageOverlapLength).toBe(300);
    // Projection carries chunk + vector + title into the target index.
    const sel = ss.indexProjections.selectors[0];
    expect(sel.targetIndexName).toBe('idx');
    expect(sel.parentKeyFieldName).toBe(PROJECTION_FIELDS.parentId);
    const mapNames = sel.mappings.map((m: any) => m.name);
    expect(mapNames).toEqual([PROJECTION_FIELDS.chunk, PROJECTION_FIELDS.vector, PROJECTION_FIELDS.title]);
    expect(ss.indexProjections.parameters.projectionMode).toBe('skipIndexingParentDocuments');
  });

  it('structured preset: no OCR/Merge; Split reads raw content', () => {
    const ss = buildPresetSkillsetDefinition({ name: 'ss', targetIndexName: 'idx', preset: 'structured', embedding: EMBED });
    const types = ss.skills.map((s: any) => s['@odata.type']);
    expect(types).not.toContain('#Microsoft.Skills.Vision.OcrSkill');
    expect(types).not.toContain('#Microsoft.Skills.Text.MergeSkill');
    const split = ss.skills.find((s: any) => s['@odata.type'] === '#Microsoft.Skills.Text.SplitSkill');
    expect(split.inputs[0].source).toBe('/document/content');
  });

  it('the embedding skill targets each chunk with the given deployment', () => {
    const ss = buildPresetSkillsetDefinition({ name: 'ss', targetIndexName: 'idx', preset: 'structured', embedding: EMBED });
    const embed = ss.skills.find((s: any) => s['@odata.type'] === '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill');
    expect(embed.context).toBe('/document/pages/*');
    expect(embed.deploymentId).toBe(EMBED.deploymentId);
    expect(embed.outputs[0].targetName).toBe('text_vector');
  });
});

describe('buildIndexerDefinition', () => {
  it('documents preset normalizes images (for OCR) and binds all three artifacts', () => {
    const ix = buildIndexerDefinition({ name: 'ixr', dataSourceName: 'ds', targetIndexName: 'idx', skillsetName: 'ss', preset: 'documents' });
    expect(ix.dataSourceName).toBe('ds');
    expect(ix.targetIndexName).toBe('idx');
    expect(ix.skillsetName).toBe('ss');
    expect(ix.parameters.configuration.imageAction).toBe('generateNormalizedImages');
  });
  it('structured preset uses json parsing', () => {
    const ix = buildIndexerDefinition({ name: 'ixr', dataSourceName: 'ds', targetIndexName: 'idx', skillsetName: 'ss', preset: 'structured' });
    expect(ix.parameters.configuration.parsingMode).toBe('json');
  });
  it('applies a validated schedule interval when given', () => {
    const ix = buildIndexerDefinition({ name: 'ixr', dataSourceName: 'ds', targetIndexName: 'idx', skillsetName: 'ss', preset: 'documents', scheduleInterval: 'PT1H' });
    expect(ix.schedule).toEqual({ interval: 'PT1H' });
  });
  it('omits the schedule for a run-once pipeline', () => {
    const ix = buildIndexerDefinition({ name: 'ixr', dataSourceName: 'ds', targetIndexName: 'idx', skillsetName: 'ss', preset: 'documents' });
    expect(ix.schedule).toBeUndefined();
  });
});

describe('parseAbfss + storageAccountResourceId', () => {
  it('parses an abfss root into container / account / root', () => {
    const p = parseAbfss('abfss://gold@dlzloomacct.dfs.core.windows.net/lakehouses/corpus');
    expect(p).toEqual({ container: 'gold', account: 'dlzloomacct', root: 'lakehouses/corpus' });
  });
  it('returns null for a non-abfss string', () => {
    expect(parseAbfss('https://foo/bar')).toBeNull();
  });
  it('builds the storage account ARM id', () => {
    expect(storageAccountResourceId('sub1', 'rg1', 'acct')).toBe('/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/acct');
  });
});
