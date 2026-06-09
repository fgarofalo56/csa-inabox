/**
 * Shared types + validation for the Loom dashboard overlay (pinned-DAX tiles,
 * Q&A tiles, streaming ADX tiles, grid layout). Used by the dashboard BFF
 * route (persist to Cosmos) and the DashboardEditor (author + render).
 *
 * Per loom-no-freeform-config.md: the overlay is a strongly-typed document with
 * an explicit `kind` discriminant per tile — NOT a free-form JSON blob. The
 * PUT handler runs `sanitizeOverlay` to whitelist every field before upsert.
 */

export type LoomTileKind = 'dax' | 'kusto' | 'streaming-adx';
export type TileVizKind = 'table' | 'timechart' | 'line' | 'bar' | 'column' | 'pie' | 'stat' | 'map';

export interface LoomTile {
  /** Stable UUID. */
  id: string;
  kind: LoomTileKind;
  title: string;
  /** DAX EVALUATE statement (kind=dax) or KQL query (kind=kusto/streaming-adx). */
  query: string;
  /** kind=dax via Power BI: the Power BI group + dataset to run executeQueries against. */
  workspaceId?: string;
  datasetId?: string;
  /** kind=kusto/streaming-adx: ADX database name. */
  database?: string;
  /** Visual type for the result renderer. */
  viz?: TileVizKind;
  /** Streaming tiles only: client-side auto-refresh interval (>= 5000 ms). */
  autoRefreshMs?: number;
  /** Default grid span (columns of 12 / row units) when no explicit layout entry. */
  w?: number;
  h?: number;
}

export interface TileLayout {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface DashboardOverlay {
  /** Loom item UUID (same as the route [id]); also the Cosmos partition value. */
  id: string;
  itemId: string;
  /** Power BI group UUID (empty when no Power BI workspace is bound — fully OK). */
  pbiWorkspaceId?: string;
  /** Power BI dashboard UUID (empty when not linked to a PBI dashboard). */
  pbiDashboardId?: string;
  loomTiles: LoomTile[];
  /** Per-tile grid position, keyed by tile id (PBI tile id or LoomTile id). */
  layout: Record<string, TileLayout>;
  updatedAt: string;
  updatedBy: string;
}

const TILE_KINDS: LoomTileKind[] = ['dax', 'kusto', 'streaming-adx'];
const VIZ_KINDS: TileVizKind[] = ['table', 'timechart', 'line', 'bar', 'column', 'pie', 'stat', 'map'];

function str(v: unknown, max = 8000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Whitelist a single tile from untrusted input. Returns null when invalid. */
export function sanitizeTile(raw: unknown): LoomTile | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const kind = TILE_KINDS.includes(t.kind as LoomTileKind) ? (t.kind as LoomTileKind) : null;
  if (!kind) return null;
  const query = str(t.query);
  if (!query.trim()) return null;
  const viz = VIZ_KINDS.includes(t.viz as TileVizKind) ? (t.viz as TileVizKind) : undefined;
  const refresh = num(t.autoRefreshMs);
  const w = num(t.w);
  const h = num(t.h);
  return {
    id: str(t.id, 80) || cryptoRandomId(),
    kind,
    title: str(t.title, 200) || 'Tile',
    query,
    workspaceId: str(t.workspaceId, 120) || undefined,
    datasetId: str(t.datasetId, 120) || undefined,
    database: str(t.database, 200) || undefined,
    viz,
    autoRefreshMs: refresh !== undefined ? Math.max(5000, Math.min(3_600_000, refresh)) : undefined,
    w: w !== undefined ? Math.max(1, Math.min(12, Math.round(w))) : undefined,
    h: h !== undefined ? Math.max(1, Math.min(12, Math.round(h))) : undefined,
  };
}

/** Whitelist the grid layout map. */
export function sanitizeLayout(raw: unknown): Record<string, TileLayout> {
  const out: Record<string, TileLayout> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    const col = num(p.col), row = num(p.row), w = num(p.w), h = num(p.h);
    if (col === undefined || row === undefined || w === undefined || h === undefined) continue;
    out[str(k, 80)] = {
      col: Math.max(0, Math.min(11, Math.round(col))),
      row: Math.max(0, Math.round(row)),
      w: Math.max(1, Math.min(12, Math.round(w))),
      h: Math.max(1, Math.min(12, Math.round(h))),
    };
  }
  return out;
}

function cryptoRandomId(): string {
  // Node 18+ / edge runtime both expose globalThis.crypto.randomUUID.
  try {
    return (globalThis.crypto as Crypto).randomUUID();
  } catch {
    return `tile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Build a fully-validated overlay document from untrusted request input. */
export function sanitizeOverlay(
  id: string,
  raw: unknown,
  updatedBy: string,
): DashboardOverlay {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tiles = Array.isArray(r.loomTiles)
    ? r.loomTiles.map(sanitizeTile).filter((t): t is LoomTile => t !== null)
    : [];
  return {
    id,
    itemId: id,
    pbiWorkspaceId: str(r.pbiWorkspaceId, 120) || undefined,
    pbiDashboardId: str(r.pbiDashboardId, 120) || undefined,
    loomTiles: tiles,
    layout: sanitizeLayout(r.layout),
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || 'unknown',
  };
}
