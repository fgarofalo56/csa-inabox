/**
 * PURE path-math for the lakehouse Tables/Files explorer (Phase 6, L1/L3/L4) —
 * no `vscode` import, so the ABFS/relative-path derivations are unit-testable in
 * isolation. `explorer.ts` builds `vscode.TreeItem`s from these; the copy-path
 * commands (L4) read the derived strings verbatim.
 *
 * Sovereign-cloud correctness (L4): the per-cloud DFS suffix
 * (`…dfs.core.windows.net` Commercial / `…dfs.core.usgovcloudapi.net` Gov) is
 * NEVER string-built here. The lakehouse's `abfssRoot` is resolved by the BFF
 * (`GET /api/items/lakehouse/[id]/abfss`); these helpers only JOIN the
 * server-resolved root with a table/file sub-path, so the suffix always comes
 * from the deployment, not the client.
 *
 * Fabric lakehouse layout (mirrored by the Azure-native ADLS backend): a
 * lakehouse root contains `Tables/` (Delta/Parquet tables) and `Files/`
 * (arbitrary files). The ADLS `paths` listing returns each entry's `name` as its
 * FULL container-relative path (e.g. `<root>/Files/sub/data.csv`), so a file's
 * path relative to the lakehouse root is that minus the `<root>/` prefix.
 */

import { trimSlashes } from '../util/trim';

/** Join an ABFS root with a sub-path using exactly one separating slash. */
export function joinAbfss(abfssRoot: string, sub: string): string {
  const base = abfssRoot.replace(/\/+$/, '');
  const rel = sub.replace(/^\/+/, '');
  return rel ? `${base}/${rel}` : base;
}

/** A path's segment relative to the lakehouse root (strips the `<root>/` prefix). */
export function relativeToRoot(fullPath: string, root: string): string {
  const clean = fullPath.replace(/^\/+/, '');
  const r = trimSlashes(root || '');
  if (!r) return clean;
  if (clean === r) return '';
  if (clean.startsWith(`${r}/`)) return clean.slice(r.length + 1);
  return clean; // Not under root (shouldn't happen) — return as-is, never guess.
}

/** The ADLS prefix of a lakehouse's `Files/` directory (root-aware). */
export function filesPrefix(root: string): string {
  const r = trimSlashes(root || '');
  return r ? `${r}/Files` : 'Files';
}

/** A table's path relative to the lakehouse root — always `Tables/<name>`. */
export function tableRelativePath(name: string): string {
  return `Tables/${name}`;
}

/** The full ABFS URI of a Delta/Parquet table directory (L4 copy-ABFS). */
export function tableAbfss(abfssRoot: string, name: string): string {
  return joinAbfss(abfssRoot, tableRelativePath(name));
}

/** The full ABFS URI of a file/dir given its container-relative `name` (L4). */
export function fileAbfss(abfssRoot: string, root: string, fullPath: string): string {
  return joinAbfss(abfssRoot, relativeToRoot(fullPath, root));
}

/** The display basename (leaf) of an ADLS path. */
export function basename(fullPath: string): string {
  const clean = fullPath.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i >= 0 ? clean.slice(i + 1) : clean;
}

/** Human size label (bytes → B/KB/MB/GB/TB) for a file node description. */
export function humanSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const rounded = u === 0 ? String(n) : n.toFixed(n < 10 && u > 0 ? 1 : 0);
  return `${rounded} ${units[u]}`;
}
