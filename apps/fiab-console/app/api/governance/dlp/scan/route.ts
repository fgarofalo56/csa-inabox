/**
 * /api/governance/dlp/scan
 *
 * GET  → scanner status (honest gate — no public Graph REST endpoint exposes
 *        Purview Information Protection scanner status) + lastScannedAt /
 *        scanTriggeredAt from the per-tenant dlp-meta doc.
 * POST → trigger a scan. There is NO public Graph REST API to start the
 *        scanner, so the route attempts the real call (which throws a typed
 *        501) and surfaces an honest MessageBar gate with a direct Purview
 *        portal link + Start-Scan cmdlet, recording the request timestamp.
 *        (Per no-vaporware.md, an honest API gate is correct here — we never
 *        fake a "scan started" response.)
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getScanStatus, triggerScan, DlpError, DlpNotConfiguredError } from '@/lib/azure/dlp-graph-client';
import { handleSecurityError } from '../../../admin/security/_lib/error-handling';
import { loadDlpMeta, saveDlpMeta } from '../_lib/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const status = await getScanStatus();
    let lastScannedAt: string | undefined;
    let scanTriggeredAt: string | undefined;
    try {
      const meta = await loadDlpMeta(s.claims.oid);
      lastScannedAt = meta.lastScannedAt;
      scanTriggeredAt = meta.scanTriggeredAt;
    } catch { /* meta best-effort */ }
    return NextResponse.json({ ok: true, status, lastScannedAt, scanTriggeredAt });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // Record that an operator requested a scan (real, auditable timestamp) even
  // though the trigger itself routes through the Purview portal / PowerShell.
  let scanTriggeredAt: string | undefined;
  try {
    const meta = await loadDlpMeta(s.claims.oid);
    scanTriggeredAt = new Date().toISOString();
    meta.scanTriggeredAt = scanTriggeredAt;
    await saveDlpMeta(meta);
  } catch { /* meta best-effort */ }
  try {
    await triggerScan(); // always throws a typed 501 (no Graph REST trigger exists)
    return NextResponse.json({ ok: true }); // unreachable
  } catch (e) {
    if (e instanceof DlpError && e.status === 501) {
      const body = (e.body || {}) as { portalLink?: string; powershellCmd?: string };
      return NextResponse.json(
        {
          ok: false,
          code: 'dlp_scan_trigger_unavailable',
          error: e.message,
          scanTriggeredAt,
          portalLink: body.portalLink,
          powershellCmd: body.powershellCmd,
        },
        { status: 501 },
      );
    }
    if (e instanceof DlpNotConfiguredError) return handleSecurityError(e);
    return handleSecurityError(e);
  }
}
