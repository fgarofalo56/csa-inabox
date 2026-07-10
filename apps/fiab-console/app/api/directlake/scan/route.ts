/**
 * POST /api/directlake/scan — Loom Direct Lake columnar scan proxy (HYP-5).
 *
 * Forwards a scan request to the loom-directlake Container App (a real Rust/axum
 * service that FRAMES a Delta/Parquet source and TRANSCODES scanned columns to an
 * Arrow IPC stream via Apache DataFusion — the Azure-native, OSS
 * outcome-equivalent of Microsoft Fabric's Direct Lake). The service reads the
 * customer's OWN ADLS Gen2 via Managed Identity; NO Fabric / OneLake / Power BI
 * service is contacted (.claude/rules/no-fabric-dependency.md).
 *
 * ── HONEST GATE (no-vaporware.md) ───────────────────────────────────────────
 * When LOOM_DIRECTLAKE_URL is unset the service is not deployed, so there is
 * nothing real to call: the route returns a 503 naming the exact env var + the
 * bicep module that provisions it. The semantic-model / report layer treats this
 * as a silent fall-back to its existing backend (AAS fast-path / Synapse
 * Serverless) — NEVER a Fabric gate. The `fixture://sales` source lets a caller
 * prove the path end-to-end with zero Azure once the service is deployed.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * Tenant-admin gated (getSession + requireTenantAdmin — copied from the sibling
 * /api/admin/capacity/guardrails route, NOT a bare getSession check). Driving the
 * Direct Lake scan/framing service is a substrate-admin action in this skeleton;
 * HYP-7 wires the per-user semantic-model query path behind the
 * LOOM_SEMANTIC_BACKEND=loom-columnar-cache selector.
 *
 * 200 → { ok:true, stats, arrowIpcBase64 }   (JSON stats + transcoded Arrow IPC)
 * 400 → bad request (missing path)
 * 401 → unauthenticated · 403 → not a tenant admin
 * 502 → service unreachable / engine error
 * 503 → service not deployed (names LOOM_DIRECTLAKE_URL + the bicep module)
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiUnauthorized } from '@/lib/api/respond';
import { normalizeScanBody, buildScanUrl, type RawScanBody } from '@/lib/directlake/scan-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Front Door caps a request at 30s; leave headroom under it. */
const SCAN_TIMEOUT_MS = 25_000;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const denied = requireTenantAdmin(session);
  if (denied) return denied;

  // ── Honest gate FIRST (no-vaporware): without the service there is nothing
  // real to call, so name the exact env var + the bicep module that deploys it.
  const base = process.env.LOOM_DIRECTLAKE_URL?.trim();
  if (!base) {
    return apiError(
      'The Loom Direct Lake columnar scan service is not deployed. Set LOOM_DIRECTLAKE_URL ' +
        '(the internal FQDN of the loom-directlake Container App) — provisioned by ' +
        'platform/fiab/bicep/modules/compute/loom-directlake-app.bicep. The semantic-model / ' +
        'report layer falls back to its existing backend (Azure Analysis Services fast-path or ' +
        'Synapse Serverless) until it is set. No Microsoft Fabric / Power BI capacity required.',
      503,
    );
  }

  let raw: RawScanBody = {};
  try {
    raw = (await req.json()) as RawScanBody;
  } catch {
    /* empty/invalid body → validated below */
  }

  const normalized = normalizeScanBody(raw);
  if (!normalized.ok) return apiError(normalized.error, 400);
  const { path, projection, limit } = normalized.value;

  const url = buildScanUrl(base);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, projection, limit }),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return apiError(
      aborted
        ? 'The Direct Lake scan did not complete in time (aborted). Reduce the projection/limit or warm the frame first.'
        : `Could not reach the Direct Lake service at LOOM_DIRECTLAKE_URL: ${
            e instanceof Error ? e.message : String(e)
          }.`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: { ok?: boolean; error?: string; stats?: unknown; arrowIpcBase64?: string } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  // Relay the service's structured result with a matching status.
  if (!res.ok || !json || json.ok !== true) {
    const status = res.ok ? 502 : res.status;
    return apiError(
      json?.error || text.slice(0, 500) || `Direct Lake scan failed (HTTP ${res.status})`,
      status,
    );
  }

  return apiOk({ stats: json.stats, arrowIpcBase64: json.arrowIpcBase64 });
}
