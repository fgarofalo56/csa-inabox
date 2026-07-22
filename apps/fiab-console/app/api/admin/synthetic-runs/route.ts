/**
 * GET /api/admin/synthetic-runs?n=12 — the last N synthetic-journey run
 * summaries for the Health & Reliability hub's Journeys tab (V1).
 *
 * REAL backend: lists the run artifacts the in-VNet `loom-synthetic-monitor`
 * job uploads to Blob (uat-runs/synthetic/<runId>/verdicts.ndjson in
 * LOOM_UAT_RESULTS_ACCOUNT / LOOM_UAT_RESULTS_CONTAINER — the exact upload
 * path of e2e/run-uat-unattended.mjs) and parses each run's per-journey
 * verdicts. No mock data; when the results store is unwired the
 * svc-synthetic-monitor gate returns the honest 503 envelope with its Fix-it.
 *
 * Session-gated, admin-only (withTenantAdmin — R1 route-toolkit), shape:
 *   { ok: true, runs: [{ runId, ts, pass, fail, skip,
 *       journeys: [{ name, verdict, status, ms, notes, screenshot }] }] }
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin, withBackendGate } from '@/lib/api/route-toolkit';
import { apiOk } from '@/lib/api/respond';
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import { getBlobSuffix } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The prefix e2e/run-synthetic.mjs pins via UAT_RUN_TAG=synthetic/<ts>. */
const RUN_PREFIX = 'uat-runs/synthetic/';

interface JourneySummary {
  name: string;
  verdict: string;
  status: 'pass' | 'fail' | 'skip' | 'vaporware';
  ms?: number;
  notes?: string;
  screenshot?: string;
}

interface RunSummary {
  runId: string;
  ts: string;
  pass: number;
  fail: number;
  skip: number;
  journeys: JourneySummary[];
}

async function streamToString(readable: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!readable) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export const GET = withTenantAdmin(
  withBackendGate('svc-synthetic-monitor', async (req: NextRequest) => {
    const account = (process.env.LOOM_UAT_RESULTS_ACCOUNT || '').trim();
    const containerName = (process.env.LOOM_UAT_RESULTS_CONTAINER || '').trim();
    const n = Math.min(Math.max(Number(req.nextUrl.searchParams.get('n')) || 12, 1), 48);

    const { BlobServiceClient } = await import('@azure/storage-blob');
    const service = new BlobServiceClient(`https://${account}.${getBlobSuffix()}`, loomServerCredential);
    const container = service.getContainerClient(containerName);

    // 1) Enumerate run folders (BlobPrefix per uat-runs/synthetic/<runId>/).
    const runIds: string[] = [];
    for await (const item of container.listBlobsByHierarchy('/', { prefix: RUN_PREFIX })) {
      if (item.kind === 'prefix') {
        runIds.push(item.name.slice(RUN_PREFIX.length).replace(/\/$/, ''));
      }
    }
    // Timestamp-shaped ids (2026-07-22T12-00-00-000Z) sort lexicographically.
    runIds.sort().reverse();

    // 2) Parse each recent run's verdicts.ndjson (small — one line per journey).
    const runs: RunSummary[] = [];
    for (const runId of runIds.slice(0, n)) {
      const blob = container.getBlobClient(`${RUN_PREFIX}${runId}/verdicts.ndjson`);
      let text = '';
      try {
        const dl = await blob.download();
        text = await streamToString(dl.readableStreamBody);
      } catch {
        // Run in progress (verdicts not uploaded yet) or a crashed execution —
        // still list it so gaps in the cadence are visible.
      }
      const journeys: JourneySummary[] = [];
      let ts = '';
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let v: any;
        try { v = JSON.parse(line); } catch { continue; }
        if (typeof v?.surface !== 'string' || !v.surface.startsWith('synthetic:')) continue;
        if (!ts && typeof v.ts === 'string') ts = v.ts;
        journeys.push({
          name: String(v.feature || v.surface.slice('synthetic:'.length)),
          verdict: String(v.verdict || ''),
          status: (['pass', 'fail', 'skip', 'vaporware'].includes(v.status) ? v.status : 'fail') as JourneySummary['status'],
          ms: typeof v.durationMs === 'number' ? v.durationMs : undefined,
          notes: typeof v.notes === 'string' ? v.notes.slice(0, 400) : undefined,
          screenshot: typeof v.screenshot === 'string' ? v.screenshot : undefined,
        });
      }
      runs.push({
        runId,
        ts,
        pass: journeys.filter((j) => j.status === 'pass').length,
        fail: journeys.filter((j) => j.status === 'fail').length,
        skip: journeys.filter((j) => j.status === 'skip').length,
        journeys,
      });
    }

    return apiOk({ runs, account, container: containerName, prefix: RUN_PREFIX });
  }),
);
