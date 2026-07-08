/**
 * Server-free shaping for the AI Search index-designer sections that used to be
 * JSON-only (AIF-16): scoring profiles, custom analyzers, CORS options, and the
 * customer-managed encryption key. Each build/parse pair round-trips a slice of
 * the index definition so the `'use client'` designer and the PUT /indexes wire
 * shape agree, and so the shaping is unit testable without a network.
 *
 * Grounded in Microsoft Learn:
 *   - Scoring profiles (weights + magnitude/freshness/distance/tag functions):
 *     https://learn.microsoft.com/azure/search/index-add-scoring-profiles
 *   - Custom analyzers (tokenizer + char/token filters, built-in component names):
 *     https://learn.microsoft.com/azure/search/index-add-custom-analyzers
 *   - CORS (`corsOptions`) + customer-managed keys (`encryptionKey`):
 *     https://learn.microsoft.com/azure/search/search-security-manage-encryption-keys
 */

// ---------------------------------------------------------------------------
// Scoring profiles  (index.scoringProfiles[] + index.defaultScoringProfile)
// ---------------------------------------------------------------------------

export const SCORING_FUNCTION_TYPES = ['magnitude', 'freshness', 'distance', 'tag'] as const;
export type ScoringFunctionType = (typeof SCORING_FUNCTION_TYPES)[number];

export const INTERPOLATIONS = ['linear', 'constant', 'quadratic', 'logarithmic'] as const;
export type Interpolation = (typeof INTERPOLATIONS)[number];

export const FUNCTION_AGGREGATIONS = ['sum', 'average', 'minimum', 'maximum', 'firstMatching'] as const;
export type FunctionAggregation = (typeof FUNCTION_AGGREGATIONS)[number];

/** A single text-weight row (field → boost weight) inside a scoring profile. */
export interface WeightRow { fieldName: string; weight: number; }

/** One scoring function inside a profile. */
export interface ScoringFunctionRow {
  type: ScoringFunctionType;
  fieldName: string;
  boost: number;
  interpolation: Interpolation;
  // magnitude
  boostingRangeStart?: number;
  boostingRangeEnd?: number;
  constantBoostBeyondRange?: boolean;
  // freshness (XSD duration, e.g. P365D)
  boostingDuration?: string;
  // distance
  referencePointParameter?: string;
  boostingDistance?: number;
  // tag
  tagsParameter?: string;
}

/** One editable scoring profile. */
export interface ScoringProfileRow {
  name: string;
  weights: WeightRow[];
  functions: ScoringFunctionRow[];
  functionAggregation: FunctionAggregation;
}

export function emptyScoringProfile(): ScoringProfileRow {
  return { name: '', weights: [], functions: [], functionAggregation: 'sum' };
}

export function defaultScoringFunction(type: ScoringFunctionType): ScoringFunctionRow {
  const base: ScoringFunctionRow = { type, fieldName: '', boost: 2, interpolation: 'linear' };
  if (type === 'magnitude') return { ...base, boostingRangeStart: 0, boostingRangeEnd: 100, constantBoostBeyondRange: false };
  if (type === 'freshness') return { ...base, boostingDuration: 'P365D' };
  if (type === 'distance') return { ...base, referencePointParameter: 'mylocation', boostingDistance: 100 };
  return { ...base, tagsParameter: 'tags' };
}

function buildScoringFunction(fn: ScoringFunctionRow): any {
  const out: any = { type: fn.type, fieldName: fn.fieldName, boost: fn.boost, interpolation: fn.interpolation };
  if (fn.type === 'magnitude') {
    out.magnitude = {
      boostingRangeStart: fn.boostingRangeStart ?? 0,
      boostingRangeEnd: fn.boostingRangeEnd ?? 100,
      constantBoostBeyondRange: !!fn.constantBoostBeyondRange,
    };
  } else if (fn.type === 'freshness') {
    out.freshness = { boostingDuration: fn.boostingDuration || 'P365D' };
  } else if (fn.type === 'distance') {
    out.distance = { referencePointParameter: fn.referencePointParameter || 'mylocation', boostingDistance: fn.boostingDistance ?? 100 };
  } else {
    out.tag = { tagsParameter: fn.tagsParameter || 'tags' };
  }
  return out;
}

/** Build one `scoringProfiles[]` entry from an editable row. */
export function buildScoringProfile(p: ScoringProfileRow): any | null {
  const name = (p.name || '').trim();
  if (!name) return null;
  const out: any = { name };
  const weights = (p.weights || []).filter((w) => w.fieldName && w.fieldName.trim());
  if (weights.length) {
    out.text = { weights: Object.fromEntries(weights.map((w) => [w.fieldName.trim(), Number(w.weight) || 1])) };
  }
  const functions = (p.functions || []).filter((f) => f.fieldName && f.fieldName.trim()).map(buildScoringFunction);
  if (functions.length) {
    out.functions = functions;
    out.functionAggregation = p.functionAggregation || 'sum';
  }
  return out;
}

export function buildScoringProfiles(rows: ScoringProfileRow[]): any[] {
  return (rows || []).map(buildScoringProfile).filter((p): p is any => p != null);
}

function parseScoringFunction(fn: any): ScoringFunctionRow {
  const type: ScoringFunctionType = (SCORING_FUNCTION_TYPES as readonly string[]).includes(fn?.type) ? fn.type : 'magnitude';
  const row: ScoringFunctionRow = {
    type,
    fieldName: fn?.fieldName ?? '',
    boost: typeof fn?.boost === 'number' ? fn.boost : 2,
    interpolation: (INTERPOLATIONS as readonly string[]).includes(fn?.interpolation) ? fn.interpolation : 'linear',
  };
  if (type === 'magnitude') {
    row.boostingRangeStart = fn?.magnitude?.boostingRangeStart ?? 0;
    row.boostingRangeEnd = fn?.magnitude?.boostingRangeEnd ?? 100;
    row.constantBoostBeyondRange = !!fn?.magnitude?.constantBoostBeyondRange;
  } else if (type === 'freshness') {
    row.boostingDuration = fn?.freshness?.boostingDuration || 'P365D';
  } else if (type === 'distance') {
    row.referencePointParameter = fn?.distance?.referencePointParameter || 'mylocation';
    row.boostingDistance = fn?.distance?.boostingDistance ?? 100;
  } else {
    row.tagsParameter = fn?.tag?.tagsParameter || 'tags';
  }
  return row;
}

/** Parse `index.scoringProfiles[]` into editable rows. */
export function parseScoringProfiles(index: any): ScoringProfileRow[] {
  const profs = index?.scoringProfiles;
  if (!Array.isArray(profs)) return [];
  return profs.map((p: any) => ({
    name: p?.name ?? '',
    weights: p?.text?.weights && typeof p.text.weights === 'object'
      ? Object.entries(p.text.weights).map(([fieldName, weight]) => ({ fieldName, weight: Number(weight) || 1 }))
      : [],
    functions: Array.isArray(p?.functions) ? p.functions.map(parseScoringFunction) : [],
    functionAggregation: (FUNCTION_AGGREGATIONS as readonly string[]).includes(p?.functionAggregation) ? p.functionAggregation : 'sum',
  }));
}

// ---------------------------------------------------------------------------
// Custom analyzers  (index.analyzers[] referencing built-in tokenizer/filters)
// ---------------------------------------------------------------------------

/** Built-in tokenizers a custom analyzer can reference by name. */
export const BUILTIN_TOKENIZERS = [
  'standard_v2', 'classic', 'keyword_v2', 'letter', 'lowercase', 'whitespace',
  'uax_url_email', 'pattern', 'microsoft_language_tokenizer',
] as const;

/** Built-in token filters (common subset). */
export const BUILTIN_TOKEN_FILTERS = [
  'apostrophe', 'asciifolding', 'classic', 'elision', 'kstem', 'length', 'lowercase',
  'porter_stem', 'reverse', 'snowball', 'stemmer', 'stopwords', 'trim', 'truncate',
  'unique', 'uppercase', 'word_delimiter',
] as const;

/** Built-in char filters. */
export const BUILTIN_CHAR_FILTERS = ['html_strip'] as const;

/** Built-in named analyzers (for the analyzer picker reference list). */
export const BUILTIN_ANALYZERS = [
  'standard.lucene', 'standardasciifolding.lucene', 'keyword', 'pattern',
  'simple', 'stop', 'whitespace',
] as const;

/** One editable custom analyzer. */
export interface CustomAnalyzerRow {
  name: string;
  tokenizer: string;
  tokenFilters: string[];
  charFilters: string[];
}

export function emptyCustomAnalyzer(): CustomAnalyzerRow {
  return { name: '', tokenizer: 'standard_v2', tokenFilters: [], charFilters: [] };
}

/** Build one `analyzers[]` entry (CustomAnalyzer) from an editable row. */
export function buildCustomAnalyzer(a: CustomAnalyzerRow): any | null {
  const name = (a.name || '').trim();
  if (!name || !a.tokenizer) return null;
  const out: any = {
    '@odata.type': '#Microsoft.Azure.Search.CustomAnalyzer',
    name,
    tokenizer: a.tokenizer,
  };
  if (a.tokenFilters?.length) out.tokenFilters = a.tokenFilters;
  if (a.charFilters?.length) out.charFilters = a.charFilters;
  return out;
}

export function buildCustomAnalyzers(rows: CustomAnalyzerRow[]): any[] {
  return (rows || []).map(buildCustomAnalyzer).filter((a): a is any => a != null);
}

/** Parse `index.analyzers[]` (custom analyzers only) into editable rows. */
export function parseCustomAnalyzers(index: any): CustomAnalyzerRow[] {
  const analyzers = index?.analyzers;
  if (!Array.isArray(analyzers)) return [];
  return analyzers
    .filter((a: any) => (a?.['@odata.type'] || '').includes('CustomAnalyzer'))
    .map((a: any) => ({
      name: a?.name ?? '',
      tokenizer: a?.tokenizer ?? 'standard_v2',
      tokenFilters: Array.isArray(a?.tokenFilters) ? a.tokenFilters : [],
      charFilters: Array.isArray(a?.charFilters) ? a.charFilters : [],
    }));
}

// ---------------------------------------------------------------------------
// CORS  (index.corsOptions)
// ---------------------------------------------------------------------------

export interface CorsOptionsRow {
  enabled: boolean;
  /** '*' allows all; otherwise a list of exact origins. */
  allowedOrigins: string[];
  maxAgeInSeconds?: number;
}

export function parseCorsOptions(index: any): CorsOptionsRow {
  const c = index?.corsOptions;
  if (!c || !Array.isArray(c.allowedOrigins)) return { enabled: false, allowedOrigins: [] };
  return {
    enabled: true,
    allowedOrigins: c.allowedOrigins,
    maxAgeInSeconds: typeof c.maxAgeInSeconds === 'number' ? c.maxAgeInSeconds : undefined,
  };
}

/** Build `corsOptions` (or null to omit / clear). */
export function buildCorsOptions(row: CorsOptionsRow): any | null {
  if (!row.enabled) return null;
  const origins = (row.allowedOrigins || []).map((o) => o.trim()).filter(Boolean);
  if (!origins.length) return null;
  const out: any = { allowedOrigins: origins };
  if (typeof row.maxAgeInSeconds === 'number' && !Number.isNaN(row.maxAgeInSeconds)) out.maxAgeInSeconds = row.maxAgeInSeconds;
  return out;
}

// ---------------------------------------------------------------------------
// Customer-managed encryption key  (index.encryptionKey)
// ---------------------------------------------------------------------------

export interface EncryptionKeyRow {
  enabled: boolean;
  keyVaultUri: string;
  keyVaultKeyName: string;
  keyVaultKeyVersion?: string;
  /** Optional UAMI resource id for keyless CMK access (else the service system MI is used). */
  userAssignedIdentity?: string;
}

export function parseEncryptionKey(index: any): EncryptionKeyRow {
  const k = index?.encryptionKey;
  if (!k || !k.keyVaultUri) return { enabled: false, keyVaultUri: '', keyVaultKeyName: '' };
  return {
    enabled: true,
    keyVaultUri: k.keyVaultUri || '',
    keyVaultKeyName: k.keyVaultKeyName || '',
    keyVaultKeyVersion: k.keyVaultKeyVersion || undefined,
    userAssignedIdentity: k?.identity?.userAssignedIdentity || undefined,
  };
}

/** Build `encryptionKey` (or null to omit). */
export function buildEncryptionKey(row: EncryptionKeyRow): any | null {
  if (!row.enabled) return null;
  const uri = (row.keyVaultUri || '').trim();
  const keyName = (row.keyVaultKeyName || '').trim();
  if (!uri || !keyName) return null;
  const out: any = { keyVaultUri: uri, keyVaultKeyName: keyName };
  if (row.keyVaultKeyVersion && row.keyVaultKeyVersion.trim()) out.keyVaultKeyVersion = row.keyVaultKeyVersion.trim();
  if (row.userAssignedIdentity && row.userAssignedIdentity.trim()) {
    out.identity = {
      '@odata.type': '#Microsoft.Azure.Search.DataUserAssignedIdentity',
      userAssignedIdentity: row.userAssignedIdentity.trim(),
    };
  }
  return out;
}

/**
 * Merge designer sections onto a live index definition for a PUT /indexes/{name}.
 * Only the passed sections are replaced; `undefined` leaves that section as-is.
 * `null` on cors/encryptionKey removes it. Field/vector/semantic sections are
 * preserved untouched.
 */
export function applyDesignerSections(
  index: any,
  patch: {
    scoringProfiles?: any[];
    defaultScoringProfile?: string | null;
    analyzers?: any[];
    corsOptions?: any | null;
    encryptionKey?: any | null;
  },
): any {
  const def: any = { ...(index || {}) };
  delete def['@odata.context'];
  delete def['@odata.etag'];
  if (patch.scoringProfiles !== undefined) def.scoringProfiles = patch.scoringProfiles;
  if (patch.defaultScoringProfile !== undefined) {
    if (patch.defaultScoringProfile) def.defaultScoringProfile = patch.defaultScoringProfile;
    else delete def.defaultScoringProfile;
  }
  if (patch.analyzers !== undefined) {
    // Preserve any non-custom analyzers already present; replace the custom ones.
    const preserved = Array.isArray(index?.analyzers)
      ? index.analyzers.filter((a: any) => !(a?.['@odata.type'] || '').includes('CustomAnalyzer'))
      : [];
    def.analyzers = [...preserved, ...patch.analyzers];
  }
  if (patch.corsOptions !== undefined) {
    if (patch.corsOptions) def.corsOptions = patch.corsOptions; else delete def.corsOptions;
  }
  if (patch.encryptionKey !== undefined) {
    if (patch.encryptionKey) def.encryptionKey = patch.encryptionKey; else delete def.encryptionKey;
  }
  return def;
}
