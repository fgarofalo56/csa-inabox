/**
 * Integrated-vectorization CONSISTENCY validation (AIF-2).
 *
 * Server-free, pure logic that pre-flights an AI Search `vectorSearch`
 * configuration against its vector fields BEFORE the `PUT /indexes/{name}` — so
 * the designer (and any BFF/orchestrator that assembles an index, e.g. the
 * AIF-3 index-my-data wizard) can surface the two failure modes AI Search would
 * otherwise only reveal as an opaque 400 at PUT time or, worse, a silently
 * unqueryable index:
 *
 *   1. DIMENSION MISMATCH — a vector field declares `dimensions: N`, but the
 *      vectorizer bound to its profile embeds with a model whose native output
 *      is M ≠ N. This is the classic integrated-vectorization footgun: define a
 *      field at 1536 dims, wire it to a `text-embedding-3-large` vectorizer
 *      (3072 dims), and the index build fails / queries return nothing.
 *   2. DANGLING REFERENCE — a vector field names a profile that doesn't exist, a
 *      profile names a vectorizer/algorithm that doesn't exist. AI Search
 *      rejects these at PUT; catching them client-side gives a precise message.
 *
 * The model→dimensions truth is the shared {@link EMBEDDING_MODELS} table (the
 * same one that drives the vectorizer + field designers), so a new model added
 * there is automatically understood here. Unknown models degrade to a WARNING
 * (we can't verify) rather than a false ERROR — honest, never a hard block.
 *
 * Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/search/vector-search-how-to-create-index
 *   https://learn.microsoft.com/azure/search/vector-search-integrated-vectorization
 */
import {
  EMBEDDING_MODELS,
  isVectorFieldType,
  type FieldRow,
  type VectorProfile,
  type VectorAlgorithm,
  type Vectorizer,
} from './search-field-shapes';

export type VectorizerIssueLevel = 'error' | 'warning';

export type VectorizerIssueCode =
  | 'dimension-mismatch'
  | 'dangling-profile'
  | 'dangling-vectorizer'
  | 'dangling-algorithm'
  | 'unknown-embedding-model';

/** One consistency finding for the designer to render (error blocks a clean build; warning is advisory). */
export interface VectorizerIssue {
  level: VectorizerIssueLevel;
  code: VectorizerIssueCode;
  message: string;
  fieldName?: string;
  profileName?: string;
  vectorizerName?: string;
}

export interface VectorConsistencyInput {
  /** The index's fields (top-level; only vector fields are inspected). */
  fields: readonly FieldRow[];
  /** vectorSearch.profiles[]. */
  profiles: readonly VectorProfile[];
  /** vectorSearch.vectorizers[]. */
  vectorizers: readonly Vectorizer[];
  /** vectorSearch.algorithms[] — optional; when supplied, profile→algorithm refs are checked too. */
  algorithms?: readonly VectorAlgorithm[];
}

/**
 * Native output dimensions of a known Azure OpenAI embedding model, resolved by
 * the vectorizer's `modelName` (preferred) or `deploymentId` (a common
 * convention is to name the deployment after the model). Returns `null` when the
 * name matches no {@link EMBEDDING_MODELS} entry — the caller treats that as
 * "cannot verify" rather than a mismatch.
 */
export function embeddingModelDimensions(modelOrDeployment: string | undefined | null): number | null {
  const needle = (modelOrDeployment || '').trim().toLowerCase();
  if (!needle) return null;
  // Exact match first, then a contains-match so a deployment like
  // "text-embedding-3-large-prod" still resolves to its base model's dims.
  const exact = EMBEDDING_MODELS.find((m) => m.model.toLowerCase() === needle);
  if (exact) return exact.dimensions;
  const contains = EMBEDDING_MODELS.find((m) => needle.includes(m.model.toLowerCase()));
  return contains ? contains.dimensions : null;
}

/**
 * Validate a vectorSearch configuration against its vector fields. Pure — no I/O.
 * Returns every finding (errors + warnings), most-actionable first is not
 * guaranteed; the caller may sort by `level`. An empty array means "consistent".
 */
export function validateVectorizerConsistency(input: VectorConsistencyInput): VectorizerIssue[] {
  const issues: VectorizerIssue[] = [];
  const profiles = input.profiles || [];
  const vectorizers = input.vectorizers || [];
  const algorithms = input.algorithms;

  const profileByName = new Map<string, VectorProfile>();
  for (const p of profiles) if (p?.name) profileByName.set(p.name, p);
  const vectorizerByName = new Map<string, Vectorizer>();
  for (const v of vectorizers) if (v?.name) vectorizerByName.set(v.name, v);
  const algoNames = new Set<string>((algorithms || []).map((a) => a?.name).filter(Boolean) as string[]);

  // --- Profile-level reference integrity ------------------------------------
  for (const p of profiles) {
    if (!p?.name) continue;
    if (p.vectorizer && !vectorizerByName.has(p.vectorizer)) {
      issues.push({
        level: 'error',
        code: 'dangling-vectorizer',
        profileName: p.name,
        vectorizerName: p.vectorizer,
        message: `Profile "${p.name}" references vectorizer "${p.vectorizer}", which is not defined. Add the vectorizer or clear the reference.`,
      });
    }
    if (algorithms && p.algorithm && !algoNames.has(p.algorithm)) {
      issues.push({
        level: 'error',
        code: 'dangling-algorithm',
        profileName: p.name,
        message: `Profile "${p.name}" references algorithm "${p.algorithm}", which is not defined.`,
      });
    }
  }

  // --- Field-level dimension + profile integrity ----------------------------
  for (const f of input.fields || []) {
    if (!f?.name || !isVectorFieldType(f.type)) continue;
    const profileName = f.vectorSearchProfile;
    if (!profileName) continue; // a vector field with no profile is a separate (field-designer) concern.

    const profile = profileByName.get(profileName);
    if (!profile) {
      issues.push({
        level: 'error',
        code: 'dangling-profile',
        fieldName: f.name,
        profileName,
        message: `Field "${f.name}" binds to vector profile "${profileName}", which is not defined in this vector search config.`,
      });
      continue;
    }

    // No vectorizer on the profile ⇒ vectors are pushed by the caller (client
    // embedding), so the field's dims can't be inferred here — not an issue.
    if (!profile.vectorizer) continue;
    const vec = vectorizerByName.get(profile.vectorizer);
    if (!vec) continue; // already reported as dangling-vectorizer at the profile level.

    const modelName = vec.azureOpenAIParameters?.modelName || vec.azureOpenAIParameters?.deploymentId;
    const expected = embeddingModelDimensions(modelName);
    if (expected == null) {
      issues.push({
        level: 'warning',
        code: 'unknown-embedding-model',
        fieldName: f.name,
        profileName,
        vectorizerName: vec.name,
        message: `Field "${f.name}" uses vectorizer "${vec.name}" (model "${modelName || 'unset'}"), whose output dimensions are unknown — verify it matches the field's dimensions (${f.dimensions ?? 'unset'}).`,
      });
      continue;
    }
    if (typeof f.dimensions === 'number' && f.dimensions > 0 && f.dimensions !== expected) {
      issues.push({
        level: 'error',
        code: 'dimension-mismatch',
        fieldName: f.name,
        profileName,
        vectorizerName: vec.name,
        message: `Field "${f.name}" declares ${f.dimensions} dimensions, but vectorizer "${vec.name}" embeds with ${modelName} (${expected} dimensions). Set the field to ${expected} dimensions (or point the vectorizer at a ${f.dimensions}-dimension model).`,
      });
    }
  }

  return issues;
}

/** Convenience: the subset of issues that would break a clean index build. */
export function vectorizerErrors(issues: readonly VectorizerIssue[]): VectorizerIssue[] {
  return issues.filter((i) => i.level === 'error');
}
