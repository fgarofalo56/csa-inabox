/**
 * POST /api/directlake/frame — Loom Direct Lake FRAMING proxy.
 *
 * Forwards a framing request to the loom-directlake Container App (the same real
 * Rust/axum service the `/scan` proxy targets). "Framing" is a metadata-only pin
 * of the source's current Delta-log version + schema — NO data is scanned or
 * copied — which is exactly Fabric Direct Lake's "framing" step (advance the
 * semantic model to the latest committed Delta version without an Import
 * refresh). The service reads the customer's OWN ADLS Gen2 via Managed Identity;
 * NO Fabric / OneLake / Power BI service is contacted
 * (.claude/rules/no-fabric-dependency.md).
 *
 * This is the sibling of `/api/directlake/scan`: `scan` returns the transcoded
 * Arrow columns for a projection; `frame` returns only the pinned version +
 * column schema so a caller can confirm the model reads Delta LIVE (the current
 * Delta version, not an imported snapshot) before scanning.
 *
 * ── HONEST GATE (no-vaporware.md) ───────────────────────────────────────────
 * When LOOM_DIRECTLAKE_URL is unset the service is not deployed, so there is
 * nothing real to call: the route returns a 503 naming the exact env var + the
 * bicep module that provisions it. The `fixture://sales` source frames end-to-end
 * with zero Azure once the service is deployed.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * Tenant-admin gated (getSession + requireTenantAdmin), matching the sibling
 * /api/directlake/scan route — driving the Direct Lake framing service is a
 * substrate-admin action.
 *
 * 200 → { ok:true, frame }          (source_kind, delta_version, columns[], elapsed_ms)
 * 400 → bad request (missing path)
 * 401 → unauthenticated · 403 → not a tenant admin
 * 502 → service unreachable / engine error
 * 503 → service not deployed (names LOOM_DIRECTLAKE_URL + the bicep module)
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiUnauthorized } from '@/lib/api/respond';
import { normalizeFrameBody, buildFrameUrl, type RawFrameBody } from '@/lib/directlake/scan-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Framing is metadata-only, but Front Door still caps a request at 30s. */
const FRAME_TIMEOUT_MS = 25_000;

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
      'The Loom Direct Lake service is not deployed. Set LOOM_DIRECTLAKE_URL ' +
        '(the internal FQDN of the loom-directlake Container App) — provisioned by ' +
        'platform/fiab/bicep/modules/compute/loom-directlake-app.bicep. The semantic-model / ' +
        'report layer falls back to its existing backend (Azure Analysis Services fast-path or ' +
        'Synapse Serverless) until it is set. No Microsoft Fabric / Power BI capacity required.',
      503,
    );
  }

  let raw: RawFrameBody = {};
  try {
    raw = (await req.json()) as RawFrameBody;
  } catch {
    /* empty/invalid body → validated below */
  }

  const normalized = normalizeFrameBody(raw);
  if (!normalized.ok) return apiError(normalized.error, 400);
  const { path } = normalized.value;

  const url = buildFrameUrl(base);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FRAME_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return apiError(
      aborted
        ? 'The Direct Lake framing did not complete in time (aborted). Retry — framing is metadata-only and should be sub-second once the source is reachable.'
        : `Could not reach the Direct Lake service at LOOM_DIRECTLAKE_URL: ${
            e instanceof Error ? e.message : String(e)
          }.`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: { ok?: boolean; error?: string; frame?: unknown } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  // Relay the service's structured result with a matching status.
  if (!res.ok || !json || json.ok !== true) {
    const status = res.ok ? 502 : res.status;
    return apiError(
      json?.error || text.slice(0, 500) || `Direct Lake framing failed (HTTP ${res.status})`,
      status,
    );
  }

  return apiOk({ frame: json.frame });
}
