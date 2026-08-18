/**
 * Variable Library substitution layer.
 *
 * Variable Libraries store typed name/value definitions per value set
 * (default / dev / test / prod). This module is the runtime dereference layer
 * that turns `@{variables.NAME}` references found in pipelines / notebooks into
 * their concrete values for the active value set, and resolves `secret-ref`
 * typed variables out of Key Vault (the value is the KV secret name, or a
 * `kv://vault/secret` URI, or an env-var name).
 *
 * Pure helpers (no Azure deps) live here so any executor can import + expand.
 * Secret resolution is async + injected (the BFF passes a KV-backed resolver)
 * so this stays unit-testable and free of a hard Key Vault import.
 */

export type VarType =
  | 'string' | 'integer' | 'number' | 'bool' | 'datetime' | 'guid'
  | 'item-ref' | 'connection-ref' | 'secret-ref';

export interface VarDef {
  name: string;
  type: VarType;
  default: string;
  dev?: string;
  test?: string;
  prod?: string;
  description?: string;
  [k: string]: unknown;
}

export type ValueSet = 'default' | 'dev' | 'test' | 'prod';

/** Pick the raw stored value for a variable in a given value set (falls back to default). */
export function rawValueForSet(v: VarDef, valueSet: ValueSet): string {
  if (valueSet !== 'default') {
    const sv = (v as Record<string, unknown>)[valueSet];
    if (typeof sv === 'string' && sv !== '') return sv;
  }
  return v.default ?? '';
}

/** Matches `@{variables.NAME}` and `${variables.NAME}` (ADF/Fabric interpolation). */
const VAR_REF = /[@$]\{\s*variables\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

/** Names referenced by a text blob — used to validate references resolve. */
export function referencedVariableNames(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  VAR_REF.lastIndex = 0;
  while ((m = VAR_REF.exec(text)) !== null) out.add(m[1]);
  return Array.from(out);
}

/**
 * ADVISORY-ONLY reference scanner (#3575). Deliberately WIDER than `VAR_REF`:
 * it matches any `@{variables.…}` / `${variables.…}` token, INCLUDING ones whose
 * name `VAR_REF` can never accept (`Order-Count`, `2fa`, `my var`, ``).
 *
 * It must never drive expansion. Widening `VAR_REF` itself would change what
 * actually gets substituted at runtime — this scanner exists purely so the UI
 * can explain WHY a reference came back verbatim instead of silently echoing
 * the input, which is the exact symptom #3575 was filed for. The distinction
 * matters because the two cases have DIFFERENT remediations: a name that fails
 * `VAR_NAME` is unmatchable no matter what the library contains (rename it),
 * whereas a well-formed name is fixed by adding/saving the variable. Telling a
 * user to "add it to the table and save" when saving cannot possibly help is
 * the class of false cause deploy-integrity.md R7 forbids.
 */
const VAR_REF_LOOSE = /[@$]\{\s*variables\.([^}]*?)\s*\}/g;

/** The name shape `VAR_REF` — and therefore `expandVariables` — will accept. */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ReferencedToken {
  /** The raw name as written between `variables.` and the closing brace. */
  name: string;
  /** The reference verbatim as it appears in the text, e.g. `${variables.ENV}`. */
  ref: string;
  /**
   * False when `name` cannot match `VAR_REF`, i.e. `expandVariables` can never
   * substitute this reference whatever the resolved value map contains.
   */
  substitutable: boolean;
}

/**
 * Every `variables.` reference in `text`, in source order, with the verbatim
 * reference text and whether expansion could ever match it. Duplicates are kept
 * — callers de-duplicate on whichever key their message is about.
 */
export function referencedVariableTokens(text: string): ReferencedToken[] {
  const out: ReferencedToken[] = [];
  let m: RegExpExecArray | null;
  VAR_REF_LOOSE.lastIndex = 0;
  while ((m = VAR_REF_LOOSE.exec(text)) !== null) {
    const name = m[1];
    out.push({ name, ref: m[0], substitutable: VAR_NAME.test(name) });
  }
  return out;
}

/**
 * Expand `@{variables.NAME}` references in `text` using a resolved value map.
 * Unknown references are left verbatim (so a missing var is visible, not silently blank).
 */
export function expandVariables(text: string, values: Record<string, string>): string {
  return text.replace(VAR_REF, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  );
}

export interface ResolvedVar {
  name: string;
  type: VarType;
  /** Display value — masked for secrets. */
  value: string;
  secret: boolean;
  /** True when a secret-ref was successfully resolved out of Key Vault. */
  resolvedFromKv?: boolean;
  error?: string;
}

/** Mask any secret material for UI display. */
export function maskSecret(): string { return '••••••••'; }

/**
 * Resolve a full variable set for a value set. `secretResolver` is called for
 * every `secret-ref` variable with its raw value (KV name / kv:// uri / env name)
 * and must return the concrete secret (or throw). The returned map's `value` for
 * secrets is MASKED; `secretValues` carries the real material for server-side
 * consumers (never serialize it to the browser).
 */
export async function resolveVariableSet(
  variables: VarDef[],
  valueSet: ValueSet,
  secretResolver: (rawRef: string) => Promise<string>,
): Promise<{ resolved: ResolvedVar[]; values: Record<string, string>; secretValues: Record<string, string> }> {
  const resolved: ResolvedVar[] = [];
  const values: Record<string, string> = {};
  const secretValues: Record<string, string> = {};
  for (const v of variables) {
    const raw = rawValueForSet(v, valueSet);
    if (v.type === 'secret-ref') {
      try {
        const secret = await secretResolver(raw);
        secretValues[v.name] = secret;
        values[v.name] = secret;
        resolved.push({ name: v.name, type: v.type, value: maskSecret(), secret: true, resolvedFromKv: true });
      } catch (e: any) {
        resolved.push({ name: v.name, type: v.type, value: '', secret: true, error: e?.message || String(e) });
      }
    } else {
      values[v.name] = raw;
      resolved.push({ name: v.name, type: v.type, value: raw, secret: false });
    }
  }
  return { resolved, values, secretValues };
}
