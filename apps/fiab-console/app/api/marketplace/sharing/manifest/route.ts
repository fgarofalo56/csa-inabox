/**
 * GET /api/marketplace/sharing/manifest — the reference server's `shares:` block.
 *
 * The OSS Delta Sharing reference server reads its share list from a config file
 * AT BOOT. Grants and revocations are immediate (Loom enforces those in the BFF),
 * but a newly published TABLE is only readable once the server's Container App is
 * rolled with a new manifest. This route is that seam, made explicit: it renders
 * the YAML + base64 from Loom's own share records and returns the exact command
 * to apply it. Without it the publish path could not be completed at all — a
 * share could be created and granted, and no table could ever be served.
 *
 * Tenant-admin: the payload contains every published table's raw `abfss://`
 * location, which is estate infrastructure, and applying it is an estate-level
 * deployment act — the same bar as the mutating share/recipient routes.
 *
 * Databricks-backed estates have no such file (Unity Catalog holds the share
 * definition itself), so this returns the honest 501 gate there.
 */
import { NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { sharingErrorResponse } from '../_lib';
import { isLoomSharingBackend, loomManifest, loomSharingErrorResponse } from '../_loom-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async () => {
  try {
    if (isLoomSharingBackend()) return await loomManifest();
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        backend: 'databricks',
        error: 'The share manifest is a Loom Sharing (OSS Delta Sharing server) concept. This estate uses Databricks Delta Sharing, where Unity Catalog holds the share definition and there is no server config to render.',
        hint: 'Deploy platform/fiab/bicep/modules/compute/loom-sharing-app.bicep and set LOOM_SHARING_URL to move this estate onto the Azure-native sharing path.',
      },
      { status: 501 },
    );
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});
