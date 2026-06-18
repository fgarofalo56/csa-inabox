/**
 * Loom-native dashboard model — the visual builder's spec + synthesizer.
 *
 * The Organizational Visuals "New visual" builder produces a {@link DashboardSpec}:
 * a name, a category, a Loom theme accent, and a list of {@link DashboardTile}s.
 * Each tile binds ONE Azure-native data source (Cost Management / Azure Resource
 * Graph / Defender / Log Analytics — see `report-render/live-bindings` →
 * BUILDER_SOURCES) to ONE visualization type (KPI card / bar / line / donut /
 * table), with a chosen category + value field.
 *
 * A Loom-native dashboard is NOT a Power BI report and needs NO Power BI / Fabric
 * workspace. It reuses the existing CoE render machinery: {@link synthReportModel}
 * turns the spec into the SAME {@link ReportModel} the <ReportCanvas> already
 * renders, and {@link synthSampleData} turns resolved-source `{columns, rows}`
 * into the SAME {@link SampleData} shape — so a builder dashboard renders with the
 * identical tile chrome, SVG charts, and live/sample/gate provenance dots as the
 * CoE templates, with zero new rendering code.
 *
 * Pure + dependency-free (runs in the builder for live preview AND server-side
 * for persisted renders). No Microsoft Fabric / Power BI service is contacted.
 */

import type { Page, ReportModel, Visual } from '../report-render/pbir-parse';
import type { SampleData, SampleTable } from '../report-render/tmdl-sample';

/** The visualization types the builder offers (each maps to a real renderer). */
export type TileVisual = 'kpi' | 'bar' | 'line' | 'donut' | 'table';

/** Map a builder tile visual to the PBIR visualType the renderer already knows. */
const VISUAL_TYPE: Record<TileVisual, string> = {
  kpi: 'card',
  bar: 'clusteredColumnChart',
  line: 'lineChart',
  donut: 'donutChart',
  table: 'tableEx',
};

export const TILE_VISUALS: { id: TileVisual; label: string }[] = [
  { id: 'kpi', label: 'KPI card' },
  { id: 'bar', label: 'Bar chart' },
  { id: 'line', label: 'Line chart' },
  { id: 'donut', label: 'Donut chart' },
  { id: 'table', label: 'Table' },
];

/** A single tile in a Loom-native dashboard. */
export interface DashboardTile {
  /** Stable id within the dashboard (also the synthesized visual + entity id). */
  id: string;
  /** Tile title (rendered in the tile header). */
  title: string;
  /** Visualization type. */
  visual: TileVisual;
  /** BUILDER_SOURCES source id this tile binds to (the Azure-native data plane). */
  sourceId: string;
  /** Category / axis / group-by column (charts + table). Ignored by KPI. */
  category?: string;
  /** Value / measure column. */
  value: string;
}

/** Loom theme accents (Loom tokens) selectable for a dashboard. */
export type DashboardAccent = 'brand' | 'finops' | 'security' | 'inventory' | 'identity' | 'data' | 'ops';

/** The persisted spec a builder dashboard saves. */
export interface DashboardSpec {
  /** Schema version for forward-compat. */
  schemaVersion: 1;
  name: string;
  description?: string;
  /** Category label (groups the dashboard with the CoE template categories). */
  category: string;
  accent: DashboardAccent;
  tiles: DashboardTile[];
}

export const DASHBOARD_CATEGORIES = [
  'Adoption & Maturity', 'FinOps', 'Security & Compliance', 'Inventory & Optimization',
  'Identity & Access', 'Data Governance', 'Operations', 'Platform & Governance',
] as const;

/**
 * Client-safe metadata for the selectable Azure-native data sources.
 *
 * MUST stay in sync with BUILDER_SOURCES in report-render/live-bindings.ts
 * (that module is server-only — it imports @azure/identity — so the builder UI
 * can't import it). A unit test asserts the two lists match by id + columns.
 */
export interface BuilderSourceMeta {
  id: string;
  label: string;
  description: string;
  plane: string;
  requiredRole: string;
  columns: string[];
  defaultCategory: string;
  defaultValue: string;
}

export const BUILDER_SOURCE_META: BuilderSourceMeta[] = [
  {
    id: 'cost-by-service',
    label: 'Cost by service (month-to-date)',
    description: 'Amortized month-to-date spend grouped by Azure service across your subscriptions.',
    plane: 'Cost Management',
    requiredRole: 'Cost Management Reader',
    columns: ['UsageDate', 'SubscriptionName', 'ResourceGroup', 'ServiceName', 'CostCenterTag', 'PreTaxCost'],
    defaultCategory: 'ServiceName',
    defaultValue: 'PreTaxCost',
  },
  {
    id: 'budgets',
    label: 'Consumption budgets',
    description: 'Monthly Azure Consumption budgets by subscription.',
    plane: 'Cost Management',
    requiredRole: 'Cost Management Reader',
    columns: ['SubscriptionName', 'MonthlyBudget'],
    defaultCategory: 'SubscriptionName',
    defaultValue: 'MonthlyBudget',
  },
  {
    id: 'resource-inventory',
    label: 'Resource inventory',
    description: 'Estate inventory from Azure Resource Graph, summarized by type, region and subscription.',
    plane: 'Azure Resource Graph',
    requiredRole: 'Reader (subscription/MG)',
    columns: ['ResourceType', 'Location', 'SubscriptionName', 'Environment', 'HasOwnerTag', 'ResourceCount'],
    defaultCategory: 'ResourceType',
    defaultValue: 'ResourceCount',
  },
  {
    id: 'role-assignments',
    label: 'RBAC role assignments',
    description: 'Azure RBAC role-assignment counts by role and principal type (authorizationresources).',
    plane: 'Azure Resource Graph',
    requiredRole: 'Reader (subscription/MG)',
    columns: ['RoleName', 'Scope', 'PrincipalType', 'IsPrivileged', 'AssignmentCount'],
    defaultCategory: 'RoleName',
    defaultValue: 'AssignmentCount',
  },
  {
    id: 'secure-score',
    label: 'Defender secure score',
    description: 'Microsoft Defender for Cloud secure score (current / max / percentage).',
    plane: 'Defender for Cloud',
    requiredRole: 'Security Reader',
    columns: ['SubscriptionName', 'CurrentScore', 'MaxScore', 'Percentage'],
    defaultCategory: 'SubscriptionName',
    defaultValue: 'Percentage',
  },
  {
    id: 'adoption-mau',
    label: 'CSA Loom monthly active users',
    description: 'Monthly active CSA Loom users from Log Analytics (AppTraces loom-audit telemetry).',
    plane: 'Log Analytics',
    requiredRole: 'Log Analytics Reader',
    columns: ['Service', 'Month', 'MonthlyActiveUsers', 'WorkloadsOnboarded'],
    defaultCategory: 'Month',
    defaultValue: 'MonthlyActiveUsers',
  },
];

export function getSourceMeta(id: string): BuilderSourceMeta | undefined {
  return BUILDER_SOURCE_META.find((s) => s.id === id);
}

/** Empty tile factory (used by the builder to seed a new tile). */
export function newTile(seed: Partial<DashboardTile> = {}): DashboardTile {
  return {
    id: seed.id || `tile-${Math.random().toString(36).slice(2, 9)}`,
    title: seed.title || 'New tile',
    visual: seed.visual || 'kpi',
    sourceId: seed.sourceId || '',
    category: seed.category,
    value: seed.value || '',
  };
}

export function newDashboardSpec(): DashboardSpec {
  return {
    schemaVersion: 1,
    name: '',
    description: '',
    category: 'FinOps',
    accent: 'brand',
    tiles: [],
  };
}

// ---------------------------------------------------------------------------
// Layout — a simple responsive grid on the same 1280×720 canvas the CoE
// renderer uses, so synthesized tiles place exactly like template visuals.
// ---------------------------------------------------------------------------

const CANVAS_W = 1280;
const CANVAS_H = 720;
const COLS = 3;
const GUTTER = 16;
const PAD = 16;

/** Compute the x/y/w/h for tile `i` of `n` on the canvas (KPIs get a short row). */
function tileBox(i: number, tile: DashboardTile): { x: number; y: number; w: number; h: number } {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const cellW = (CANVAS_W - PAD * 2 - GUTTER * (COLS - 1)) / COLS;
  // KPI cards are short; charts/tables are taller.
  const unitH = tile.visual === 'kpi' ? 150 : 280;
  const x = PAD + col * (cellW + GUTTER);
  const y = PAD + row * (unitH + GUTTER);
  return { x, y, w: cellW, h: unitH };
}

/**
 * Synthesize the {@link ReportModel} for a dashboard spec. Each tile becomes one
 * {@link Visual} projecting its `value` (as a measure-like field) and, for
 * non-KPI tiles, its `category` (as the axis), keyed to a per-tile entity named
 * by the tile id — which {@link synthSampleData} fills from the resolved source.
 */
export function synthReportModel(spec: DashboardSpec): ReportModel {
  const visuals: Visual[] = spec.tiles.map((tile, i) => {
    const box = tileBox(i, tile);
    const entity = tile.id;
    const roles: Record<string, Visual['roles'][string]> = {};
    const valueField = { entity, property: tile.value || 'Value', kind: 'measure' as const, queryRef: `${entity}.${tile.value}` };
    if (tile.visual === 'kpi') {
      roles.Values = [valueField];
    } else if (tile.visual === 'table') {
      // Table projects category + value columns.
      const fields = [] as Visual['roles'][string];
      if (tile.category) fields.push({ entity, property: tile.category, kind: 'column' as const, queryRef: `${entity}.${tile.category}` });
      fields.push(valueField);
      roles.Values = fields;
    } else {
      roles.Category = [{ entity, property: tile.category || 'Category', kind: 'column' as const, queryRef: `${entity}.${tile.category}` }];
      roles.Y = [valueField];
    }
    return {
      id: tile.id,
      type: VISUAL_TYPE[tile.visual],
      x: box.x, y: box.y, z: i, w: box.w, h: box.h,
      title: tile.title,
      roles,
    };
  });

  // Grow the page height to fit the rows actually used.
  const rows = Math.max(1, Math.ceil(spec.tiles.length / COLS));
  const tallest = spec.tiles.some((t) => t.visual !== 'kpi');
  const unitH = tallest ? 280 : 150;
  const height = Math.max(CANVAS_H, PAD * 2 + rows * (unitH + GUTTER));

  const page: Page = {
    name: 'dashboard',
    displayName: spec.name || 'Dashboard',
    width: CANVAS_W,
    height,
    visuals,
  };
  return { pages: [page] };
}

/**
 * Build the {@link SampleData} for a dashboard render from per-tile resolved
 * tables. `tableBySource[sourceId]` is the resolved {columns, rows} (live or the
 * source's bundled fallback). Each tile gets its own entity (keyed by tile id)
 * pointing at its source's table, so two tiles on the same source render
 * independently. Tiles whose source has no resolved table get an empty table.
 */
export function synthSampleData(
  spec: DashboardSpec,
  tableBySource: Record<string, SampleTable | undefined>,
): SampleData {
  const out: SampleData = {};
  for (const tile of spec.tiles) {
    const t = tableBySource[tile.sourceId];
    out[tile.id] = t || { columns: [], rows: [] };
  }
  return out;
}

/** Map a builder accent to a Fluent `Badge` color (Loom tokens). */
export function accentBadgeColor(accent: DashboardAccent): 'brand' | 'danger' | 'success' | 'important' | 'warning' | 'severe' | 'informative' {
  switch (accent) {
    case 'finops': return 'informative';
    case 'security': return 'danger';
    case 'inventory': return 'success';
    case 'identity': return 'important';
    case 'data': return 'severe';
    case 'ops': return 'warning';
    default: return 'brand';
  }
}

/** Validate a spec before save; returns an error string or null when valid. */
export function validateSpec(spec: DashboardSpec): string | null {
  if (!spec.name.trim()) return 'Give the dashboard a name.';
  if (!spec.tiles.length) return 'Add at least one tile.';
  for (const t of spec.tiles) {
    if (!t.title.trim()) return 'Every tile needs a title.';
    if (!t.sourceId) return `Tile “${t.title}” needs a data source.`;
    if (!t.value) return `Tile “${t.title}” needs a value field.`;
    if (t.visual !== 'kpi' && !t.category) return `Tile “${t.title}” needs a category field.`;
  }
  return null;
}
