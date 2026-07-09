/**
 * Variable-library-aware deployment-pipeline promotion (FGC-24).
 *
 * Fabric's FabCon-2026 flagship CI/CD feature is a workspace-scoped Variable
 * Library whose values are resolved PER-ENVIRONMENT (dev / test / prod) so that
 * promoting an item between stages automatically swaps stage-appropriate values
 * (connection strings, resource ids, env values) without editing the item.
 *
 * The Azure-native DEFAULT (no-fabric-dependency.md) needs zero new infra: the
 * Variable Library is already a Cosmos-backed WorkspaceItem (`variable-library`)
 * whose `state.variables[]` carry a per-value-set override map (default / dev /
 * test / prod — see lib/variables/resolve.ts). This module is the PURE logic the
 * promote path uses to:
 *
 *   1. map a pipeline stage to its value set (`stageValueSet`),
 *   2. collect the resolved (non-secret) values for that value set from the
 *      pipeline's variable libraries (`collectStageVariableValues`),
 *   3. rebind an item's serialized definition by substituting `{{var:NAME}}`
 *      placeholder tokens with the target stage's values (`rebindContent`), and
 *   4. build a per-stage diff of which variables differ across stages for the
 *      "Variable overrides" UI (`variableDiffRows`).
 *
 * Secret-ref typed variables are NEVER inlined into promoted item JSON (that JSON
 * is persisted to Cosmos): their tokens are left verbatim and reported as
 * skipped, so the runtime dereference layer resolves them from Key Vault at
 * execution time instead. No Azure call happens here — this is unit-tested pure
 * logic the deploy/approve routes import.
 */
import { rawValueForSet, type VarDef, type ValueSet } from '@/lib/variables/resolve';

/** A pipeline stage as far as value-set mapping is concerned. */
export interface StageLike {
  displayName?: string;
  order?: number;
}

/**
 * Map a deployment-pipeline stage to the Variable Library value set whose values
 * it should resolve. Mirrors Fabric's dev/test/prod value sets and the same
 * name/order heuristic the pane's `stageVisual` uses:
 *   - name contains "prod"            → prod
 *   - name contains "test" / "stag"   → test    (or order 1 when unnamed)
 *   - name contains "dev" / order 0   → dev
 *   - anything else                   → default (extra stages fall back)
 */
export function stageValueSet(stage: StageLike): ValueSet {
  const name = (stage.displayName || '').toLowerCase();
  if (name.includes('prod')) return 'prod';
  if (name.includes('test') || name.includes('stag')) return 'test';
  if (name.includes('dev')) return 'dev';
  if (stage.order === 0) return 'dev';
  if (stage.order === 1) return 'test';
  if (stage.order === 2) return 'prod';
  return 'default';
}

/** `{{var:NAME}}` promotion placeholder (whitespace-tolerant). NAME is an ident. */
export const VAR_TOKEN = /\{\{\s*var:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Distinct variable names referenced by `{{var:NAME}}` tokens in a text blob. */
export function referencedTokenNames(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  VAR_TOKEN.lastIndex = 0;
  while ((m = VAR_TOKEN.exec(text)) !== null) out.add(m[1]);
  return Array.from(out);
}

export interface CollectedStageValues {
  /** value set the values were resolved for. */
  valueSet: ValueSet;
  /** resolved non-secret values, keyed by variable name (later library wins). */
  values: Record<string, string>;
  /** variable names that are secret-ref typed (NOT inlined; resolved at runtime). */
  secretNames: Set<string>;
}

/**
 * Collect the resolved variable values for a target value set from a set of
 * variable-library `state.variables[]` arrays (one per library item present in
 * the pipeline's workspaces). Non-secret variables resolve to their concrete
 * value for the value set (falling back to `default`); secret-ref variables are
 * recorded in `secretNames` and left OUT of `values` so `rebindContent` never
 * inlines secret material into promoted JSON. When two libraries define the same
 * name the later one wins (callers pass target-workspace libraries last).
 */
export function collectStageVariableValues(
  variableSets: VarDef[][],
  valueSet: ValueSet,
): CollectedStageValues {
  const values: Record<string, string> = {};
  const secretNames = new Set<string>();
  for (const vars of variableSets) {
    for (const v of vars || []) {
      if (!v || typeof v.name !== 'string' || !v.name) continue;
      if (v.type === 'secret-ref') {
        secretNames.add(v.name);
        // A secret-ref shadows any earlier non-secret of the same name.
        delete values[v.name];
        continue;
      }
      secretNames.delete(v.name);
      values[v.name] = rawValueForSet(v, valueSet);
    }
  }
  return { valueSet, values, secretNames };
}

/** One recorded substitution — surfaced in the deploy receipt / steps. */
export interface Substitution {
  name: string;
  value: string;
}

export interface RebindResult<T> {
  /** deep-cloned content with resolvable `{{var:NAME}}` tokens replaced. */
  content: T;
  /** substitutions actually applied (unique by name, first value seen). */
  substitutions: Substitution[];
  /** referenced names that had no non-secret value (token left verbatim). */
  unresolved: string[];
  /** referenced names that are secret-ref typed (token left for runtime KV). */
  skippedSecrets: string[];
}

/** Replace every `{{var:NAME}}` in one string; records what happened. */
function rebindString(
  text: string,
  values: Record<string, string>,
  secretNames: Set<string>,
  applied: Map<string, string>,
  unresolved: Set<string>,
  skippedSecrets: Set<string>,
): string {
  return text.replace(VAR_TOKEN, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      if (!applied.has(name)) applied.set(name, values[name]);
      return values[name];
    }
    if (secretNames.has(name)) {
      skippedSecrets.add(name);
      return whole; // leave secret token for the runtime dereference layer
    }
    unresolved.add(name);
    return whole; // leave a missing var visible rather than silently blanking it
  });
}

/**
 * Deep-clone `content` and rebind every `{{var:NAME}}` token found in any string
 * (object keys are preserved; only string VALUES are rewritten). Non-plain
 * inputs (null/number/etc.) pass through unchanged. Never mutates the input.
 */
export function rebindContent<T>(
  content: T,
  values: Record<string, string>,
  secretNames: Set<string> = new Set(),
): RebindResult<T> {
  const applied = new Map<string, string>();
  const unresolved = new Set<string>();
  const skippedSecrets = new Set<string>();

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return rebindString(node, values, secretNames, applied, unresolved, skippedSecrets);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(node as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return node;
  };

  const cloned = walk(content) as T;
  return {
    content: cloned,
    substitutions: Array.from(applied, ([name, value]) => ({ name, value })),
    unresolved: Array.from(unresolved),
    skippedSecrets: Array.from(skippedSecrets),
  };
}

/** One variable's value across every stage — a row in the overrides diff table. */
export interface VariableDiffRow {
  name: string;
  type: string;
  isSecret: boolean;
  /** stageId → { valueSet, value } (value MASKED for secrets). */
  perStage: Record<string, { valueSet: ValueSet; value: string }>;
  /** true when the resolved value is not identical across all stages. */
  differs: boolean;
}

const SECRET_MASK = '••••••••';

/**
 * Build the per-stage variable diff for the "Variable overrides" UI. For each
 * distinct variable name across the supplied libraries, resolve its value for
 * every stage's value set and flag whether it differs stage-to-stage — mirroring
 * Fabric's variable-library view in the deployment-pipeline compare. Secret
 * values are masked (never returned to the browser).
 */
export function variableDiffRows(
  variableSets: VarDef[][],
  stages: Array<{ id: string } & StageLike>,
): VariableDiffRow[] {
  // Merge variable definitions by name (later library wins), remembering type.
  const byName = new Map<string, VarDef>();
  for (const vars of variableSets) {
    for (const v of vars || []) {
      if (v && typeof v.name === 'string' && v.name) byName.set(v.name, v);
    }
  }
  const rows: VariableDiffRow[] = [];
  for (const [name, v] of byName) {
    const isSecret = v.type === 'secret-ref';
    const perStage: VariableDiffRow['perStage'] = {};
    const seen: string[] = [];
    for (const st of stages) {
      const vs = stageValueSet(st);
      const raw = rawValueForSet(v, vs);
      perStage[st.id] = { valueSet: vs, value: isSecret ? SECRET_MASK : raw };
      seen.push(isSecret ? SECRET_MASK : raw);
    }
    const differs = !isSecret && seen.some((x) => x !== seen[0]);
    rows.push({ name, type: v.type, isSecret, perStage, differs });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}
