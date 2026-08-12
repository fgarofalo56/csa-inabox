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
// SHARED with the mirrored-database lifecycle/state routes on purpose. A
// per-route copy of credential resolution is precisely how the original
// 'collected but never consumed' bug survived in two planes at once (#3146,
// #3149).
import { withSourceAuth } from '@/lib/azure/connection-auth';
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
    // Bind the operator's stored Connection credential to the run. Without this
    // the engine reads as the Console UAMI no matter what the wizard collected —
    // which is exactly what #3149 measured. `connectionId` absent is a legitimate
    // state (Entra-token sources); withSourceAuth returns UAMI_AUTH for it, so
    // the fallback is now DELIBERATE and described rather than silent.
    const { src, descriptor: sourceAuth } = await withSourceAuth(
      session.claims.oid,
      connectorToEngineSource(state),
      state.connectionId ? String(state.connectionId) : undefined,
    );
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
          // NON-SECRET descriptor: which identity actually read the source
          // ('connection' + its name, or 'uami'). Never the secret. Recorded so
          // the surface can STATE the identity instead of implying one — the
          // whole point of #3149 was that it implied a credential it never used.
          sourceAuth,
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(item.id, item.workspaceId).replace(next);

    if (run.status === 'Gated') {
      return apiOk({ action, status: { mirroringStatus }, gate: run.gate, note: run.note, sourceAuth });
    }
    return apiOk({
      action, status: { mirroringStatus }, tables: run.tables, engine: run.engine,
      cdcName: run.cdcName, basePath: run.basePath, note: run.note, error: run.error,
      sourceAuth,
    });
  } catch (e) {
    return apiServerError(e);
  }
});
