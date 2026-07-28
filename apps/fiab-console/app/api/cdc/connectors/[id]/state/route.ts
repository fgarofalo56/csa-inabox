/**
 * N7b — start / stop a CDC connector.
 *
 *   POST /api/cdc/connectors/[id]/state   body: { action: 'start' | 'stop' }
 *
 * Start delegates to the SAME Azure-native mirror engine the mirrored-database
 * item uses (`runMirrorSnapshot`): initial snapshot → ADLS Bronze, then ongoing
 * watermark-incremental change capture. N6 data-contract enforcement is applied
 * at the ingest boundary INSIDE the engine (violating rows quarantine to the
 * Bronze `_rejected` dead-letter path rather than corrupting Bronze) — the
 * control plane reuses it by passing the tenant scope, never re-implementing it.
 *
 * After the run the connector's source schema is captured (best-effort) and
 * diffed against the previous fingerprint, appending the drift to the
 * schema-change log the monitor surfaces. No Microsoft Fabric; IL5 in-boundary.
 */
import type { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { runMirrorSnapshot, type MirrorTableResult } from '@/lib/azure/mirror-engine';
import { connectorToEngineSource, foldSchemaCapture, type CdcSchemaTracking } from '@/lib/cdc/connector-plane';
import { captureSourceSchema } from '@/lib/cdc/schema-capture';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Snapshotting several tables (source read + ADLS write each) can take a while.
export const maxDuration = 300;

export const POST = withWorkspaceOwner('cdc-connector', async (req: NextRequest, { session, item }) => {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'start' && action !== 'stop') return apiError("action must be 'start' or 'stop'", 400);

  const state = (item.state || {}) as Record<string, unknown>;
  try {
    const items = await itemsContainer();

    if (action === 'stop') {
      const next: WorkspaceItem = {
        ...item,
        state: { ...state, mirroringStatus: 'Stopped', lastStateChange: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      };
      await items.item(item.id, item.workspaceId).replace(next);
      return apiOk({ action, status: { mirroringStatus: 'Stopped' }, note: 'Connector stopped. Change-tracking watermarks and landed data remain; Start to resume.' });
    }

    // ---- start ----
    const src = connectorToEngineSource(state);
    const prevTableStatus = (Array.isArray(state.tablesStatus) ? state.tablesStatus : []) as MirrorTableResult[];
    // N6 — pass the tenant scope so the engine enforces the ODCS contracts bound
    // to this connector at the Bronze boundary (warn-quarantine → `_rejected`).
    const run = await runMirrorSnapshot(item.id, item.workspaceId, src, prevTableStatus, { tenantId: session.claims.oid });

    const mirroringStatus = run.status === 'Running' ? 'Running' : run.status === 'Gated' ? 'NotStarted' : 'Error';

    // Capture the source schema + fold the drift into the schema-change log
    // (best-effort — never blocks Start; empty for ADF-copy families).
    let cdcSchema = state.cdcSchema as CdcSchemaTracking | undefined;
    try {
      const captured = await captureSourceSchema(src);
      if (Object.keys(captured).length) cdcSchema = foldSchemaCapture(cdcSchema, captured, new Date().toISOString());
    } catch { /* schema capture is best-effort */ }

    const next: WorkspaceItem = {
      ...item,
      state: {
        ...state,
        mirroringStatus,
        lastStateChange: new Date().toISOString(),
        tablesStatus: run.tables,
        ...(cdcSchema ? { cdcSchema } : {}),
        lastRun: {
          at: new Date().toISOString(), status: run.status, engine: run.engine, cdcName: run.cdcName,
          basePath: run.basePath, note: run.note, error: run.error, gate: run.gate,
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(item.id, item.workspaceId).replace(next);

    if (run.status === 'Gated') {
      return apiOk({ action, status: { mirroringStatus }, gate: run.gate, note: run.note });
    }
    return apiOk({
      action, status: { mirroringStatus }, tables: run.tables, engine: run.engine,
      cdcName: run.cdcName, basePath: run.basePath, note: run.note, error: run.error,
    });
  } catch (e) {
    return apiServerError(e);
  }
});
