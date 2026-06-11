/**
 * Shared error → HTTP response helpers for /api/admin/security/** routes.
 *
 * Maps the typed errors thrown by purview-client, mip-graph-client, and
 * dlp-graph-client to structured JSON responses the panels can render
 * directly into a Fluent MessageBar with remediation guidance.
 *
 * Response shape:
 *   { ok: false, error: string, code: string, hint?: {...}, status?: number, body?: unknown }
 *
 * Status mapping:
 *   - NotConfigured  → 503 (service unavailable + structured hint)
 *   - Upstream 4xx   → propagate (401/403/404/etc.)
 *   - Upstream 5xx   → 502
 */
import { NextResponse } from 'next/server';
import { PurviewError, PurviewNotConfiguredError } from '@/lib/azure/purview-client';
import { MipError, MipNotConfiguredError } from '@/lib/azure/mip-graph-client';
import { SccError, SccNotConfiguredError } from '@/lib/azure/scc-labels-client';
import { DlpError, DlpNotConfiguredError } from '@/lib/azure/dlp-graph-client';

export function handleSecurityError(e: unknown): NextResponse {
  if (e instanceof PurviewNotConfiguredError) {
    return NextResponse.json(
      { ok: false, error: e.message, code: 'purview_not_configured', hint: e.hint },
      { status: 503 },
    );
  }
  if (e instanceof MipNotConfiguredError) {
    return NextResponse.json(
      { ok: false, error: e.message, code: 'mip_not_configured', hint: e.hint },
      { status: 503 },
    );
  }
  if (e instanceof SccNotConfiguredError) {
    return NextResponse.json(
      { ok: false, error: e.message, code: 'mip_admin_not_configured', hint: e.hint },
      { status: 503 },
    );
  }
  if (e instanceof DlpNotConfiguredError) {
    return NextResponse.json(
      { ok: false, error: e.message, code: 'dlp_not_configured', hint: e.hint },
      { status: 503 },
    );
  }
  if (e instanceof PurviewError) {
    const code = e.status >= 400 && e.status < 500 ? 'purview_client_error' : 'purview_upstream_error';
    const status = e.status >= 400 && e.status < 500 ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e.message, code, status: e.status, body: e.body },
      { status },
    );
  }
  if (e instanceof MipError) {
    const code = e.status >= 400 && e.status < 500 ? 'mip_client_error' : 'mip_upstream_error';
    const status = e.status >= 400 && e.status < 500 ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e.message, code, status: e.status, body: e.body, endpoint: e.endpoint },
      { status },
    );
  }
  if (e instanceof DlpError) {
    const code = e.status >= 400 && e.status < 500 ? 'dlp_client_error' : 'dlp_upstream_error';
    const status = e.status >= 400 && e.status < 500 ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e.message, code, status: e.status, body: e.body, endpoint: e.endpoint },
      { status },
    );
  }
  if (e instanceof SccError) {
    const code = e.status >= 400 && e.status < 500 ? 'scc_client_error' : 'scc_upstream_error';
    const status = e.status >= 400 && e.status < 500 ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e.message, code, status: e.status, body: e.body, endpoint: e.endpoint },
      { status },
    );
  }
  const msg = (e as any)?.message || String(e);
  return NextResponse.json({ ok: false, error: msg, code: 'unexpected' }, { status: 500 });
}
