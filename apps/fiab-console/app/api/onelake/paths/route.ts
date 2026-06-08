/**
 * GET /api/onelake/paths?container=&itemPath=&workspaceGuid=&itemGuid=
 *
 * Translates a Loom item's {container, itemPath} into the four OneLake-
 * compatible ADLS URI forms (DFS / Blob / ABFS / GUID), resolving the storage
 * account name server-side from the DLZ env (LOOM_{BRONZE,SILVER,GOLD,…}_URL)
 * via adls-client.getAccountName(). Keeping the account name on the BFF avoids
 * exposing it as a public env var.
 *
 * Azure-native by design (no-fabric-dependency.md): the suffix comes from the
 * cloud-endpoints resolver, so the URIs are correct in Commercial / GCC /
 * GCC-High / IL5 / DoD without any Fabric workspace bound.
 *
 * Honest gate (no-vaporware.md): when no ADLS container URL is configured the
 * route returns 503 with the exact env var to set — never a fabricated host.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getAccountName } from '@/lib/azure/adls-client';
import { onelakePaths } from '@/lib/azure/onelake-path';
import { cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const container = (sp.get('container') || '').trim();
  const itemPath = (sp.get('itemPath') || '').trim();
  const workspaceGuid = sp.get('workspaceGuid')?.trim() || undefined;
  const itemGuid = sp.get('itemGuid')?.trim() || undefined;

  if (!container) {
    return NextResponse.json({ ok: false, error: 'container is required' }, { status: 400 });
  }

  let account: string;
  try {
    account = getAccountName();
  } catch {
    // Honest infra gate — the DLZ storage account is not wired into this
    // deployment yet. Name the exact env var rather than invent a host.
    return NextResponse.json(
      {
        ok: false,
        error:
          'OneLake addressing needs the DLZ storage account. Set LOOM_BRONZE_URL ' +
          '(or LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL) to the ADLS Gen2 ' +
          'container URL deployed by platform/fiab/bicep — see the data-landing-zone module.',
        envVar: 'LOOM_BRONZE_URL',
      },
      { status: 503 },
    );
  }

  const paths = onelakePaths({ account, container, itemPath, workspaceGuid, itemGuid });
  return NextResponse.json({
    ok: true,
    account,
    cloud: cloudBoundaryLabel(),
    container,
    itemPath,
    paths,
  });
}
