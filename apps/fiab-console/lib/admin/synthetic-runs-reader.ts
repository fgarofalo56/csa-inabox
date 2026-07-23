/**
 * synthetic-runs-reader — shared read of the in-VNet `loom-synthetic-monitor`
 * run artifacts (V1). Lists the run folders the job uploads to Blob
 * (uat-runs/synthetic/<runId>/verdicts.ndjson in LOOM_UAT_RESULTS_ACCOUNT /
 * LOOM_UAT_RESULTS_CONTAINER — the exact upload path of
 * e2e/run-uat-unattended.mjs) and parses each run's per-journey verdicts.
 *
 * WHY a shared module: two hub surfaces read the same feed — the Journeys tab
 * (GET /api/admin/synthetic-runs) shows the raw run list, and the SLO tab
 * (SLO1, GET /api/admin/slo) rolls the journey verdicts into a 28-day
 * availability SLI + error-budget burn. Keeping the Blob listing + verdict
 * parse in ONE place means the two never drift on what a "run" is.
 *
 * Gate posture differs by caller, so this module is gate-AGNOSTIC: it reports
 * `configured:false` (never throws) when the results store env is unset. The
 * Journeys route keeps its `withBackendGate('svc-synthetic-monitor')` wrapper
 * (hard 503) for a single-feed surface; the SLO route treats an unwired store
 * as "journey SLI unavailable" and still renders the Copilot + cache SLIs.
 *
 * No mock data (no-vaporware.md). Server-only: imports @azure/storage-blob.
 */
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import { getBlobSuffix } from '@/lib/azure/cloud-endpoints';

/** The prefix e2e/run-synthetic.mjs pins via UAT_RUN_TAG=synthetic/<ts>. */
export const SYNTHETIC_RUN_PREFIX = 'uat-runs/synthetic/';

/** One journey's verdict inside a run (mirrors the Journeys tab shape). */
export interface JourneyVerdict {
  name: string;
  verdict: string;
  status: 'pass' | 'fail' | 'skip' | 'vaporware';
  ms?: number;
  notes?: string;
  screenshot?: string;
}

/** One synthetic-monitor run's parsed summary. */
export interface SyntheticRunSummary {
  runId: string;
  ts: string;
  pass: number;
  fail: number;
  skip: number;
  journeys: JourneyVerdict[];
}

/** Result of a read — `configured:false` = the results store env is unset. */
export interface SyntheticRunsResult {
  configured: boolean;
  /** The env var(s) missing when `configured` is false (honest gate hint). */
  missing?: string;
  runs: SyntheticRunSummary[];
  account?: string;
  container?: string;
}

async function streamToString(readable: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!readable) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Parse one run's verdicts.ndjson text into a summary (pure — unit-tested). */
export function parseVerdicts(runId: string, text: string): SyntheticRunSummary {
  const journeys: JourneyVerdict[] = [];
  let ts = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v?.surface !== 'string' || !v.surface.startsWith('synthetic:')) continue;
    if (!ts && typeof v.ts === 'string') ts = v.ts;
    journeys.push({
      name: String(v.feature || v.surface.slice('synthetic:'.length)),
      verdict: String(v.verdict || ''),
      status: (['pass', 'fail', 'skip', 'vaporware'].includes(v.status) ? v.status : 'fail') as JourneyVerdict['status'],
      ms: typeof v.durationMs === 'number' ? v.durationMs : undefined,
      notes: typeof v.notes === 'string' ? v.notes.slice(0, 400) : undefined,
      screenshot: typeof v.screenshot === 'string' ? v.screenshot : undefined,
    });
  }
  return {
    runId,
    ts,
    pass: journeys.filter((j) => j.status === 'pass').length,
    fail: journeys.filter((j) => j.status === 'fail').length,
    skip: journeys.filter((j) => j.status === 'skip').length,
    journeys,
  };
}

/**
 * Read the last `n` synthetic-monitor runs (newest first). Gate-agnostic:
 * returns `{ configured:false }` when the results store env is unset — the
 * caller decides whether that is a hard gate (Journeys tab) or a soft
 * "no data" SLI (SLO tab).
 */
export async function readSyntheticRuns(opts: { n: number }): Promise<SyntheticRunsResult> {
  const account = (process.env.LOOM_UAT_RESULTS_ACCOUNT || '').trim();
  const containerName = (process.env.LOOM_UAT_RESULTS_CONTAINER || '').trim();
  if (!account || !containerName) {
    const missing = [
      account ? '' : 'LOOM_UAT_RESULTS_ACCOUNT',
      containerName ? '' : 'LOOM_UAT_RESULTS_CONTAINER',
    ]
      .filter(Boolean)
      .join(', ');
    return { configured: false, missing, runs: [] };
  }
  const n = Math.min(Math.max(opts.n, 1), 200);

  const { BlobServiceClient } = await import('@azure/storage-blob');
  const service = new BlobServiceClient(`https://${account}.${getBlobSuffix()}`, loomServerCredential);
  const container = service.getContainerClient(containerName);

  // 1) Enumerate run folders (BlobPrefix per uat-runs/synthetic/<runId>/).
  const runIds: string[] = [];
  for await (const item of container.listBlobsByHierarchy('/', { prefix: SYNTHETIC_RUN_PREFIX })) {
    if (item.kind === 'prefix') {
      runIds.push(item.name.slice(SYNTHETIC_RUN_PREFIX.length).replace(/\/$/, ''));
    }
  }
  // Timestamp-shaped ids (2026-07-22T12-00-00-000Z) sort lexicographically.
  runIds.sort().reverse();

  // 2) Parse each recent run's verdicts.ndjson (small — one line per journey).
  const runs: SyntheticRunSummary[] = [];
  for (const runId of runIds.slice(0, n)) {
    const blob = container.getBlobClient(`${SYNTHETIC_RUN_PREFIX}${runId}/verdicts.ndjson`);
    let text = '';
    try {
      const dl = await blob.download();
      text = await streamToString(dl.readableStreamBody);
    } catch {
      // Run in progress (verdicts not uploaded yet) or a crashed execution —
      // still list it so gaps in the cadence are visible.
    }
    runs.push(parseVerdicts(runId, text));
  }

  return { configured: true, runs, account, container: containerName };
}
