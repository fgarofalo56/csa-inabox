/**
 * PSR-1 — optional LoomPerf_CL Log-Analytics export.
 *
 * Mirrors lib/admin/audit-stream.ts: each benchmark metric row is ALSO POSTed
 * (fire-and-forget) to the Azure Monitor **Logs Ingestion API** so perf trends
 * can be queried in KQL alongside platform telemetry (Sentinel / workbooks).
 *
 * Transport (grounded in Microsoft Learn — "Logs Ingestion API in Azure
 * Monitor"):
 *   POST {DCE-endpoint}/dataCollectionRules/{DCR-immutable-id}/streams/Custom-LoomPerf_CL?api-version=2023-01-01
 *
 * Honest gate (no-vaporware.md): when `LOOM_PERF_DCR_ENDPOINT` /
 * `LOOM_PERF_DCR_ID` are unset the exporter is a silent no-op — the Cosmos
 * `perf-benchmarks` trend store is the authoritative record and always works;
 * the Log-Analytics export is strictly additive. Deploy the pipeline with
 * platform/fiab/bicep/modules/admin-plane/perf-benchmarks-dcr.bicep, then set
 * this module's outputs on the Console app.
 *
 * These env vars are DEPLOYMENT-OUTPUT wiring (like LOOM_AUDIT_DCR_*), read
 * directly here — they are NOT part of the /admin/env-config editable registry
 * (EDITABLE_ENV), so the pinned env-config count test is unaffected.
 */
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { monitorIngestionScope } from '@/lib/azure/cloud-endpoints';
import type { PerfBenchmarkDoc } from '@/lib/perf/perf-store';

/** DCR stream name (matches the bicep streamDeclarations key + table). */
export const PERF_STREAM = 'Custom-LoomPerf_CL';
export const PERF_INGESTION_API_VERSION = '2023-01-01';

/** Row shape POSTed to the ingestion API — 1:1 with the LoomPerf_CL columns. */
export interface LoomPerfRow {
  TimeGenerated: string;
  RunId: string;
  GitSha: string;
  Rev: string;
  Metric: string;
  Backend: string;
  P50: number;
  P95: number;
  P99: number;
  ColdMs: number;
  WarmMs: number;
  Gated: boolean;
  TenantId: string;
}

let warnedDisabled = false;

/** Resolve the DCR ingestion config, or null (the honest un-provisioned gate). */
export function perfExportConfig(): { endpoint: string; dcrId: string } | null {
  const endpoint = (process.env.LOOM_PERF_DCR_ENDPOINT || '').trim().replace(/\/+$/, '');
  const dcrId = (process.env.LOOM_PERF_DCR_ID || '').trim();
  if (!endpoint || !dcrId) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      // eslint-disable-next-line no-console
      console.debug(
        '[perf-export] LoomPerf_CL Log-Analytics export disabled — set LOOM_PERF_DCR_ENDPOINT ' +
          '(the DCE logs-ingestion endpoint) + LOOM_PERF_DCR_ID (the DCR immutable id) to stream ' +
          'benchmark rows to the LoomPerf_CL table. Deploy them with ' +
          'platform/fiab/bicep/modules/admin-plane/perf-benchmarks-dcr.bicep. The Cosmos ' +
          'perf-benchmarks trend store is unaffected.',
      );
    }
    return null;
  }
  return { endpoint, dcrId };
}

/** Map a persisted benchmark doc to a LoomPerf_CL row (numbers default to 0). */
export function buildPerfRow(d: PerfBenchmarkDoc): LoomPerfRow {
  const num = (n: number | null | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  return {
    TimeGenerated: d.ts || new Date().toISOString(),
    RunId: d.runId || '',
    GitSha: d.gitSha || '',
    Rev: d.rev || '',
    Metric: d.metric || '',
    Backend: d.backend || '',
    P50: num(d.p50),
    P95: num(d.p95),
    P99: num(d.p99),
    ColdMs: num(d.coldMs),
    WarmMs: num(d.warmMs),
    Gated: !!d.gated,
    TenantId: d.tenantId || '',
  };
}

let tokenCache: { token: string; expiresOnTimestamp: number } | null = null;
async function ingestionToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresOnTimestamp - now > 120_000) return tokenCache.token;
  const cred = uamiArmCredential();
  const t = await cred.getToken(monitorIngestionScope());
  if (!t?.token) throw new Error('could not acquire an Azure Monitor ingestion token');
  tokenCache = { token: t.token, expiresOnTimestamp: t.expiresOnTimestamp };
  return t.token;
}

/**
 * POST benchmark rows to the LoomPerf_CL stream. Resolves `{ sent: 0,
 * skipped:'not-configured' }` when un-provisioned (honest gate); throws on a
 * real transport/auth error so the caller can log it.
 */
export async function postPerfRows(
  docs: PerfBenchmarkDoc[],
): Promise<{ sent: number; skipped?: 'not-configured' | 'empty' }> {
  if (!docs.length) return { sent: 0, skipped: 'empty' };
  const cfg = perfExportConfig();
  if (!cfg) return { sent: 0, skipped: 'not-configured' };

  const rows = docs.map(buildPerfRow);
  const token = await ingestionToken();
  const url =
    `${cfg.endpoint}/dataCollectionRules/${cfg.dcrId}/streams/${PERF_STREAM}` +
    `?api-version=${PERF_INGESTION_API_VERSION}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Logs Ingestion API ${res.status}: ${body.slice(0, 300)}`);
  }
  return { sent: rows.length };
}

/** Fire-and-forget export — never throws, never blocks the run write-back. */
export function exportPerfRows(docs: PerfBenchmarkDoc[]): void {
  try {
    void postPerfRows(docs).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[perf-export] failed to forward perf rows to LoomPerf_CL:', (e as Error)?.message || e);
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[perf-export] emit failed:', (e as Error)?.message || e);
  }
}
