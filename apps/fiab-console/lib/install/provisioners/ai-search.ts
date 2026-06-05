/**
 * Phase 2 — AI Search index provisioner.
 *
 * Real REST: PUT /indexes/{name}?api-version=2024-07-01 (idempotent
 * upsert) followed by POST /indexes/{name}/docs/index for sample
 * documents.
 *
 * Auth: DefaultAzureCredential / UAMI against
 * https://{service}.search.windows.net/.default
 *
 * Remediation gates:
 *   - LOOM_AI_SEARCH_SERVICE missing → set it.
 *   - 403 → UAMI lacks Search Service Contributor on the service.
 *
 * Schema hygiene (grounded in Microsoft Learn):
 *   - Create Index:
 *     https://learn.microsoft.com/rest/api/searchservice/indexes/create-or-update
 *   - Add scoring profiles:
 *     https://learn.microsoft.com/rest/api/searchservice/add-scoring-profiles-to-a-search-index
 *
 *   Bundles author scoringProfiles as `[{ name, description }]` for human
 *   docs, but the Create-Index schema rejects any key other than
 *   `{ name, text:{weights:{field:weight}}, functions?, functionAggregation? }`
 *   on a scoringProfile — sending `description` returns HTTP 400. We therefore
 *   SANITIZE every profile before the PUT: drop unsupported keys, keep/repair
 *   `text.weights` (only searchable string fields survive), keep only valid
 *   `functions` (lowercase type, field must be filterable, type-specific config
 *   present), and OMIT any profile we can't make valid rather than ship an
 *   invalid one. Fields and vectorConfig are likewise validated against the
 *   create-index schema.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import type { Provisioner, ProvisionResult } from './types';

const SEARCH_API = '2024-07-01';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  const t = await credential.getToken('https://search.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire AAD token for AI Search');
  return t.token;
}

// ----------------------------------------------------------------------------
// Schema hygiene — sanitize the bundle's authored payload against the
// Create-Index schema BEFORE the PUT, so an authoring shortcut (e.g. a
// scoringProfile carrying a human `description`) never produces a 400.
// ----------------------------------------------------------------------------

/** Edm types accepted by the index-field type picker (per Learn supported data types). */
const VECTOR_TYPE_RE = /^Collection\(Edm\.(Single|Half|Int16|Int8|Byte)\)$/;
function isVectorType(type: string): boolean {
  return VECTOR_TYPE_RE.test((type || '').trim());
}

/** Whitelisted, well-known per-field keys for the Create-Index wire payload. */
const FIELD_KEYS = new Set([
  'name', 'type', 'key', 'searchable', 'filterable', 'sortable', 'facetable',
  'retrievable', 'analyzer', 'searchAnalyzer', 'indexAnalyzer', 'normalizer',
  'synonymMaps', 'dimensions', 'vectorSearchProfile', 'fields',
]);

interface NormalizedField {
  name: string;
  type: string;
  searchable: boolean;
  filterable: boolean;
  isVector: boolean;
}

/**
 * Normalize one authored field into a valid Create-Index field. Drops unknown
 * keys, forces vector fields to carry `dimensions` + `vectorSearchProfile` and
 * to NOT carry filterable/sortable/facetable/analyzer (ignored for vectors per
 * Learn). Returns the wire field plus a summary used by scoring-profile repair.
 * Returns null when the row can't yield a valid field (missing name/type).
 */
function sanitizeField(raw: any, vectorProfileName?: string): { wire: any; summary: NormalizedField } | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!name || !type) return null;

  const vector = isVectorType(type);
  const wire: any = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FIELD_KEYS.has(k)) wire[k] = v;
  }
  wire.name = name;
  wire.type = type;
  if (raw.key) {
    wire.key = true;
    wire.retrievable = true; // a key field must be retrievable
  }

  if (vector) {
    // Vector fields ignore filterable/sortable/facetable/analyzer — drop them
    // so the wire payload matches what the portal would send.
    delete wire.filterable;
    delete wire.sortable;
    delete wire.facetable;
    delete wire.analyzer;
    delete wire.searchAnalyzer;
    delete wire.indexAnalyzer;
    delete wire.normalizer;
    if (typeof wire.dimensions !== 'number' || wire.dimensions <= 0) {
      // Without dimensions the PUT is invalid; if absent, the field is unusable.
      return null;
    }
    if (!wire.vectorSearchProfile && vectorProfileName) {
      wire.vectorSearchProfile = vectorProfileName;
    }
    if (!wire.vectorSearchProfile) return null; // can't PUT a vector field with no profile
  } else {
    // Non-vector field can't carry vector-only keys.
    delete wire.dimensions;
    delete wire.vectorSearchProfile;
    if (!wire.searchable && wire.analyzer) delete wire.analyzer; // analyzer only meaningful when searchable
  }

  return {
    wire,
    summary: {
      name,
      type,
      searchable: !!raw.searchable,
      filterable: !!raw.filterable || !!raw.key,
      isVector: vector,
    },
  };
}

/**
 * Sanitize one authored scoringProfile against the add-scoring-profiles schema.
 *
 * A valid profile is `{ name, text?:{weights}, functions?, functionAggregation? }`.
 * We:
 *   - drop `description` and every other non-schema key,
 *   - keep `text.weights` entries only when they reference a SEARCHABLE string
 *     field (per Learn, text weights apply only to searchable fields),
 *   - keep `functions` entries only when the field is FILTERABLE, the type is a
 *     lowercase magnitude|freshness|distance|tag, and the type-specific config
 *     block is present,
 *   - keep `functionAggregation` only when functions survive.
 * Returns null when nothing valid remains (caller omits the profile entirely
 * rather than send an invalid one).
 */
function sanitizeScoringProfile(raw: any, fields: NormalizedField[]): any | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const searchable = new Set(
    fields.filter((f) => f.searchable && !f.isVector && f.type.startsWith('Edm.String')).map((f) => f.name),
  );
  const filterable = new Set(fields.filter((f) => f.filterable).map((f) => f.name));

  const out: any = { name };

  // text.weights — keep only searchable-string targets with a positive numeric weight.
  const rawWeights = raw?.text?.weights;
  if (rawWeights && typeof rawWeights === 'object') {
    const weights: Record<string, number> = {};
    for (const [field, w] of Object.entries(rawWeights)) {
      if (searchable.has(field) && typeof w === 'number' && w > 0) weights[field] = w;
    }
    if (Object.keys(weights).length > 0) out.text = { weights };
  }

  // functions — keep only schema-valid, type-specific entries on filterable fields.
  const FN_TYPES = new Set(['magnitude', 'freshness', 'distance', 'tag']);
  if (Array.isArray(raw.functions)) {
    const functions = raw.functions
      .map((fn: any) => sanitizeScoringFunction(fn, filterable, FN_TYPES))
      .filter((fn: any): fn is any => fn !== null);
    if (functions.length > 0) {
      out.functions = functions;
      const agg = raw.functionAggregation;
      if (typeof agg === 'string' && ['sum', 'average', 'minimum', 'maximum', 'firstMatching'].includes(agg)) {
        out.functionAggregation = agg;
      }
    }
  }

  // A profile with neither text weights nor functions is invalid — omit it.
  if (!out.text && !out.functions) return null;
  return out;
}

/** Validate one scoring function; return the cleaned wire object or null. */
function sanitizeScoringFunction(fn: any, filterable: Set<string>, fnTypes: Set<string>): any | null {
  if (!fn || typeof fn !== 'object') return null;
  const type = typeof fn.type === 'string' ? fn.type.trim().toLowerCase() : '';
  const fieldName = typeof fn.fieldName === 'string' ? fn.fieldName.trim() : '';
  if (!fnTypes.has(type) || !fieldName) return null;
  // Functions can only be applied to filterable fields (per Learn).
  if (!filterable.has(fieldName)) return null;
  if (typeof fn.boost !== 'number') return null;

  const out: any = { type, fieldName, boost: fn.boost };
  if (typeof fn.interpolation === 'string'
    && ['constant', 'linear', 'quadratic', 'logarithmic'].includes(fn.interpolation)) {
    out.interpolation = fn.interpolation;
  }

  // Each function type requires its own config block; without it the PUT is invalid.
  if (type === 'magnitude') {
    const m = fn.magnitude;
    if (!m || typeof m.boostingRangeStart !== 'number' || typeof m.boostingRangeEnd !== 'number') return null;
    out.magnitude = {
      boostingRangeStart: m.boostingRangeStart,
      boostingRangeEnd: m.boostingRangeEnd,
      ...(typeof m.constantBoostBeyondRange === 'boolean'
        ? { constantBoostBeyondRange: m.constantBoostBeyondRange }
        : {}),
    };
  } else if (type === 'freshness') {
    const dur = fn?.freshness?.boostingDuration;
    if (typeof dur !== 'string' || !dur) return null;
    out.freshness = { boostingDuration: dur };
  } else if (type === 'distance') {
    const d = fn.distance;
    if (!d || typeof d.referencePointParameter !== 'string' || typeof d.boostingDistance !== 'number') return null;
    out.distance = { referencePointParameter: d.referencePointParameter, boostingDistance: d.boostingDistance };
  } else if (type === 'tag') {
    const t = fn.tag;
    if (!t || typeof t.tagsParameter !== 'string' || !t.tagsParameter) return null;
    out.tag = { tagsParameter: t.tagsParameter };
  }
  return out;
}

export const aiSearchProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const svc = input.target.aiSearchService || process.env.LOOM_AI_SEARCH_SERVICE;
  if (!svc) {
    return {
      status: 'remediation',
      gate: {
        reason: 'AI Search service not configured.',
        remediation: 'Set LOOM_AI_SEARCH_SERVICE to the service name (without .search.windows.net).',
        link: 'https://learn.microsoft.com/azure/search/',
      },
      steps,
    };
  }
  const content = input.content as any;
  const schema = content?.schema;
  if (!schema?.fields || !Array.isArray(schema.fields)) {
    return { status: 'skipped', steps: ['No schema in bundle; nothing to provision.'] };
  }
  const indexName = input.displayName.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 128) || 'loom-index';
  steps.push(`Target: https://${svc}.search.windows.net/indexes/${indexName}`);

  const tok = await token();

  // vectorSearch is synthesized from vectorConfig; vector fields that don't
  // name their own profile get bound to this one.
  const hasVectorConfig = !!content.vectorConfig;
  const DEFAULT_VECTOR_PROFILE = 'default-profile';

  // Sanitize fields against the Create-Index schema (drop unknown keys, repair
  // vector fields). Drop any field that can't be made valid rather than 400.
  const normalized: NormalizedField[] = [];
  const wireFields: any[] = [];
  for (const raw of schema.fields) {
    const r = sanitizeField(raw, hasVectorConfig ? DEFAULT_VECTOR_PROFILE : undefined);
    if (!r) {
      steps.push(`Dropped invalid field "${raw?.name ?? '<unnamed>'}" (missing name/type or unusable vector field).`);
      continue;
    }
    wireFields.push(r.wire);
    normalized.push(r.summary);
  }
  if (wireFields.length === 0) {
    return { status: 'failed', error: 'No valid fields remain after schema sanitization; cannot create index.', steps };
  }
  if (!wireFields.some((f) => f.key === true)) {
    return { status: 'failed', error: 'Index schema has no key field (exactly one Edm.String key required).', steps };
  }

  // Sanitize scoringProfiles — strip `description` + any non-schema key, repair
  // text.weights / functions, OMIT any profile that can't be made valid.
  const cleanProfiles: any[] = [];
  if (Array.isArray(content.scoringProfiles)) {
    for (const raw of content.scoringProfiles) {
      const p = sanitizeScoringProfile(raw, normalized);
      if (p) cleanProfiles.push(p);
      else steps.push(`Omitted scoringProfile "${raw?.name ?? '<unnamed>'}" (no valid text weights or functions after sanitization).`);
    }
  }
  if (cleanProfiles.length > 0) steps.push(`Kept ${cleanProfiles.length} valid scoringProfile(s).`);

  const indexBody: any = {
    name: indexName,
    fields: wireFields,
    ...(hasVectorConfig
      ? {
          vectorSearch: {
            algorithms: [{
              name: 'default-hnsw',
              kind: 'hnsw',
              hnswParameters: { metric: 'cosine', m: 4, efConstruction: 400, efSearch: 500 },
            }],
            profiles: [{ name: DEFAULT_VECTOR_PROFILE, algorithm: 'default-hnsw' }],
          },
        }
      : {}),
    ...(cleanProfiles.length > 0 ? { scoringProfiles: cleanProfiles } : {}),
  };

  const putRes = await fetch(`https://${svc}.search.windows.net/indexes/${indexName}?api-version=${SEARCH_API}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(indexBody),
    cache: 'no-store',
  });
  if (putRes.status === 401 || putRes.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `AI Search ${putRes.status}: cannot create/update index.`,
        remediation:
          'Grant the Console UAMI Search Service Contributor on the AI Search service: az role assignment create --assignee <uami-objectid> --role "Search Service Contributor" --scope /subscriptions/.../Microsoft.Search/searchServices/<service>',
        link: 'https://learn.microsoft.com/azure/search/search-howto-managed-identities-data-sources',
      },
      steps,
    };
  }
  if (!putRes.ok) {
    const t = await putRes.text();
    return { status: 'failed', error: `Search index PUT ${putRes.status}: ${t.slice(0, 300)}`, steps };
  }
  steps.push(`Index PUT ${putRes.status} OK.`);

  // Push sample docs if any.
  const sampleDocs: any[] = Array.isArray(content.sampleDocs) ? content.sampleDocs : [];
  if (sampleDocs.length > 0) {
    const ingestRes = await fetch(`https://${svc}.search.windows.net/indexes/${indexName}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: sampleDocs.map((d) => ({ '@search.action': 'mergeOrUpload', ...d })) }),
      cache: 'no-store',
    });
    if (ingestRes.ok) {
      steps.push(`Pushed ${sampleDocs.length} sample docs.`);
    } else {
      const t = await ingestRes.text();
      steps.push(`Sample-doc push failed ${ingestRes.status}: ${t.slice(0, 200)}`);
    }
  }

  return {
    status: putRes.status === 201 ? 'created' : 'exists',
    resourceId: indexName,
    secondaryIds: { service: svc, endpoint: `https://${svc}.search.windows.net/indexes/${indexName}` },
    steps,
  };
};
