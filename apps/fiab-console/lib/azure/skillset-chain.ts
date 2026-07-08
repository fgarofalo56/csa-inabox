/**
 * Cognitive skill-CHAIN model + pure logic for the AI Search skillset designer
 * (SVC-2). Server-free so the `'use client'` skillset builder and any BFF/tests
 * share the exact wire contract for a `PUT /skillsets/{name}` definition.
 *
 * This owns:
 *   - the full built-in cognitive-skill family (Split / Merge / Language
 *     detection / Entity recognition / Key-phrase / Sentiment / PII / Text
 *     translation / OCR / Image analysis / Azure OpenAI embedding) + the
 *     Custom Web API skill,
 *   - chain ORDERING (`moveSkill` / `reorderSkill`),
 *   - the enrichment-tree CONTEXT-PATH + source-field pickers
 *     (`availableSourcePaths` / `contextOptions` — no hand-typed JSON),
 *   - knowledge-store projection assembly (`buildKnowledgeStore`),
 *   - definition assemble + parse (round-trips for edit).
 *
 * Every `@odata.type`, parameter name and default is grounded in Microsoft
 * Learn (Predefined skills / Create Skillset REST / Knowledge store
 * projections). No mocks — the assembled definition is sent verbatim to the
 * real AI Search data-plane.
 *   https://learn.microsoft.com/azure/search/cognitive-search-predefined-skills
 *   https://learn.microsoft.com/rest/api/searchservice/create-skillset
 *   https://learn.microsoft.com/azure/search/knowledge-store-projection-overview
 */

export type SkillType =
  | '#Microsoft.Skills.Text.SplitSkill'
  | '#Microsoft.Skills.Text.MergeSkill'
  | '#Microsoft.Skills.Text.LanguageDetectionSkill'
  | '#Microsoft.Skills.Text.V3.EntityRecognitionSkill'
  | '#Microsoft.Skills.Text.KeyPhraseExtractionSkill'
  | '#Microsoft.Skills.Text.V3.SentimentSkill'
  | '#Microsoft.Skills.Text.PIIDetectionSkill'
  | '#Microsoft.Skills.Text.TranslationSkill'
  | '#Microsoft.Skills.Vision.OcrSkill'
  | '#Microsoft.Skills.Vision.ImageAnalysisSkill'
  | '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill'
  | '#Microsoft.Skills.Custom.WebApiSkill';

export interface SkillIo {
  /** The skill's declared input/output slot name (fixed by the skill contract). */
  name: string;
  /** Enrichment-tree path feeding an input (unused for outputs). */
  source: string;
  /** Enrichment-tree node an output is written to (unused for inputs). */
  targetName?: string;
}

export interface BuiltSkill {
  /** Local React key — never serialized. */
  id: string;
  type: SkillType;
  /** Optional skill name (required-ish for Custom Web API; identifies in traces). */
  name?: string;
  /** The enrichment-tree node the skill iterates over (e.g. `/document`). */
  context: string;
  // SplitSkill
  textSplitMode?: 'pages' | 'sentences';
  maximumPageLength?: number;
  // EntityRecognitionSkill (V3)
  categories?: string[];
  minimumPrecision?: number;
  // KeyPhrase / Sentiment / OCR / ImageAnalysis default language
  defaultLanguageCode?: string;
  // SentimentSkill (V3)
  includeOpinionMining?: boolean;
  // PIIDetectionSkill
  piiCategories?: string[];
  maskingMode?: 'none' | 'replace';
  maskingCharacter?: string;
  domain?: string;
  // TranslationSkill
  defaultToLanguageCode?: string;
  defaultFromLanguageCode?: string;
  suggestedFrom?: string;
  // OcrSkill
  detectOrientation?: boolean;
  lineEnding?: 'Space' | 'CarriageReturn' | 'LineFeed';
  // ImageAnalysisSkill
  visualFeatures?: string[];
  details?: string[];
  // AzureOpenAIEmbeddingSkill
  resourceUri?: string;
  deploymentId?: string;
  modelName?: string;
  // Custom WebApiSkill
  uri?: string;
  httpMethod?: 'POST' | 'PUT';
  timeout?: string;
  batchSize?: number;
  degreeOfParallelism?: number;
  // Field mappings
  inputs: SkillIo[];
  outputs: SkillIo[];
}

export type SkillCategory = 'Text' | 'Vision' | 'Vector' | 'Custom';

export interface SkillMeta {
  label: string;
  category: SkillCategory;
  /** Short one-line description shown in the picker + card. */
  short: string;
  /** True when the skill calls a billable Cognitive/AI-service backend. */
  billable?: boolean;
}

export const SKILL_CATALOG: Record<SkillType, SkillMeta> = {
  '#Microsoft.Skills.Text.SplitSkill': {
    label: 'Split text', category: 'Text',
    short: 'Chunk text into pages or sentences for downstream skills.',
  },
  '#Microsoft.Skills.Text.MergeSkill': {
    label: 'Merge text', category: 'Text',
    short: 'Consolidate text (e.g. OCR output back into the document body).',
  },
  '#Microsoft.Skills.Text.LanguageDetectionSkill': {
    label: 'Language detection', category: 'Text', billable: true,
    short: 'Detect the dominant language of each record.',
  },
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill': {
    label: 'Entity recognition', category: 'Text', billable: true,
    short: 'Extract people, organizations, locations and more.',
  },
  '#Microsoft.Skills.Text.KeyPhraseExtractionSkill': {
    label: 'Key phrase extraction', category: 'Text', billable: true,
    short: 'Pull the key talking points out of unstructured text.',
  },
  '#Microsoft.Skills.Text.V3.SentimentSkill': {
    label: 'Sentiment', category: 'Text', billable: true,
    short: 'Positive / neutral / negative labels + optional opinion mining.',
  },
  '#Microsoft.Skills.Text.PIIDetectionSkill': {
    label: 'PII detection', category: 'Text', billable: true,
    short: 'Detect and optionally mask personally identifiable information.',
  },
  '#Microsoft.Skills.Text.TranslationSkill': {
    label: 'Text translation', category: 'Text', billable: true,
    short: 'Machine-translate text into a target language.',
  },
  '#Microsoft.Skills.Vision.OcrSkill': {
    label: 'OCR', category: 'Vision', billable: true,
    short: 'Extract printed and handwritten text from images.',
  },
  '#Microsoft.Skills.Vision.ImageAnalysisSkill': {
    label: 'Image analysis', category: 'Vision', billable: true,
    short: 'Captions, tags, objects, faces and landmarks from images.',
  },
  '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill': {
    label: 'Azure OpenAI embedding', category: 'Vector', billable: true,
    short: 'Vectorize text with an Azure OpenAI embedding deployment.',
  },
  '#Microsoft.Skills.Custom.WebApiSkill': {
    label: 'Custom Web API', category: 'Custom',
    short: 'Call your own HTTPS endpoint as an enrichment step.',
  },
};

export const SKILL_TYPES = Object.keys(SKILL_CATALOG) as SkillType[];
export const SKILL_CATEGORIES: SkillCategory[] = ['Text', 'Vision', 'Vector', 'Custom'];

/** Group the catalog by category for a sectioned picker. */
export function skillsByCategory(): Array<{ category: SkillCategory; types: SkillType[] }> {
  return SKILL_CATEGORIES.map((category) => ({
    category,
    types: SKILL_TYPES.filter((t) => SKILL_CATALOG[t].category === category),
  })).filter((g) => g.types.length > 0);
}

/** Entity categories supported by the V3 Entity Recognition skill. */
export const ENTITY_CATEGORIES = [
  'Person', 'PersonType', 'Location', 'Organization', 'Event', 'Product',
  'Skill', 'Address', 'PhoneNumber', 'Email', 'URL', 'IP', 'DateTime',
  'Quantity',
];

/** A representative set of PII entity categories (empty ⇒ all categories). */
export const PII_CATEGORIES = [
  'Person', 'PersonType', 'PhoneNumber', 'Email', 'Address', 'IPAddress',
  'URL', 'DateTime', 'Organization', 'CreditCardNumber', 'ABARoutingNumber',
  'USSocialSecurityNumber', 'USBankAccountNumber', 'USDriversLicenseNumber',
  'USUKPassportNumber', 'InternationalBankingAccountNumber',
];

/** Image Analysis visual features. */
export const IMAGE_VISUAL_FEATURES = [
  'adult', 'brands', 'categories', 'description', 'faces', 'objects', 'tags',
];
/** Image Analysis domain-specific detail models. */
export const IMAGE_DETAILS = ['celebrities', 'landmarks'];

/** Curated language codes for the language-code pickers. */
export const LANGUAGE_CODES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'nl', 'sv', 'da', 'no', 'fi',
  'pl', 'cs', 'ru', 'uk', 'tr', 'ar', 'he', 'hi', 'ja', 'ko', 'zh-Hans',
  'zh-Hant', 'th', 'vi', 'id',
];

export function newSkillId(): string {
  return Math.random().toString(36).slice(2);
}

function mkOut(name: string, targetName?: string): SkillIo {
  return { name, source: '', targetName: targetName || name };
}

/** A skill pre-filled with faithful defaults for its type. */
export function defaultSkill(type: SkillType): BuiltSkill {
  const base: BuiltSkill = {
    id: newSkillId(), type, context: '/document',
    inputs: [{ name: 'text', source: '/document/content' }],
    outputs: [mkOut('output')],
  };
  switch (type) {
    case '#Microsoft.Skills.Text.SplitSkill':
      return { ...base, textSplitMode: 'pages', maximumPageLength: 5000, defaultLanguageCode: 'en',
        inputs: [{ name: 'text', source: '/document/content' }], outputs: [mkOut('textItems', 'pages')] };
    case '#Microsoft.Skills.Text.MergeSkill':
      return { ...base,
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'itemsToInsert', source: '/document/normalized_images/*/text' },
          { name: 'offsets', source: '/document/normalized_images/*/contentOffset' },
        ],
        outputs: [mkOut('mergedText')] };
    case '#Microsoft.Skills.Text.LanguageDetectionSkill':
      return { ...base, inputs: [{ name: 'text', source: '/document/content' }], outputs: [mkOut('languageCode'), mkOut('languageName'), mkOut('score')] };
    case '#Microsoft.Skills.Text.V3.EntityRecognitionSkill':
      return { ...base, categories: ['Organization'], minimumPrecision: 0.5, defaultLanguageCode: 'en', outputs: [mkOut('organizations'), mkOut('entities')] };
    case '#Microsoft.Skills.Text.KeyPhraseExtractionSkill':
      return { ...base, defaultLanguageCode: 'en', outputs: [mkOut('keyPhrases')] };
    case '#Microsoft.Skills.Text.V3.SentimentSkill':
      return { ...base, defaultLanguageCode: 'en', includeOpinionMining: false, outputs: [mkOut('sentiment'), mkOut('confidenceScores')] };
    case '#Microsoft.Skills.Text.PIIDetectionSkill':
      return { ...base, defaultLanguageCode: 'en', minimumPrecision: 0.5, maskingMode: 'none', maskingCharacter: '*', piiCategories: [],
        outputs: [mkOut('piiEntities'), mkOut('maskedText')] };
    case '#Microsoft.Skills.Text.TranslationSkill':
      return { ...base, defaultToLanguageCode: 'en', inputs: [{ name: 'text', source: '/document/content' }], outputs: [mkOut('translatedText'), mkOut('translatedToLanguageCode'), mkOut('translatedFromLanguageCode')] };
    case '#Microsoft.Skills.Vision.OcrSkill':
      return { ...base, context: '/document/normalized_images/*', detectOrientation: true, defaultLanguageCode: 'en', lineEnding: 'Space',
        inputs: [{ name: 'image', source: '/document/normalized_images/*' }], outputs: [mkOut('text'), mkOut('layoutText')] };
    case '#Microsoft.Skills.Vision.ImageAnalysisSkill':
      return { ...base, context: '/document/normalized_images/*', defaultLanguageCode: 'en', visualFeatures: ['tags', 'description'], details: [],
        inputs: [{ name: 'image', source: '/document/normalized_images/*' }], outputs: [mkOut('tags'), mkOut('description')] };
    case '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill':
      return { ...base, resourceUri: '', deploymentId: 'text-embedding-3-large', modelName: 'text-embedding-3-large',
        inputs: [{ name: 'text', source: '/document/content' }], outputs: [mkOut('embedding')] };
    case '#Microsoft.Skills.Custom.WebApiSkill':
      return { ...base, uri: '', httpMethod: 'POST', timeout: 'PT30S', batchSize: 1000, degreeOfParallelism: 5,
        inputs: [{ name: 'text', source: '/document/content' }], outputs: [mkOut('output')] };
    default:
      return base;
  }
}

/** Serialize one built skill to its AI Search wire shape. */
export function serializeSkill(s: BuiltSkill): Record<string, any> {
  const out: Record<string, any> = {
    '@odata.type': s.type,
    context: s.context || '/document',
    inputs: (s.inputs || []).filter((i) => i.name).map((i) => ({ name: i.name, source: i.source })),
    outputs: (s.outputs || []).filter((o) => o.name).map((o) => ({ name: o.name, targetName: o.targetName || o.name })),
  };
  if (s.name && s.name.trim()) out.name = s.name.trim();
  switch (s.type) {
    case '#Microsoft.Skills.Text.SplitSkill':
      out.textSplitMode = s.textSplitMode || 'pages';
      if (s.maximumPageLength) out.maximumPageLength = s.maximumPageLength;
      if (s.defaultLanguageCode) out.defaultLanguageCode = s.defaultLanguageCode;
      break;
    case '#Microsoft.Skills.Text.V3.EntityRecognitionSkill':
      if (s.categories?.length) out.categories = s.categories;
      if (s.minimumPrecision != null) out.minimumPrecision = s.minimumPrecision;
      if (s.defaultLanguageCode) out.defaultLanguageCode = s.defaultLanguageCode;
      break;
    case '#Microsoft.Skills.Text.KeyPhraseExtractionSkill':
      if (s.defaultLanguageCode) out.defaultLanguageCode = s.defaultLanguageCode;
      break;
    case '#Microsoft.Skills.Text.V3.SentimentSkill':
      if (s.defaultLanguageCode) out.defaultLanguageCode = s.defaultLanguageCode;
      out.includeOpinionMining = !!s.includeOpinionMining;
      break;
    case '#Microsoft.Skills.Text.PIIDetectionSkill':
      if (s.defaultLanguageCode) out.defaultLanguageCode = s.defaultLanguageCode;
      if (s.minimumPrecision != null) out.minimumPrecision = s.minimumPrecision;
      out.maskingMode = s.maskingMode || 'none';
      if (s.maskingMode === 'replace' && s.maskingCharacter) out.maskingCharacter = s.maskingCharacter;
      if (s.domain) out.domain = s.domain;
      if (s.piiCategories?.length) out.piiCategories = s.piiCategories;
      break;
    case '#Microsoft.Skills.Text.TranslationSkill':
      out.defaultToLanguageCode = s.defaultToLanguageCode || 'en';
      if (s.defaultFromLanguageCode) out.defaultFromLanguageCode = s.defaultFromLanguageCode;
      if (s.suggestedFrom) out.suggestedFrom = s.suggestedFrom;
      break;
    case '#Microsoft.Skills.Vision.OcrSkill':
      out.detectOrientation = !!s.detectOrientation;
      if (s.defaultLanguageCode) out.defaultLanguageCode = s.defaultLanguageCode;
      if (s.lineEnding) out.lineEnding = s.lineEnding;
      break;
    case '#Microsoft.Skills.Vision.ImageAnalysisSkill':
      if (s.defaultLanguageCode) out.defaultLanguageCode = s.defaultLanguageCode;
      if (s.visualFeatures?.length) out.visualFeatures = s.visualFeatures;
      if (s.details?.length) out.details = s.details;
      break;
    case '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill':
      if (s.resourceUri) out.resourceUri = s.resourceUri;
      if (s.deploymentId) out.deploymentId = s.deploymentId;
      if (s.modelName) out.modelName = s.modelName;
      break;
    case '#Microsoft.Skills.Custom.WebApiSkill':
      out.uri = s.uri || '';
      out.httpMethod = s.httpMethod || 'POST';
      if (s.timeout) out.timeout = s.timeout;
      if (s.batchSize) out.batchSize = s.batchSize;
      if (s.degreeOfParallelism != null) out.degreeOfParallelism = s.degreeOfParallelism;
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chain ordering
// ---------------------------------------------------------------------------

/** Return a new array with the skill at `from` moved to `to`. No-op on bad idx. */
export function moveSkill(skills: BuiltSkill[], from: number, to: number): BuiltSkill[] {
  if (
    from === to || from < 0 || to < 0 ||
    from >= skills.length || to >= skills.length
  ) return skills;
  const copy = skills.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** Move the skill at `index` one slot up or down. No-op at the boundary. */
export function reorderSkill(skills: BuiltSkill[], index: number, direction: 'up' | 'down'): BuiltSkill[] {
  return moveSkill(skills, index, direction === 'up' ? index - 1 : index + 1);
}

// ---------------------------------------------------------------------------
// Enrichment-tree paths (context builder + source-field pickers)
// ---------------------------------------------------------------------------

/** Root document nodes always available as an input source. */
export const DOCUMENT_ROOT_PATHS = [
  '/document/content',
  '/document/merged_content',
  '/document/text',
  '/document/language',
  '/document/normalized_images/*',
  '/document/normalized_images/*/text',
  '/document/metadata_storage_name',
  '/document/metadata_storage_path',
];

/** Preset iteration contexts. */
export const CONTEXT_PRESETS = ['/document', '/document/pages/*', '/document/normalized_images/*'];

/** Join a context node and an output leaf into an enrichment-tree path. */
export function joinPath(context: string, leaf: string): string {
  const c = (context || '/document').replace(/\/+$/, '');
  const l = (leaf || '').replace(/^\/+/, '');
  return l ? `${c}/${l}` : c;
}

/** Every enrichment-tree node a skill writes (its outputs, under its context). */
export function skillOutputPaths(s: BuiltSkill): string[] {
  return (s.outputs || [])
    .filter((o) => o.name || o.targetName)
    .map((o) => joinPath(s.context, o.targetName || o.name));
}

/**
 * Source paths available to the input pickers of the skill at `uptoIndex`:
 * the document roots plus every output produced by an UPSTREAM skill
 * (indexes 0..uptoIndex-1). This is what makes the chain "ordered" — a skill
 * can only bind to what ran before it.
 */
export function availableSourcePaths(skills: BuiltSkill[], uptoIndex: number, extraRoots: string[] = []): string[] {
  const out: string[] = [...DOCUMENT_ROOT_PATHS, ...extraRoots];
  const upto = Math.max(0, Math.min(uptoIndex, skills.length));
  for (let i = 0; i < upto; i++) out.push(...skillOutputPaths(skills[i]));
  return Array.from(new Set(out.filter(Boolean)));
}

/**
 * Context nodes available to the skill at `uptoIndex`: the presets plus any
 * upstream output that can be iterated (suffixed with `/*`).
 */
export function contextOptions(skills: BuiltSkill[], uptoIndex: number): string[] {
  const out: string[] = [...CONTEXT_PRESETS];
  const upto = Math.max(0, Math.min(uptoIndex, skills.length));
  for (let i = 0; i < upto; i++) {
    for (const p of skillOutputPaths(skills[i])) out.push(p.endsWith('/*') ? p : `${p}/*`);
  }
  return Array.from(new Set(out.filter(Boolean)));
}

// ---------------------------------------------------------------------------
// Knowledge store projections
// ---------------------------------------------------------------------------

export interface KsTable { name: string; source: string; generatedKeyName?: string }
export interface KsObject { storageContainer: string; source: string; generatedKeyName?: string }
export interface KsFile { storageContainer: string; source: string }
export interface KnowledgeStoreModel { tables: KsTable[]; objects: KsObject[]; files: KsFile[] }

export function emptyKnowledgeStore(): KnowledgeStoreModel {
  return { tables: [], objects: [], files: [] };
}

export function knowledgeStoreIsEmpty(m: KnowledgeStoreModel): boolean {
  return !m || ((m.tables?.length || 0) + (m.objects?.length || 0) + (m.files?.length || 0)) === 0;
}

/**
 * Build the `knowledgeStore` block for a skillset definition. Returns
 * `undefined` when no connection string is set or no complete projection is
 * defined — so an empty knowledge store never lands on the wire.
 */
export function buildKnowledgeStore(conn: string, m: KnowledgeStoreModel): Record<string, any> | undefined {
  if (!conn || !conn.trim()) return undefined;
  const tables = (m.tables || [])
    .filter((t) => t.name?.trim() && t.source?.trim())
    .map((t) => ({ tableName: t.name.trim(), generatedKeyName: (t.generatedKeyName || `${t.name.trim()}Key`).trim(), source: t.source.trim() }));
  const objects = (m.objects || [])
    .filter((o) => o.storageContainer?.trim() && o.source?.trim())
    .map((o) => ({ storageContainer: o.storageContainer.trim(), source: o.source.trim(), ...(o.generatedKeyName?.trim() ? { generatedKeyName: o.generatedKeyName.trim() } : {}) }));
  const files = (m.files || [])
    .filter((f) => f.storageContainer?.trim() && f.source?.trim())
    .map((f) => ({ storageContainer: f.storageContainer.trim(), source: f.source.trim() }));
  if (!tables.length && !objects.length && !files.length) return undefined;
  return { storageConnectionString: conn.trim(), projections: [{ tables, objects, files }] };
}

// ---------------------------------------------------------------------------
// Assemble + parse a full skillset definition
// ---------------------------------------------------------------------------

export interface AssembleOpts {
  description?: string;
  knowledgeStore?: Record<string, any>;
}

/** Assemble the `PUT /skillsets/{name}` body from the ordered skill cards. */
export function assembleSkillsetDef(name: string, skills: BuiltSkill[], opts: AssembleOpts = {}): Record<string, any> {
  const def: Record<string, any> = {
    name,
    skills: skills.map(serializeSkill),
  };
  if (opts.description) def.description = opts.description;
  if (opts.knowledgeStore) def.knowledgeStore = opts.knowledgeStore;
  return def;
}

const KNOWN_TYPES = new Set<string>(SKILL_TYPES);

/** Deserialize one wire skill back into the builder model (for editing). */
export function parseSkill(raw: any): BuiltSkill {
  const type = (raw?.['@odata.type'] || '') as SkillType;
  const s: BuiltSkill = {
    id: newSkillId(),
    type: (KNOWN_TYPES.has(type) ? type : type) as SkillType,
    context: raw?.context || '/document',
    inputs: Array.isArray(raw?.inputs) ? raw.inputs.map((i: any) => ({ name: i?.name || '', source: i?.source || '' })) : [],
    outputs: Array.isArray(raw?.outputs) ? raw.outputs.map((o: any) => ({ name: o?.name || '', source: '', targetName: o?.targetName || o?.name || '' })) : [],
  };
  if (raw?.name) s.name = raw.name;
  // Copy per-type config verbatim so a round-trip is stable.
  if (raw?.textSplitMode !== undefined) s.textSplitMode = raw.textSplitMode;
  if (raw?.maximumPageLength !== undefined) s.maximumPageLength = raw.maximumPageLength;
  if (raw?.categories !== undefined) s.categories = raw.categories;
  if (raw?.minimumPrecision !== undefined) s.minimumPrecision = raw.minimumPrecision;
  if (raw?.defaultLanguageCode !== undefined) s.defaultLanguageCode = raw.defaultLanguageCode;
  if (raw?.includeOpinionMining !== undefined) s.includeOpinionMining = raw.includeOpinionMining;
  if (raw?.piiCategories !== undefined) s.piiCategories = raw.piiCategories;
  if (raw?.maskingMode !== undefined) s.maskingMode = raw.maskingMode;
  if (raw?.maskingCharacter !== undefined) s.maskingCharacter = raw.maskingCharacter;
  if (raw?.domain !== undefined) s.domain = raw.domain;
  if (raw?.defaultToLanguageCode !== undefined) s.defaultToLanguageCode = raw.defaultToLanguageCode;
  if (raw?.defaultFromLanguageCode !== undefined) s.defaultFromLanguageCode = raw.defaultFromLanguageCode;
  if (raw?.suggestedFrom !== undefined) s.suggestedFrom = raw.suggestedFrom;
  if (raw?.detectOrientation !== undefined) s.detectOrientation = raw.detectOrientation;
  if (raw?.lineEnding !== undefined) s.lineEnding = raw.lineEnding;
  if (raw?.visualFeatures !== undefined) s.visualFeatures = raw.visualFeatures;
  if (raw?.details !== undefined) s.details = raw.details;
  if (raw?.resourceUri !== undefined) s.resourceUri = raw.resourceUri;
  if (raw?.deploymentId !== undefined) s.deploymentId = raw.deploymentId;
  if (raw?.modelName !== undefined) s.modelName = raw.modelName;
  if (raw?.uri !== undefined) s.uri = raw.uri;
  if (raw?.httpMethod !== undefined) s.httpMethod = raw.httpMethod;
  if (raw?.timeout !== undefined) s.timeout = raw.timeout;
  if (raw?.batchSize !== undefined) s.batchSize = raw.batchSize;
  if (raw?.degreeOfParallelism !== undefined) s.degreeOfParallelism = raw.degreeOfParallelism;
  return s;
}

export interface ParsedSkillset {
  name: string;
  skills: BuiltSkill[];
  knowledgeStore: KnowledgeStoreModel;
  storageConnectionString: string;
}

/** Deserialize a full skillset definition into the builder state (for editing). */
export function parseSkillset(def: any): ParsedSkillset {
  const skills = Array.isArray(def?.skills) ? def.skills.map(parseSkill) : [];
  const ks: KnowledgeStoreModel = emptyKnowledgeStore();
  let conn = '';
  const rawKs = def?.knowledgeStore;
  if (rawKs) {
    conn = rawKs.storageConnectionString || '';
    const groups = Array.isArray(rawKs.projections) ? rawKs.projections : [];
    for (const g of groups) {
      for (const t of g?.tables || []) ks.tables.push({ name: t.tableName || t.name || '', source: t.source || '', generatedKeyName: t.generatedKeyName });
      for (const o of g?.objects || []) ks.objects.push({ storageContainer: o.storageContainer || '', source: o.source || '', generatedKeyName: o.generatedKeyName });
      for (const f of g?.files || []) ks.files.push({ storageContainer: f.storageContainer || '', source: f.source || '' });
    }
  }
  return { name: def?.name || '', skills, knowledgeStore: ks, storageConnectionString: conn };
}
