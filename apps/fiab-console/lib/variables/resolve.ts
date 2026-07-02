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
