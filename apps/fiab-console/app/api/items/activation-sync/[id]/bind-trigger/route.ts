/**
 * POST /api/items/activation-sync/[id]/bind-trigger
 *
 * Binds this activation-sync to a DATA-CHANGE trigger on its source table — the
 * N5 software-defined-asset way, not a parallel scheduler. It upserts the
 * source Delta table's asset sidecar with `mode:'auto'` + an `activation-sync`
 * materializer bound to THIS item, so the reconciler runs an incremental sync
 * whenever a new Delta commit lands on the source. The source asset key is built
 * SERVER-SIDE (the browser never invents a storage account). Owner-scoped +
 * audited via saveAssetPolicy. No Fabric dependency.
 */

import { NextResponse } from 'next/server';
import { jerr } from '../../../_lib/item-crud';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { saveAssetPolicy } from '@/lib/assets/asset-store';
import { getAccountName } from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';
import { buildAbfssUri } from '@/lib/activation/sync-engine';
import { coerceSpec } from '@/lib/activation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withWorkspaceOwner('activation-sync', async (_req, { session, params, item }) => {
  const { id } = params;
  const spec = coerceSpec(item.state);
  if (!spec.source?.container || !spec.source?.path) {
    return jerr('Pick a source table before binding a data-change trigger.', 400);
  }

  try {
    // Canonical lake asset key (path:<abfss uri>) — account resolved server-side.
    const uri = buildAbfssUri(getAccountName(), dfsSuffix(), spec.source.container, spec.source.path);
    const assetKey = `path:${uri}`;
    const doc = await saveAssetPolicy(session, {
      assetKey,
      // Data-change driven: mode auto + cadence none ⇒ the reconciler fires when
      // the source's observed Delta version advances (not on a clock). The engine
      // owns failure alerting, so the asset policy alert stays 'none'.
      policy: { cadence: 'none', grace: 'hourly', mode: 'auto', alertSeverity: 'none' },
      materializer: { kind: 'activation-sync', itemId: id },
      name: spec.source.label || spec.source.path,
    });
    return NextResponse.json({ ok: true, assetKey, materializer: doc.materializer });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
});
