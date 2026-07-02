/**
 * POST /api/items/report/[id]/visual-data  — REPORT-BUILDER PARITY · WAVE 9
 *
 * Per-visual "Export data" (Power BI parity): stream the rows behind a single
 * report visual as CSV or Excel (.xlsx). Two modes, mirroring Power BI's
 * Summarized-vs-Underlying export:
 *
 *   • summarized  — the SAME aggregated rows the visual renders (the exact
 *                   wells→SQL / DAX compile the `/query` route runs). Available
 *                   on every backend.
 *   • underlying  — the row-level detail behind the visual (no GROUP BY): every
 *                   well column projected raw, capped at the Power BI export
 *                   limits. REQUIRES report ownership AND an Azure-native SQL
 *                   (Synapse / lakehouse) source — the wells→SQL compiler's
 *                   `underlying` projection mode. On a non-SQL backend (AAS /
 *                   Get-Data connection) it returns an honest 412 (the live
 *                   executor / XMLA path can't project arbitrary row detail).
 *
 * ROW CAPS (Power BI parity, passed to the compiler as `rowCapOverride` on the
 * underlying compile): CSV ≤ 30,000 rows, Excel ≤ 150,000 rows.
 *
 * 100% Azure-native (no-fabric-dependency.md): rows come from Synapse
 * `executeQuery` (loom-native), the resolver's real connection executor, or
 * Azure Analysis Services XMLA — never a Fabric / Power BI / OneLake host. Real
 * bytes from real rows (no-vaporware.md): the CSV/XLSX is built from the actual
 * query result, never mock.
 *
 * SENSITIVITY (MIP) — when the report carries a sensitivity label
 * (`state.sensitivityLabelId`) AND MIP is wired (`LOOM_MIP_ENABLED==='true'`):
 *   1. A guard runs `checkExportProtection(label, format)` BEFORE streaming. A
 *      PROTECTED label blocks CSV/TXT export (those formats strip the AIP/RMS
 *      protection) → 403 with the precise reason.
 *   2. The XLSX bytes are stamped with the label via `applySensitivityStamp`
 *      (real OOXML custom-property injection) so the downloaded workbook carries
 *      the label. The helper no-ops when no label / MIP disabled / unsupported
 *      type, and never throws into the export.
 *
 * Auth: session-gated (401). `loadOwnedItem` enforces tenant ownership, so a
 * caller who doesn't own the report gets 404 (summarized) / 403 (underlying).
 *
 * Responses:
 *   200  → binary stream (text/csv or the xlsx content-type) as an attachment
 *   401  → unauthenticated
 *   403  → underlying export on a non-owned report, OR a protected-label CSV block
 *   404  → report not found / not owned
 *   400  → no visual / no fields / cross-table visual (honest parity gate)
 *   412  → unbound data source, OR underlying export on a non-SQL backend
 *   502  → a backend execution error (surfaced verbatim)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import {
  resolveReportModel,
  type ResolvedReportModel,
  type ReportSqlSource,
  type FieldTable,
  type SqlBaseRelation,
} from '@/lib/azure/report-model-resolver';
import {
  buildSqlFromVisual,
  wrapDaxWithFilters,
  type SqlSource,
  type SqlSourceColumn,
  type ReportFilterInput,
  type VisualCompileOptions,
} from '@/lib/azure/wells-to-sql';
import { buildDaxFromVisual, executeAasQuery, flattenAasRows, type DaxVisual } from '@/lib/azure/aas-client';
import { recordsetsToXlsxBuffer } from '@/lib/azure/sql-xlsx-export';
import { getSensitivityLabel } from '@/lib/azure/mip-graph-client';
import { checkExportProtection } from '@/lib/azure/label-protection';
import { applySensitivityStamp } from '@/lib/azure/report-export-label';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ExportMode = 'summarized' | 'underlying';
type ExportFormat = 'csv' | 'xlsx';

interface VisualDataRequest {
  visual?: DaxVisual & Record<string, unknown>;
  filters?: ReportFilterInput[];
  dataSource?: unknown; // resolved from persisted state; accepted for forward-compat
  mode?: ExportMode;
  format?: ExportFormat;
}

/** Column-matrix recordset — the shape both the CSV writer and the xlsx writer
 *  (recordsetsToXlsxBuffer's RecordsetSlice) consume. */
interface Recordset {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

// ── resolver model → single-FROM wells→SQL compiler projection ─────────────────
//
// Mirrors the (non-exported) `toSqlSource` in the sibling /query route: project
// the resolver's `ReportSqlSource` (a model-table→relation map, or a derived
// SELECT) onto the single-FROM `SqlSource` the compiler binds. Identifiers come
// ONLY from the resolved model (never the request) — bracket-quoted + the column
// whitelist makes the emitted SQL injection-safe. A visual spanning >1 model
// table is an honest 400 (the single-FROM compiler can't JOIN without
// relationship keys), never a silent partial. The source-groups (Wave-2) arm is
// served via its back-compat `tableMap` (the flattened LIVE relation map) — real
// live Synapse rows, the resolver's documented honest fallback.

type ProjectResult =
  | { kind: 'ok'; source: SqlSource }
  | { kind: 'no-columns' }
  | { kind: 'multi-table'; tables: string[] };

/** Map a resolved Fields table's columns to the compiler's identifier whitelist. */
function fieldColumns(table: FieldTable | undefined): SqlSourceColumn[] {
  return (table?.columns || []).map((c) => ({ table: table?.name, name: c.name, dataType: c.dataType }));
}

/** Model tables a visual + its filters reference (for the multi-table gate). */
function referencedTables(visual: DaxVisual, filters: ReportFilterInput[] | undefined): string[] {
  const out = new Set<string>();
  const wells = visual.wells || {};
  for (const arr of [wells.category, wells.values, wells.legend]) {
    for (const w of arr || []) if (w?.table) out.add(w.table);
  }
  for (const f of filters || []) if (f?.table) out.add(f.table);
  return [...out];
}

function projectSqlSource(
  tables: FieldTable[],
  sqlSource: ReportSqlSource,
  visual: DaxVisual,
  filters: ReportFilterInput[] | undefined,
): ProjectResult {
  // direct-query: a single validated derived SELECT.
  if (sqlSource.mode === 'derived') {
    const columns = fieldColumns(tables.find((t) => t.name === sqlSource.tableName) || tables[0]);
    if (!columns.length) return { kind: 'no-columns' };
    return { kind: 'ok', source: { from: { kind: 'derived', sql: sqlSource.sql }, columns, measures: [] } };
  }

  // table-map AND source-groups both expose `.tableMap` (the live base-relation
  // map; source-groups carries it for back-compat) — bind ONE model table.
  const map = (sqlSource as { tableMap?: Record<string, SqlBaseRelation> }).tableMap;
  if (!map) return { kind: 'no-columns' };
  const mapped = Object.keys(map);
  if (!mapped.length) return { kind: 'no-columns' };

  const referenced = Array.from(new Set(referencedTables(visual, filters).filter((t) => map[t])));
  if (referenced.length > 1) return { kind: 'multi-table', tables: referenced };

  const chosen =
    referenced[0] ||
    (mapped.length === 1 ? mapped[0] : '') ||
    tables.map((t) => t.name).find((n) => map[n]) ||
    mapped[0];
  const relation = map[chosen];
  if (!relation) return { kind: 'no-columns' };
  const columns = fieldColumns(tables.find((t) => t.name === chosen));
  if (!columns.length) return { kind: 'no-columns' };
  return {
    kind: 'ok',
    source: { from: { kind: 'table', schema: relation.schema, table: relation.table }, columns, measures: [] },
  };
}

/** Fold object rows (AAS / connection executor) into a column matrix — columns
 *  are the union of keys in first-seen order, so a sparse row never shifts. */
function objectRowsToRecordset(objRows: Record<string, unknown>[]): Recordset {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of objRows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  const rows = objRows.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c])));
  return { columns, rows, rowCount: objRows.length, truncated: false };
}

/** Build the recordset for a visual against the resolved backend, OR an honest
 *  NextResponse gate / error. A backend execution throw becomes a verbatim 502. */
async function buildRecordset(
  resolved: ResolvedReportModel,
  visual: DaxVisual & Record<string, unknown>,
  filters: ReportFilterInput[] | undefined,
  mode: ExportMode,
  cap: number,
): Promise<Recordset | NextResponse> {
  try {
    // ── Loom-native Synapse (Azure-native DEFAULT) ─────────────────────────────
    if (resolved.backend === 'loom-native') {
      const projected = projectSqlSource(resolved.tables, resolved.sqlSource, visual, filters);
      if (projected.kind === 'multi-table') {
        return NextResponse.json(
          {
            ok: false,
            code: 'multi-table',
            error:
              `This visual binds fields from more than one model table ` +
              `(${projected.tables.join(', ')}). The Azure-native (Synapse) export renders each ` +
              `visual over a single model table, so cross-table visuals can't be exported on this ` +
              `path. Use a semantic model — or a direct-query SELECT — whose single table already ` +
              `joins these fields.`,
          },
          { status: 400 },
        );
      }
      if (projected.kind === 'no-columns') {
        return NextResponse.json(
          { ok: false, error: 'The report’s data source has no bindable columns for this visual.' },
          { status: 400 },
        );
      }
      // Power BI export row caps (csv 30k / xlsx 150k) passed to the compiler for
      // BOTH modes. The underlying projection applies the override directly (every
      // well column raw, no GROUP BY). The summarized/aggregate compile is bounded
      // by the compiler's built-in ROW_CAP and reads the same override forward-
      // compatibly — so a grouped export is never capped BELOW what the dialog
      // advertises (ROW_CAP ≤ cap, so its "≤ 30k / ≤ 150k rows" copy holds, and an
      // aggregated visual's grouped row count is far below the cap in practice).
      const opts: VisualCompileOptions =
        mode === 'underlying'
          ? { underlying: true, rowCapOverride: cap }
          : { rowCapOverride: cap };
      const compiled = buildSqlFromVisual(visual, filters, projected.source, opts);
      if (!compiled) {
        return NextResponse.json(
          { ok: false, error: 'The visual has no fields yet — add a category/value field to export.' },
          { status: 400 },
        );
      }
      const result = await executeQuery(resolved.sqlSource.target, compiled.sql, 60_000, compiled.parameters);
      return { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated };
    }

    // ── Get-Data connection (Azure-native, opt-in source) ──────────────────────
    if (resolved.backend === 'connection') {
      if (mode === 'underlying') {
        return NextResponse.json(
          {
            ok: false,
            code: 'underlying-unsupported',
            error: 'Underlying-rows export is available on the Azure-native SQL (Synapse/lakehouse) path.',
          },
          { status: 412 },
        );
      }
      const { rows } = await resolved.executor.runVisual(visual, filters);
      return objectRowsToRecordset(rows);
    }

    // ── Azure Analysis Services (advanced / back-compat) ───────────────────────
    if (resolved.backend === 'aas') {
      if (mode === 'underlying') {
        return NextResponse.json(
          {
            ok: false,
            code: 'underlying-unsupported',
            error: 'Underlying-rows export is available on the Azure-native SQL (Synapse/lakehouse) path.',
          },
          { status: 412 },
        );
      }
      const dax = buildDaxFromVisual(visual);
      if (!dax) {
        return NextResponse.json(
          { ok: false, error: 'The visual has no fields yet — add a category/value field to export.' },
          { status: 400 },
        );
      }
      const wrapped = wrapDaxWithFilters(dax, filters);
      const aas = await executeAasQuery(
        resolved.binding.region,
        resolved.binding.serverName,
        resolved.binding.database,
        wrapped,
      );
      return objectRowsToRecordset(flattenAasRows(aas) as Record<string, unknown>[]);
    }

    return NextResponse.json({ ok: false, error: 'This report’s data source does not support export.' }, { status: 412 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/** Spreadsheet-safe slug for the download filename. */
function slugify(s: string): string {
  return (
    (s || 'visual')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'visual'
  );
}

/** RFC-4180 CSV with a leading UTF-8 BOM (U+FEFF) so Excel opens unicode
 *  columns correctly. */
function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return '﻿' + lines.join('\r\n');
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const id = (await ctx.params).id;
  const body = (await req.json().catch(() => ({}))) as VisualDataRequest;
  const visual = body.visual;
  if (!visual) {
    return NextResponse.json(
      { ok: false, error: 'A visual (with field wells) is required to export its data.' },
      { status: 400 },
    );
  }
  const filters = Array.isArray(body.filters) ? body.filters : undefined;
  const mode: ExportMode = body.mode === 'underlying' ? 'underlying' : 'summarized';
  const format: ExportFormat = body.format === 'xlsx' ? 'xlsx' : 'csv';
  // Power BI export row caps — applied to the underlying compile via rowCapOverride.
  const cap = format === 'csv' ? 30_000 : 150_000;

  // Owner-checked load. Underlying export REQUIRES ownership (no shared-report
  // row-level export); summarized of a non-owned/absent report → 404.
  //
  // CONTENT-ID PARITY (mirror /query): a bundle-installed (template) report carries
  // a `loom:<cosmosId>` id whose chart renders via /query — which resolves the id
  // through isLoomContentId + cosmosIdFromLoomId + loadContentBackedItem. Resolving
  // it the SAME way here lets per-visual Export data work for those reports instead
  // of 404ing. A plain Cosmos id keeps the loadOwnedItem path byte-for-byte. The
  // resolved `cosmosId` is also what we hand applySensitivityStamp below, so the
  // MIP stamp finds the real Cosmos doc for a content-id report too.
  const cosmosId = isLoomContentId(id) ? cosmosIdFromLoomId(id) : id;
  const item = isLoomContentId(id)
    ? await loadContentBackedItem(cosmosId, 'report', session.claims.oid)
    : await loadOwnedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return mode === 'underlying'
      ? NextResponse.json({ ok: false, error: 'Underlying data export requires report ownership' }, { status: 403 })
      : NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
  }

  // ── Sensitivity (MIP) guard — runs BEFORE any streaming ────────────────────
  // A protected label blocks CSV/TXT (those formats strip AIP/RMS protection).
  const state = (item.state || {}) as Record<string, unknown>;
  const labelId = typeof state.sensitivityLabelId === 'string' ? state.sensitivityLabelId : '';
  if (labelId && process.env.LOOM_MIP_ENABLED === 'true') {
    try {
      const label = await getSensitivityLabel(labelId);
      if (label) {
        const chk = checkExportProtection(label, format);
        if (chk.blocked) return NextResponse.json({ ok: false, error: chk.reason }, { status: 403 });
      }
    } catch (e: any) {
      // The user explicitly applied a protective label; if we can't verify export
      // rights we fail honest rather than silently leaking the data.
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── Resolve the data source → backend (Azure-native default) ───────────────
  let resolved: ResolvedReportModel;
  try {
    resolved = await resolveReportModel(item, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  if (resolved.backend === 'unbound') {
    return NextResponse.json({ ok: false, code: 'unbound', error: resolved.gate.error }, { status: 412 });
  }

  // ── Build the rows ─────────────────────────────────────────────────────────
  const built = await buildRecordset(resolved, visual, filters, mode, cap);
  if (built instanceof NextResponse) return built;

  const slug = slugify(String((visual as Record<string, unknown>).title ?? 'visual'));

  // ── Stream ─────────────────────────────────────────────────────────────────
  if (format === 'csv') {
    const text = toCsv(built.columns, built.rows);
    return new NextResponse(text, {
      headers: {
        'content-type': 'text/csv;charset=utf-8',
        'content-disposition': `attachment; filename="${slug}-${mode}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  // xlsx — one worksheet from the result set, then stamp the label onto the bytes.
  const bytes = Buffer.from(
    recordsetsToXlsxBuffer(
      [{ columns: built.columns, rows: built.rows, rowCount: built.rowCount, truncated: built.truncated }],
      [],
    ),
  );
  const stamped = await applySensitivityStamp(session, cosmosId, bytes, 'xlsx');
  if (stamped.blocked) return NextResponse.json({ ok: false, error: stamped.blocked }, { status: 403 });
  return new NextResponse(new Uint8Array(stamped.bytes), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${slug}-${mode}.xlsx"`,
      'cache-control': 'no-store',
    },
  });
}
