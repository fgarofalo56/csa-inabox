/**
 * /api/items/data-quality/[id]/diff   (N7d — fold b)
 *
 * POST → compute the exact row + cell delta between two Delta versions (or two
 *        environments / paths) of a table, **through the N2 DuckDB engine**.
 *        body {
 *          a: { container, path, version?, label? },
 *          b: { container, path, version?, label? },
 *          keyColumns: string[], limit?, emitFinding?: boolean
 *        }
 *
 * DuckDB reconstructs each side's active parquet file-set from the `_delta_log`
 * and reads them in place — Azure-native, no Fabric, IL5-disconnected. When
 * `emitFinding` is set and the diff shows changes, a `data-diff` finding is
 * emitted for N17's incident console (N17 OWNS the incident UX).
 */
import type { NextRequest } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { computeDataDiff, DataDiffError, type DiffSide } from '@/lib/azure/dq-data-diff';
import { buildDqFinding } from '@/lib/azure/dq-finding-model';
import { writeDqFindings } from '@/lib/azure/dq-finding-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-quality';
const FLAG = 'n7d-data-quality-diff';

function sanitizeSide(raw: unknown): DiffSide | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const container = typeof o.container === 'string' ? o.container.trim() : '';
  const path = typeof o.path === 'string' ? o.path.trim() : '';
  if (!container || !path) return null;
  const side: DiffSide = { container, path };
  if (typeof o.version === 'number' && Number.isFinite(o.version) && o.version >= 0) side.version = Math.floor(o.version);
  if (typeof o.label === 'string' && o.label.trim()) side.label = o.label.trim().slice(0, 60);
  return side;
}

export const POST = withWorkspaceOwner(ITEM_TYPE, async (req: NextRequest, { session, item }) => {
  const enabled = await runtimeFlag(FLAG, { default: true });
  if (!enabled) {
    return apiOk({ disabled: true, note: 'The N7d data-quality depth surface is turned off (runtime flag n7d-data-quality-diff).' });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const a = sanitizeSide(body.a);
  const b = sanitizeSide(body.b);
  if (!a || !b) return apiError('Both sides need a container and a table path.', 400);

  const keyColumns = Array.isArray(body.keyColumns)
    ? body.keyColumns.map((k) => String(k).trim()).filter(Boolean).slice(0, 10)
    : [];
  if (!keyColumns.length) return apiError('Pick at least one key column so rows can be matched across versions.', 400);

  const limit = typeof body.limit === 'number' ? body.limit : undefined;

  try {
    const diff = await computeDataDiff({ a, b, keyColumns, limit });

    if (body.emitFinding === true && (diff.counts.changed || diff.counts.added || diff.counts.removed)) {
      const scope = `${diff.scan.a.label} → ${diff.scan.b.label} on ${a.container}/${a.path}`;
      const finding = buildDqFinding({
        tenantId: session.claims.oid,
        itemId: item.id,
        itemType: ITEM_TYPE,
        workspaceId: item.workspaceId,
        runId: `diff_${Date.now()}`,
        source: 'data-diff',
        severity: diff.counts.removed > 0 ? 'error' : 'warning',
        checkKey: scope,
        target: { engine: 'duckdb', table: a.path, diffScope: scope },
        title: `Data diff: ${diff.counts.changed} changed, ${diff.counts.added} added, ${diff.counts.removed} removed (${scope})`,
        detail:
          `Comparing ${diff.scan.a.label} (${diff.scan.a.files} file(s)) with ${diff.scan.b.label} (${diff.scan.b.files} file(s)) `
          + `over key [${keyColumns.join(', ')}]: ${diff.counts.changed} row(s) with changed cells, `
          + `${diff.counts.added} added, ${diff.counts.removed} removed.`,
        metric: { name: 'changed-rows', value: diff.counts.changed + diff.counts.added + diff.counts.removed },
        createdBy: session.claims.upn || session.claims.email || session.claims.oid,
      });
      await writeDqFindings([finding], {
        oid: session.claims.oid,
        upn: session.claims.upn || session.claims.email || session.claims.oid,
        tenantId: session.claims.oid,
      });
      return apiOk({ diff, findingEmitted: true, findingId: finding.id });
    }

    return apiOk({ diff, findingEmitted: false });
  } catch (e) {
    if (e instanceof DataDiffError) return apiError(e.message, e.status);
    return apiError((e as Error)?.message || String(e), 502);
  }
});
