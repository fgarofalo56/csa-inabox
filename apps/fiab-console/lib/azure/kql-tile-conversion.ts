/**
 * kql-tile-conversion — pure helpers for the "Create dashboard tile from query"
 * flow (operator review 5.2): converting a KQL-database query into a real
 * kql-dashboard tile.
 *
 * Shared by:
 *  • the BFF conversion route (app/api/thread/kql-query-to-dashboard-tile) —
 *    builds/updates the persisted dashboard model (content-fallback aware, so
 *    appending a tile to a bundle-installed dashboard never shadows its starter
 *    tiles), and
 *  • the client wizard (lib/editors/phase3/query-to-dashboard-wizard.tsx) —
 *    step order + per-step validation, so the wizard's Next/Create gating is
 *    unit-testable without the (broken) render harness.
 *
 * Pure of I/O: no Cosmos, no ADX, no fetch — deterministic and vitest-covered
 * (lib/azure/__tests__/kql-tile-conversion.test.ts).
 */

import {
  sanitizeModel,
  VALID_VIZ,
  type DashboardModel,
  type DashboardTile,
  type TileViz,
} from '@/lib/azure/kql-dashboard-model';

// ───────────────────────────────────────────────────────────────────────────
// Tile size presets — the wizard offers a structured size picker (never raw
// w/h typing, per loom-no-freeform-config). Geometry respects the dashboard
// grid bounds (w 1..12, h 1..8) enforced by sanitizeModel.
// ───────────────────────────────────────────────────────────────────────────

export type TileSizeKey = 'small' | 'medium' | 'wide' | 'tall';

export const TILE_SIZES: Array<{ value: TileSizeKey; label: string; w: number; h: number }> = [
  { value: 'small', label: 'Small (4 × 2)', w: 4, h: 2 },
  { value: 'medium', label: 'Medium (6 × 3)', w: 6, h: 3 },
  { value: 'wide', label: 'Wide (12 × 3)', w: 12, h: 3 },
  { value: 'tall', label: 'Tall (6 × 5)', w: 6, h: 5 },
];

/** Grid geometry for a size key (unknown keys fall back to medium). */
export function geometryForSize(size: string | undefined): { w: number; h: number } {
  const hit = TILE_SIZES.find((s) => s.value === size);
  return hit ? { w: hit.w, h: hit.h } : { w: 6, h: 3 };
}

/** Visual choices the conversion wizard offers (dashboard tile model subset). */
export const CONVERSION_VIZ_CHOICES: Array<{ value: TileViz; label: string }> = [
  { value: 'table', label: 'Table' },
  { value: 'timechart', label: 'Time chart' },
  { value: 'column', label: 'Column chart' },
  { value: 'bar', label: 'Bar chart' },
  { value: 'pie', label: 'Pie chart' },
  { value: 'stat', label: 'Card (KPI)' },
];

/** True when `viz` is a valid dashboard tile visual. */
export function isValidTileViz(viz: unknown): viz is TileViz {
  return typeof viz === 'string' && VALID_VIZ.has(viz as TileViz);
}

// ───────────────────────────────────────────────────────────────────────────
// Query pre-validation (structural — the route ALSO executes it against ADX).
// ───────────────────────────────────────────────────────────────────────────

export const MAX_TILE_KQL_LENGTH = 65_536;

/** Structural check of the tile KQL (empty / mgmt command / oversized). */
export function checkTileKql(kql: string): { ok: true } | { ok: false; error: string } {
  const trimmed = (kql || '').trim();
  if (!trimmed) return { ok: false, error: 'The tile query is empty. Write or run a KQL query first.' };
  if (trimmed.startsWith('.')) {
    return { ok: false, error: 'Management commands cannot be pinned as dashboard tiles — tiles run tabular queries only.' };
  }
  if (trimmed.length > MAX_TILE_KQL_LENGTH) {
    return { ok: false, error: `The tile query is too long (max ${MAX_TILE_KQL_LENGTH.toLocaleString()} characters).` };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// Dashboard-model append (server side)
// ───────────────────────────────────────────────────────────────────────────

/** Map a bundle `KqlDashboardContent` viz keyword to a sanitizer-valid viz —
 *  mirror of the kql-dashboard [id] route's `vizFromContent`, kept here so the
 *  conversion route materializes a bundle dashboard's starter tiles the same
 *  way the read route renders them. */
function vizFromContent(v: unknown): string {
  switch (v) {
    case 'card': return 'stat';
    case 'line': return 'line';
    case 'bar': return 'bar';
    case 'pie': return 'pie';
    case 'table': return 'table';
    default: return 'table';
  }
}

/**
 * Materialize the EFFECTIVE dashboard model from a kql-dashboard item's state,
 * content-fallback aware (mirror of the read route's `readModel`): a bundle
 * dashboard whose tiles were never saved still renders its starter content
 * tiles, so appending a new tile must materialize those first — otherwise the
 * first save would shadow them (saved tiles take precedence over content).
 */
export function effectiveDashboardModel(state: Record<string, any> | undefined): DashboardModel {
  const hasSavedTiles = Array.isArray(state?.tiles) && state!.tiles.length > 0;
  const content = state?.content;
  if (!hasSavedTiles && content?.kind === 'kql-dashboard' && Array.isArray(content.tiles)) {
    return sanitizeModel({
      tiles: content.tiles.map((t: any) => ({ title: t?.title, kql: t?.kql, viz: vizFromContent(t?.viz) })),
      dataSources: state?.dataSources,
      parameters: state?.parameters,
      baseQueries: state?.baseQueries ?? content?.baseQueries,
      timeRange: state?.timeRange,
      autoRefreshMs: state?.autoRefreshMs,
    });
  }
  return sanitizeModel({
    tiles: state?.tiles,
    dataSources: state?.dataSources,
    parameters: state?.parameters,
    baseQueries: state?.baseQueries,
    timeRange: state?.timeRange,
    autoRefreshMs: state?.autoRefreshMs,
  });
}

export interface NewTileInput {
  title: string;
  kql: string;
  viz: TileViz;
  w: number;
  h: number;
}

/**
 * Append a tile to a dashboard model, binding it to a data source that
 * resolves `database`: an existing source with the same database (and no
 * cluster override) is reused, else a new one is added. Returns the NEXT model
 * (sanitized) — the caller persists its fields onto the item state.
 */
export function withAppendedTile(
  model: DashboardModel,
  tile: NewTileInput,
  database: string,
): DashboardModel {
  const dataSources = [...model.dataSources];
  let ds = dataSources.find((d) => d.database === database && !d.clusterUri);
  if (!ds) {
    ds = { id: genId(), name: database, database };
    dataSources.push(ds);
  }
  const nextTile: DashboardTile = {
    title: tile.title,
    kql: tile.kql,
    viz: tile.viz,
    dataSourceId: ds.id,
    w: tile.w,
    h: tile.h,
  };
  return sanitizeModel({ ...model, dataSources, tiles: [...model.tiles, nextTile] });
}

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* noop */ }
  return 'ds-' + Math.random().toString(36).slice(2, 10);
}

// ───────────────────────────────────────────────────────────────────────────
// Wizard state machine (client side) — pure, so the step gating is testable.
// ───────────────────────────────────────────────────────────────────────────

export type ConversionWizardStep = 'target' | 'visual' | 'details' | 'review';

export const CONVERSION_WIZARD_STEPS: ConversionWizardStep[] = ['target', 'visual', 'details', 'review'];

export const CONVERSION_STEP_LABELS: Record<ConversionWizardStep, string> = {
  target: 'Target dashboard',
  visual: 'Visual type',
  details: 'Title & size',
  review: 'Review & create',
};

export interface ConversionWizardState {
  /** '__new__' → create a new dashboard; else an existing kql-dashboard item id. */
  dashboardId: string;
  /** Name for the new dashboard (target = '__new__' only). */
  newDashboardName: string;
  viz: TileViz;
  title: string;
  size: TileSizeKey;
  kql: string;
}

/** Fresh wizard state seeded from the editor's current query + item name. */
export function initialConversionState(kql: string, sourceName: string): ConversionWizardState {
  return {
    dashboardId: '__new__',
    newDashboardName: sourceName ? `${sourceName} dashboard` : '',
    viz: 'table',
    title: '',
    size: 'medium',
    kql,
  };
}

/**
 * Per-step gate for the wizard's Next/Create button. Returns `ok:false` with a
 * user-facing reason when the step's required inputs are missing/invalid.
 */
export function canAdvance(
  step: ConversionWizardStep,
  state: ConversionWizardState,
): { ok: true } | { ok: false; reason: string } {
  switch (step) {
    case 'target': {
      if (!state.dashboardId) return { ok: false, reason: 'Pick a target dashboard.' };
      if (state.dashboardId === '__new__' && !state.newDashboardName.trim()) {
        return { ok: false, reason: 'Name the new dashboard.' };
      }
      return { ok: true };
    }
    case 'visual':
      return isValidTileViz(state.viz) ? { ok: true } : { ok: false, reason: 'Pick a visual type.' };
    case 'details':
      return state.title.trim() ? { ok: true } : { ok: false, reason: 'Give the tile a title.' };
    case 'review': {
      const q = checkTileKql(state.kql);
      return q.ok ? { ok: true } : { ok: false, reason: q.error };
    }
    default:
      return { ok: true };
  }
}

/** The step after `step` (or null on the last step). */
export function nextConversionStep(step: ConversionWizardStep): ConversionWizardStep | null {
  const i = CONVERSION_WIZARD_STEPS.indexOf(step);
  return i >= 0 && i < CONVERSION_WIZARD_STEPS.length - 1 ? CONVERSION_WIZARD_STEPS[i + 1] : null;
}

/** The step before `step` (or null on the first step). */
export function prevConversionStep(step: ConversionWizardStep): ConversionWizardStep | null {
  const i = CONVERSION_WIZARD_STEPS.indexOf(step);
  return i > 0 ? CONVERSION_WIZARD_STEPS[i - 1] : null;
}
