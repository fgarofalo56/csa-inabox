/**
 * GET / PUT /api/items/report/[id]/data-source
 *
 * Read + persist the REPORT DATA SOURCE — the discriminated union
 * (`lib/editors/report/report-data-source.ts`) the designer holds in state and
 * the `/fields` + `/query` resolvers dispatch on. This is the route the
 * designer's "Data source" drawer calls to switch a report between an
 * Azure-native Loom semantic model (DEFAULT), a direct SQL query, or (advanced)
 * an Azure Analysis Services tabular model.
 *
 * ── GET ────────────────────────────────────────────────────────────────────
 * Returns the report item's persisted `state.dataSource`. For reports saved
 * before `state.dataSource` existed, `fromLegacyState()` synthesizes
 * `{kind:'aas', server, database}` from the legacy `state.aasServer` /
 * `state.aasDatabase` keys so they keep working unchanged. A genuinely unbound
 * report returns `{ ok:true, dataSource:null }` so the designer shows its
 * honest "pick a data source" gate rather than an empty render.
 *
 * Also returns (W2, additive) `tableStorage` — the persisted per-table
 * StorageMode map (`state.tableStorage`, `{}` when unset) — and `lastRefresh` —
 * the refresh route's read-only last-materialization receipts
 * (`state.lastRefresh`, `{}` when unset) — so StorageModePane / RefreshPane seed
 * from real state. Reports saved before W2 get `{}`/`{}` and behave identically.
 *
 * ── PUT ────────────────────────────────────────────────────────────────────
 * Validate the `ReportDataSource` union and persist it to `state.dataSource`
 * via `updateOwnedItem` (additive — the legacy `aasServer/aasDatabase` keys and
 * `state.content` are left untouched). Validation per kind:
 *   • semantic-model → `itemId` must resolve to an owned `semantic-model` item
 *     in the caller's tenant (the picker's choice is real, not a dangling ref).
 *     The id is normalized off any `loom:` content prefix so the `/fields` +
 *     `/query` resolvers (`loadModelItem` by plain Cosmos id) find it.
 *   • direct-query   → `sql` must pass `readOnlySelect` (single guarded SELECT,
 *     no DML/DDL — the only free-text escape hatch, per no-freeform-config);
 *     `target` is the warehouse|lakehouse Synapse path.
 *   • aas            → both `server` (XMLA URI) + `database` are required.
 *   • connection     → (Get Data) `connectionId` must resolve to an owned, KV-
 *     backed Loom Connection (`loadConnection`, tenant-scoped); `connType` is
 *     normalized off the LOADED connection.type (non-queryable types — event-hub
 *     / service-bus / key-vault — are rejected, never persisted as a dead ref);
 *     `objectRef` is validated by `mode` (table|file|kql structural, query via
 *     the same `readOnlySelect` guard).
 *   • file-upload    → (Get Data) `containerPath` (the path returned by the
 *     existing /api/lakehouse/upload route) + a supported `format`.
 *   • adls-file      → (Get Data) `container` + `path` + a supported `format`.
 *
 * The body may ALSO carry an optional `tableStorage` map (W2, additive):
 * `{ [table]: { mode: StorageMode, group? } }`. Each entry's key is trimmed,
 * its `mode` validated against `STORAGE_MODES` (unknown/invalid entries are
 * ignored), and the map is persisted to `state.tableStorage` alongside
 * `state.dataSource`. A body carrying ONLY `tableStorage` (the per-table mode
 * picker's save) persists the map without re-binding the source; an explicit
 * `{}` clears all per-table overrides (every table back to DirectQuery). When
 * `tableStorage` is absent the existing single-source PUT behaviour is unchanged.
 *
 * Session-gated; owner-checked against the parent workspace's tenant. The
 * report id may be a plain Cosmos id OR a `loom:<cosmosId>` content-backed id
 * (bundle-installed reports), handled exactly like the sibling `…/definition`
 * write path.
 *
 * Rules compliance:
 *  - no-fabric-dependency: the DEFAULT source is a Loom semantic model over
 *    Synapse/lakehouse; AAS is advanced; Power BI is reached only via the
 *    opt-in publish path, never from this union. No api.powerbi.com /
 *    api.fabric.microsoft.com is called here.
 *  - no-vaporware: the semantic-model branch verifies the referenced item
 *    actually exists + is owned (no dangling binding); every reject is an
 *    actionable error, never a silent no-op.
 *  - no-freeform-config: the source is a picker choice; the only free text is
 *    the advanced AAS XMLA URI + the guarded direct-query SELECT.
 *
 * 200 OK → { ok:true, dataSource }
 * 4xx    → { ok:false, error } (validation) | { ok:false, gate } (honest gate)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import {
  parseDataSource,
  fromLegacyState,
  isReportConnType,
  type ReportDataSource,
  type ReportConnType,
  type ReportObjectRef,
} from '@/lib/editors/report/report-data-source';
import { loadConnection } from '@/lib/azure/connections-store';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A validated source ready to persist, or a structured rejection. */
type ValidationResult =
  | { ok: true; dataSource: ReportDataSource }
  | { ok: false; status: number; error: string };

/** A validated connection object-ref ready to persist, or a structured rejection. */
type ObjectRefResult =
  | { ok: true; ref: ReportObjectRef }
  | { ok: false; status: number; error: string };

/**
 * Tabular file formats the serverless-OPENROWSET / ADLS read path supports.
 * Shared by the file-upload, adls-file, and connection `mode:'file'` branches —
 * keep in sync with the resolver's OPENROWSET dispatch (delta via
 * buildDeltaOpenRowsetSql, parquet/csv/json via generic OPENROWSET).
 */
const FILE_FORMATS = new Set(['csv', 'parquet', 'json', 'delta']);

/* ============================================================================
 * W2 — per-table STORAGE MODE (additive, back-compat).
 *
 * `state.tableStorage[table]` rides ALONGSIDE the existing `state.dataSource`;
 * when it is absent every model table is DirectQuery in one 'primary' group —
 * byte-identical to today's single-source behaviour. The StorageModePane PUTs
 * `{ tableStorage }` here (no `dataSource`), and the pane + RefreshPane seed
 * from this route's GET (`tableStorage` + read-only `lastRefresh`).
 *
 * `StorageMode` / `TableStorage` are OWNED by the `'use client'` module
 * `lib/editors/report/storage-mode-pane.tsx` (the W2 shared contract). A server
 * route cannot import that client module, so — exactly as the resolver +
 * wells-to-sql do for the same union — we carry a small string-validated LOCAL
 * MIRROR here. Keep `STORAGE_MODES` in sync with the owner.
 * ========================================================================== */

/** Local mirror of the StorageMode union (owner: storage-mode-pane.tsx). */
const STORAGE_MODES = ['DirectQuery', 'Import', 'Dual', 'DirectLake'] as const;
type StorageMode = (typeof STORAGE_MODES)[number];
function isStorageMode(v: unknown): v is StorageMode {
  return typeof v === 'string' && (STORAGE_MODES as readonly string[]).includes(v);
}

/** Per-table storage selection persisted on `state.tableStorage[table]`. */
interface TableStorage {
  mode: StorageMode;
  /** Source-group id; default 'primary'. Cross-group = a limited relationship. */
  group?: string;
}
type TableStorageMap = Record<string, TableStorage>;

/**
 * Validate + normalize a client-supplied `tableStorage` bag into a canonical
 * `TableStorageMap`. Keys are trimmed (empties dropped); each entry's `mode`
 * must be a known StorageMode (unknown / invalid entries are ignored, never
 * persisted as a dead mode); `group` is preserved when a non-empty string.
 * Symmetric with the pane's `parseTableStorageMap`, so what is persisted reads
 * back identically.
 *
 * Returns `null` when the input is absent / not an object — the caller then
 * leaves `state.tableStorage` untouched (full back-compat). An explicit `{}`
 * returns an empty map (clears all per-table overrides → every table
 * DirectQuery again).
 */
function validateTableStorage(raw: unknown): TableStorageMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: TableStorageMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const table = key.trim();
    if (!table) continue;
    if (!value || typeof value !== 'object') continue;
    const rv = value as Record<string, unknown>;
    if (!isStorageMode(rv.mode)) continue;
    const group = typeof rv.group === 'string' && rv.group.trim() ? rv.group.trim() : undefined;
    out[table] = { mode: rv.mode, ...(group ? { group } : {}) };
  }
  return out;
}

/**
 * Validate + normalize a connection's `ReportObjectRef`, discriminated by `mode`.
 * Pure structural checks except `mode:'query'`, which is run through the same
 * `readOnlySelect` guard as `direct-query` (the single free-text escape hatch,
 * per no-freeform-config). Returns the canonical ref to persist.
 */
function validateObjectRef(ref: ReportObjectRef | undefined): ObjectRefResult {
  if (!ref || typeof ref !== 'object') {
    return { ok: false, status: 400, error: 'Pick an object (table, file, or query) inside the connection.' };
  }
  switch (ref.mode) {
    case 'table': {
      const table = (ref.table || '').trim();
      if (!table) {
        return { ok: false, status: 400, error: 'Pick a table (or collection) for this connection source.' };
      }
      const schema = (ref.schema || '').trim();
      return { ok: true, ref: { mode: 'table', table, ...(schema ? { schema } : {}) } };
    }
    case 'query': {
      const guard = readOnlySelect(ref.sql);
      if (!guard.ok) {
        return { ok: false, status: 400, error: `Connection custom query: ${guard.error}` };
      }
      return { ok: true, ref: { mode: 'query', sql: guard.sql } };
    }
    case 'file': {
      const containerPath = (ref.containerPath || '').trim();
      const format = (ref.format || '').trim().toLowerCase();
      if (!containerPath) {
        return { ok: false, status: 400, error: 'The file object requires a container path inside the connection.' };
      }
      if (!FILE_FORMATS.has(format)) {
        return {
          ok: false,
          status: 400,
          error: `Unsupported file format "${ref.format}". Supported: ${[...FILE_FORMATS].join(', ')}.`,
        };
      }
      return { ok: true, ref: { mode: 'file', containerPath, format } };
    }
    case 'kql': {
      const kql = (ref.kql || '').trim();
      if (!kql) {
        return { ok: false, status: 400, error: 'The KQL object requires a query.' };
      }
      return { ok: true, ref: { mode: 'kql', kql } };
    }
    default:
      return { ok: false, status: 400, error: 'Unrecognized connection object reference.' };
  }
}

/**
 * Validate + normalize a parsed `ReportDataSource` against the caller's tenant.
 * The semantic-model branch is the only one that touches Cosmos (to confirm the
 * referenced model item exists + is owned); the others are pure structural
 * checks. Returns the canonical value to persist (ids trimmed/normalized, SQL
 * guard-normalized) so the `/fields` + `/query` resolvers find it.
 */
async function validateDataSource(
  ds: ReportDataSource,
  tenantId: string,
): Promise<ValidationResult> {
  switch (ds.kind) {
    case 'semantic-model': {
      const raw = (ds.itemId || '').trim();
      if (!raw) {
        return {
          ok: false,
          status: 400,
          error: 'Pick a semantic model for this report in the Data source panel.',
        };
      }
      // Normalize off any `loom:` content prefix so the model resolves by its
      // plain Cosmos id (what loadModelItem/loadOwnedItem query on).
      const itemId = isLoomContentId(raw) ? cosmosIdFromLoomId(raw) : raw;
      const model = await loadOwnedItem(itemId, 'semantic-model', tenantId);
      if (!model) {
        return {
          ok: false,
          status: 404,
          error:
            `The selected semantic model (${raw}) was not found in your workspace, or is not a ` +
            'semantic-model item. Pick an existing semantic model in the Data source panel.',
        };
      }
      return { ok: true, dataSource: { kind: 'semantic-model', itemId } };
    }

    case 'direct-query': {
      const guard = readOnlySelect(ds.sql);
      if (!guard.ok) {
        return { ok: false, status: 400, error: `Direct-query data source: ${guard.error}` };
      }
      const target = ds.target === 'lakehouse' ? 'lakehouse' : 'warehouse';
      return {
        ok: true,
        dataSource: {
          kind: 'direct-query',
          target,
          sql: guard.sql,
          // Preserve an already-scaffolded model link (governed reuse).
          ...(ds.modelItemId && ds.modelItemId.trim()
            ? { modelItemId: ds.modelItemId.trim() }
            : {}),
        },
      };
    }

    case 'aas': {
      const server = (ds.server || '').trim();
      const database = (ds.database || '').trim();
      if (!server || !database) {
        return {
          ok: false,
          status: 400,
          error:
            'The Analysis Services source requires both a server (XMLA URI, e.g. ' +
            'asazure://eastus2.asazure.windows.net/my-server) and a database/model name.',
        };
      }
      return { ok: true, dataSource: { kind: 'aas', server, database } };
    }

    case 'connection': {
      // Get Data — a report sourced from a reusable, KV-backed Loom Connection.
      // The binding is real: the connection must exist + be owned by the caller
      // (loadConnection is tenant-scoped). The connType is normalized off the
      // LOADED connection (never trusted from the client), and non-queryable
      // connection types (event-hub / service-bus / key-vault) are rejected
      // here with an honest error rather than persisted as a dead source.
      const connectionId = (ds.connectionId || '').trim();
      if (!connectionId) {
        return {
          ok: false,
          status: 400,
          error: 'Pick a connection for this report in the Get data panel, or add one with the connection wizard.',
        };
      }
      const conn = await loadConnection(tenantId, connectionId);
      if (!conn) {
        return {
          ok: false,
          status: 404,
          error:
            `The selected connection (${connectionId}) was not found in your workspace. Pick an existing ` +
            'connection in the Get data panel, or add one with the connection wizard.',
        };
      }
      // Normalize connType from the real connection.type. Types outside the
      // report-queryable set (event-hub / service-bus / key-vault) are not
      // valid report sources.
      const loadedType = conn.type;
      if (!isReportConnType(loadedType)) {
        return {
          ok: false,
          status: 400,
          error:
            `Connections of type "${conn.type}" cannot be used as a report source. Supported: Azure SQL, ` +
            'Synapse, Databricks SQL, PostgreSQL, Cosmos DB, ADLS/Blob files.',
        };
      }
      const connType: ReportConnType = loadedType;
      const refResult = validateObjectRef(ds.objectRef);
      if (!refResult.ok) {
        return { ok: false, status: refResult.status, error: refResult.error };
      }
      return {
        ok: true,
        dataSource: { kind: 'connection', connectionId, connType, objectRef: refResult.ref },
      };
    }

    case 'file-upload': {
      // A user-uploaded file already staged to ADLS landing by the existing
      // POST /api/lakehouse/upload route — we persist only the returned path +
      // format (read tabularly via serverless OPENROWSET in the resolver).
      const containerPath = (ds.containerPath || '').trim();
      const format = (ds.format || '').trim().toLowerCase();
      const fileName = (ds.fileName || '').trim();
      if (!containerPath) {
        return {
          ok: false,
          status: 400,
          error: 'The uploaded-file source requires a staged file path. Upload a file in the Get data panel first.',
        };
      }
      if (!FILE_FORMATS.has(format)) {
        return {
          ok: false,
          status: 400,
          error: `Unsupported file format "${ds.format}". Supported: ${[...FILE_FORMATS].join(', ')}.`,
        };
      }
      return { ok: true, dataSource: { kind: 'file-upload', fileName, format, containerPath } };
    }

    case 'adls-file': {
      // An existing ADLS Gen2 path (Console MI via adls-client; no connection
      // needed) — read tabularly via serverless OPENROWSET in the resolver.
      const container = (ds.container || '').trim();
      const path = (ds.path || '').trim();
      const format = (ds.format || '').trim().toLowerCase();
      if (!container) {
        return {
          ok: false,
          status: 400,
          error: 'The ADLS file source requires a container (e.g. bronze, silver, gold, landing).',
        };
      }
      if (!path) {
        return { ok: false, status: 400, error: 'The ADLS file source requires a path within the container.' };
      }
      if (!FILE_FORMATS.has(format)) {
        return {
          ok: false,
          status: 400,
          error: `Unsupported file format "${ds.format}". Supported: ${[...FILE_FORMATS].join(', ')}.`,
        };
      }
      return { ok: true, dataSource: { kind: 'adls-file', container, path, format } };
    }

    default:
      return { ok: false, status: 400, error: 'Unrecognized data source.' };
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Persisted dataSource wins; else legacy aasServer/aasDatabase synthesizes an
  // AAS source; else null (drives the designer's "pick a data source" gate).
  const state = (item.state || {}) as Record<string, unknown>;
  const dataSource = fromLegacyState(state);
  // W2 (additive): surface the persisted per-table storage map + the refresh
  // route's last-materialization receipts so StorageModePane / RefreshPane seed
  // from real state. Both default to `{}` for reports saved before W2.
  const tableStorage = validateTableStorage(state.tableStorage) ?? {};
  const lastRefresh =
    state.lastRefresh && typeof state.lastRefresh === 'object'
      ? (state.lastRefresh as Record<string, unknown>)
      : {};
  return NextResponse.json({ ok: true, dataSource, tableStorage, lastRefresh });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: unknown = {};
  try { body = await req.json(); } catch {}

  const bodyObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  // W2 (additive): an optional per-table storage map. `null` ⇒ not present in
  // this PUT → `state.tableStorage` is left untouched (back-compat). The
  // StorageModePane PUTs `{ tableStorage }` with NO `dataSource`, so a body
  // carrying only a valid map must persist without requiring a source re-bind.
  const tableStorage = 'tableStorage' in bodyObj ? validateTableStorage(bodyObj.tableStorage) : null;

  // Accept either the bare union or `{ dataSource: <union> }`.
  const candidate = 'dataSource' in bodyObj ? bodyObj.dataSource : body;
  const parsed = parseDataSource(candidate);
  if (!parsed && tableStorage === null) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Provide a data source with kind "semantic-model" (default, Azure-native), ' +
          '"direct-query", "aas", or a Get Data source ("connection", "file-upload", "adls-file") ' +
          '— or a tableStorage map of per-table storage modes.',
      },
      { status: 400 },
    );
  }

  // Owner-check the report item up-front (404 before any validation work).
  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Validate the data source only when one was supplied (a tableStorage-only
  // PUT leaves the bound source — `state.dataSource` — exactly as it is).
  let validatedDataSource: ReportDataSource | undefined;
  if (parsed) {
    const validated = await validateDataSource(parsed, session.claims.oid);
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.error }, { status: validated.status });
    }
    validatedDataSource = validated.dataSource;
  }

  // Persist additively (legacy keys + state.content untouched): set
  // `state.dataSource` only when a source was (re)bound, and `state.tableStorage`
  // only when a map was supplied in this request.
  const prevState = (item.state || {}) as Record<string, unknown>;
  const newState: Record<string, unknown> = {
    ...prevState,
    ...(validatedDataSource ? { dataSource: validatedDataSource } : {}),
    ...(tableStorage !== null ? { tableStorage } : {}),
  };
  const updated = await updateOwnedItem(cosmosId, 'report', session.claims.oid, { state: newState });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist data source' }, { status: 502 });
  }

  // Echo the effective bound source (the newly validated one, else the existing
  // persisted/legacy source) plus the persisted map when this PUT set it.
  const responseDataSource = validatedDataSource ?? fromLegacyState(prevState);
  return NextResponse.json({
    ok: true,
    dataSource: responseDataSource,
    ...(tableStorage !== null ? { tableStorage } : {}),
  });
}
