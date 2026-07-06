/**
 * Data Wrangler BFF — POST /api/notebook/wrangler
 *
 * Backs the notebook editor's Data Wrangler panel (Microsoft Fabric
 * "Data Wrangler" 1:1 on Azure — https://learn.microsoft.com/fabric/data-science/data-wrangler).
 * The panel POSTs a data SAMPLE ({ columns, rows }) plus an ordered list of
 * structured transform STEPS chosen from the operation gallery; this route
 * forwards them to the loom-wrangler-host Container App (a real FastAPI + pandas
 * service) which applies each step with REAL pandas and returns the preview grid
 * + per-column summary + the equivalent pandas AND PySpark code for export.
 *
 * No Microsoft Fabric dependency: the host is a plain pandas service. When it
 * isn't deployed the route HONEST-GATES on LOOM_WRANGLER_ENDPOINT (503) naming
 * the exact env var + the bicep module — the panel still renders (no-vaporware).
 *
 * Envelope: { ok, ... } via apiOk / apiError / apiServerError (respond.ts).
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WRANGLER_TIMEOUT_MS = 25_000; // Front Door 30s cap; leave headroom.
const MAX_ROWS = 5_000;
const MAX_STEPS = 100;

interface WranglerBody {
  columns?: string[];
  rows?: Record<string, unknown>[];
  steps?: Record<string, unknown>[];
  dfVar?: string;
  outVar?: string;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  // ── Honest gate FIRST (no-vaporware): without the host there is nothing real
  // to call, so name the exact env var + the bicep module that deploys it.
  const endpoint = process.env.LOOM_WRANGLER_ENDPOINT?.trim();
  if (!endpoint) {
    return apiError(
      'The Data Wrangler pandas host is not deployed. Set LOOM_WRANGLER_ENDPOINT ' +
        '(the internal FQDN of the loom-wrangler-host Container App) — provisioned by ' +
        'platform/fiab/bicep/modules/integration/wrangler.bicep and wired into the console ' +
        'env in admin-plane/main.bicep. No Microsoft Fabric capacity required.',
      503,
    );
  }

  let body: WranglerBody = {};
  try {
    body = (await req.json()) as WranglerBody;
  } catch {
    /* empty/invalid body → validated below */
  }

  const columns = Array.isArray(body.columns) ? body.columns.map(String) : [];
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  const steps = Array.isArray(body.steps) ? body.steps.slice(0, MAX_STEPS) : [];
  if (!rows.length) {
    return apiError('Provide a data sample (rows) to preview transforms against.', 400);
  }

  const base = endpoint.replace(/\/$/, '');
  const url = (/^https?:\/\//i.test(base) ? base : `https://${base}`) + '/preview';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRANGLER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        columns,
        rows,
        steps,
        df_var: typeof body.dfVar === 'string' && body.dfVar ? body.dfVar : 'df',
        out_var: typeof body.outVar === 'string' && body.outVar ? body.outVar : 'df_clean',
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return apiError(
      aborted
        ? 'The Data Wrangler host did not respond in time (the request was aborted). Reduce the sample size or the number of queued steps.'
        : `Could not reach the Data Wrangler host at LOOM_WRANGLER_ENDPOINT: ${e?.message || String(e)}.`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return apiError(`Data Wrangler host returned a non-JSON response (HTTP ${res.status}).`, 502);
  }
  if (!res.ok || payload?.ok === false) {
    return apiError(
      typeof payload?.error === 'string' ? payload.error : `Data Wrangler host error (HTTP ${res.status}).`,
      res.status >= 400 && res.status < 600 ? res.status : 502,
    );
  }

  try {
    return apiOk({
      columns: payload.columns ?? [],
      rows: payload.rows ?? [],
      rowCount: payload.row_count ?? (payload.rows?.length ?? 0),
      summary: payload.summary ?? [],
      steps: payload.steps ?? [],
      code: payload.code ?? { pandas: '', pyspark: '' },
    });
  } catch (e) {
    return apiServerError(e, 'Failed to shape the Data Wrangler response.');
  }
}
