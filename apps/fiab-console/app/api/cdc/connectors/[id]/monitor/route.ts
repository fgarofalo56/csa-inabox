/**
 * N7b — live connector monitor (GET only, no side effects; 30s auto-refresh).
 *
 *   GET /api/cdc/connectors/[id]/monitor?workspaceId=…
 *
 * All-real telemetry for the Monitor surface, nothing mocked:
 *   • health   — Debezium-style phase (initial snapshot % → streaming lag),
 *                derived from the engine's persisted `mirroringStatus` +
 *                per-table run status.
 *   • tables   — the real per-table replication rows (status / mode / rows /
 *                last-sync) from the last engine run.
 *   • schemaChanges — the source-DDL drift feed captured at each Start.
 *   • deadLetter — a REAL ADLS read of the N6 `_rejected` quarantine tree
 *                (per-dataset counts + a bounded sample of rejected rows with
 *                their ODCS violations).
 */
import { apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import {
  deriveConnectorHealth, type CdcTableStatusLike, type CdcSchemaTracking,
} from '@/lib/cdc/connector-plane';
import { readDeadLetter } from '@/lib/cdc/dead-letter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withWorkspaceOwner('cdc-connector', { allowReadRoles: true }, async (_req, { item }) => {
  const enabled = await runtimeFlag('n7b-cdc-control-plane');
  if (!enabled) return apiOk({ flagOff: true });

  const st = (item.state || {}) as Record<string, unknown>;
  const tablesStatus = (Array.isArray(st.tablesStatus) ? st.tablesStatus : []) as CdcTableStatusLike[];
  const selectedTables = Array.isArray(st.tables) ? (st.tables as unknown[]).length : 0;

  const health = deriveConnectorHealth({
    mirroringStatus: String(st.mirroringStatus || ''),
    selectedTables,
    tablesStatus,
  });

  const schema = st.cdcSchema as CdcSchemaTracking | undefined;

  // Real ADLS read of the N6 dead-letter quarantine tree beside the landed data.
  const lastRun = st.lastRun as { basePath?: string } | undefined;
  const basePath = lastRun?.basePath || `mirrors/${item.workspaceId}/${item.id}`;
  const deadLetter = await readDeadLetter(basePath).catch(() => ({
    present: false, totalFiles: 0, totalBytes: 0, datasets: [], sample: [],
    note: 'Dead-letter path not reachable.',
  }));

  return apiOk({
    mirroringStatus: st.mirroringStatus || 'NotStarted',
    health,
    tables: tablesStatus.map((t) => ({
      schema: t.schema, table: t.table, status: t.status, mode: t.mode,
      rows: t.rows, lastSync: t.lastSync, error: t.error, note: t.note,
    })),
    schemaChanges: schema?.log || [],
    schemaCapturedAt: schema?.updatedAt,
    deadLetter,
  });
});
