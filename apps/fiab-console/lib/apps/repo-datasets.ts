/**
 * Repo-hosted sample-dataset reader.
 *
 * Per .claude/rules/no-vaporware.md, a bundle that references a dataset must
 * ship that dataset REAL — hosted IN THE REPO — and the install flow must
 * actually load it so the data is present + queryable after install. Bundles
 * declare a repo-relative path under `samples/app-data/<app>/<file>` on a
 * lakehouse shortcut (`repoDataset`) or anywhere else that needs real bytes;
 * this module resolves that path against the repo root and returns the file
 * contents so the lakehouse provisioner can upload it into the tenant's own
 * ADLS Gen2 (self-contained — no external URL that can 404).
 *
 * Path safety: ONLY paths under `samples/app-data/` are readable. Any `..`
 * traversal, absolute path, or path that escapes that prefix is rejected — a
 * bundle can never coax this into reading an arbitrary file off the host.
 *
 * Runtime root resolution mirrors lib/azure/loom-docs-index.ts: walk up from
 * cwd looking for the repo-root marker (`mkdocs.yml`), since in ACA `cwd` is
 * the Next.js standalone server dir, not the repo root. The `samples/` tree is
 * kept in the standalone bundle via `outputFileTracingIncludes` in
 * next.config.mjs so the files exist at runtime; when a file genuinely can't
 * be found we return null and the caller honest-gates (status:'pending') with
 * the exact missing path — never a silent success.
 */
import fs from 'fs';
import path from 'path';

/** Sub-tree that repo datasets MUST live under (relative to repo root). */
export const REPO_DATASET_PREFIX = 'samples/app-data';

export interface RepoDataset {
  /** The repo-relative path that was requested (normalised, forward-slash). */
  relPath: string;
  /** Absolute path resolved on the runtime filesystem. */
  absPath: string;
  /** File bytes. */
  bytes: Buffer;
  /** Leaf file name, e.g. `retail-orders-public.csv`. */
  fileName: string;
  /** Best-effort content type derived from the extension. */
  contentType: string;
}

/** Find the repo root by walking up from cwd to the `mkdocs.yml` marker. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'mkdocs.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/** Map a sample-data extension to a content type for the ADLS upload. */
function contentTypeFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.csv':
      return 'text/csv';
    case '.tsv':
      return 'text/tab-separated-values';
    case '.json':
    case '.jsonl':
    case '.ndjson':
      return 'application/json';
    case '.parquet':
      return 'application/vnd.apache.parquet';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Normalise + validate a bundle-declared repo dataset path. Returns the safe
 * forward-slash relative path, or null when the path is unsafe (absolute,
 * traversal, or outside `samples/app-data/`). A bundle author may write the
 * path with or without the `samples/app-data/` prefix; both resolve to the
 * same file, but the final resolved path MUST stay under the prefix.
 */
export function normalizeRepoDatasetPath(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  // Reject absolute paths + Windows drive letters outright.
  if (path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) return null;
  let rel = input.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
  if (!rel) return null;
  // Allow the author to omit the prefix; canonicalise to include it once.
  if (!rel.startsWith(`${REPO_DATASET_PREFIX}/`) && rel !== REPO_DATASET_PREFIX) {
    rel = `${REPO_DATASET_PREFIX}/${rel}`;
  }
  // Collapse + verify no `..` escapes the prefix.
  const segs: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  const normalized = segs.join('/');
  if (!normalized.startsWith(`${REPO_DATASET_PREFIX}/`)) return null;
  // Reject the bare prefix (a directory, not a file).
  if (normalized === REPO_DATASET_PREFIX) return null;
  return normalized;
}

/**
 * Read a repo-hosted sample dataset. Returns null when the path is unsafe or
 * the file does not exist at runtime (the caller honest-gates with the exact
 * missing path — no silent success). Never throws on a missing file.
 */
export function readRepoDataset(input: string): RepoDataset | null {
  const relPath = normalizeRepoDatasetPath(input);
  if (!relPath) return null;
  const absPath = path.join(repoRoot(), ...relPath.split('/'));
  // Defence-in-depth: confirm the resolved absolute path is still under the
  // repo's samples/app-data dir after symlink-free join.
  const prefixAbs = path.join(repoRoot(), ...REPO_DATASET_PREFIX.split('/'));
  if (!absPath.startsWith(prefixAbs + path.sep) && absPath !== prefixAbs) return null;
  let bytes: Buffer;
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    bytes = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  const fileName = path.basename(absPath);
  return { relPath, absPath, bytes, fileName, contentType: contentTypeFor(fileName) };
}
