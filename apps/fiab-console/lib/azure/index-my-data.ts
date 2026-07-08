/**
 * Index-my-estate wizard — PURE artifact assembly (AIF-3). NO server imports.
 *
 * Split out of the BFF route + the `'use client'` wizard so the exact AI Search
 * wire shapes (data source / skillset / index / indexer) the coordinated
 * "Import-and-vectorize" pipeline PUTs are shared by the server orchestrator and
 * the client preview, AND are unit-testable without a live service or a
 * credential (per .claude/rules/no-vaporware.md — real REST contract, no mocks).
 *
 * This mirrors the Azure portal "Import and vectorize data" wizard, applied to
 * Loom's OWN estate (a lakehouse's ADLS Gen2 root). The pipeline it assembles is
 * the modern integrated-vectorization pattern:
 *   SplitSkill (chunk) → AzureOpenAIEmbeddingSkill (embed each chunk) →
 *   indexProjections (project each chunk as its own search document, carrying
 *   parent_id + chunk + title + text_vector).
 *
 * Grounded in Microsoft Learn:
 *   - Import and vectorize data (portal wizard the pipeline mirrors):
 *     https://learn.microsoft.com/azure/search/search-get-started-portal-import-vectors
 *   - Integrated vectorization (skillset + index projections + vectorizer):
 *     https://learn.microsoft.com/azure/search/vector-search-integrated-vectorization
 *   - Index data from ADLS Gen2 (adlsgen2 data source + managed-identity conn):
 *     https://learn.microsoft.com/azure/search/search-how-to-index-azure-data-lake-storage
 *   - Data source managed-identity connection string (ResourceId form):
 *     https://learn.microsoft.com/azure/search/search-howto-managed-identities-storage
 *   - Naming rules: https://learn.microsoft.com/rest/api/searchservice/naming-rules
 */

import {
  EMBEDDING_MODELS,
  buildVectorSearchSection,
  buildSemanticSection,
  defaultHnswParameters,
  type FieldRow,
  type Vectorizer,
} from './search-field-shapes';

/** The three Loom source item types the wizard launches from. */
export type IndexableSourceType = 'lakehouse' | 'warehouse' | 'kql-database';

/** Ingestion preset — drives parsing mode + whether OCR runs. */
export type ContentPreset = 'documents' | 'structured';

/**
 * Whether a source type can be indexed DIRECTLY by an AI Search indexer, or is
 * honest-gated (with the exact reason + the recommended Azure-native path).
 *
 * - lakehouse → SUPPORTED: its ADLS Gen2 root is a first-class `adlsgen2`
 *   indexer data source (managed identity, keyless).
 * - warehouse → GATED: the Loom warehouse is a Synapse dedicated SQL pool
 *   (`Microsoft.Synapse/workspaces`). AI Search's `azuresql` indexer only does
 *   managed-identity auth against a `Microsoft.Sql/servers` ResourceId — Synapse
 *   isn't that resource type, and Loom never stores a SQL password (Gov secret
 *   rules). Recommended: land the table in a lakehouse (CTAS/COPY INTO → ADLS
 *   Delta/JSON) and index THAT.
 * - kql-database → GATED: Azure AI Search has no native Azure Data Explorer
 *   (Kusto) indexer data-source type at all. Recommended: continuously export
 *   the ADX table to ADLS Gen2 (`.export` / continuous export) and index that
 *   lakehouse path.
 */
export interface SourceSupport {
  supported: boolean;
  /** The AI Search data-source `type` when supported. */
  datasourceType?: 'adlsgen2';
  /** Human reason the direct path is gated (honest, actionable). */
  reason?: string;
  /** The recommended Azure-native alternative when gated. */
  recommended?: string;
}

export function sourceSupport(sourceType: IndexableSourceType): SourceSupport {
  switch (sourceType) {
    case 'lakehouse':
      return { supported: true, datasourceType: 'adlsgen2' };
    case 'warehouse':
      return {
        supported: false,
        reason:
          "Azure AI Search's SQL indexer connects to a Microsoft.Sql/servers resource with a keyless " +
          'managed-identity (ResourceId) connection string. The Loom warehouse is a Synapse dedicated SQL ' +
          "pool (Microsoft.Synapse/workspaces), which isn't a supported managed-identity SQL indexer target, " +
          'and Loom never stores a SQL password.',
        recommended:
          'Land the warehouse table in a lakehouse (CTAS / COPY INTO → ADLS Gen2 Delta or JSON), then run this ' +
          'wizard from that lakehouse. The ADLS Gen2 path is a fully-supported, keyless indexer source.',
      };
    case 'kql-database':
      return {
        supported: false,
        reason:
          'Azure AI Search has no native Azure Data Explorer (Kusto) indexer data-source type — ADX tables ' +
          'cannot be crawled directly by an indexer.',
        recommended:
          "Continuously export the ADX table to ADLS Gen2 (Kusto `.export` / continuous export to an external " +
          'table), then run this wizard from the lakehouse that owns that path.',
      };
  }
}

// ----------------------------------------------------------------------------
// AI Search object naming (data source / index / skillset / indexer)
// ----------------------------------------------------------------------------

/**
 * Sanitize an arbitrary item name into a valid AI Search object name:
 * lowercase letters / digits / dashes only, must START with a letter, must NOT
 * end with a dash, no consecutive dashes, ≤ 128 chars. Grounded in Learn
 * (naming rules). Pure + exported for tests.
 */
export function sanitizeSearchName(raw: string, fallback = 'source'): string {
  let s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse any run of non-alnum to a single dash
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  // Must start with a letter.
  if (!/^[a-z]/.test(s)) s = `x-${s}`;
  s = s.replace(/-+$/, '');
  if (!s || s === 'x') s = fallback;
  return s.slice(0, 96).replace(/-+$/, ''); // leave headroom for suffixes ≤128
}

export interface ArtifactNames {
  dataSourceName: string;
  indexName: string;
  skillsetName: string;
  indexerName: string;
}

/**
 * Derive the four coordinated artifact names from the source item — deterministic
 * (same input → same names) and collision-resistant (a short id fragment keeps
 * two same-named lakehouses distinct). Pure + exported for tests.
 */
export function deriveArtifactNames(
  sourceType: IndexableSourceType,
  itemName: string,
  itemId: string,
): ArtifactNames {
  const base = sanitizeSearchName(itemName || sourceType, sourceType);
  const frag = String(itemId || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6) || '000000';
  const stem = sanitizeSearchName(`${base}-${frag}`, `${sourceType}-${frag}`);
  return {
    indexName: sanitizeSearchName(`idx-${stem}`, `idx-${frag}`),
    dataSourceName: sanitizeSearchName(`${stem}-ds`, `${frag}-ds`),
    skillsetName: sanitizeSearchName(`${stem}-ss`, `${frag}-ss`),
    indexerName: sanitizeSearchName(`${stem}-ixr`, `${frag}-ixr`),
  };
}

// ----------------------------------------------------------------------------
// Source-schema → Edm type mapping (the field-type table shown for confirmation)
// ----------------------------------------------------------------------------

/**
 * Map a source column type (SQL / Delta / Kusto / JSON) to the closest Azure AI
 * Search Edm type. Conservative: unknown → Edm.String (always safe + searchable).
 * Pure + exported for tests. Grounded in Learn's SQL→Edm mapping table (decimals
 * map to Edm.String to avoid precision loss).
 */
export function mapSourceTypeToEdm(rawType: string): string {
  const t = String(rawType || '').trim().toLowerCase();
  if (!t) return 'Edm.String';
  // Booleans
  if (/^(bit|bool|boolean)$/.test(t)) return 'Edm.Boolean';
  // Integers
  if (/^(bigint|long|int64)$/.test(t)) return 'Edm.Int64';
  if (/^(int|integer|smallint|tinyint|int32|int16|byte|short)$/.test(t)) return 'Edm.Int32';
  // Floating point (decimal/numeric/money → string to preserve precision, per Learn)
  if (/^(decimal|numeric|money|smallmoney)/.test(t)) return 'Edm.String';
  if (/^(real|float|double|single)$/.test(t)) return 'Edm.Double';
  // Temporal
  if (/(datetimeoffset|datetime|timestamp|date|time)/.test(t)) return 'Edm.DateTimeOffset';
  // Geo
  if (/(geography|geo_point|point)/.test(t)) return 'Edm.GeographyPoint';
  // Strings / everything else
  return 'Edm.String';
}

export interface SourceColumn {
  name: string;
  type: string;
}

export interface FieldMappingRow {
  source: string;
  sourceType: string;
  target: string;
  edmType: string;
}

/**
 * Build the source-column → index-field mapping table shown in the wizard's
 * "confirm schema" step. Purely informational for the chunk-projection pipeline
 * (whose index is the fixed parent/chunk/vector shape), but grounds the user in
 * the REAL source schema. Pure + exported for tests.
 */
export function buildFieldMappingTable(columns: SourceColumn[]): FieldMappingRow[] {
  return (columns || [])
    .filter((c) => c && c.name)
    .map((c) => ({
      source: c.name,
      sourceType: c.type || 'string',
      target: sanitizeSearchName(c.name, 'field').replace(/-/g, '_'),
      edmType: mapSourceTypeToEdm(c.type),
    }));
}

// ----------------------------------------------------------------------------
// Embedding dimensions
// ----------------------------------------------------------------------------

/** Vector dimensions for a known embedding model (defaults to 3072/large). */
export function embeddingDimensions(modelName: string): number {
  const hit = EMBEDDING_MODELS.find((m) => m.model === modelName);
  return hit ? hit.dimensions : 3072;
}

// ----------------------------------------------------------------------------
// Data source definition (adlsgen2, managed identity)
// ----------------------------------------------------------------------------

export interface AdlsDataSourceInput {
  name: string;
  /** Full ARM id: /subscriptions/{s}/resourceGroups/{g}/providers/Microsoft.Storage/storageAccounts/{a} */
  storageResourceId: string;
  /** Container (file system) name. */
  container: string;
  /** Optional blob path prefix inside the container (the lakehouse root / subfolder). */
  query?: string;
  description?: string;
}

/**
 * Build an `adlsgen2` data-source definition using the KEYLESS managed-identity
 * connection string (ResourceId form — no account key). The search service's
 * system-assigned identity must hold "Storage Blob Data Reader" on the account.
 * Pure + exported for tests. Grounded in Learn (managed-identity storage conn).
 */
export function buildAdlsDataSourceDefinition(input: AdlsDataSourceInput): {
  name: string;
  type: string;
  credentials: { connectionString: string };
  container: { name: string; query?: string };
  description?: string;
} {
  const rid = String(input.storageResourceId || '').replace(/\/+$/, '');
  const def: any = {
    name: input.name,
    type: 'adlsgen2',
    credentials: { connectionString: `ResourceId=${rid};` },
    container: {
      name: input.container,
      ...(input.query && input.query.trim() ? { query: input.query.replace(/^\/+|\/+$/g, '') } : {}),
    },
  };
  if (input.description) def.description = input.description;
  return def;
}

// ----------------------------------------------------------------------------
// Index definition (parent / chunk / title / text_vector) + vector + semantic
// ----------------------------------------------------------------------------

/** The fixed field names the chunk-projection pipeline writes (portal-wizard parity). */
export const PROJECTION_FIELDS = {
  parentId: 'parent_id',
  chunkId: 'chunk_id',
  chunk: 'chunk',
  title: 'title',
  vector: 'text_vector',
} as const;

const VECTOR_ALGORITHM_NAME = 'imd-hnsw';
const VECTOR_PROFILE_NAME = 'imd-vector-profile';
const VECTORIZER_NAME = 'imd-vectorizer';
const SEMANTIC_CONFIG_NAME = 'imd-semantic';

/** The index field rows the projection pipeline needs (parent/chunk/title/vector). */
export function inferIndexFields(dimensions: number): FieldRow[] {
  return [
    // chunk_id is the document key. Per the portal wizard it uses the `keyword`
    // analyzer so the generated chunk id isn't tokenized.
    { name: PROJECTION_FIELDS.chunkId, type: 'Edm.String', key: true, searchable: true, filterable: false, sortable: true, facetable: false, retrievable: true, analyzer: 'keyword' },
    { name: PROJECTION_FIELDS.parentId, type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: PROJECTION_FIELDS.title, type: 'Edm.String', searchable: true, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: PROJECTION_FIELDS.chunk, type: 'Edm.String', searchable: true, filterable: false, sortable: false, facetable: false, retrievable: true },
    { name: PROJECTION_FIELDS.vector, type: 'Collection(Edm.Single)', searchable: true, retrievable: true, dimensions, vectorSearchProfile: VECTOR_PROFILE_NAME },
  ];
}

export interface IndexDefinitionInput {
  name: string;
  dimensions: number;
  embedding: { resourceUri: string; deploymentId: string; modelName: string };
}

/**
 * Build the full index definition (fields + integrated-vectorization vectorSearch
 * + a semantic configuration over title/chunk). The `azureOpenAI` vectorizer lets
 * a `kind:'text'` vector query embed at query time via the search service's
 * managed identity (keyless). Pure + exported for tests.
 */
export function buildIndexDefinition(input: IndexDefinitionInput): Record<string, any> {
  const fields = inferIndexFields(input.dimensions).map((r) => {
    const f: any = {
      name: r.name,
      type: r.type,
      key: !!r.key,
      retrievable: r.retrievable !== false,
      searchable: !!r.searchable,
    };
    if (/^Collection\(Edm\.Single\)$/.test(r.type)) {
      f.dimensions = r.dimensions;
      f.vectorSearchProfile = r.vectorSearchProfile;
    } else {
      f.filterable = !!r.filterable;
      f.sortable = !!r.sortable;
      f.facetable = !!r.facetable;
      if (r.analyzer) f.analyzer = r.analyzer;
    }
    return f;
  });

  const vectorizer: Vectorizer = {
    name: VECTORIZER_NAME,
    kind: 'azureOpenAI',
    azureOpenAIParameters: {
      resourceUri: input.embedding.resourceUri,
      deploymentId: input.embedding.deploymentId,
      modelName: input.embedding.modelName,
      authIdentity: null, // search service system-assigned MI
    },
  };
  const vectorSearch = buildVectorSearchSection(
    [{ name: VECTOR_ALGORITHM_NAME, kind: 'hnsw', hnswParameters: defaultHnswParameters() }],
    [{ name: VECTOR_PROFILE_NAME, algorithm: VECTOR_ALGORITHM_NAME, vectorizer: VECTORIZER_NAME }],
    [vectorizer],
  );

  const semantic = buildSemanticSection([
    {
      name: SEMANTIC_CONFIG_NAME,
      prioritizedFields: {
        titleField: { fieldName: PROJECTION_FIELDS.title },
        prioritizedContentFields: [{ fieldName: PROJECTION_FIELDS.chunk }],
        prioritizedKeywordsFields: [],
      },
    },
  ]);

  return { name: input.name, fields, vectorSearch, semantic };
}

// ----------------------------------------------------------------------------
// Skillset definition (Split → AzureOpenAIEmbedding → indexProjections)
// ----------------------------------------------------------------------------

export interface SkillsetInput {
  name: string;
  targetIndexName: string;
  preset: ContentPreset;
  embedding: { resourceUri: string; deploymentId: string; modelName: string };
  /** Chunk size (chars) — SplitSkill maximumPageLength. Default 2000. */
  maximumPageLength?: number;
  /** Chunk overlap (chars). Default 500. */
  pageOverlapLength?: number;
}

/**
 * Build the integrated-vectorization skillset:
 *   [OCR (documents preset only)] → SplitSkill (chunk) →
 *   AzureOpenAIEmbeddingSkill (embed each chunk) → indexProjections (one search
 *   doc per chunk carrying parent_id + chunk + title + text_vector).
 * Pure + exported for tests. Grounded in Learn (integrated vectorization).
 */
export function buildPresetSkillsetDefinition(input: SkillsetInput): Record<string, any> {
  const maxLen = input.maximumPageLength && input.maximumPageLength > 0 ? input.maximumPageLength : 2000;
  const overlap = typeof input.pageOverlapLength === 'number' && input.pageOverlapLength >= 0 ? input.pageOverlapLength : 500;

  const skills: any[] = [];

  // Documents preset: OCR + Merge so scanned/image text feeds the split. The
  // merged text (or raw content) is the split input.
  const splitInputSource = input.preset === 'documents' ? '/document/merged_content' : '/document/content';
  if (input.preset === 'documents') {
    skills.push({
      '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
      context: '/document/normalized_images/*',
      detectOrientation: true,
      inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
      outputs: [{ name: 'text', targetName: 'text' }],
    });
    skills.push({
      '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
      context: '/document',
      inputs: [
        { name: 'text', source: '/document/content' },
        { name: 'itemsToInsert', source: '/document/normalized_images/*/text' },
      ],
      outputs: [{ name: 'mergedText', targetName: 'merged_content' }],
    });
  }

  // Chunk.
  skills.push({
    '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
    context: '/document',
    textSplitMode: 'pages',
    maximumPageLength: maxLen,
    pageOverlapLength: overlap,
    inputs: [{ name: 'text', source: splitInputSource }],
    outputs: [{ name: 'textItems', targetName: 'pages' }],
  });

  // Embed each chunk.
  skills.push({
    '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
    context: '/document/pages/*',
    resourceUri: input.embedding.resourceUri,
    deploymentId: input.embedding.deploymentId,
    modelName: input.embedding.modelName,
    inputs: [{ name: 'text', source: '/document/pages/*' }],
    outputs: [{ name: 'embedding', targetName: 'text_vector' }],
  });

  // Project each chunk as its own search document.
  const indexProjections = {
    selectors: [
      {
        targetIndexName: input.targetIndexName,
        parentKeyFieldName: PROJECTION_FIELDS.parentId,
        sourceContext: '/document/pages/*',
        mappings: [
          { name: PROJECTION_FIELDS.chunk, source: '/document/pages/*' },
          { name: PROJECTION_FIELDS.vector, source: '/document/pages/*/text_vector' },
          { name: PROJECTION_FIELDS.title, source: '/document/metadata_storage_name' },
        ],
      },
    ],
    parameters: { projectionMode: 'skipIndexingParentDocuments' },
  };

  return { name: input.name, skills, indexProjections };
}

// ----------------------------------------------------------------------------
// Indexer definition
// ----------------------------------------------------------------------------

export interface IndexerInput {
  name: string;
  dataSourceName: string;
  targetIndexName: string;
  skillsetName: string;
  preset: ContentPreset;
  /** Optional schedule interval (ISO-8601 duration, e.g. PT1H). */
  scheduleInterval?: string;
}

/**
 * Build the indexer definition binding data source + skillset + target index.
 * `parsingMode` follows the preset: documents rely on the default blob parser
 * (+ image normalization for OCR); structured JSON uses `json`. Pure + exported.
 */
export function buildIndexerDefinition(input: IndexerInput): Record<string, any> {
  const parameters: any = { configuration: {} };
  if (input.preset === 'documents') {
    // Enable image normalization so OCR sees embedded/scanned images.
    parameters.configuration.dataToExtract = 'contentAndMetadata';
    parameters.configuration.imageAction = 'generateNormalizedImages';
  } else {
    parameters.configuration.parsingMode = 'json';
    parameters.configuration.dataToExtract = 'contentAndMetadata';
  }
  const def: any = {
    name: input.name,
    dataSourceName: input.dataSourceName,
    targetIndexName: input.targetIndexName,
    skillsetName: input.skillsetName,
    parameters,
    // The projection pipeline writes chunk documents; map storage metadata to
    // fields the projection references at the document root.
    fieldMappings: [
      { sourceFieldName: 'metadata_storage_path', targetFieldName: PROJECTION_FIELDS.parentId, mappingFunction: { name: 'base64Encode' } },
    ],
  };
  if (input.scheduleInterval && input.scheduleInterval.trim()) {
    def.schedule = { interval: input.scheduleInterval.trim() };
  }
  return def;
}

// ----------------------------------------------------------------------------
// Storage account name / ResourceId helpers (parse from an abfss root)
// ----------------------------------------------------------------------------

/** Parse `abfss://<container>@<account>.dfs.<suffix>/<root>` → its parts. */
export function parseAbfss(abfss: string): { account: string; container: string; root: string } | null {
  const m = /^abfss:\/\/([^@]+)@([^.]+)\.dfs\.[^/]+\/(.*)$/i.exec(String(abfss || '').trim());
  if (!m) return null;
  return { container: m[1], account: m[2], root: (m[3] || '').replace(/^\/+|\/+$/g, '') };
}

/** Build the storage-account ARM ResourceId from its coordinates. */
export function storageAccountResourceId(sub: string, rg: string, account: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${account}`;
}
