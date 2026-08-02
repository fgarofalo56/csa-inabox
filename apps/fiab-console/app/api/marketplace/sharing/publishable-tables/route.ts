/**
 * GET /api/marketplace/sharing/publishable-tables?lakehouseId=<id>&workspaceId=<id>
 *
 * Enumerates the REAL Delta tables a lakehouse item can publish through the
 * Loom (Azure-native) Delta Sharing backend, each with the exact
 * `abfss://<container>@<account>.dfs.<suffix>/<path>` root the sharing server
 * will read.
 *
 * Why this route exists (issue #2618 / LU-9): the "Add a table to <share>"
 * dialog used to take that abfss URI as a hand-typed `<Input>`, which violates
 * `loom_no_freeform_config` — Loom already knows its own lakehouses and their
 * ADLS roots, so the operator must pick, not type. The Databricks branch of the
 * same dialog has always been a cascading Catalog → Schema → Table picker; this
 * is the Azure-native equivalent (Workspace → Lakehouse → Delta table).
 *
 * The abfss URI is assembled SERVER-side, from `resolveLakehouseAbfss` (which
 * already resolved the provisioner-stamped container + root, sovereign-cloud
 * correct via the configured LOOM_*_URL host) plus the path the scanner
 * actually found. The browser never constructs a storage URI — it has neither
 * the account name nor the cloud's DFS suffix, and guessing either is exactly
 * the class of error the typed field produced.
 *
 * No mocks: the table list comes from a real ADLS Gen2 directory listing plus a
 * `_delta_log` probe (`scanLakehouseTables`). When no lakehouse storage is
 * configured the response is an honest gate naming the env vars, per
 * `.claude/rules/no-vaporware.md` — never a fabricated list.
 *
 * AUTHORIZATION — tenant admin. Two reasons, both load-bearing:
 *   1. The response contains raw `abfss://` roots, which `_loom-backend.ts`
 *      deliberately withholds from non-admin readers of the shares list
 *      (`SharingViewScope.full`). A non-admin picker would leak, through the
 *      enumeration route, exactly the estate infrastructure the read path
 *      elides.
 *   2. It feeds PATCH /api/marketplace/sharing/shares/[name], which is already
 *      `withTenantAdmin`. Enumerating choices a caller may not act on is a
 *      probing oracle, not a feature.
 */
import { NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { scanLakehouseTables } from '@/lib/azure/synapse-catalog-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One publishable Delta table. `location` is what the share record stores. */
export interface PublishableTable {
  /** Leaf directory name under the lakehouse's `Tables/` — the default alias. */
  name: string;
  /** Full `abfss://<container>@<host>/<path>` Delta root. */
  location: string;
  /** Latest Delta commit version, when the `_delta_log` was readable. */
  latestVersion: number | null;
  sizeBytes: number | null;
  lastModified: string | null;
}

/**
 * Re-root a container-relative scanner path onto the lakehouse's own abfss
 * authority.
 *
 * `CatalogTable.adlsPath` is `<container>/<root>/Tables/<name>`; the abfss
 * authority (`<container>@<account>.dfs.<suffix>`) only exists on the resolved
 * lakehouse root. Splicing the two here — rather than string-concatenating the
 * root and the table name — keeps the published location byte-identical to the
 * path the scan actually probed, so a table can never be published at a path
 * that was never verified to hold a `_delta_log`.
 *
 * Returns null when either input is malformed, so a bad row is dropped rather
 * than published at a guessed location.
 */
export function tableLocationFrom(lakehouseAbfss: string, adlsPath: string): string | null {
  const m = /^abfss:\/\/([^@/\s]+)@([^/\s]+)\//.exec(lakehouseAbfss.trim());
  if (!m) return null;
  const [, container, host] = m;
  const rel = adlsPath.trim().replace(/^\/+/, '');
  // The scanner prefixes the container; strip exactly that one leading segment.
  const prefix = `${container}/`;
  if (!rel.startsWith(prefix)) return null;
  const withinContainer = rel.slice(prefix.length).replace(/^\/+/, '');
  if (!withinContainer) return null;
  return `abfss://${container}@${host}/${withinContainer}`;
}

export const GET = withTenantAdmin(async (req) => {
  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim() || '';
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim() || '';
  if (!lakehouseId || !workspaceId) {
    return NextResponse.json(
      { ok: false, error: 'lakehouseId and workspaceId are required' },
      { status: 400 },
    );
  }

  try {
    const root = await resolveLakehouseAbfss(lakehouseId, workspaceId);
    if (!root) {
      return NextResponse.json({
        ok: false,
        gate: { missing: 'LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL' },
        error:
          'That lakehouse has no resolved ADLS Gen2 storage — set '
          + 'LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL (deployed by the DLZ Bicep) and grant the Console '
          + 'UAMI Storage Blob Data Reader on the container, then reopen this dialog.',
      });
    }

    const scanned = await scanLakehouseTables({ containers: [root.container], rootPrefix: root.root });
    const tables: PublishableTable[] = [];
    for (const t of scanned) {
      if (t.format !== 'delta') continue;
      const location = tableLocationFrom(root.abfss, t.adlsPath);
      if (!location) continue;
      tables.push({
        name: t.name,
        location,
        latestVersion: t.latestVersion,
        sizeBytes: t.sizeBytes,
        lastModified: t.lastModified,
      });
    }

    return NextResponse.json({ ok: true, tables });
  } catch (e) {
    return apiServerError(e);
  }
});
