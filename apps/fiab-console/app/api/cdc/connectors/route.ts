/**
 * N7b — CDC connector control plane: list + create.
 *
 *   GET  /api/cdc/connectors?workspaceId=…   → the workspace's CDC connectors.
 *   POST /api/cdc/connectors?workspaceId=…   → create a connector from the
 *        dropdown-only wizard (validated → engine-consumable config).
 *
 * Connectors are stored as `cdc-connector` workspace items; their state IS the
 * flat source config the mirror engine already consumes (sourceType + server/
 * database + tables + syncMode), so Start delegates straight to
 * `runMirrorSnapshot`. Secrets are Key Vault REFERENCES only — the wizard
 * validator rejects an inline value. No Microsoft Fabric.
 */
import type { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { createOwnedItem, listOwnedItems } from '@/app/api/items/_lib/item-crud';
import { validateConnectorWizard, cdcSource } from '@/lib/cdc/connector-plane';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'cdc-connector';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const enabled = await runtimeFlag('n7b-cdc-control-plane');
  if (!enabled) return apiOk({ flagOff: true, connectors: [] });
  const items = await listOwnedItems(ITEM_TYPE, session.claims.oid, { workspaceId, session });
  const connectors = items
    .filter((it) => (it.state as Record<string, unknown> | undefined)?.cdcConnector)
    .map((it) => {
      const st = (it.state || {}) as Record<string, unknown>;
      return {
        id: it.id,
        displayName: it.displayName,
        description: it.description,
        kind: st.kind,
        sourceType: st.sourceType,
        server: st.server,
        database: st.database,
        syncMode: st.syncMode,
        mirroringStatus: st.mirroringStatus || 'NotStarted',
        tableCount: Array.isArray(st.tables) ? (st.tables as unknown[]).length : 0,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      };
    });
  return apiOk({ workspaceId, connectors });
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));

  const validation = validateConnectorWizard({ ...body, workspaceId });
  if (!validation.ok || !validation.state) {
    return apiError('invalid connector configuration', 400, { errors: validation.errors });
  }
  const def = cdcSource(validation.state.kind);

  const created = await createOwnedItem(session, ITEM_TYPE, {
    workspaceId,
    displayName: String(body?.displayName || '').trim(),
    description: body?.description ? String(body.description).trim() : undefined,
    state: validation.state as unknown as Record<string, unknown>,
  });
  if (!created.ok) return apiError(created.error, created.status);

  return apiOk({
    connector: {
      id: created.item.id,
      displayName: created.item.displayName,
      kind: validation.state.kind,
      sourceType: validation.state.sourceType,
      builtIn: def?.builtIn ?? false,
    },
    note: def?.builtIn
      ? 'Connector created. Start it to run the initial snapshot, then continuous change capture into ADLS Bronze.'
      : `Connector created. ${def?.label || 'This source'} replicates via the Azure-native ADF copy runtime — Start surfaces the exact linked-service to configure (no Microsoft Fabric).`,
  });
});
