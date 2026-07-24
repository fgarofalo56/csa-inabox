/**
 * N7b — dead-letter reader (server; real ADLS reads).
 *
 * N6 contract enforcement quarantines a violating row to
 * `<basePath>/_rejected/<schema.table>/rejected-<ts>.jsonl` BESIDE the clean
 * landed data (see lib/ingest/contract-enforcement.ts). The control-plane
 * monitor's "Dead letter" panel reads that folder directly — no mock arrays:
 * per-dataset reject counts from a real `listPaths`, plus a bounded sample of
 * the most-recent quarantined rows (each carries its ODCS violations) from a
 * real `downloadFile`.
 *
 * The whole tree is in the deployment's own Bronze ADLS Gen2 container, so this
 * runs fully in-boundary (IL5). Best-effort: an unconfigured / empty Bronze
 * returns an empty, honest result rather than throwing.
 */
import { listPaths, downloadFile } from '@/lib/azure/adls-client';

/** ADLS Gen2 container the mirror + its `_rejected` tree live in. */
const BRONZE = 'bronze';

export interface DeadLetterSampleRow {
  dataset: string;
  rejectedAt?: string;
  contractId?: string;
  contractVersion?: string;
  violations?: unknown;
  /** The original quarantined row, verbatim. */
  row?: unknown;
}

export interface DeadLetterDataset {
  dataset: string;
  files: number;
  bytes: number;
  lastRejectedAt?: string;
}

export interface DeadLetterReport {
  /** True when a `_rejected` tree exists (even if currently empty). */
  present: boolean;
  totalFiles: number;
  totalBytes: number;
  datasets: DeadLetterDataset[];
  /** A bounded, most-recent-first sample of quarantined rows. */
  sample: DeadLetterSampleRow[];
  note?: string;
}

/** Basename of an ADLS full path (`a/b/c` → `c`). */
function baseName(p: string): string {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * Read the connector's dead-letter tree under `<basePath>/_rejected/`.
 * `basePath` is the mirror's Bronze-relative root (`mirrors/<ws>/<mirror>`),
 * i.e. the `state.lastRun.basePath` the engine persisted (an https URL) OR the
 * derived `mirrors/<ws>/<id>` prefix — this helper accepts either and reduces it
 * to the container-relative prefix.
 */
export async function readDeadLetter(
  basePathOrUrl: string,
  opts: { sampleLimit?: number; datasetLimit?: number } = {},
): Promise<DeadLetterReport> {
  const sampleLimit = opts.sampleLimit ?? 25;
  const datasetLimit = opts.datasetLimit ?? 100;
  const empty: DeadLetterReport = { present: false, totalFiles: 0, totalBytes: 0, datasets: [], sample: [] };

  const base = toRelativePrefix(basePathOrUrl);
  if (!base) return { ...empty, note: 'No landing path yet — Start the connector to establish its Bronze root.' };

  const rejectedRoot = `${base}/_rejected`;
  let datasetDirs;
  try {
    datasetDirs = await listPaths(BRONZE, rejectedRoot, datasetLimit);
  } catch {
    // Bronze not configured / not reachable → honest empty, not a throw.
    return { ...empty, note: 'The Bronze dead-letter path is not reachable (ADLS not configured, or nothing has been quarantined yet).' };
  }
  if (!datasetDirs.length) {
    return { present: false, totalFiles: 0, totalBytes: 0, datasets: [], sample: [], note: 'No quarantined rows — every replicated row conformed to its bound data contract (or no contract is bound).' };
  }

  const datasets: DeadLetterDataset[] = [];
  const fileIndex: Array<{ dataset: string; path: string; lastModified?: string; bytes: number }> = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const dir of datasetDirs) {
    if (!dir.isDirectory) continue;
    const dataset = baseName(dir.name);
    let files;
    try {
      files = await listPaths(BRONZE, dir.name, 500);
    } catch {
      continue;
    }
    const jsonl = files.filter((f) => !f.isDirectory && f.name.endsWith('.jsonl'));
    let bytes = 0;
    let last: string | undefined;
    for (const f of jsonl) {
      bytes += f.size;
      if (f.lastModified && (!last || f.lastModified > last)) last = f.lastModified;
      fileIndex.push({ dataset, path: f.name, lastModified: f.lastModified, bytes: f.size });
    }
    totalFiles += jsonl.length;
    totalBytes += bytes;
    datasets.push({ dataset, files: jsonl.length, bytes, lastRejectedAt: last });
  }

  datasets.sort((a, b) => (b.lastRejectedAt || '').localeCompare(a.lastRejectedAt || ''));

  // Sample the most-recent files (across datasets) until we have `sampleLimit` rows.
  fileIndex.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
  const sample: DeadLetterSampleRow[] = [];
  for (const f of fileIndex) {
    if (sample.length >= sampleLimit) break;
    let text: string;
    try {
      const { body } = await downloadFile(BRONZE, f.path);
      text = body.toString('utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (sample.length >= sampleLimit) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        sample.push({
          dataset: f.dataset,
          rejectedAt: obj._rejectedAt as string | undefined,
          contractId: obj._contractId as string | undefined,
          contractVersion: obj._contractVersion as string | undefined,
          violations: obj._violations,
          row: obj.row,
        });
      } catch {
        /* skip a malformed line — never fail the panel */
      }
    }
  }

  return {
    present: true,
    totalFiles,
    totalBytes,
    datasets: datasets.slice(0, datasetLimit),
    sample,
  };
}

/**
 * Reduce a Bronze base (either the engine's persisted https folder URL or a
 * container-relative `mirrors/<ws>/<id>` prefix) to a clean container-relative
 * prefix with no leading/trailing slashes and no `_rejected` suffix.
 */
export function toRelativePrefix(basePathOrUrl: string): string {
  let v = String(basePathOrUrl || '').trim();
  if (!v) return '';
  // Strip an https URL down to its path, then drop the container segment.
  const httpsMatch = /^https?:\/\/[^/]+\/([^/]+)\/(.*)$/i.exec(v);
  if (httpsMatch) {
    v = httpsMatch[2];
  }
  v = v.replace(/^\/+|\/+$/g, '');
  // If the caller already pointed at `_rejected`, step back up one level.
  v = v.replace(/\/_rejected$/i, '');
  return v;
}
