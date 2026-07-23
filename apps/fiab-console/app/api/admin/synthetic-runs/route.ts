/**
 * GET /api/admin/synthetic-runs?n=12 — the last N synthetic-journey run
 * summaries for the Health & Reliability hub's Journeys tab (V1).
 *
 * REAL backend: lists the run artifacts the in-VNet `loom-synthetic-monitor`
 * job uploads to Blob (uat-runs/synthetic/<runId>/verdicts.ndjson in
 * LOOM_UAT_RESULTS_ACCOUNT / LOOM_UAT_RESULTS_CONTAINER — the exact upload
 * path of e2e/run-uat-unattended.mjs) and parses each run's per-journey
 * verdicts. The Blob listing + verdict parse live in the shared
 * `lib/admin/synthetic-runs-reader` (also consumed by the SLO tab, SLO1) so the
 * two hub surfaces never drift on what a "run" is. No mock data; when the
 * results store is unwired the svc-synthetic-monitor gate returns the honest
 * 503 envelope with its Fix-it.
 *
 * Session-gated, admin-only (withTenantAdmin — R1 route-toolkit), shape:
 *   { ok: true, runs: [{ runId, ts, pass, fail, skip,
 *       journeys: [{ name, verdict, status, ms, notes, screenshot }] }] }
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin, withBackendGate } from '@/lib/api/route-toolkit';
import { apiOk } from '@/lib/api/respond';
import { readSyntheticRuns, SYNTHETIC_RUN_PREFIX } from '@/lib/admin/synthetic-runs-reader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(
  withBackendGate('svc-synthetic-monitor', async (req: NextRequest) => {
    const n = Math.min(Math.max(Number(req.nextUrl.searchParams.get('n')) || 12, 1), 48);
    const { runs, account, container } = await readSyntheticRuns({ n });
    return apiOk({ runs, account, container, prefix: SYNTHETIC_RUN_PREFIX });
  }),
);
