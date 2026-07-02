/**
 * Deployment-placeholder substitution for bundle-provided notebook cell source.
 *
 * The Supercharge content bundles ship an `{{ADLS_ACCOUNT}}` token in place of
 * the deployment's ADLS Gen2 account name — the notebook generator swaps
 * OneLake's `onelake.dfs.fabric.microsoft.com` host for
 * `{{ADLS_ACCOUNT}}.dfs.core.windows.net` (see
 * scripts/csa-loom/import-supercharge-notebooks.mjs) so the vendored source
 * carries zero deployment-specific host and zero hard Fabric dependency.
 *
 * Left un-substituted the token yields an INVALID abfss host
 * (`abfss://c@{{ADLS_ACCOUNT}}.dfs.core.windows.net/...`) that fails at read
 * time — a no-vaporware violation. This helper resolves the token to the real
 * Azure-native account, from `LOOM_ADLS_ACCOUNT` (set by admin-plane bicep) or
 * an explicit override resolved from the workspace's bound storage.
 *
 * Substitution runs on BOTH sides of the notebook lifecycle:
 *   - install  (app install route persists `state.cells`) — so the stored
 *     notebook is already deployment-correct, and
 *   - run      (notebook `/run` route) — so notebooks installed before this
 *     fix, or edited by hand, still resolve at execution time.
 *
 * Honest gate: when no account is resolvable the token is LEFT INTACT rather
 * than guessed — the cell then fails with a clear invalid-host error naming the
 * literal `{{ADLS_ACCOUNT}}`, pointing the operator at `LOOM_ADLS_ACCOUNT`.
 */

/** The default ADLS Gen2 account for this deployment (admin-plane bicep env). */
export function resolveAdlsAccount(): string {
  return (process.env.LOOM_ADLS_ACCOUNT || '').trim();
}

const ADLS_ACCOUNT_TOKEN = /\{\{\s*ADLS_ACCOUNT\s*\}\}/g;

/**
 * Replace `{{ADLS_ACCOUNT}}` in a single notebook cell's source with the
 * resolved account. No-ops when the source has no placeholder or no account is
 * resolvable. Never throws.
 */
export function substituteNotebookPlaceholders(source: string, account?: string): string {
  if (typeof source !== 'string' || source.indexOf('{{') === -1) return source;
  const acct = (account ?? resolveAdlsAccount());
  if (!acct) return source;
  return source.replace(ADLS_ACCOUNT_TOKEN, acct);
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
  const acct = (account ?? resolveAdlsAccount());
  if (!acct) return cells;
  let changed = false;
  const out = cells.map((c) => {
    if (c && typeof (c as any).source === 'string' && (c as any).source.indexOf('{{') !== -1) {
      const next = substituteNotebookPlaceholders((c as any).source, acct);
      if (next !== (c as any).source) { changed = true; return { ...c, source: next }; }
    }
    return c;
  });
  return changed ? out : cells;
}
