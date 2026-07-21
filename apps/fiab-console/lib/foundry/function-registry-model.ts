/**
 * Functions-on-objects registry model (WS-4.2) — the client-safe, pure typed
 * model + version resolution for the Loom function registry (Palantir Foundry
 * "functions on objects" parity). NO server imports (no Cosmos / no fetch) so
 * the authoring wizard AND the BFF routes share one source of truth, exactly
 * like `ai-functions-registry.ts`.
 *
 * A registered function is a versioned, callable unit executed on the Loom UDF
 * runtime (Azure Functions / ACA — `LOOM_UDF_FUNCTION_BASE`, Gov-safe). It is
 * referenced by:
 *   - a `function`-kind derived property (custom computed value), and
 *   - an ontology action's `validationFunction` (server-side write validation).
 *
 * Versioning: multiple entries may share a `name`; each carries a distinct
 * `version` string. A reference may PIN a version, or omit it to resolve the
 * LATEST (highest `version` by natural-order compare, tie-broken by newest
 * `createdAt`). Azure-native, no Microsoft Fabric.
 */

/** Where a registered function executes. Azure-native default; both call the UDF runtime. */
export const FUNCTION_RUNTIMES = ['udf', 'azure-function'] as const;
export type FunctionRuntime = typeof FUNCTION_RUNTIMES[number];
export const FUNCTION_RUNTIME_LABELS: Record<FunctionRuntime, string> = {
  udf: 'Loom UDF runtime (ACA / Azure Functions)',
  'azure-function': 'Dedicated Azure Function App',
};

/** What a registered function is used for (drives the pickers' filtering). */
export const FUNCTION_PURPOSES = ['validation', 'derived', 'general'] as const;
export type FunctionPurpose = typeof FUNCTION_PURPOSES[number];
export const FUNCTION_PURPOSE_LABELS: Record<FunctionPurpose, string> = {
  validation: 'Action validation (returns valid / invalid)',
  derived: 'Derived property (returns a computed value)',
  general: 'General purpose',
};

/** A typed function parameter. */
export const FUNCTION_PARAM_TYPES = ['string', 'number', 'boolean', 'object'] as const;
export type FunctionParamType = typeof FUNCTION_PARAM_TYPES[number];

export interface LoomFunctionParam {
  name: string;
  type: FunctionParamType;
  required?: boolean;
  description?: string;
}

/** A single registered function version. */
export interface RegisteredFunction {
  /** Stable function name (shared across versions). */
  name: string;
  /** Version tag, unique within the name (e.g. "1", "1.2.0", "v3"). */
  version: string;
  displayName?: string;
  description?: string;
  /** Execution backend. */
  runtime: FunctionRuntime;
  /**
   * The runtime function path invoked as `POST {LOOM_UDF_FUNCTION_BASE}/api/<functionPath>`
   * (or the same shape on a dedicated Function App). Defaults to `name`.
   */
  functionPath: string;
  /** For a `azure-function` runtime: an explicit base URL overriding LOOM_UDF_FUNCTION_BASE. */
  baseUrlOverride?: string;
  /** For a keyed function: the Key Vault secret name holding the function key. */
  functionKeySecret?: string;
  /** Declared purpose (validation / derived / general). */
  purpose: FunctionPurpose;
  /** Typed input parameters. */
  params: LoomFunctionParam[];
  /** Return-value description (informational). */
  returns?: string;
  createdAt?: string;
  createdBy?: string;
}

// ============================================================
// Identifier guards
// ============================================================

/** A safe function name: leading letter/underscore, ≤62 word chars (an AGE/UDF-safe ident). */
export function isFunctionName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][\w]{0,62}$/.test(name);
}

/** A version tag: 1–32 chars of word chars, dots, dashes. */
export function isFunctionVersion(v: unknown): v is string {
  return typeof v === 'string' && /^[\w.\-]{1,32}$/.test(v);
}

/** A function path segment: word chars + dash (no slashes — one segment). */
export function isFunctionPath(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z_][\w\-]{0,62}$/.test(v);
}

function s(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }

// ============================================================
// Normalizers
// ============================================================

export function normalizeFunctionParam(raw: unknown): LoomFunctionParam | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = s(r.name).trim();
  if (!isFunctionName(name)) return null;
  const type: FunctionParamType = (FUNCTION_PARAM_TYPES as readonly string[]).includes(s(r.type))
    ? (s(r.type) as FunctionParamType) : 'string';
  return {
    name, type,
    ...(r.required ? { required: true } : {}),
    ...(r.description ? { description: s(r.description) } : {}),
  };
}

export function normalizeRegisteredFunction(raw: unknown): RegisteredFunction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = s(r.name).trim();
  const version = s(r.version).trim();
  if (!isFunctionName(name) || !isFunctionVersion(version)) return null;
  const runtime: FunctionRuntime = (FUNCTION_RUNTIMES as readonly string[]).includes(s(r.runtime))
    ? (s(r.runtime) as FunctionRuntime) : 'udf';
  const purpose: FunctionPurpose = (FUNCTION_PURPOSES as readonly string[]).includes(s(r.purpose))
    ? (s(r.purpose) as FunctionPurpose) : 'general';
  const functionPath = isFunctionPath(s(r.functionPath).trim()) ? s(r.functionPath).trim() : name;
  const params = Array.isArray(r.params)
    ? r.params.map(normalizeFunctionParam).filter((p): p is LoomFunctionParam => p !== null)
    : [];
  const baseUrlOverride = s(r.baseUrlOverride).trim();
  const functionKeySecret = s(r.functionKeySecret).trim();
  return {
    name, version, runtime, purpose, functionPath, params,
    ...(r.displayName ? { displayName: s(r.displayName) } : {}),
    ...(r.description ? { description: s(r.description) } : {}),
    ...(baseUrlOverride && /^https:\/\//i.test(baseUrlOverride) ? { baseUrlOverride } : {}),
    ...(functionKeySecret ? { functionKeySecret } : {}),
    ...(r.returns ? { returns: s(r.returns) } : {}),
    ...(r.createdAt ? { createdAt: s(r.createdAt) } : {}),
    ...(r.createdBy ? { createdBy: s(r.createdBy) } : {}),
  };
}

export function normalizeRegisteredFunctions(raw: unknown): RegisteredFunction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeRegisteredFunction).filter((f): f is RegisteredFunction => f !== null);
}

// ============================================================
// Version resolution
// ============================================================

/** Compare two version strings by natural order (numeric segments compared numerically). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_]/);
  const pb = b.split(/[.\-_]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '';
    const sb = pb[i] ?? '';
    const na = Number(sa);
    const nb = Number(sb);
    const bothNum = Number.isFinite(na) && Number.isFinite(nb) && sa !== '' && sb !== '';
    if (bothNum) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** All registered versions of a function name, newest (highest) version first. */
export function functionVersions(fns: RegisteredFunction[], name: string): RegisteredFunction[] {
  return (fns || [])
    .filter((f) => f.name === name)
    .sort((a, b) => compareVersions(b.version, a.version)
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** Distinct registered function names (for the picker). */
export function functionNames(fns: RegisteredFunction[]): string[] {
  return Array.from(new Set((fns || []).map((f) => f.name))).sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve a function reference to a concrete registered version: the exact
 * `version` when pinned + present, else the LATEST version of `name`. Returns
 * null when the name (or pinned version) is not registered.
 */
export function resolveFunction(
  fns: RegisteredFunction[],
  name: string,
  version?: string,
): RegisteredFunction | null {
  const versions = functionVersions(fns, name);
  if (versions.length === 0) return null;
  if (version) return versions.find((f) => f.version === version) || null;
  return versions[0]; // latest (functionVersions sorts newest-first)
}
