/**
 * GET /api/lakehouse/shortcuts/sharepoint
 *
 * Live SharePoint / OneDrive browse for the shortcut wizard — Azure-native
 * parity with Fabric OneLake's "New shortcut → SharePoint / OneDrive" picker,
 * NO Fabric dependency. Everything resolves through Microsoft Graph on the
 * Console UAMI's application token (Sites.Read.All + Files.Read.All).
 *
 * Actions (action= query param):
 *   sites   → search SharePoint sites           q=<search>
 *   drives  → list a site's document libraries  siteId=<id>
 *   items   → list one folder level (SharePoint) siteId=<id>&driveId=<id>&prefix=<path>
 *   onedrive→ list one folder level (OneDrive)   userId=<upn|oid>&prefix=<path>
 *
 * Returns { ok, data }. Honest-gate (503) when LOOM_SHAREPOINT_SHORTCUTS_ENABLED
 * is unset or the Graph AppRoles aren't consented — the error/hint names the
 * exact env var, grant script, and consent step (per no-vaporware.md).
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchSites,
  listSiteDrives,
  browseSharePoint,
  browseOneDrive,
} from '@/lib/azure/sharepoint-graph-client';
import { ShortcutSourceError } from '@/lib/azure/shortcut-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const action = (sp.get('action') || 'sites').trim();

  try {
    if (action === 'sites') {
      const q = (sp.get('q') || '').trim();
      const sites = await searchSites(q);
      return NextResponse.json({ ok: true, data: { sites } });
    }
    if (action === 'drives') {
      const siteId = (sp.get('siteId') || '').trim();
      if (!siteId) return NextResponse.json({ ok: false, error: 'siteId is required' }, { status: 400 });
      const drives = await listSiteDrives(siteId);
      return NextResponse.json({ ok: true, data: { drives } });
    }
    if (action === 'items') {
      const siteId = (sp.get('siteId') || '').trim();
      const driveId = (sp.get('driveId') || '').trim();
      const prefix = (sp.get('prefix') || '').trim();
      if (!siteId || !driveId) {
        return NextResponse.json({ ok: false, error: 'siteId and driveId are required' }, { status: 400 });
      }
      const result = await browseSharePoint({ siteId, driveId, prefix });
      return NextResponse.json({ ok: true, data: result });
    }
    if (action === 'onedrive') {
      const userId = (sp.get('userId') || '').trim();
      const prefix = (sp.get('prefix') || '').trim();
      if (!userId) return NextResponse.json({ ok: false, error: 'userId (UPN or object id) is required' }, { status: 400 });
      const result = await browseOneDrive({ userId, prefix });
      return NextResponse.json({ ok: true, data: result });
    }
    return NextResponse.json({ ok: false, error: `Unknown action '${action}'. Use sites | drives | items | onedrive.` }, { status: 400 });
  } catch (e: any) {
    if (e instanceof ShortcutSourceError) {
      return NextResponse.json({ ok: false, code: e.code, error: sanitize(e), hint: sanitize(e) }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: e?.code || 'sharepoint_browse_failed', error: sanitize(e) }, { status: 502 });
  }
}
