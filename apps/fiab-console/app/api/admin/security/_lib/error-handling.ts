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
 *   - Purview 401/403 → 403 (role missing) + structured hint (honest gate, not
 *                       a raw error) so the panel renders the NotConfiguredBar
 *                       naming the Data Map role to grant — never a bare 403.
 *   - Upstream 4xx   → propagate (404/etc.)
 *   - Upstream 5xx   → 502
 */
import { NextResponse } from 'next/server';
import { apiServerError } from '@/lib/api/respond';
import { PurviewError, PurviewNotConfiguredError, notConfiguredHint } from '@/lib/azure/purview-client';
import { MipError, MipNotConfiguredError } from '@/lib/azure/mip-graph-client';
import { SccError, SccNotConfiguredError } from '@/lib/azure/scc-labels-client';
import { DlpError, DlpNotConfiguredError } from '@/lib/azure/dlp-graph-client';
import { DlpAdminError, DlpAdminNotConfiguredError } from '@/lib/azure/scc-dlp-client';

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
  if (e instanceof DlpAdminNotConfiguredError) {
    return NextResponse.json(
      { ok: false, error: e.message, code: 'dlp_admin_not_configured', hint: e.hint },
      { status: 503 },
    );
  }
  if (e instanceof PurviewError) {
    // 401/403 from the Data Map data-plane = the Console UAMI lacks a Data Map
    // role on the root collection (classic metadata-policy, NOT ARM RBAC). This
    // is the "Not authorized to access account" 403. Surface it as an HONEST
    // GATE (structured hint) rather than a raw error so the panel renders the
    // NotConfiguredBar with the exact grant remediation — same shape probePurview
    // emits for reason:'role_missing'. The grant is applied by
    // scripts/csa-loom/grant-purview-datamap-role.sh (run by the post-deploy
    // bootstrap workflow). Account stays configured, so we keep a distinct code.
    if (e.status === 401 || e.status === 403) {
      const hint = notConfiguredHint('LOOM_PURVIEW_ACCOUNT');
      hint.followUp =
        `The Microsoft Purview Data Map host resolved and answered ${e.status} — the Loom ` +
        'Console managed identity lacks a Data Map data-plane role on this account. Grant ' +
        'Data Curator (read/write) or Data Reader (read-only) on the ROOT collection via ' +
        'scripts/csa-loom/grant-purview-datamap-role.sh (run by the csa-loom-post-deploy-bootstrap ' +
        'workflow — it loops data-reader/data-curator/data-source-administrator/collection-administrator), ' +
        'then retry. Classic Data Map roles are collection metadata-policy, NOT ARM RBAC, so they ' +
        'cannot be set in bicep.';
      return NextResponse.json(
        { ok: false, error: e.message, code: 'purview_not_authorized', status: e.status, body: e.body, hint },
        { status: 403 },
      );
    }
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
  if (e instanceof DlpAdminError) {
    const code = e.status >= 400 && e.status < 500 ? 'dlp_admin_client_error' : 'dlp_admin_upstream_error';
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
  return apiServerError(e, 'internal error', 'unexpected');
}
