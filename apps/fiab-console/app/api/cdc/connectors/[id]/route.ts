/**
 * N7b — CDC connector: detail + delete.
 *
 *   GET    /api/cdc/connectors/[id]?workspaceId=…  → the connector's config +
 *          last-run summary (read-role members allowed).
 *   DELETE /api/cdc/connectors/[id]?workspaceId=…  → remove the connector
 *          (landed Bronze data is retained).
 */
import type { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { deleteOwnedItem } from '@/app/api/items/_lib/item-crud';
import { cdcSource } from '@/lib/cdc/connector-plane';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'cdc-connector';

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req, { item }) => {
  const st = (item.state || {}) as Record<string, unknown>;
  const def = cdcSource(String(st.kind || ''));
  return apiOk({
    connector: {
      id: item.id,
      displayName: item.displayName,
      description: item.description,
      workspaceId: item.workspaceId,
    },
    source: {
      kind: st.kind,
      label: def?.label,
      sourceType: st.sourceType,
      connectorClass: st.connectorClass,
      server: st.server,
      database: st.database,
      tables: Array.isArray(st.tables) ? st.tables : [],
      syncMode: st.syncMode,
      secretRefBound: !!st.secretRef,
      builtIn: def?.builtIn ?? false,
    },
    mirroringStatus: st.mirroringStatus || 'NotStarted',
    lastRun: st.lastRun,
  });
});

export const DELETE = withWorkspaceOwner(ITEM_TYPE, async (req: NextRequest, { session, item }) => {
  await deleteOwnedItem(item.id, ITEM_TYPE, session.claims.oid);
  return apiOk({ deleted: item.id, note: 'Connector removed. Landed Bronze data and any dead-letter files are retained.' });
});
