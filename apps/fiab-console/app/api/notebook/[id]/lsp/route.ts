/**
 * Notebook LSP probe + VS Code for Web config.
 *
 * GET /api/notebook/[id]/lsp
 *   → { ok, lspAvailable, wsUrl, boundary, vscodeWeb: { enabled, url } }
 *
 * The Monaco notebook editor calls this once per opened notebook to learn:
 *   1. Whether the Pylance/pylsp WebSocket bridge is live (LOOM_PYLSP_ENABLED).
 *      The actual WS upgrade is served by the bridge attached in
 *      instrumentation.ts (same path, same origin) — Next route handlers can't
 *      upgrade a socket, so this GET is the discovery/probe surface.
 *   2. Whether to show the "Open in VS Code for Web" deep-link. VS Code for the
 *      Web (ml.azure.com compute-instance VS Code) is only offered on
 *      unambiguously Commercial boundaries — it is unavailable in GCC / GCC-High
 *      / DoD per Microsoft docs — and only when a real AML instance + workspace
 *      are configured (honest gate: no dead button).
 *
 * Azure-native by default: no Fabric / Power BI dependency. Works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildVscodeWeb(): { enabled: boolean; url: string | null; reason?: string } {
  const boundary = (process.env.CSA_LOOM_BOUNDARY || 'Commercial').trim();
  // Conservative: Commercial only. GCC reports as AzureCloud but VS Code for the
  // Web is still restricted there, so gate on the explicit boundary tag.
  if (boundary !== 'Commercial') {
    return { enabled: false, url: null, reason: `VS Code for the Web is not available in the ${boundary} boundary.` };
  }
  const instance = (process.env.LOOM_AML_INSTANCE || '').trim();
  const workspaceId = (process.env.LOOM_AML_WORKSPACE_ID || '').trim();
  if (!instance || !workspaceId) {
    return {
      enabled: false,
      url: null,
      reason: 'Set LOOM_AML_INSTANCE and LOOM_AML_WORKSPACE_ID to enable the VS Code for the Web deep-link.',
    };
  }
  const base = (process.env.LOOM_AML_PORTAL_BASE || 'https://ml.azure.com').replace(/\/+$/, '');
  const url = `${base}/compute/instance/${encodeURIComponent(instance)}/vscode?wsId=${encodeURIComponent(workspaceId)}`;
  return { enabled: true, url };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  const lspAvailable = (process.env.LOOM_PYLSP_ENABLED || '').trim() !== '';
  const boundary = (process.env.CSA_LOOM_BOUNDARY || 'Commercial').trim();

  return NextResponse.json({
    ok: true,
    lspAvailable,
    // Path the browser opens as ws(s)://<host><wsUrl>; served by the bridge.
    wsUrl: lspAvailable ? `/api/notebook/${encodeURIComponent(id)}/lsp` : null,
    boundary,
    vscodeWeb: buildVscodeWeb(),
  });
}
