/**
 * GET /api/lakehouse/shortcuts/sharepoint
 *
 * Microsoft Graph-backed navigation for the SharePoint / OneDrive shortcut
 * source in the OneLake shortcut wizard — Azure-native parity with Fabric
 * OneLake's "New shortcut → OneDrive/SharePoint" browse flow, NO Fabric
 * dependency. Everything runs on the Console UAMI's Graph app-roles
 * (Sites.Read.All / Files.Read.All), so it works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE UNSET.
 *
 * Query (?action=...):
 *   action=sites&q=<keyword>                         → search SharePoint sites
 *   action=siteDrives&siteId=<id>                    → document libraries of a site
 *   action=userDrives[&user=<upn|oid>]               → OneDrive drives for a user
 *   action=children&driveId=<id>[&prefix=<path>]     → browse one folder level
 *   action=resolveUrl&url=<sharing-or-web-url>       → resolve a pasted link
 *
 * Returns { ok, data } or an honest 503 gate naming
 * LOOM_SHAREPOINT_SHORTCUTS_ENABLED + the two Graph app-roles when unconfigured.
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 * Per .claude/rules/no-vaporware.md — real Graph REST, no mock arrays.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchSites,
  listSiteDrives,
  listUserDrives,
  listDriveChildren,
  resolveSharingUrl,
  graphDriveConfigGate,
  GraphDriveNotConfiguredError,
  GraphDriveError,
} from '@/lib/azure/graph-drive-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['sites', 'siteDrives', 'userDrives', 'children', 'resolveUrl'] as const;
type Action = (typeof ACTIONS)[number];

function fail(status: number, error: string, code?: string, hint?: string) {
  return NextResponse.json({ ok: false, error, code, hint }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return fail(401, 'unauthenticated');

  const gate = graphDriveConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: gate.code, error: gate.hint.followUp, hint: gate.hint.followUp, gateDetail: gate.hint },
      { status: 503 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const action = (sp.get('action') || '').trim() as Action;
  if (!ACTIONS.includes(action)) {
    return fail(400, `action must be one of ${ACTIONS.join(', ')}`);
  }

  try {
    if (action === 'sites') {
      const data = await searchSites(sp.get('q') || '');
      return NextResponse.json({ ok: true, data: { sites: data } });
    }
    if (action === 'siteDrives') {
      const siteId = (sp.get('siteId') || '').trim();
      if (!siteId) return fail(400, 'siteId is required');
      const data = await listSiteDrives(siteId);
      return NextResponse.json({ ok: true, data: { drives: data } });
    }
    if (action === 'userDrives') {
      // Default to the signed-in user's own OneDrive (oid/upn) when no user given.
      const user = (sp.get('user') || session.claims.upn || session.claims.oid || '').trim();
      const data = await listUserDrives(user || undefined);
      return NextResponse.json({ ok: true, data: { drives: data } });
    }
    if (action === 'children') {
      const driveId = (sp.get('driveId') || '').trim();
      if (!driveId) return fail(400, 'driveId is required');
      const data = await listDriveChildren({ driveId, prefix: sp.get('prefix') || '' });
      return NextResponse.json({ ok: true, data });
    }
    // resolveUrl
    const url = (sp.get('url') || '').trim();
    if (!url) return fail(400, 'url is required');
    const data = await resolveSharingUrl(url);
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    if (e instanceof GraphDriveNotConfiguredError) {
      return NextResponse.json({ ok: false, code: e.code, error: e.hint.followUp, hint: e.hint.followUp, gateDetail: e.hint }, { status: 503 });
    }
    if (e instanceof GraphDriveError) {
      return NextResponse.json({ ok: false, code: e.code, error: e.message, hint: e.message }, { status: e.status || 502 });
    }
    return fail(502, (e?.message || String(e)).slice(0, 500), e?.code || 'sharepoint_browse_failed');
  }
}
