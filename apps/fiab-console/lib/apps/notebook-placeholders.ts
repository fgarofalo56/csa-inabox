/**
 * Deployment-placeholder substitution for bundle-provided notebook cell source.
 *
 * Content bundles ship `{{TOKEN}}` placeholders in place of deployment-specific
 * values so the vendored source carries zero deployment-specific host, pool, or
 * account name — and zero hard Fabric dependency. Two tokens exist today:
 *
 *   `{{ADLS_ACCOUNT}}`             → `LOOM_ADLS_ACCOUNT` (admin-plane bicep).
 *     The Supercharge notebook generator swaps OneLake's
 *     `onelake.dfs.fabric.microsoft.com` host for
 *     `{{ADLS_ACCOUNT}}.dfs.core.windows.net` (see
 *     scripts/csa-loom/import-supercharge-notebooks.mjs).
 *   `{{SYNAPSE_DEDICATED_POOL}}`   → `LOOM_SYNAPSE_DEDICATED_POOL`.
 *     The Synapse dedicated SQL pool that backs Loom warehouses. A notebook
 *     reading a warehouse table needs the pool's DATABASE name for the
 *     connector's three-part `db.schema.table` argument
 *     (`spark.read.synapsesql`), and a Spark session has no LOOM_* env of its
 *     own to read it from — so it must be filled in here. Added for #4093
 *     (app-casino-analytics), where making the user supply the pool name would
 *     have been a user-performed binding step (`auto-bind-by-default.md`).
 *
 * Left un-substituted a token yields a value that fails at read time — an
 * invalid abfss host, or a three-part name containing literal braces — which is
 * a no-vaporware violation. Substitution therefore runs on BOTH sides of the
 * notebook lifecycle:
 *   - install  (app install route persists `state.cells`) — so the stored
 *     notebook is already deployment-correct, and
 *   - run      (notebook `/run` route) — so notebooks installed before this
 *     fix, or edited by hand, still resolve at execution time.
 *
 * Honest gate: when a token's value is not resolvable the token is LEFT INTACT
 * rather than guessed — the cell then fails naming the literal `{{TOKEN}}`,
 * pointing the operator at the env var that would have filled it. Resolution is
 * PER TOKEN: an unset `LOOM_ADLS_ACCOUNT` must not suppress substitution of a
 * pool name that IS set (and vice versa).
 */

/** A deployment placeholder and the env var that resolves it. */
interface PlaceholderToken {
  /** The literal token as authored in a bundle cell, e.g. `{{ADLS_ACCOUNT}}`. */
  readonly token: string;
  /** Env var holding the deployment's value. */
  readonly envVar: string;
  /** Matches the token, tolerating inner whitespace (`{{ ADLS_ACCOUNT }}`). */
  readonly pattern: RegExp;
}

function tokenDef(name: string, envVar: string): PlaceholderToken {
  return {
    token: `{{${name}}}`,
    envVar,
    pattern: new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g'),
  };
}

/**
 * Every placeholder the substituter knows. A bundle that authors a token absent
 * from this list would ship a permanently-unresolved literal, so the bundle
 * lint test asserts this list covers every `{{…}}` in every registered bundle.
 */
export const PLACEHOLDER_TOKENS: readonly PlaceholderToken[] = [
  tokenDef('ADLS_ACCOUNT', 'LOOM_ADLS_ACCOUNT'),
  tokenDef('SYNAPSE_DEDICATED_POOL', 'LOOM_SYNAPSE_DEDICATED_POOL'),
];

/** The token names this module can resolve (for lint/diagnostics). */
export function knownPlaceholderNames(): string[] {
  return PLACEHOLDER_TOKENS.map((t) => t.token.slice(2, -2));
}

/** The default ADLS Gen2 account for this deployment (admin-plane bicep env). */
export function resolveAdlsAccount(): string {
  return (process.env.LOOM_ADLS_ACCOUNT || '').trim();
}

/** The Synapse dedicated SQL pool (database) backing Loom warehouses. */
export function resolveSynapseDedicatedPool(): string {
  return (process.env.LOOM_SYNAPSE_DEDICATED_POOL || '').trim();
}

/**
 * Resolve every known token from the environment. `adlsAccountOverride` keeps
 * the historical explicit-override argument working for `{{ADLS_ACCOUNT}}`.
 */
function resolveValues(adlsAccountOverride?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of PLACEHOLDER_TOKENS) {
    const value =
      t.envVar === 'LOOM_ADLS_ACCOUNT' && adlsAccountOverride !== undefined
        ? adlsAccountOverride
        : (process.env[t.envVar] || '').trim();
    if (value) out[t.token] = value;
  }
  return out;
}

/**
 * Replace every resolvable `{{TOKEN}}` in a single notebook cell's source.
 * No-ops on a source with no placeholder. A token whose env var is unset is left
 * intact (honest gate) WITHOUT blocking the tokens that did resolve. Never throws.
 */
export function substituteNotebookPlaceholders(source: string, account?: string): string {
  if (typeof source !== 'string' || source.indexOf('{{') === -1) return source;
  const values = resolveValues(account);
  let out = source;
  for (const t of PLACEHOLDER_TOKENS) {
    const value = values[t.token];
    if (value) out = out.replace(t.pattern, value);
  }
  return out;
}

/**
 * Apply placeholder substitution across a NotebookContent `cells[]` array
 * (install path). Returns the same array reference when nothing needs changing,
 * otherwise a shallow copy with substituted `source` strings. Never throws.
 */
export function substituteCellsPlaceholders<T extends { source?: unknown }>(
  cells: T[],
  account?: string,
): T[] {
  if (!Array.isArray(cells) || cells.length === 0) return cells;
  let changed = false;
  const out = cells.map((c) => {
    if (c && typeof (c as any).source === 'string' && (c as any).source.indexOf('{{') !== -1) {
      const next = substituteNotebookPlaceholders((c as any).source, account);
      if (next !== (c as any).source) { changed = true; return { ...c, source: next }; }
    }
    return c;
  });
  return changed ? out : cells;
}
