/**
 * GET /api/items/dataset/browse
 *   No `container`  → lists the reachable DLZ ADLS Gen2 containers (or an honest
 *                     gate when none are configured/reachable).
 *   ?container=&prefix=&maxResults=
 *                   → flat directory listing of that container, each entry
 *                     pre-shaped with the abfss:// URI + Foundry dataType
 *                     (uri_folder | uri_file) the dataset register form posts.
 *
 * One endpoint for the dataset "Browse for a data URI" picker — Azure-native
 * (ADLS Gen2, no Fabric/OneLake). Real backend: reuses the adls-client the
 * lakehouse explorer uses; honest gate when the DLZ lake isn't wired.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  KNOWN_CONTAINERS,
  listContainers,
  listPaths,
  hasConfiguredContainers,
  type KnownContainer,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** abfss host for a container, derived from its configured https URL. */
function dfsHostFor(url: string, account: string): string {
  return (url.match(/^https:\/\/([^/]+)/i) || [])[1] || `${account}.dfs.core.windows.net`;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const container = req.nextUrl.searchParams.get('container') || '';
  const prefix = req.nextUrl.searchParams.get('prefix') || '';
  const maxResults = Number(req.nextUrl.searchParams.get('maxResults') || '200');

  // No container → enumerate the medallion containers, honest-gated.
  if (!container) {
    try {
      const containers = await listContainers();
      if (containers.length === 0) {
        const configured = hasConfiguredContainers();
        return NextResponse.json({
          ok: true,
          containers: [],
          gate: configured
            ? {
                reason: 'No DLZ ADLS Gen2 containers were reachable from the Console UAMI within the timeout.',
                remediation:
                  'Ensure the DLZ storage account is reachable from the Console VNet (private endpoint or storage-firewall allowance) and that the Console UAMI holds "Storage Blob Data Reader" on it.',
              }
            : {
                reason: 'No internal Data Landing Zone ADLS Gen2 container is configured.',
                remediation:
                  'Set LOOM_LANDING_URL / LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL to the DLZ ADLS Gen2 container URLs the DLZ Bicep emits. No Microsoft Fabric required.',
              },
        });
      }
      return NextResponse.json({ ok: true, containers });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  try {
    const cs = await listContainers();
    const account = (cs.find((c) => c.name === container)?.url.match(/^https:\/\/([^./]+)\./i) || [])[1] || '';
    const dfsHost = dfsHostFor(cs.find((c) => c.name === container)?.url || '', account);
    const raw = await listPaths(container as KnownContainer, prefix, Math.min(maxResults, 1000));
    const paths = raw.map((p) => ({
      ...p,
      uri: `abfss://${container}@${dfsHost}/${(p.name || '').replace(/^\/+/, '')}`,
      dataType: p.isDirectory ? 'uri_folder' : 'uri_file',
    }));
    const folderUri = `abfss://${container}@${dfsHost}/${prefix.replace(/^\/+|\/+$/g, '')}`.replace(/\/+$/, '');
    return NextResponse.json({ ok: true, container, prefix, account, dfsHost, folderUri, paths });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}
