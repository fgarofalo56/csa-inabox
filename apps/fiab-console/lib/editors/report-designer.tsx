'use client';

/**
 * ReportDesigner — the Loom-native interactive REPORT DESIGNER.
 *
 * Power BI report-authoring parity, Azure-native (no-fabric-dependency.md): the
 * default report editor is no longer a read-only viewer. You can CREATE and
 * design a report end-to-end against the bound Azure Analysis Services tabular
 * model — NO Power BI / Fabric workspace required.
 *
 * Layout mirrors the Power BI report canvas (ui-parity.md), Loom-themed:
 *   ├─ left   : Pages list  (add / rename / delete / select a page)
 *   ├─ center : report CANVAS — a grid of visuals; add via a visual-type
 *   │           gallery; select to edit; remove; resize (span) + reorder
 *   └─ right  : Visualizations + Fields pane — pick a visual type, drag/assign
 *               model columns & measures into wells (Axis/Category, Values,
 *               Legend), choose an aggregation (Sum/Avg/Count/Min/Max)
 *
 * Every visual LIVE-RENDERS real rows by POSTing its field wells to
 * /api/items/report/[id]/query (DAX SUMMARIZECOLUMNS over the AAS model — real
 * backend, no mock). Save persists the whole definition via PUT
 * /api/items/report/[id]/definition. The Fields tree is loaded from
 * /api/items/report/[id]/fields (real TMSCHEMA Discover). When no AAS model is
 * bound the surface still renders, with an honest Fluent gate naming the exact
 * binding to set (no-vaporware.md).
 *
 * no-freeform-config.md: visual type, fields, and aggregations are all
 * pickers / wells — there is never a typed-DAX or JSON box.
 *
 * The Power BI embed path (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi → ReportLikeEditor)
 * is untouched; this is strictly the Azure-native default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge, Button, Caption1, Dropdown, Option, Divider, Input, Field, Radio, RadioGroup,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader, MenuDivider,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Spinner, Subtitle2, Text, Title3, Tooltip,
  Tree, TreeItem, TreeItemLayout, TabList, Tab,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  Slider, Checkbox,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Save20Regular, ArrowSync20Regular, Edit20Regular,
  DataBarVerticalRegular, Table20Regular, NumberSymbol20Regular,
  Filter20Regular, Dismiss16Regular, Sparkle20Regular,
  Database20Regular, CloudArrowUp20Regular, ColorRegular,
  Copy20Regular, Options20Regular, DataTrending20Regular, Eye16Regular, EyeOff16Regular,
  Info16Regular,
  // ── wave-2 additions ─────────────────────────────────────────────────────────
  Map20Regular, Play20Regular, Pause20Regular,
  Layer20Regular, LockClosed20Regular, LockOpen20Regular,
  Group20Regular, GroupDismiss20Regular,
  PositionToFront20Regular, PositionToBack20Regular,
  ArrowUndo20Regular, ArrowRedo20Regular, ArrowExpand20Regular,
  Bookmark20Regular, BookmarkAdd20Regular, BookmarkMultiple20Regular,
  Eye20Regular, EyeOff20Regular, Checkmark20Regular, ArrowExit20Regular,
  // ── wave-3 additions (AI-visual gallery + View tab) ──────────────────────────
  Question20Regular, DataTreemap20Regular,
  // ── wave-4 additions (free-form canvas + redesigned visual gallery) ──────────
  // Per-visual-type gallery glyphs (PBI Visualizations pane parity) + canvas zoom +
  // align/distribute + snap/grid toggles. Each is a distinct, dark-legible Fluent
  // glyph so every visual type reads at a glance like the real PBI picker.
  TextNumberFormat20Regular, TextBulletListSquare20Regular, Gauge20Regular,
  DataBarVertical20Regular, DataBarHorizontal20Regular, DataLine20Regular, DataArea20Regular,
  DataPie20Regular, DataScatter20Regular, DataWaterfall20Regular, DataFunnel20Regular,
  DataHistogram20Regular, DataUsage20Regular, ChartMultiple20Regular, RibbonStar20Regular,
  AlignLeft20Regular, AlignCenterHorizontal20Regular, AlignRight20Regular,
  AlignTop20Regular, AlignCenterVertical20Regular, AlignBottom20Regular,
  AlignSpaceEvenlyHorizontal20Regular, AlignSpaceEvenlyVertical20Regular,
  Grid20Regular, GridDots20Regular,
  // ── wave-4 additions (R/Python script visuals) ───────────────────────────────
  // PBI ships SEPARATE Python + R visual glyphs in the Visualizations pane; mirror
  // that with two distinct dark-legible Fluent glyphs (Code = Python, Braces = R).
  Code20Regular, BracesVariable20Regular,
} from '@fluentui/react-icons';
import type { CSSProperties, ReactElement } from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ItemEditorChrome } from './item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import {
  LoomChart, type LoomChartType,
  type ChartErrorBar, type ChartForecast, type ChartSymmetry,
} from '@/lib/components/charts/loom-chart';
// ── Wave-6 Format-pane parity ACTIVATION SEAM (owned HERE). The Wave-6 Format
//    controls are translated into REAL LoomChart props + row transforms + axis
//    titles by `formatToChartProps` (lib/components/charts/loom-chart-format),
//    and the title / subtitle / header-icons / axis-titles / card frame are
//    painted AROUND the chart by `VisualChrome` (./report/visual-chrome). Both
//    are pure passthroughs until a Wave-6 control is set, so wiring them is the
//    single additive, default-off line the wave needs — and the default render
//    stays byte-identical (no regression to waves 0-5). This is the ONE seam the
//    parallel Wave-6 modules (loom-chart-format.ts / visual-chrome.tsx) require
//    to stop being dormant; loom-chart.tsx itself is NOT edited.
import { formatToChartProps, type ChartAdapterContext } from '@/lib/components/charts/loom-chart-format';
import { VisualChrome } from './report/visual-chrome';
import { ReportPowerBiCopilot, type CopilotVisualSpec, type CopilotWellField } from '@/lib/components/report/report-powerbi-copilot';
import { DataSourcePicker } from './report/data-source-picker';
import { FormatPane, type ReportVisualFormat, formatValue, LOOM_DATA_PALETTE } from './report/format-pane';
// Wave-1 parity panels (extracted, self-contained): the Filters pane (3-scope
// structured filters + Top N / relative date / lock-hide), the Analytics pane
// (structured reference lines), the Conditional-formatting painters, and the
// Visual-interactions editor + cross-filter/highlight engine. report-designer
// MOUNTS these — the canonical implementations live in ./report/*.
import {
  FiltersPane, fieldOptions, reFilters, wireFilters, applyFilters,
  parseFilterPaneFormat, wireFilterPaneFormat,
  type ReportFilter, type FieldOpt, type FilterPaneFormat,
} from './report/filters-pane';
import {
  AnalyticsPane, computeReferenceLines, computeErrorBars, computeForecast, computeSymmetry,
  seriesNamesFromRows, parseAnalytics,
  CARTESIAN_VISUAL_TYPES,
  type ReportAnalytics,
} from './report/analytics-pane';
import { applyConditionalFormat } from './report/conditional-format';
import {
  InteractionsEditor, resolveInteraction, applySelection, selectionFromRow,
  parseInteractions, wireInteractions,
  type PageInteractions, type InteractionMode, type VisualSelection,
} from './report/interactions';
import {
  type ReportDataSource, isBound, describeSource, fromLegacyState, parseDataSource,
} from './report/report-data-source';
// Wave-4 ABSOLUTE free-form canvas (Power BI Desktop parity): the page is a
// fixed-aspect sheet and every visual owns a px rect {x,y,w,h,z}. FreeFormCanvas
// is the drag/resize/snap/guide/marquee engine; the pure absolute math (migrate
// from the legacy 12-col flow, align, distribute, z-order) lives in the same
// use-canvas-layout module the wave-0..2 grid used.
import { FreeFormCanvas } from './report/free-form-canvas';
import {
  type AbsRect, type AlignEdge, type DistributeAxis,
  migrateFlowToAbsolute, absAlign, absDistribute, reorderZ as absReorderZ,
  reorderZStep as absReorderZStep, defaultElementLayout,
} from './report/use-canvas-layout';
// ── Wave-7 free-form CANVAS ELEMENTS (text / image / shape / button / page +
//    bookmark navigators) — Power BI "Insert" objects. The element registry
//    (model + parse/wire helpers + the Insert gallery + the per-kind property
//    pane + the node body/chrome renderers + tokenToSpec) lives in the SIBLING
//    ./report/canvas-elements module so THIS host stays thin: report-designer
//    only wires elements onto the page (DPage.elements), MERGES them into the
//    SAME FreeFormCanvas node array + z-space as data visuals, persists them
//    ADDITIVELY via /definition (page.elements — the route's sanitizeElements is
//    the security/structure gate), and resolves REAL data-bound tokens through
//    the shared /query (queryAdHoc). Pure client + the existing /query +
//    /definition — zero Fabric / Power BI hosts (no-fabric-dependency). ───────
import {
  type CanvasElement, type ElementKind, type FieldToken, type ButtonAction,
  ElementsGallery, ElementProperties,
  parseElements, wireElements, newElement, renderElement, renderElementChrome, tokenToSpec,
} from './report/canvas-elements';
// Wave-2 right-rail panes (extracted, self-contained, PBI-parity). These are the
// canonical Bookmarks + Selection panes — report-designer MOUNTS them (the model
// matches the /definition route's bookmark sanitizer). The previously-inline
// duplicate panes + flat bookmark model were removed; everything below consumes
// these imports (capture / apply are the pure helpers; the panes own their UI).
import {
  BookmarksPane, parseBookmarks, wireBookmarks,
  captureBookmark as captureBookmarkState, applyBookmark as bookmarkToPatch, newBookmark,
  type ReportBookmark, type BookmarkScope, type BookmarkApply, type BookmarkCaptureSource,
} from './report/bookmarks-pane';
import { SelectionPane } from './report/selection-pane';
// ── Wave-3 parity surfaces (extracted, self-contained) ───────────────────────
// Themes (built-in + custom + PBI-theme-JSON import/export), the viewer-side
// Personalize overlay (per-user, never persisted), the dependency-free + server
// Export menu, and the four real AI visuals (smart narrative / Q&A over AOAI;
// decomposition tree / key influencers over REAL /query SQL). report-designer
// MOUNTS these — the canonical implementations live in ./report/* and
// ./report/ai-visuals/*. Theme model + helpers come from ./report/themes; the
// ThemesPane authoring surface from ./report/themes-pane (its structurally-
// compatible ReportTheme assigns both ways).
import {
  sanitizeTheme, themeChartProps, applyThemeCssVars,
  type ReportTheme, type ThemeChartProps,
} from './report/themes';
import { ThemesPane } from './report/themes-pane';
import {
  usePersonalize, PersonalizeBanner, PersonalizePopover,
  type DVisual as PersonalizeVisual,
} from './report/personalize';
import {
  ExportMenu, printReport, pngOfElement, buildReportPrintHtml, downloadBlobObject, slugify,
  type ExportFormat, type ExportScope, type PrintPage,
} from './report/export-report';
import { SmartNarrative, type SmartNarrativeVisualRows } from './report/ai-visuals/smart-narrative';
import { ReportQA } from './report/ai-visuals/qa';
import { DecompositionTree } from './report/ai-visuals/decomposition-tree';
import { KeyInfluencers } from './report/ai-visuals/key-influencers';
// Wave-4 R/Python SCRIPT VISUAL (Power BI parity). The editor is a code editor +
// language toggle (PBI's R/Python visual IS a code editor — EXEMPT from
// no-freeform-config exactly like the ADF expression builder); Run posts the real
// /query rows + the script to a sandboxed Azure Container Apps executor (app.py)
// and renders the returned PNG. The component owns its own surface; report-designer
// just mounts it as one more DVisual (absolute layout, positioned by FreeFormCanvas
// like any visual). Azure-native (ACA + the existing Synapse /query) — no Fabric.
import { ScriptVisual } from './report/script-visual';
import { MapVisual } from './report/map-visual';
// Wave-5: the Power BI Slicer surface. Until now this component was ORPHANED —
// nothing imported it, and the slicer branch below rendered a bare single-select
// <Dropdown> that only emitted a one-value `eq` via the visual-selection channel.
// It is now THE slicer body: List / Dropdown / Tile / Between / Before / After /
// Relative-date / Date-range, each emitting a structured ReportFilter the host
// merges into the page-filters channel that feeds applyFilters. `slicerFilterId`
// is the deterministic per-field id (slc_<table>_<col>) the host uses to (a) find
// the slicer's current filter for re-hydrate, (b) replace/remove it on emit, and
// (c) exclude it from the slicer's OWN query so its value list never self-collapses.
import { SlicerVisual, slicerFilterId, type SlicerStyle } from './report/slicer-visual';
import type { ReportFilterInput } from '@/lib/azure/wells-to-sql';

// ── Model ───────────────────────────────────────────────────────────────────

/**
 * Visual types. The first 11 are the shipped vocabulary; the 8 gallery additions
 * (combo / waterfall / funnel / gauge / kpi / treemap / multiRowCard / ribbon)
 * are Power BI-parity entries. Each renders REAL aggregated rows through the same
 * /query + wells-to-sql path (no new backend route). Wave-5 gives every one its
 * TRUE geometry through LoomChart — dual-axis line+column (combo), rank-connector
 * ribbons, running-total waterfall, trapezoid funnel, squarified treemap, and a
 * radial gauge / indicator KPI — so there is no approximate-shape-with-a-caption
 * (no-vaporware.md). multiRowCard draws its own card-list surface; card stays a
 * single-number tile.
 */
type VisualType =
  | 'table' | 'matrix' | 'card' | 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'slicer'
  | 'combo' | 'waterfall' | 'funnel' | 'gauge' | 'kpi' | 'treemap' | 'multiRowCard' | 'ribbon'
  // ── wave-2 gallery addition ──────────────────────────────────────────────────
  | 'map'
  // ── wave-3 AI visuals (each REAL — AOAI smart-narrative/Q&A, real /query SQL
  //    decomposition-tree/key-influencers; rendered by ./report/ai-visuals/*) ────
  | 'decompositionTree' | 'keyInfluencers' | 'smartNarrative' | 'qna'
  // ── wave-4 R/Python script visual (REAL sandboxed ACA executor; ./report/script-visual) ──
  | 'scriptVisual';

type Agg = 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max';
const AGGS: Agg[] = ['Sum', 'Avg', 'Count', 'Min', 'Max'];

/**
 * Field-well names. category/values/legend are the base wells the /query route
 * compiles directly; the rest are the wave-1 additive wells (their persisted
 * names match the /definition route's EXTRA_WELL_NAMES exactly). queryVisual()
 * FOLDS the additive wells into the base three before each query.
 */
type WellName =
  | 'category' | 'values' | 'legend'
  | 'secondaryValues' | 'target' | 'minimum' | 'maximum' | 'smallMultiples' | 'tooltips' | 'details'
  // ── wave-2 additive wells ────────────────────────────────────────────────────
  // size      → scatter→bubble radius (3rd plotted measure) / map bubble size
  // playAxis  → scatter Play-axis frame dimension (an extra grouped category)
  // latitude/longitude → map location wells (grouped category; render is gated)
  | 'size' | 'playAxis' | 'latitude' | 'longitude';

interface WellField {
  uid: string;
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: Agg;
}
interface Wells {
  category: WellField[];
  values: WellField[];
  legend: WellField[];
  // ── additive wells (all optional) ───────────────────────────────────────────
  secondaryValues?: WellField[]; // combo: the line series (plotted)
  target?: WellField[];          // gauge / kpi (plotted as a caption)
  minimum?: WellField[];         // gauge / kpi (plotted as a caption)
  maximum?: WellField[];         // gauge / kpi (plotted as a caption)
  smallMultiples?: WellField[];  // charts: trellis group (persisted; NOT plotted yet — Wave 2)
  tooltips?: WellField[];        // charts: hover-only measures (persisted; NEVER plotted — Wave 2 hover)
  details?: WellField[];         // treemap: detail sub-group (persisted; NOT plotted yet — Wave 2)
  // ── wave-2 additive wells (all optional) ─────────────────────────────────────
  size?: WellField[];            // scatter→bubble radius / map size (folded into plotted values)
  playAxis?: WellField[];        // scatter Play-axis frame field (folded as an extra category)
  latitude?: WellField[];        // map latitude (folded as a category; render gated)
  longitude?: WellField[];       // map longitude (folded as a category; render gated)
}

/** PBI canvas page type (16:9 / 4:3 / Letter / Tooltip / Custom). */
type CanvasType = '16:9' | '4:3' | 'letter' | 'tooltip' | 'custom';

/** Canvas page px dimensions per PBI page type (default 16:9 1280×720 — the real
 *  Power BI Desktop default report-page size). The free-form canvas letter-boxes
 *  + scales this sheet to fit; visuals live at absolute px inside it. */
const PAGE_DIMS: Record<CanvasType, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 960, height: 720 },
  letter: { width: 1056, height: 816 },
  tooltip: { width: 320, height: 240 },
  custom: { width: 1280, height: 720 },
};
/** Resolve a page's canvas px size from its type / explicit custom size. */
function pageDims(p?: { canvasType?: CanvasType; size?: { width?: number; height?: number } }): { width: number; height: number } {
  if (p?.size?.width && p?.size?.height) return { width: p.size.width, height: p.size.height };
  return PAGE_DIMS[p?.canvasType || '16:9'] || PAGE_DIMS['16:9'];
}

interface DVisual {
  id: string;
  type: VisualType;
  title: string;
  wells: Wells;
  /** column span on a 12-col canvas grid + a row-height hint (LEGACY flow layout —
   *  kept for back-compat reads + the Size S/M/L buttons; the free-form canvas
   *  positions by `layout` below, migrated from these on first load). */
  w: number;
  h: number;
  /** ABSOLUTE free-form rect {x,y,w,h,z} in page px (Power BI Desktop canvas).
   *  The single source of truth for position/size on the wave-4 canvas; migrated
   *  from the legacy grid `w/h` on load and persisted to config.layout (unit:px). */
  layout?: AbsRect;
  /** Structured visual formatting (FormatPane → visual.config.format). */
  format?: ReportVisualFormat;
  /** Structured analytics reference lines (AnalyticsPane → visual.config.analytics). */
  analytics?: ReportAnalytics;
  /** Filters scoped to this visual only. */
  filters?: ReportFilter[];
  // ── wave-2 canvas/object state (Selection pane + Arrange toolbar) ─────────────
  /** Hidden from the report (Selection pane eye-toggle). Faded + skipped in render. */
  hidden?: boolean;
  /** Locked: drag/resize disabled on the canvas (Arrange → Lock). */
  locked?: boolean;
  /** Z-order index (Arrange → bring to front / send to back). Mirrors list order. */
  z?: number;
  /** Group id (Arrange → Group). Members select + arrange together. */
  groupId?: string;
  // ── wave-4 R/Python script visual state ──────────────────────────────────────
  /** Script-visual config: the chosen language + the user's script text. Persisted
   *  ADDITIVELY under config.{language,script} (like the wave-2 hidden/locked keys)
   *  so a reload reconstructs the editor; the executor reads them at Run time. Only
   *  set for type 'scriptVisual'.
   *
   *  Wave-5 slicer: `slicerStyle` is the persisted PBI slicer interaction style
   *  (List / Dropdown / Tile / Between / Before / After / Relative-date / Date-range)
   *  the SlicerVisual chooser writes. ADDITIVE (same round-trip pattern as the wave-2
   *  hidden/locked/groupId keys); only set for type 'slicer'. */
  config?: { language?: 'python' | 'r'; script?: string; slicerStyle?: SlicerStyle };
}

/** A bare field reference (no aggregation / client uid) — drillthrough + tooltip wells. */
interface WellFieldRef { table?: string; column?: string; measure?: string }

interface DPage {
  id: string;
  name: string;
  visuals: DVisual[];
  filters?: ReportFilter[];
  // ── wave-1 page options (persisted under page.config) ────────────────────────
  hidden?: boolean;
  /** Source→target visual-interaction matrix (Edit interactions). */
  interactions?: PageInteractions;
  /** Canvas page type + background (Format-page surface). */
  canvasType?: CanvasType;
  background?: { color?: string; transparency?: number };
  size?: { width?: number; height?: number };
  // ── wave-2 page options (persisted under page.config — additive) ─────────────
  /** Drillthrough TARGET fields: this page is a drillthrough destination for any
   *  source visual containing one of these fields (PBI "Drillthrough filters"). */
  drillthrough?: { fields: WellFieldRef[] };
  /** Tooltip-page binding: when enabled this page renders as a hover tooltip
   *  bound to `boundField` (PBI report-page tooltips). canvasType 'tooltip' pairs. */
  tooltipPage?: { enabled: boolean; boundField?: WellFieldRef };
  // ── wave-7 free-form ELEMENTS (text / image / shape / button / page + bookmark
  //    navigators). ADDITIVE sibling of `visuals` (NOT under config). Each element
  //    carries an absolute `layout` in the SAME px + z-space as a data visual, so
  //    paint order interleaves the two arrays. Persisted on page.elements via
  //    /definition (the route's sanitizeElements whitelists kind/layout/per-kind
  //    props + clampUrl); the loader hydrates via parseElements. The model + all
  //    element logic live in ./report/canvas-elements (this host stays thin). ──
  elements?: CanvasElement[];
}

/** A positioned node on the free-form canvas: EITHER a data visual (carrying an
 *  absolute `layout`) OR a wave-7 element (tagged `__el`). Both satisfy the
 *  canvas's generic FFVisual, so the host MERGES them into ONE `visuals` node
 *  array — paint order by the shared `layout.z` interleaves elements and visuals
 *  (a shape can sit behind chart A yet in front of chart B — PBI parity). The
 *  `__el` tag drives the render-prop + dragBody dispatch (data visuals omit it). */
type FFNode =
  | (DVisual & { layout: AbsRect; __el?: undefined })
  | { id: string; layout: AbsRect; locked?: boolean; hidden?: boolean; groupId?: string; __el: CanvasElement };

// A saved bookmark (PBI Bookmarks pane) is the rich `ReportBookmark` imported from
// ./report/bookmarks-pane (scope + Data/Display/Current-page apply toggles + a
// captured `state`: active page, report/page/visual filters, slicer/selection,
// per-visual visibility + z-order). The host captures/applies it through the pure
// helpers (captureBookmarkState / bookmarkToPatch / newBookmark) and persists it
// via /definition (state.content.bookmarks — the same shape that route sanitizes).

// ── filters ───────────────────────────────────────────────────────────────────
// The structured 3-scope Filters pane, its model (`ReportFilter`, incl. the
// wave-1 Top N / relative-date / lock-hide fields), and the pure helpers
// (`reFilters` / `wireFilters` / `applyFilters` / `fieldOptions`) are the
// canonical implementations imported above from ./report/filters-pane. The
// previously-inline copies were removed; everything below consumes the imports.

interface FieldColumn { name: string; dataType: string; summarizeBy?: string; isHidden: boolean }
interface FieldMeasure { name: string; isHidden: boolean }
interface FieldTable { name: string; columns: FieldColumn[]; measures: FieldMeasure[] }

interface VisualState { rows: Array<Record<string, unknown>>; loading: boolean; err: string | null }

// ── Visual catalogue (gallery) ───────────────────────────────────────────────

const VISUALS: { type: VisualType; label: string; icon: ReactElement; group?: 'ai'; seed?: { language: 'python' | 'r' } }[] = [
  { type: 'table',        label: 'Table',          icon: <Table20Regular /> },
  { type: 'matrix',       label: 'Matrix',         icon: <Grid20Regular /> },
  { type: 'card',         label: 'Card',           icon: <TextNumberFormat20Regular /> },
  { type: 'multiRowCard', label: 'Multi-row card', icon: <TextBulletListSquare20Regular /> },
  { type: 'kpi',          label: 'KPI',            icon: <DataTrending20Regular /> },
  { type: 'gauge',        label: 'Gauge',          icon: <Gauge20Regular /> },
  { type: 'column',       label: 'Column chart',   icon: <DataBarVertical20Regular /> },
  { type: 'bar',          label: 'Bar chart',      icon: <DataBarHorizontal20Regular /> },
  { type: 'line',         label: 'Line chart',     icon: <DataLine20Regular /> },
  { type: 'area',         label: 'Area chart',     icon: <DataArea20Regular /> },
  { type: 'combo',        label: 'Line + column',  icon: <ChartMultiple20Regular /> },
  { type: 'ribbon',       label: 'Ribbon chart',   icon: <RibbonStar20Regular /> },
  { type: 'waterfall',    label: 'Waterfall',      icon: <DataWaterfall20Regular /> },
  { type: 'funnel',       label: 'Funnel',         icon: <DataFunnel20Regular /> },
  { type: 'pie',          label: 'Pie chart',      icon: <DataPie20Regular /> },
  { type: 'donut',        label: 'Donut chart',    icon: <DataUsage20Regular /> },
  { type: 'treemap',      label: 'Treemap',        icon: <DataTreemap20Regular /> },
  { type: 'scatter',      label: 'Scatter',        icon: <DataScatter20Regular /> },
  { type: 'map',          label: 'Map',            icon: <Map20Regular /> },
  { type: 'slicer',       label: 'Slicer',         icon: <Filter20Regular /> },
  // ── wave-4 R/Python script visuals (PBI ships separate Python + R tiles; both
  //    produce type 'scriptVisual', distinguished by the `seed` language) ────────
  { type: 'scriptVisual', label: 'Python visual',  icon: <Code20Regular />,          seed: { language: 'python' } },
  { type: 'scriptVisual', label: 'R visual',       icon: <BracesVariable20Regular />, seed: { language: 'r' } },
  // ── AI visuals (real backends) ───────────────────────────────────────────────
  { type: 'smartNarrative',    label: 'Smart narrative',    icon: <Sparkle20Regular />,       group: 'ai' },
  { type: 'qna',               label: 'Q&A',                icon: <Question20Regular />,      group: 'ai' },
  { type: 'decompositionTree', label: 'Decomposition tree', icon: <DataHistogram20Regular />, group: 'ai' },
  { type: 'keyInfluencers',    label: 'Key influencers',    icon: <DataTrending20Regular />,  group: 'ai' },
];

/**
 * The wave-3 AI visual types. They are NOT folded into CHART_TYPES / KPI_TYPES —
 * each renders its own ./report/ai-visuals/* surface (VisualBody dispatch). The
 * two that drill on real SQL (decomposition tree / key influencers) SELF-QUERY via
 * the shared `queryAdHoc`, so the host's per-visual runVisual effect MUST skip them
 * (smart narrative / Q&A have no wells and never reach runVisual anyway).
 */
const AI_TYPES = new Set<VisualType>(['decompositionTree', 'keyInfluencers', 'smartNarrative', 'qna']);
/** AI visuals that issue their OWN /query calls — excluded from the host runVisual effect. */
const AI_SELF_QUERY = AI_TYPES;

/**
 * Wave-4 R/Python script visuals. NOT folded into CHART_TYPES / KPI_TYPES — each
 * renders its own ./report/script-visual surface (VisualBody dispatch). Unlike the
 * AI self-query visuals, a script visual DOES use the host's per-visual `state.rows`
 * (the Values well's REAL non-aggregated /query rows become the executor's
 * `dataset`), so it is deliberately NOT added to AI_SELF_QUERY — runVisual fetches
 * its rows like any bound visual.
 */
const SCRIPT_TYPES = new Set<VisualType>(['scriptVisual']);

/**
 * Wave-5 TRUE GEOMETRY: every chart-family visual maps to the real LoomChart
 * geometry type that draws its distinctive Power BI shape over the SAME real
 * aggregated /query rows — NO approximate-shape-with-a-caption (no-vaporware.md):
 *   • combo     → dual-axis line + column          ('combo')
 *   • ribbon    → rank-connector ribbons           ('ribbon')
 *   • waterfall → running-total floating bars       ('waterfall')
 *   • funnel    → centered trapezoid bands          ('funnel')
 *   • treemap   → squarified tiles (+ detail nest)  ('treemap')
 * bar/column/line/area/pie/donut/scatter keep their own true geometry. gauge /
 * kpi LEAVE the single-number tile and render real radial / indicator geometry
 * (see GAUGE_KPI below); multiRowCard keeps its card-list surface; card stays a
 * single-number tile.
 *
 * Values are typed `string` (not the imported {@link LoomChartType}) so this
 * file compiles independently of the loom-chart.tsx geometry extension landing
 * in the same wave; each is cast to `LoomChartType` at the call site.
 */
const CHART_RENDER: Partial<Record<VisualType, string>> = {
  bar: 'bar', column: 'column', line: 'line', area: 'area', pie: 'pie', donut: 'donut', scatter: 'scatter',
  combo: 'combo', ribbon: 'ribbon', waterfall: 'waterfall', funnel: 'funnel', treemap: 'treemap',
};
/** Visual types rendered through LoomChart. */
const CHART_TYPES = new Set<VisualType>(Object.keys(CHART_RENDER) as VisualType[]);
/**
 * Cartesian charts that can carry analytics reference lines (value axis).
 * Imported from analytics-pane so this canvas-side set (what computeReferenceLines
 * runs over) is the SAME set the Analytics pane lets a user author — no drift.
 */
const CARTESIAN_TYPES = CARTESIAN_VISUAL_TYPES;
/**
 * Single-big-number tile (card only). gauge / kpi LEFT this set in wave-5: they
 * now render true radial-arc / indicator geometry through LoomChart (GAUGE_KPI),
 * not a numeric tile (no-vaporware: real geometry, never an approximation).
 */
const KPI_TYPES = new Set<VisualType>(['card']);
/**
 * Gauge / KPI: rendered through LoomChart's real radial-arc / indicator geometry.
 * The first value result column is the value/indicator; the Target / Minimum /
 * Maximum wells fold into extra value columns and are read back by their aliases
 * to drive the needle / arc bounds / goal delta (see VisualBody GAUGE_KPI branch).
 */
const GAUGE_KPI = new Set<VisualType>(['gauge', 'kpi']);
/**
 * Visual types that drop to a compact default footprint when first added
 * (card + the KPI/gauge indicators). RENDER routing is separate (KPI_TYPES /
 * GAUGE_KPI); this only sizes the new visual's drop rect.
 */
const COMPACT_TYPES = new Set<VisualType>(['card', 'kpi', 'gauge']);

/**
 * The result-set column ALIAS a value-well field produces (lock-step with
 * wells-to-sql.aggProjection): a measure aliases to its own name; an aggregated
 * column to `<Agg> of <Column>` (defaulting to Sum). Used to read Target / Min /
 * Max / tooltip / secondary (combo line) aggregates back off the real rows by
 * the exact column name the SQL emitted.
 */
function wellResultAlias(f: WellField): string {
  return f.measure ? f.measure : `${f.aggregation || 'Sum'} of ${f.column}`;
}

/**
 * Which wells a given visual type exposes, with parity-correct labels.
 *
 * Wave-5 RE-EXPOSES the Small multiples (cartesian charts), Tooltips (charts),
 * and treemap Details wells: LoomChart now tiles a real trellis by the
 * small-multiples facet, nests treemap detail sub-partitions, and surfaces
 * tooltip-only measures in a hover popover (excluded from the plotted series).
 * queryVisual() folds them accordingly (small multiples / details ride as extra
 * GROUP columns; tooltips ride as extra aggregates that the chart plots-EXCLUDES)
 * — so every exposed well DRIVES the render (no dead controls, no-vaporware.md).
 */
function wellsFor(type: VisualType): { name: WellName; label: string }[] {
  switch (type) {
    // ── wave-4 R/Python script visual ────────────────────────────────────────
    case 'scriptVisual':
      // Power BI parity: EVERY field goes to a single Values well (no aggregation).
      // The rows are grouped + deduped and handed to the script as `dataset` whose
      // column names are the field names — so one structured Values well is correct.
      return [{ name: 'values', label: 'Values' }];
    // ── wave-3 AI visuals ────────────────────────────────────────────────────
    case 'smartNarrative':
    case 'qna':
      // No field wells: smart narrative summarizes the page's other visuals;
      // Q&A is driven by a natural-language box. Both render their own surface.
      return [];
    case 'decompositionTree':
    case 'keyInfluencers':
      // Structured wells, parity-labelled: ONE Analyze measure + N Explain-by
      // dimensions. The component self-queries real GROUP-BY SQL over these.
      return [
        { name: 'values', label: 'Analyze' },
        { name: 'category', label: 'Explain by' },
      ];
    case 'card':
    case 'multiRowCard':
      return [{ name: 'values', label: 'Fields' }];
    case 'slicer':
      return [{ name: 'category', label: 'Field' }];
    case 'table':
      return [{ name: 'values', label: 'Columns' }];
    case 'matrix':
      return [
        { name: 'category', label: 'Rows' },
        { name: 'legend', label: 'Columns' },
        { name: 'values', label: 'Values' },
      ];
    case 'gauge':
    case 'kpi':
      return [
        { name: 'values', label: type === 'gauge' ? 'Value' : 'Indicator' },
        { name: 'target', label: 'Target' },
        { name: 'minimum', label: 'Minimum' },
        { name: 'maximum', label: 'Maximum' },
      ];
    case 'treemap':
      return [
        { name: 'category', label: 'Group' },
        { name: 'details', label: 'Details' },
        { name: 'values', label: 'Values' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'funnel':
      return [
        { name: 'category', label: 'Category' },
        { name: 'values', label: 'Values' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'waterfall':
      return [
        { name: 'category', label: 'Category' },
        { name: 'values', label: 'Y values' },
        { name: 'legend', label: 'Breakdown' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'combo':
      return [
        { name: 'category', label: 'Shared axis' },
        { name: 'values', label: 'Column values' },
        { name: 'secondaryValues', label: 'Line values' },
        { name: 'legend', label: 'Legend' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'ribbon':
      return [
        { name: 'category', label: 'Axis' },
        { name: 'values', label: 'Values' },
        { name: 'legend', label: 'Legend' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'scatter':
      // Scatter exposes the wave-2 Size (→ bubble radius, the 3rd plotted
      // measure) and Play axis (an animated frame dimension) wells in addition
      // to Details/Values/Legend. Both DRIVE the render (no dead controls).
      return [
        { name: 'category', label: 'Details' },
        { name: 'values', label: 'X / Y values' },
        { name: 'size', label: 'Size' },
        { name: 'playAxis', label: 'Play axis' },
        { name: 'legend', label: 'Legend' },
      ];
    case 'map':
      // Azure-Maps map: Location (lat/long) + Size. Render is an honest
      // Azure-Maps gate over the REAL aggregated rows (see VisualBody) — every
      // well still produces a real grouped/aggregated query column.
      return [
        { name: 'latitude', label: 'Latitude' },
        { name: 'longitude', label: 'Longitude' },
        { name: 'category', label: 'Location' },
        { name: 'size', label: 'Size' },
        { name: 'legend', label: 'Legend' },
      ];
    default:
      // bar / column / line / area / pie / donut
      return [
        { name: 'category', label: 'Axis' },
        { name: 'values', label: 'Values' },
        { name: 'legend', label: 'Legend' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function uid(prefix = 'v'): string {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${r}`;
}
function fieldKey(f: WellField): string { return f.measure ? `m:${f.measure}` : `c:${f.table}.${f.column}`; }
function fieldLabel(f: WellField): string {
  if (f.measure) return f.measure;
  const agg = f.aggregation ? `${f.aggregation} of ` : '';
  return `${agg}${f.column}`;
}

/** Parse a stored single-`field` ('Table'[Col] / [Measure]) for back-compat. */
function parseFieldRef(field?: string): WellField | null {
  if (!field) return null;
  let m = /^'?([^'[]+?)'?\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), table: m[1].trim(), column: m[2].trim() };
  m = /^\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), measure: m[1].trim() };
  return null;
}

/** Strip a well's client-only `uid` (the wire/persist field shape). */
function stripWell(a?: WellField[]): Array<Omit<WellField, 'uid'>> {
  return (a || []).map(({ uid: _u, ...rest }) => rest);
}

/**
 * Build the wire `visual` payload the /query route understands (type + field +
 * wells). The additive wells that DRIVE the rendered visual fold into the wire
 * wells the route compiles, so every visual returns REAL aggregated SQL rows
 * with zero new route work:
 *   • secondary values / target / minimum / maximum → extra `values` aggregates
 *     (combo's line series; gauge/KPI target/min/max — each one more projection).
 *   • size → final `values` aggregate (bubble radius / map size).
 *   • TOOLTIPS → extra `values` aggregates (wave-5). They ARE returned as result
 *     columns, but LoomChart EXCLUDES them from the plotted series (the host
 *     passes their aliases as the `tooltips` prop) and shows them only in the
 *     hover popover — so a tooltip measure is never an extra bar/line.
 *   • SMALL MULTIPLES / treemap DETAILS → their OWN wire keys (wave-5). The route
 *     appends them as trailing GROUP columns after category+legend (one row per
 *     axis×facet); LoomChart splits the rows into a real trellis (small multiples)
 *     / nests a treemap detail level (details). Empty ⇒ byte-identical query.
 */
function queryVisual(v: DVisual) {
  const w = v.wells;
  // Wave-4 script visual → a NON-aggregated, row-level projection (PBI hands the
  // script a `dataset` of grouped + deduped raw rows whose column names are the
  // field names). Emitting the wire type as 'table' makes buildSqlFromVisual take
  // its raw-projection branch (deduped columns, no GROUP BY / no aggregation) over
  // ONLY the Values well — exactly the PBI contract, with zero new route work.
  if (SCRIPT_TYPES.has(v.type)) {
    const vals = stripWell(w.values || []).map((f) => ({ ...f, aggregation: undefined }));
    const first = vals[0];
    const field = first?.measure
      ? `[${first.measure}]`
      : first?.column
        ? `${first.table ? `'${first.table.replace(/'/g, "''")}'` : ''}[${first.column}]`
        : undefined;
    return { type: 'table' as VisualType, field, wells: { category: [], values: vals, legend: [] } };
  }
  // Primary group (category + the wave-2 grouped wells: playAxis frame dim + map
  // latitude/longitude). Each is a real GROUP BY column the route returns,
  // sliced/located client-side.
  const cat = stripWell([
    ...(w.category || []), ...(w.playAxis || []), ...(w.latitude || []), ...(w.longitude || []),
  ]);
  // Plotted + carried aggregates. Size folds in for the bubble radius / map size
  // measure; TOOLTIPS now fold in too (wave-5) so the route returns them as real
  // aggregate columns — LoomChart EXCLUDES them from the plotted series (via the
  // `tooltips` prop) and surfaces them only in the hover popover, so a tooltip
  // measure is never an extra bar/line. Order: values, secondary (combo line),
  // target/min/max (gauge/kpi), size, tooltips.
  const vals = stripWell([
    ...(w.values || []), ...(w.secondaryValues || []),
    ...(w.target || []), ...(w.minimum || []), ...(w.maximum || []),
    ...(w.size || []), ...(w.tooltips || []),
  ]);
  const leg = stripWell(w.legend || []);
  // Wave-5 trellis group wells. Carried as their OWN wire keys so the route
  // (wells-to-sql) appends them as trailing GROUP columns AFTER category+legend
  // — one row per axis×facet — which LoomChart splits into a real small-multiples
  // trellis (smallMultiples) / nests as a treemap detail level (details). Empty
  // for every non-trellis visual ⇒ byte-identical query to before.
  const trellisSmall = stripWell(w.smallMultiples || []);
  const trellisDetails = stripWell(w.details || []);
  const first = vals[0] || cat[0];
  const field = first?.measure
    ? `[${first.measure}]`
    : first?.column
      ? `${first.table ? `'${first.table.replace(/'/g, "''")}'` : ''}[${first.column}]`
      : undefined;
  return {
    type: v.type,
    field,
    wells: {
      category: cat, values: vals, legend: leg,
      smallMultiples: trellisSmall, details: trellisDetails,
    },
  };
}

/**
 * The FULL authoring wells (base + additive, uid-stripped) persisted via
 * /definition so a reload reconstructs the exact authoring state. Distinct from
 * {@link queryVisual} (which folds for the query); the persisted extra wells ride
 * along under their canonical names and the route only stores the non-empty ones.
 */
function wireWells(w: Wells) {
  return {
    category: stripWell(w.category),
    values: stripWell(w.values),
    legend: stripWell(w.legend),
    secondaryValues: stripWell(w.secondaryValues),
    target: stripWell(w.target),
    minimum: stripWell(w.minimum),
    maximum: stripWell(w.maximum),
    smallMultiples: stripWell(w.smallMultiples),
    tooltips: stripWell(w.tooltips),
    details: stripWell(w.details),
    size: stripWell(w.size),
    playAxis: stripWell(w.playAxis),
    latitude: stripWell(w.latitude),
    longitude: stripWell(w.longitude),
  };
}

/** True when a visual has at least one bound field (i.e. is runnable). */
function hasBinding(v: DVisual): boolean {
  const w = v.wells;
  return [
    w.category, w.values, w.legend,
    w.secondaryValues, w.target, w.minimum, w.maximum, w.smallMultiples, w.tooltips, w.details,
    w.size, w.playAxis, w.latitude, w.longitude,
  ].reduce((n, a) => n + (a?.length || 0), 0) > 0;
}

/**
 * Apply a 0–100 transparency to a (token) color via CSS color-mix so the result
 * stays a Loom token (web3-ui). 0 → the color unchanged; 100 → fully transparent.
 */
function applyAlpha(color?: string, transparency?: number): string | undefined {
  if (!color) return undefined;
  const t = Math.min(100, Math.max(0, transparency || 0));
  return t ? `color-mix(in srgb, ${color} ${100 - t}%, transparent)` : color;
}

// Persisted bookmarks (report state.content.bookmarks) are hydrated by the
// imported `parseBookmarks` from ./report/bookmarks-pane — the same sanitizer the
// pane + /definition route share (drops malformed entries, normalizes filter
// scopes, clamps names/count). No local copy.

// ── styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, minHeight: 0 },
  pageRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
  },
  pageRowActive: { backgroundColor: tokens.colorNeutralBackground1Selected, fontWeight: tokens.fontWeightSemibold },
  pageRowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  canvasWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minHeight: 0 },
  canvasGrid: { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: tokens.spacingHorizontalM },
  vcard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    position: 'relative',
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, border-color', transitionDuration: tokens.durationFaster,
    minHeight: '180px',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  vcardSel: { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow16 },
  vcardDragHandle: {
    display: 'inline-flex', alignItems: 'center', cursor: 'grab',
    color: tokens.colorNeutralForeground3, borderRadius: tokens.borderRadiusSmall,
    ':hover': { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  vcardDragging: { opacity: 0.55 },
  vcardDropBefore: { boxShadow: `inset 3px 0 0 0 ${tokens.colorBrandStroke1}, ${tokens.shadow16}` },
  vcardDropAfter: { boxShadow: `inset -3px 0 0 0 ${tokens.colorBrandStroke1}, ${tokens.shadow16}` },
  vcardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  vcardTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  vcardBody: { flex: 1, minWidth: 0, overflow: 'auto' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  // ── Visualizations gallery (PBI Visualizations pane parity) ──────────────────
  // A tidy responsive grid of visual-type tiles. Each glyph sits in a contrast
  // chip that is legible in BOTH light and dark (colorNeutralForeground1 on
  // colorNeutralBackground3); hover + selected lift to the brand accent. No
  // hard-coded colors — every value is a Loom/Fluent token (web3-ui.md).
  gallery: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(74px, 1fr))',
    gap: tokens.spacingHorizontalXS,
  },
  galleryBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
    gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1, cursor: 'pointer',
    transitionProperty: 'background-color, border-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow4,
    },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  galleryIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '40px', height: '40px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    fontSize: '22px',
  },
  galleryLabel: {
    textAlign: 'center', lineHeight: tokens.lineHeightBase200,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden', textOverflow: 'ellipsis',
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
  },
  galleryBtnActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: `0 0 0 1px ${tokens.colorBrandStroke1}`,
  },
  galleryIconActive: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  well: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXS, minHeight: '44px', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXXS, backgroundColor: tokens.colorNeutralBackground2,
  },
  wellOver: { border: `1px dashed ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  wellHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  token: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tokenName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, cursor: 'grab',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  kpi: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightHero800 },
  muted: { color: tokens.colorNeutralForeground3 },
  // Honest "approximate geometry" disclosure shown beneath a visual whose true
  // PBI shape is a Wave-2 LoomChart build (no silent wrong-geometry).
  approxNote: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3,
  },
  // Multi-row card: one elevated card per result row, field:value stacked pairs.
  cardList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  cardRow: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardField: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  // Analytics reference-line legend strip (under cartesian charts).
  refLineRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  refLineChip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  refLineDot: { width: '10px', height: '10px', borderRadius: tokens.borderRadiusCircular, flexShrink: 0 },
  // Page-format (Format-page surface) swatch row.
  pageSwatchRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  pageSwatchDot: {
    width: '20px', height: '20px', padding: 0, cursor: 'pointer',
    borderRadius: tokens.borderRadiusCircular, border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  pageSwatchActive: { border: `2px solid ${tokens.colorNeutralForeground1}`, boxShadow: tokens.shadow4 },
  filterScope: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
  },
  filterRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  filterValues: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  resizeHandle: {
    position: 'absolute', right: '2px', bottom: '2px', width: '14px', height: '14px',
    cursor: 'nwse-resize', borderRight: `2px solid ${tokens.colorNeutralStroke1}`,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`, borderBottomRightRadius: tokens.borderRadiusSmall,
    opacity: 0.5,
    ':hover': {
      opacity: 1,
      borderRight: `2px solid ${tokens.colorBrandStroke1}`,
      borderBottom: `2px solid ${tokens.colorBrandStroke1}`,
    },
  },
  // ── wave-2 canvas chrome ─────────────────────────────────────────────────────
  /** Multi-selected card (Ctrl/Shift-click) — distinct from the single-selected ring. */
  vcardMulti: { border: `1px solid ${tokens.colorBrandStroke2}`, boxShadow: tokens.shadow8, outline: `2px solid ${tokens.colorBrandStroke2}`, outlineOffset: '-1px' },
  /** Hidden visual (Selection pane) — faded but still authorable in edit mode. */
  vcardHidden: { opacity: 0.4 },
  /** Locked visual — drag/resize disabled (dashed border cue). */
  vcardLocked: { border: `1px dashed ${tokens.colorNeutralStroke1}` },
  /** Arrange / Edit canvas toolbar group. */
  arrangeBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexWrap: 'wrap',
    padding: tokens.spacingVerticalXXS, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  /** Drillthrough "Back" bar shown on a drillthrough target page. */
  backBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorBrandStroke2}`,
    boxShadow: tokens.shadow2,
  },
  // ── Play-axis (scatter animation) ────────────────────────────────────────────
  playRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS },
  playSlider: { flex: 1, minWidth: 0 },
  // ── Selection / Bookmarks panes (right rail) ────────────────────────────────
  listRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  listRowActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  listRowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});
type Styles = ReturnType<typeof useStyles>;

// ── visual render ─────────────────────────────────────────────────────────────

/**
 * Shared host wiring the wave-3 AI visuals consume. `queryAdHoc` is the generalized
 * /query POST (Path-3 wells→SQL) the decomposition tree / key influencers / Q&A
 * self-query through; `onApplyVisual` turns a Q&A answer into a real persisted
 * visual (the same path the Copilot uses); `pageRows` are the active page's REAL
 * /query result sets the smart narrative summarizes (it never fetches page data).
 */
interface AiVisualWiring {
  reportId: string;
  tables: FieldTable[];
  queryAdHoc: (spec: CopilotVisualSpec, filters?: ReportFilterInput[]) => Promise<Array<Record<string, unknown>>>;
  onApplyVisual: (spec: CopilotVisualSpec) => void;
  pageRows: SmartNarrativeVisualRows[];
}

function VisualBody({ visual, state, styles, filters, selection, interactionMode, onSelect, onPageFilter, onSlicerStyle, themeChart, ai, script, reportId }: {
  visual: DVisual; state?: VisualState; styles: Styles; filters?: ReportFilter[];
  selection?: VisualSelection | null; interactionMode?: InteractionMode;
  onSelect?: (sel: VisualSelection | null) => void;
  // Wave-5 slicer host wiring. `onPageFilter` merges the slicer's emitted
  // ReportFilter into the active page's filters (the SAME channel the Filters pane
  // writes + applyFilters reads); `removeId` is the slicer's stable id so a clear
  // (null) removes exactly its own constraint. `onSlicerStyle` persists the chosen
  // PBI slicer style to visual.config.slicerStyle (additive round-trip).
  onPageFilter?: (filter: ReportFilter | null, removeId: string) => void;
  onSlicerStyle?: (style: SlicerStyle) => void;
  themeChart?: ThemeChartProps; ai?: AiVisualWiring;
  // Wave-4 script-visual host wiring (mirrors `ai`): patches the visual's
  // config.{script,language} and marks the report dirty (same persist path the
  // Format/wells edits use). `reportId` is the executor target for the Run call.
  script?: { onChange: (id: string, patch: { script?: string; language?: 'python' | 'r' }) => void };
  reportId?: string;
}) {
  // Wave-3 AI visuals render their OWN surface (real AOAI / real /query SQL).
  // Branched BEFORE the hasBinding/state guards: smart narrative + Q&A carry no
  // wells, and decomposition tree / key influencers self-query (they never use the
  // host's per-visual `state`). Each surfaces its own honest gate (503 when no AOAI
  // deployment, verbatim multi-table 400 from /query) — no dead controls.
  if (AI_TYPES.has(visual.type)) {
    if (!ai) return <Caption1 className={styles.muted}>Preparing…</Caption1>;
    if (visual.type === 'smartNarrative') {
      return <SmartNarrative reportId={ai.reportId} pageRows={ai.pageRows} />;
    }
    if (visual.type === 'qna') {
      return <ReportQA reportId={ai.reportId} tables={ai.tables} queryAdHoc={ai.queryAdHoc} onApplyVisual={ai.onApplyVisual} />;
    }
    // Explain-by spans BOTH the Category ("Explain by") AND the Legend wells. A
    // Copilot-placed decomposition tree / key influencers may carry extra Explain-by
    // dimensions in `legend` (report-designer-tools documents legend as "Additional
    // Explain by fields for decompositionTree/keyInfluencers"). Dropping legend here
    // would render the visual with FEWER dimensions than the author placed.
    const aiWells = {
      analyze: visual.wells.values || [],
      explainBy: [...(visual.wells.category || []), ...(visual.wells.legend || [])],
    };
    if (visual.type === 'decompositionTree') {
      return <DecompositionTree wells={aiWells} queryAdHoc={ai.queryAdHoc} />;
    }
    return <KeyInfluencers wells={aiWells} queryAdHoc={ai.queryAdHoc} />;
  }
  // Wave-4 R/Python script visual — its own surface (code editor + language toggle
  // + Run against the real sandboxed ACA executor, rendering the returned PNG).
  // Branched BEFORE the hasBinding/state guards so the FULL editor renders even
  // with no fields yet; it consumes the host's REAL non-aggregated `state.rows`
  // (the Values well) as the executor's `dataset`. The component owns its own
  // empty / loading / honest-503 gate (when LOOM_SCRIPT_RUNNER_URL is unset).
  if (SCRIPT_TYPES.has(visual.type)) {
    const onScriptChange = script?.onChange;
    return (
      <ScriptVisual
        reportId={ai?.reportId ?? reportId ?? ''}
        language={(visual.config?.language as 'python' | 'r') || 'python'}
        script={visual.config?.script || ''}
        rows={state?.rows || []}
        valueFields={visual.wells.values || []}
        onChange={onScriptChange ? (p) => onScriptChange(visual.id, p) : () => {}}
      />
    );
  }
  if (!hasBinding(visual)) {
    return <Caption1 className={styles.muted}>Add a field from the Fields pane to render this {visual.type}.</Caption1>;
  }
  if (!state || state.loading) return <Spinner size="tiny" label="Querying model…" />;
  if (state.err) return <MessageBar intent="error"><MessageBarBody>{state.err}</MessageBarBody></MessageBar>;
  const fmt = visual.format;
  const nf = fmt?.numberFormat;
  // Apply the merged report/page/visual filters client-side so they take effect
  // immediately (visible) — idempotent with the server-side WHERE/FILTER.
  let rows = applyFilters(state.rows, filters || []);
  // Visual interactions: a selection in another visual cross-filters or
  // cross-highlights this one (real client engine over the same /query rows).
  // Charts can't dim individual marks here, so a chart target under 'highlight'
  // is cross-FILTERED (visible) instead; tables dim non-matching rows.
  let dimmed: boolean[] = [];
  if (selection && interactionMode && interactionMode !== 'none' && selection.sourceId !== visual.id) {
    const chartLike = CHART_TYPES.has(visual.type);
    const mode: InteractionMode = interactionMode === 'highlight' && chartLike ? 'filter' : interactionMode;
    const res = applySelection(rows, selection, mode);
    rows = res.rows; dimmed = res.dimmed;
  }
  if (state.rows.length === 0) return <Caption1 className={styles.muted}>No rows returned.</Caption1>;
  if (rows.length === 0) return <Caption1 className={styles.muted}>No rows match the current selection.</Caption1>;
  const cols = Object.keys(rows[0]);
  // Structured conditional formatting (rules / color scale / data bars / icons),
  // resolved once against the real result rows; painted on table cells + KPI value.
  const cf = applyConditionalFormat(rows, fmt?.conditionalFormat);

  // card → single big value (conditional paint applied). gauge / kpi LEFT this
  // branch in wave-5 — they render real radial / indicator geometry below.
  if (KPI_TYPES.has(visual.type)) {
    const valKey = cols[0];
    const paint = cf.active ? cf.paintFor(valKey, rows[0][valKey]) : undefined;
    return (
      <div className={styles.section}>
        <div className={styles.kpi}
          style={{
            color: paint?.color, background: paint?.background,
            borderRadius: paint?.background ? tokens.borderRadiusMedium : undefined,
            paddingInline: paint?.background ? tokens.spacingHorizontalS : undefined,
          }}>
          {paint?.icon && (
            <span aria-hidden style={{ color: paint.icon.color, marginInlineEnd: tokens.spacingHorizontalXS }}>{paint.icon.glyph}</span>
          )}
          {formatValue(rows[0][valKey], nf)}
        </div>
      </div>
    );
  }

  // gauge / kpi → REAL geometry through LoomChart (wave-5): a radial 270° arc with
  // a target needle (gauge) / a big indicator + sparkline + goal delta (kpi). The
  // value/indicator is the first numeric result column; the Target / Minimum /
  // Maximum wells fold into extra value columns and are read back by their exact
  // SQL aliases to drive the needle, the arc bounds, and the goal delta — no
  // approximation, no dead control. (LoomChart geometry ships in the same wave.)
  if (GAUGE_KPI.has(visual.type)) {
    const numAt = (f?: WellField): number | undefined => {
      if (!f) return undefined;
      const cell = rows[0]?.[wellResultAlias(f)];
      return cellIsNumeric(cell) ? Number(cell) : undefined;
    };
    const tgt = numAt(visual.wells.target?.[0]);
    const lo = numAt(visual.wells.minimum?.[0]);
    const hi = numAt(visual.wells.maximum?.[0]);
    const lead = fmt?.dataColors?.[0];
    const wrapStyle = lead ? ({ '--colorBrandForeground1': lead } as unknown as CSSProperties) : undefined;
    // Gauge → arc value + target marker + min/max bounds; KPI → indicator + goal
    // delta (vs Target) + an optional upper target. All optional + read via an
    // `as any` spread so this file compiles independently of the LoomChart props.
    const geom = visual.type === 'gauge'
      ? { target: tgt, gaugeMin: lo, gaugeMax: hi }
      : { kpiGoal: tgt, kpiTarget: hi };
    const gkType: string = visual.type === 'gauge' ? 'gauge' : 'kpi';
    return (
      <div style={wrapStyle}>
        <LoomChart type={gkType as LoomChartType} rows={rows} height={200} format={fmt} {...(geom as any)} />
      </div>
    );
  }

  if (visual.type === 'slicer') {
    const col = cols[0];
    // Wave-5: the full Power BI Slicer surface (no longer a bare single-select
    // Dropdown). SlicerVisual picks a style appropriate to the bound column
    // (List / Dropdown / Tile for any field; Between / Before / After + a real
    // min/max slider for numeric; Date-range / Relative-date / On-or-before/after
    // for date) and emits a STRUCTURED ReportFilter (or null to clear). The host
    // merges it into the PAGE-FILTERS channel — the same `page.filters` the Filters
    // pane writes and `applyFilters` reads — so a slicer pick really cross-filters
    // every other visual on the page AND rides the server-side WHERE on re-query.
    // NO query-engine change: the slicer just authors a page filter.
    //   • rows = state.rows: the raw SELECT-DISTINCT list. The re-query effect
    //     EXCLUDES this slicer's own filter from its own query (slicerFilterId), so
    //     the value list never collapses to the selection (PBI behaviour).
    //   • value = the page filter with this slicer's stable id (re-hydrates the
    //     control on reload / bookmark apply; echo-suppressed inside SlicerVisual).
    //   • queryAdHoc = the shared Path-3 /query → REAL SELECT MIN/MAX bounds for a
    //     numeric Between/threshold slider (honest client fallback when absent).
    const slcField = visual.wells.category?.[0] ?? null;
    const slcId = slicerFilterId(slcField, col);
    return (
      <SlicerVisual
        field={slcField}
        column={col}
        rows={state.rows}
        style={visual.config?.slicerStyle}
        value={(filters || []).find((f) => f.id === slcId) ?? null}
        onFilter={(f) => onPageFilter?.(f, slcId)}
        onStyleChange={onSlicerStyle}
        queryAdHoc={ai?.queryAdHoc}
        title={visual.title}
      />
    );
  }

  // Map → the REAL Azure Maps renderer over the SAME aggregated rows. MapVisual
  // fetches the wave-5 map token (GET …/map-token): when LOOM_MAPS_BACKEND is
  // unset it shows the honest gate + the rows beneath (the full surface still
  // renders, the data is never hidden); when Azure Maps is configured it draws
  // real bubbles (lat/long or geocoded Location) or a filled choropleth — no
  // dead control (no-vaporware.md / no-fabric-dependency.md). The resolved well
  // column aliases (lat / long / Location / Size / Legend) ride straight off the
  // bound wells via wellResultAlias so the map keys on the exact SQL columns.
  if (visual.type === 'map') {
    const mapReportId = ai?.reportId ?? reportId ?? '';
    const aliasOf = (w?: WellField[]) => (w && w.length ? wellResultAlias(w[0]) : undefined);
    return (
      <MapVisual
        reportId={mapReportId}
        rows={rows}
        cols={cols}
        numberFormat={nf}
        latitudeColumn={aliasOf(visual.wells.latitude)}
        longitudeColumn={aliasOf(visual.wells.longitude)}
        locationColumn={aliasOf(visual.wells.category)}
        sizeColumn={aliasOf(visual.wells.size)}
        legendColumn={aliasOf(visual.wells.legend)}
      />
    );
  }

  // Scatter with a Size and/or Play-axis well → bubble + animated frames, drawn
  // locally over the REAL aggregated rows (LoomChart's scatter draws no radius /
  // frames). Plain scatter (no size/play) keeps the existing LoomChart path.
  if (visual.type === 'scatter' && (((visual.wells.size?.length ?? 0) > 0) || ((visual.wells.playAxis?.length ?? 0) > 0))) {
    return (
      <BubblePlayBody
        rows={rows} cols={cols} fmt={fmt} styles={styles}
        hasSize={(visual.wells.size?.length ?? 0) > 0}
        hasPlay={(visual.wells.playAxis?.length ?? 0) > 0}
      />
    );
  }

  if (CHART_TYPES.has(visual.type)) {
    const hasNumeric = visual.type === 'scatter'
      || rows.some((r) => Object.values(r).some((v) => v != null && v !== '' && !Number.isNaN(Number(v))));
    if (hasNumeric) {
      // The Format pane's lead data color (a Loom brand-palette token) is applied
      // by overriding the Fluent brand CSS variable LoomChart's series-1 reads
      // (tokens.colorBrandForeground1 === var(--colorBrandForeground1)). What you
      // pick in Format → Data colors is what the chart paints. Wave-3: when a
      // report THEME is active and the visual has no per-visual lead, the theme's
      // lead (palette[0]) repaints series-1 — but a token value that points at the
      // very variable we'd override is SKIPPED (assigning `--x: var(--x)` is a CSS
      // cycle that blanks it; same guard themes.applyThemeCssVars uses).
      const lead = fmt?.dataColors?.[0];
      const themeLead = themeChart && themeChart.palette[0] !== 'var(--colorBrandForeground1)' ? themeChart.palette[0] : undefined;
      const leadVar = lead || themeLead;
      const wrapStyle = leadVar ? ({ '--colorBrandForeground1': leadVar } as unknown as CSSProperties) : undefined;
      // Wave-3 theme props for LoomChart (palette + typography + structural axis /
      // gridline / plot colors) are NOW emitted by the Wave-6 format→chart adapter
      // (formatToChartProps) from `themeChart` + the per-visual lead, alongside the
      // Format-pane axis/label/effect colors — so the theme still flips the WHOLE
      // chart (not just series-1) while the Format pane's own color controls layer
      // on top. The previous inline `themeChartProps_` object is superseded by
      // `adapter.chartProps` below; passing `themeChart`/`leadVar` through the
      // adapter context keeps the exact same theme behavior (and finally carries
      // the theme gridline color the old object dropped). Omitted when no theme +
      // no Wave-6 color → byte-identical output.
      // Analytics reference lines — computed from these same rows and OVERLAID
      // on the chart by LoomChart (horizontal, or sloped for a trend line), with
      // a compact legend strip below for quick scanning. Each is data-derived,
      // never a dead control.
      const refLines = CARTESIAN_TYPES.has(visual.type) ? computeReferenceLines(rows, visual.analytics) : [];
      // Wave-5 X-CONSTANT lines: an analytics line authored with axis:'x' is a
      // VERTICAL (category-axis) constant rather than the default horizontal
      // value-axis line. The Analytics model's per-line `axis` is read defensively
      // (it's an additive field) and mapped to LoomChart's refLine `orientation`
      // ('v' = opposite axis). Horizontal lines keep orientation 'h' (default).
      const xLineIds = new Set<string>(
        ((((visual.analytics as { lines?: Array<{ id?: string; axis?: string }> } | undefined)?.lines) || [])
          .filter((l) => l?.axis === 'x')
          .map((l) => l?.id)
          .filter((id): id is string => typeof id === 'string')),
      );
      const orientedRefLines = refLines.map((rl) =>
        (xLineIds.has(rl.id) ? { ...rl, orientation: 'v' as const } : rl));
      // Analytics ERROR BARS / FORECAST / SYMMETRY — computed from these SAME rows
      // and overlaid by LoomChart (it fully supports all three). Authoring any of
      // them in the Analytics pane now visibly changes the canvas; none is a dead
      // control. Error bars map each computed point's row index to the category
      // label LoomChart's xFor keys on (chartCategories mirrors parseRows' label
      // column). Forecast is line/area-only; symmetry is scatter-only — exactly the
      // visual families LoomChart draws each overlay for.
      const ebCats = chartCategories(rows);
      const errorBars: ChartErrorBar[] = CARTESIAN_TYPES.has(visual.type)
        ? computeErrorBars(rows, visual.analytics).flatMap((eb) =>
            eb.points.map((p) => ({ x: ebCats[p.index] ?? String(p.index), low: p.low, high: p.high, color: eb.color })))
        : [];
      let forecast: ChartForecast | undefined;
      if ((visual.type === 'line' || visual.type === 'area') && visual.analytics?.forecast?.length) {
        const cf = computeForecast(rows, visual.analytics.forecast[0]);
        if (cf) forecast = {
          projected: cf.points.map((p) => p.y),
          band: { low: cf.points.map((p) => p.lower), high: cf.points.map((p) => p.upper) },
          color: tokens.colorBrandForeground2,
        };
      }
      let symmetry: ChartSymmetry | undefined;
      if (visual.type === 'scatter') {
        const cs = computeSymmetry(rows, visual.analytics);
        if (cs) symmetry = { color: cs.color };
      }
      // ── Wave-5 true-geometry + trellis + hover + anomaly props. All optional and
      //    spread via `as any` so this file compiles independently of the
      //    loom-chart.tsx geometry extension landing in the same wave.
      const aliasesOf = (a?: WellField[]) => (a || []).map(wellResultAlias);
      // Trellis facet (small multiples) / treemap detail = the resolved GROUP
      // column name (== the SQL alias of a group well, which is the column name).
      const facetColumn = visual.wells.smallMultiples?.[0]?.column || undefined;
      const detailColumn = (visual.type === 'treemap' && visual.wells.details?.[0]?.column) || undefined;
      // Tooltip measures: plotted-EXCLUDED hover-only columns (their aggregates are
      // in the result; LoomChart drops them from the series + shows them on hover).
      const tooltipAliases = aliasesOf(visual.wells.tooltips);
      // Combo: the secondary (line) series painted on the right-hand value axis.
      const comboLineSeries = aliasesOf(visual.wells.secondaryValues);
      // Stacking (none / stacked / 100%) — read defensively off the Format pane.
      const stackingRaw = (fmt as { stacking?: string } | undefined)?.stacking;
      const stackMode = stackingRaw === 'stacked' || stackingRaw === 'stacked100' ? stackingRaw : 'none';
      // Anomaly band + flagged points (real rolling-mean / z-score) + shaded ranges
      // — cartesian only, computed from the SAME rows, read from the additive
      // analytics model. Absent ⇒ undefined (nothing drawn; never a ghost overlay).
      const anomalies = CARTESIAN_TYPES.has(visual.type)
        ? computeAnomalyOverlay(rows, (visual.analytics as { anomalies?: unknown[] } | undefined)?.anomalies, ebCats)
        : undefined;
      const shadedRangesRaw = (visual.analytics as { shadedRanges?: unknown[] } | undefined)?.shadedRanges;
      const shadedRanges = Array.isArray(shadedRangesRaw) && shadedRangesRaw.length ? shadedRangesRaw : undefined;
      const geomProps: Record<string, unknown> = {
        stackMode,
        comboLineSeries,
        ...(facetColumn ? { smallMultiples: { facetColumn } } : {}),
        ...(detailColumn ? { detailColumn } : {}),
        ...(tooltipAliases.length ? { tooltips: tooltipAliases } : {}),
        ...(anomalies ? { anomalies } : {}),
        ...(shadedRanges ? { shadedRanges } : {}),
      };
      // ── Wave-6 ACTIVATION SEAM (the single additive, default-off line the
      //    Format-pane parity wave needs). `formatToChartProps` maps the persisted
      //    Format model onto levers LoomChart already reads — value-axis range,
      //    secondary axis, gridline / label / plot colors, whole-chart font,
      //    palette, stacking, small-multiples, tooltips — plus `rows` transforms
      //    (log / display-units / decimals / zoom window) and axis-title chrome.
      //    Every shipped control therefore takes REAL effect with NO edit to
      //    loom-chart.tsx (no-vaporware: no dead controls). The wells-derived
      //    `geomProps` is spread LAST so the PBI-native field-well geometry keeps
      //    precedence; the adapter only fills what the Format pane adds. When no
      //    Wave-6 control is set the adapter returns the same `rows` ref + a format
      //    passthrough, so the render is byte-identical to wave-5 (no regression).
      const chartCtx: ChartAdapterContext = {
        visualType: visual.type,
        rows,
        themeChart,
        perVisualLead: leadVar,
      };
      const adapter = formatToChartProps(fmt, chartCtx);
      // fx-conditional title → a REAL per-measure aggregate from the SAME /query
      // rows the visual already drew (SUM for numeric columns, first value
      // otherwise), keyed by column name. Computed ONLY when an fx-title is bound,
      // so the common path pays nothing; lets VisualChrome paint a real value
      // instead of a placeholder (no-vaporware). Absent ⇒ the literal title text /
      // the visual name shows.
      const titleMeasureValues = fmt?.title?.conditionalField
        ? measureAggregates(rows, cols)
        : undefined;
      return (
        <div style={wrapStyle}>
          {/* VisualChrome paints title / subtitle / header-icons / axis-titles /
              card border+shadow AROUND the chart from the Format model + the
              adapter's axisChrome; it collapses to a passthrough when none is set. */}
          <VisualChrome chrome={adapter.axisChrome} format={fmt} fallbackTitle={visual.title} measureValues={titleMeasureValues}>
            <LoomChart type={(CHART_RENDER[visual.type] || 'column') as LoomChartType} rows={adapter.rows} height={200}
              refLines={orientedRefLines} errorBars={errorBars} forecast={forecast} symmetry={symmetry}
              {...(adapter.chartProps as any)} {...(geomProps as any)} />
          </VisualChrome>
          {refLines.length > 0 && (
            <div className={styles.refLineRow}>
              {refLines.map((rl) => (
                <span key={rl.id} className={styles.refLineChip} title={rl.label || rl.kind}>
                  <span className={styles.refLineDot} style={{ backgroundColor: rl.color }} aria-hidden />
                  <Caption1>{rl.label || rl.kind}</Caption1>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
  }

  // multi-row card → one elevated card per result row (field:value pairs). This
  // is the real Power BI multi-row-card surface, not the table fallback.
  if (visual.type === 'multiRowCard') {
    return (
      <div className={styles.cardList}>
        {rows.slice(0, 60).map((row, ri) => (
          <div key={ri} className={styles.cardRow}>
            {cols.map((c) => {
              const paint = cf.active ? cf.paintFor(c, row[c]) : undefined;
              return (
                <div key={c} className={styles.cardField}>
                  <Caption1 className={styles.muted}>{c}</Caption1>
                  <Text weight="semibold" style={{ color: paint?.color }}>
                    {paint?.icon && (
                      <span aria-hidden style={{ color: paint.icon.color, marginInlineEnd: tokens.spacingHorizontalXXS }}>{paint.icon.glyph}</span>
                    )}
                    {formatValue(row[c], nf)}
                  </Text>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  // table / matrix / non-numeric fallback — conditional paint,
  // selection dim, and click-to-cross-filter (a clicked row becomes a selection).
  return (
    <Table size="small">
      <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
      <TableBody>
        {rows.slice(0, 100).map((row, ri) => (
          <TableRow key={ri}
            style={{ opacity: dimmed[ri] ? 0.35 : undefined, cursor: onSelect ? 'pointer' : undefined }}
            onClick={onSelect ? () => onSelect(selectionFromRow(visual.id, row, [cols[0]])) : undefined}>
            {cols.map((c) => {
              const paint = cf.active ? cf.paintFor(c, row[c]) : undefined;
              return (
                <TableCell key={c} style={{ background: paint?.background, color: paint?.color }}>
                  {paint?.icon && (
                    <span aria-hidden style={{ color: paint.icon.color, marginInlineEnd: tokens.spacingHorizontalXXS }}>{paint.icon.glyph}</span>
                  )}
                  {formatValue(row[c], nf)}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── wave-2 render helpers: numeric detection (shared with bubble / map) ───────

/** True when a cell coerces to a finite number (mirrors LoomChart's isNumeric). */
function cellIsNumeric(v: unknown): boolean {
  if (v == null || v === '') return false;
  return !Number.isNaN(Number(v));
}
/**
 * Per-column aggregate values for an fx-conditional visual title (no-vaporware:
 * VisualChrome paints a REAL measure value, not a placeholder). Mirrors Power
 * BI's default title-measure aggregate — SUM over a numeric column, the first
 * non-null value otherwise — keyed by result-column name so a title bound to a
 * measure / column lights up off the SAME /query rows the visual already drew.
 */
function measureAggregates(rows: Array<Record<string, unknown>>, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    let sum = 0;
    let sawNumeric = false;
    let firstNonNull: unknown;
    for (const r of rows) {
      const v = r[c];
      if (v == null || v === '') continue;
      if (firstNonNull === undefined) firstNonNull = v;
      if (cellIsNumeric(v)) { sum += Number(v); sawNumeric = true; }
    }
    out[c] = sawNumeric ? sum : firstNonNull;
  }
  return out;
}
/** Split result columns into non-numeric (label/category) and numeric, by scanning rows. */
function splitCols(rows: Array<Record<string, unknown>>, cols: string[]): { cats: string[]; nums: string[] } {
  const nums = cols.filter((c) => rows.some((r) => cellIsNumeric(r[c])));
  const cats = cols.filter((c) => !nums.includes(c));
  return { cats, nums };
}

/**
 * The chart's category-axis labels, aligned with row order — the SAME label
 * column LoomChart's parseRows (and analytics-pane's numericSeriesFromRows) pick:
 * the first non-numeric column, or the first column when it is numeric. Used to
 * map a computed error bar's row INDEX to the category label LoomChart's `xFor`
 * keys whiskers on (so an error bar lands on the right bar/point).
 */
function chartCategories(rows: Array<Record<string, unknown>>): string[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  if (!cols.length) return [];
  const firstNumericIdx = cols.findIndex((c) => rows.some((r) => cellIsNumeric(r[c])));
  const labelCol = firstNumericIdx === 0
    ? cols[0]
    : (cols.find((c) => rows.some((r) => !cellIsNumeric(r[c]) && r[c] != null)) ?? cols[0]);
  return rows.map((r) => (r[labelCol] == null ? '—' : String(r[labelCol])));
}

/**
 * Wave-5 ANOMALY overlay (real rolling-mean / z-score, no-vaporware.md). Computes
 * a trailing rolling mean + standard deviation over the primary (or named) numeric
 * series and flags any point whose |z| exceeds a sensitivity-driven threshold, plus
 * the shaded ±threshold·σ band. Cartesian only; consumed by LoomChart's `anomalies`
 * prop. `defs` is the additive `analytics.anomalies` model (read via a narrow cast);
 * the FIRST definition drives the overlay. Returns undefined when there's nothing to
 * flag (no defs / no numeric series) so nothing is drawn — never a ghost overlay.
 *
 *   window   = clamp(round(n / 8), 3, 24)
 *   z-thresh = 3.5 − (sensitivity/100)·2   →  100 ≈ 1.5σ (aggressive), 0 ≈ 3.5σ
 */
function computeAnomalyOverlay(
  rows: Array<Record<string, unknown>>,
  defs: unknown[] | undefined,
  cats: string[],
): { points: Array<{ x: string | number; value: number; isAnomaly: boolean }>; band: Array<{ x: string | number; low: number; high: number }>; color: string } | undefined {
  if (!Array.isArray(defs) || defs.length === 0 || rows.length === 0) return undefined;
  const def = (defs[0] || {}) as { measure?: string; sensitivity?: number; color?: string };
  const { nums } = splitCols(rows, Object.keys(rows[0]));
  if (nums.length === 0) return undefined;
  const col = def.measure && nums.includes(def.measure) ? def.measure : nums[0];
  const vals = rows.map((r) => (cellIsNumeric(r[col]) ? Number(r[col]) : Number.NaN));
  const n = vals.length;
  const window = Math.min(24, Math.max(3, Math.round(n / 8)));
  const sens = Math.min(100, Math.max(0, Number(def.sensitivity ?? 50)));
  const zThreshold = 3.5 - (sens / 100) * 2.0;
  const color = typeof def.color === 'string' && def.color ? def.color : tokens.colorPaletteRedForeground1;

  const points: Array<{ x: string | number; value: number; isAnomaly: boolean }> = [];
  const band: Array<{ x: string | number; low: number; high: number }> = [];
  let flagged = 0;
  for (let i = 0; i < n; i++) {
    const win = vals.slice(Math.max(0, i - window + 1), i + 1).filter((v) => Number.isFinite(v));
    const m = win.length ? win.reduce((a, b) => a + b, 0) / win.length : 0;
    const variance = win.length > 1 ? win.reduce((a, b) => a + (b - m) ** 2, 0) / (win.length - 1) : 0;
    const sd = Math.sqrt(variance);
    const x = cats[i] ?? String(i);
    const v = vals[i];
    const isAnomaly = sd > 0 && Number.isFinite(v) && Math.abs((v - m) / sd) > zThreshold;
    if (isAnomaly) flagged += 1;
    points.push({ x, value: Number.isFinite(v) ? v : 0, isAnomaly });
    if (sd > 0) band.push({ x, low: m - zThreshold * sd, high: m + zThreshold * sd });
  }
  // Nothing to draw (no band + no flagged point) ⇒ no overlay.
  if (band.length === 0 && flagged === 0) return undefined;
  return { points, band, color };
}

/**
 * Bubble + Play-axis scatter, drawn locally over the REAL aggregated `/query`
 * rows. LoomChart's scatter draws no radius or animation, so this is the honest
 * Loom-native bubble renderer (ui-parity.md): X = 1st numeric, Y = 2nd numeric,
 * bubble RADIUS = the last numeric (the folded Size measure). With a Play axis,
 * the LAST non-numeric column is the frame dimension — Play/Pause + a slider
 * step through its distinct values, re-slicing the rows per frame. No dead
 * controls: every well drives the picture; an honest caption names the encoding.
 */
function BubblePlayBody({ rows, cols, fmt, styles, hasSize, hasPlay }: {
  rows: Array<Record<string, unknown>>; cols: string[]; fmt?: ReportVisualFormat;
  styles: Styles; hasSize: boolean; hasPlay: boolean;
}) {
  const { cats, nums } = splitCols(rows, cols);
  // Frame dimension: the LAST non-numeric column (playAxis folds in after the
  // Details category). Falls back to no animation when there isn't a 2nd category.
  const playCol = hasPlay && cats.length >= 2 ? cats[cats.length - 1] : null;
  const frames = useMemo(() => {
    if (!playCol) return [] as string[];
    const seen: string[] = [];
    for (const r of rows) { const v = String(r[playCol] ?? '—'); if (!seen.includes(v)) seen.push(v); }
    return seen;
  }, [rows, playCol]);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const safeFrame = frames.length ? Math.min(frame, frames.length - 1) : 0;
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), 1100);
    return () => clearInterval(t);
  }, [playing, frames.length]);
  useEffect(() => { if (frame > Math.max(0, frames.length - 1)) setFrame(0); }, [frames.length, frame]);

  const frameRows = playCol ? rows.filter((r) => String(r[playCol] ?? '—') === (frames[safeFrame] ?? '')) : rows;

  // X / Y / R columns (R is the folded Size measure when present → last numeric).
  const xKey = nums[0];
  const yKey = nums[1] ?? nums[0];
  const rKey = hasSize ? nums[nums.length - 1] : undefined;
  const labelKey = cats.find((c) => c !== playCol) ?? cats[0];

  if (!xKey) {
    return <Caption1 className={styles.muted}>Add an X and a Y measure to the Values well to plot a bubble chart.</Caption1>;
  }

  // Geometry (Loom tokens for color; raw px for SVG math, per LoomChart).
  const W = 520, H = 220, padL = 48, padR = 14, padT = 12, padB = 30;
  const pts = frameRows.map((r) => ({
    x: cellIsNumeric(r[xKey]) ? Number(r[xKey]) : 0,
    y: cellIsNumeric(r[yKey]) ? Number(r[yKey]) : 0,
    r: rKey && cellIsNumeric(r[rKey]) ? Number(r[rKey]) : 0,
    label: labelKey ? String(r[labelKey] ?? '—') : '—',
  }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), rs = pts.map((p) => p.r);
  const xMin = Math.min(...xs, 0), xMax = Math.max(...xs, 1);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 1);
  const rMax = Math.max(...rs, 1);
  const xSpan = (xMax - xMin) || 1, ySpan = (yMax - yMin) || 1;
  const xPix = (v: number) => padL + ((v - xMin) / xSpan) * (W - padL - padR);
  const yPix = (v: number) => padT + (H - padT - padB) - ((v - yMin) / ySpan) * (H - padT - padB);
  const rPix = (v: number) => 4 + (rKey ? (Math.sqrt(Math.max(v, 0)) / Math.sqrt(rMax)) * 18 : 0);
  const lead = fmt?.dataColors?.[0] || tokens.colorBrandForeground1;

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`bubble chart${rKey ? ' with size encoding' : ''}`}
        style={{ display: 'block', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: tokens.colorNeutralBackground1, overflow: 'visible' }}>
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
        <text x={padL - 4} y={padT + 6} fontSize={9} textAnchor="end" fill={tokens.colorNeutralForeground3}>{yKey}</text>
        <text x={W - padR} y={H - padB + 14} fontSize={9} textAnchor="end" fill={tokens.colorNeutralForeground3}>{xKey}</text>
        {pts.map((p, i) => (
          <circle key={i} cx={xPix(p.x)} cy={yPix(p.y)} r={rPix(p.r)}
            fill={lead} opacity={0.55} stroke={tokens.colorNeutralBackground1} strokeWidth={0.8}>
            <title>{`${p.label}\n${xKey}: ${p.x.toLocaleString()}, ${yKey}: ${p.y.toLocaleString()}${rKey ? `, ${rKey}: ${p.r.toLocaleString()}` : ''}`}</title>
          </circle>
        ))}
      </svg>
      <div className={styles.approxNote}>
        <Info16Regular aria-hidden />
        <Caption1>
          X = {xKey}, Y = {yKey}{rKey ? `, bubble size = ${rKey}` : ''}
          {playCol ? ` · animated by ${playCol}` : ''}.
        </Caption1>
      </div>
      {playCol && frames.length > 1 && (
        <div className={styles.playRow}>
          <Button size="small" appearance="subtle" aria-label={playing ? 'Pause' : 'Play'}
            icon={playing ? <Pause20Regular /> : <Play20Regular />} onClick={() => setPlaying((p) => !p)} />
          <Slider className={styles.playSlider} min={0} max={frames.length - 1} value={safeFrame}
            aria-label={`Play axis frame: ${playCol}`}
            onChange={(_e, d) => { setPlaying(false); setFrame(d.value); }} />
          <Badge appearance="tint" color="brand">{frames[safeFrame]}</Badge>
        </div>
      )}
    </div>
  );
}

// ── well editor (right pane) ────────────────────────────────────────────────

function WellEditor({
  visual, well, label, tables, styles, onAdd, onRemove, onAgg, onDrop,}: {
  visual: DVisual; well: WellName; label: string; tables: FieldTable[]; styles: Styles;
  onAdd: (well: WellName, f: WellField) => void;
  onRemove: (well: WellName, uid: string) => void;
  onAgg: (well: WellName, uid: string, agg: Agg) => void;
  onDrop: (well: WellName, payload: WellField) => void;
}) {
  const [over, setOver] = useState(false);
  const items = visual.wells[well] || [];
  return (
    <div className={styles.section}>
      <div className={styles.wellHead}>
        <Caption1><strong>{label}</strong></Caption1>
        <div className={styles.spacer} />
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="subtle" icon={<Add20Regular />} aria-label={`add field to ${label}`} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {tables.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
              {tables.map((t) => (
                <MenuGroup key={t.name}>
                  <MenuGroupHeader>{t.name}</MenuGroupHeader>
                  {t.measures.map((m) => (
                    <MenuItem key={`m:${m.name}`} icon={<NumberSymbol20Regular />}
                      onClick={() => onAdd(well, { uid: uid('f'), measure: m.name })}>{m.name}</MenuItem>
                  ))}
                  {t.columns.map((c) => (
                    <MenuItem key={`c:${c.name}`}
                      onClick={() => onAdd(well, { uid: uid('f'), table: t.name, column: c.name, aggregation: well === 'values' ? 'Sum' : undefined })}>{c.name}</MenuItem>
                  ))}
                  <MenuDivider />
                </MenuGroup>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      <div
        className={mergeClasses(styles.well, over && styles.wellOver)}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setOver(false);
          try {
            const p = JSON.parse(e.dataTransfer.getData('application/json')) as WellField;
            if (p && (p.column || p.measure)) onDrop(well, { ...p, uid: uid('f'), aggregation: well === 'values' && p.column ? (p.aggregation || 'Sum') : p.aggregation });
          } catch { /* ignore non-field drops */ }
        }}
      >
        {items.length === 0 && <Caption1 className={styles.muted}>Drop a field here</Caption1>}
        {items.map((f) => (
          <div key={f.uid} className={styles.token}>
            <span className={styles.tokenName}>{fieldLabel(f)}</span>
            {well === 'values' && f.column && (
              <Dropdown size="small" value={f.aggregation || 'Sum'} selectedOptions={[f.aggregation || 'Sum']}
                aria-label="aggregation" style={{ minWidth: '92px' }}
                onOptionSelect={(_e, d) => onAgg(well, f.uid, (d.optionValue as Agg) || 'Sum')}>
                {AGGS.map((a) => <Option key={a} value={a}>{a}</Option>)}
              </Dropdown>
            )}
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
              aria-label={`remove ${fieldLabel(f)}`} onClick={() => onRemove(well, f.uid)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── filters pane (right rail tab) ────────────────────────────────────────────
// `FiltersPane`, `fieldOptions`, and the `FieldOpt` shape are imported from
// ./report/filters-pane (the canonical 3-scope structured pane with Top N /
// relative-date / lock-hide). The previously-inline FieldOpt/fieldOptions/
// FilterScope/FiltersPane copies were removed; the host mounts <FiltersPane …/>.

// ── main ────────────────────────────────────────────────────────────────────

/** Right-rail tab identifiers (wave-2 adds Bookmarks + Selection). */
type RightTab = 'build' | 'format' | 'analytics' | 'filters' | 'interactions' | 'bookmarks' | 'selection' | 'copilot';

export function ReportDesigner({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const router = useRouter();

  const isNew = id === 'new';

  const [pages, setPages] = useState<DPage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selectedVisual, setSelectedVisual] = useState<string | null>(null);
  /**
   * Multi-selection (Ctrl/Shift-click a card) for the Arrange toolbar — group /
   * ungroup / lock / z-order / match-size act on this set. The single-selected
   * `selectedVisual` (the one whose Build/Format pane shows) is preserved.
   */
  const [selectedVisualIds, setSelectedVisualIds] = useState<Set<string>>(new Set());
  // ── wave-4 free-form canvas view options (PBI "View" menu) ───────────────────
  // Snap-to-grid + gridlines are independent toggles (PBI parity); snap defaults ON.
  const [snapGrid, setSnapGrid] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  /**
   * Active cross-filter / cross-highlight selection (Visual interactions). A
   * slicer pick or a clicked table row sets it; every other visual on the page
   * reacts per the page's interaction matrix. Cleared on page change.
   */
  const [selection, setSelection] = useState<VisualSelection | null>(null);
  /**
   * Drillthrough context: when a source visual's selected data point is drilled
   * to a target page, the seed filters + the originating page are held here so
   * the target renders filtered and shows a Back button (PBI drillthrough).
   */
  const [drill, setDrill] = useState<{ fromPage: number; toPage: number; filters: ReportFilter[]; label: string } | null>(null);
  /** Saved bookmarks (PBI Bookmarks pane). Captured/applied in-memory; persisted additively. */
  const [bookmarks, setBookmarks] = useState<ReportBookmark[]>([]);
  /** Right rail mode: Build, Format, Analytics, Filters, Interactions, Bookmarks, Selection, or the Power BI Copilot. */
  const [rightTab, setRightTab] = useState<RightTab>('build');
  const [reportName, setReportName] = useState('');

  // ── wave-3: report theme (View ▸ Themes) ──────────────────────────────────────
  // The active report theme restyles EVERY visual (palette + font + background +
  // foreground), persisted ADDITIVELY on state.content.theme via /definition —
  // exactly like bookmarks / filterPaneFormat. Null/undefined ⇒ Loom default.
  const [theme, setTheme] = useState<ReportTheme | undefined>(undefined);
  const [themesOpen, setThemesOpen] = useState(false);
  // The structural props LoomChart / VisualBody read from the theme (palette /
  // font / foreground); the canvas-wide CSS-var wrapper comes from applyThemeCssVars.
  const themeChart = useMemo(() => themeChartProps(theme), [theme]);
  const themeVars = useMemo(() => applyThemeCssVars(theme), [theme]);

  // ── wave-3: viewer-side Personalize overlay (per-user, NEVER persisted) ───────
  // A reading-mode overlay layered over each saved visual at render time only.
  // localStorage-mirrored per browser profile (per-user), outside the shared
  // definition — overrides never enter buildDefinitionBody.
  const personalize = usePersonalize(id, '');
  // Ref so mutatePage can go read-only in personalize mode without a dep churn.
  const personalizeActiveRef = useRef(false);
  personalizeActiveRef.current = personalize.active;

  // ── wave-3: export result/gate message (Export menu) ──────────────────────────
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Report DATA SOURCE (semantic-model default · direct-query · AAS). Replaces the
  // old AAS-only binding; back-compat falls through to {kind:'aas'} from item state.
  const [dataSource, setDataSource] = useState<ReportDataSource | null>(null);
  const [dsOpen, setDsOpen] = useState(false);
  const [dsSaving, setDsSaving] = useState(false);
  const [dsNote, setDsNote] = useState<{ ok: boolean; text: string } | null>(null);

  // Report-scope filters (page-scope live on the page; visual-scope on the visual).
  const [reportFilters, setReportFilters] = useState<ReportFilter[]>([]);
  // Filters-pane FORMAT (pane colors — Loom swatch tokens, never typed CSS).
  // Persisted at state.content.filterPaneFormat; round-trips via /definition.
  const [filterPaneFormat, setFilterPaneFormat] = useState<FilterPaneFormat | null>(null);

  // Publish (Azure-native Org gallery default · Power BI opt-in).
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishTarget, setPublishTarget] = useState<'org' | 'powerbi'>('org');
  const [publishMsg, setPublishMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [tables, setTables] = useState<FieldTable[]>([]);
  const [fieldsErr, setFieldsErr] = useState<string | null>(null);
  const [fieldsLoading, setFieldsLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // First-save "Create report" (id === 'new'): a brand-new report has no Cosmos
  // record, so PUT …/report/new/definition 404s (loadContentBackedItem('new')
  // returns null — there is no create path on that route). On the first Save we
  // mint the real item via the generic create route, persist the in-memory
  // pages/visuals + chosen data source against the new id, then open the live
  // editor. Mirrors the NewItemCreateGate flow (workspace + name → real Cosmos
  // write → /items/report/<id>), kept Azure-native (no Power BI/Fabric).
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createWsId, setCreateWsId] = useState('');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[] | null>(null);
  const [wsErr, setWsErr] = useState<string | null>(null);
  const [visualRows, setVisualRows] = useState<Record<string, VisualState>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);

  // ── undo / redo history (in-memory, bounded) ─────────────────────────────────
  // Auto-records a snapshot of { pages, reportFilters, bookmarks } whenever any of
  // those state references changes (every mutatePage / filter / bookmark edit). It
  // never snapshots w/h/x/y/visibility into the query signature, so undo/redo
  // restore layout/selection state WITHOUT re-querying the model. Capped at 50.
  type HistSnap = { pages: DPage[]; reportFilters: ReportFilter[]; bookmarks: ReportBookmark[] };
  const historyRef = useRef<{ past: HistSnap[]; future: HistSnap[] }>({ past: [], future: [] });
  const prevSnapRef = useRef<HistSnap | null>(null);
  const restoringRef = useRef(false);
  const [, setHistTick] = useState(0); // forces ribbon enable/disable refresh

  const pbiPublishEnabled = (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND || '').toLowerCase() === 'powerbi';
  const bound = isBound(dataSource);

  // ── load definition ────────────────────────────────────────────────────────
  const loadDetail = useCallback(async () => {
    // Brand-new report has no persisted Cosmos item yet (id === 'new'): don't
    // fetch /api/items/report/new (404). Start with one empty page — the user
    // picks a data source, lays out pages/visuals, and Save creates the real item.
    if (id === 'new') {
      setPages([{ id: uid('p'), name: 'Page 1', visuals: [] }]);
      setActivePage(0); setReportName(''); setDataSource(null); setReportFilters([]);
      setBookmarks([]); setDrill(null); setSelectedVisualIds(new Set()); setFilterPaneFormat(null);
      setTheme(undefined);
      historyRef.current = { past: [], future: [] }; prevSnapRef.current = null; restoringRef.current = false;
      setDirty(false); setLoadErr(null); setLoading(false);
      return;
    }
    setLoading(true); setLoadErr(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      setReportName(j.report?.name || '');

      // Resolve the data source: an explicit state.dataSource (read via the v2
      // /data-source route when present) wins; otherwise fall back to the legacy
      // AAS binding so already-saved reports keep working unchanged.
      let ds: ReportDataSource | null = null;
      try {
        const dr = await fetch(`/api/items/report/${encodeURIComponent(id)}/data-source`);
        if (dr.ok) { const dj = await dr.json(); if (dj?.ok) ds = parseDataSource(dj.dataSource); }
      } catch { /* route may not be present yet — fall through to legacy below */ }
      if (!ds) ds = fromLegacyState({ aasServer: j.aasServer ?? undefined, aasDatabase: j.aasDatabase ?? undefined });
      setDataSource(ds);
      setReportFilters(reFilters(j.reportFilters));
      setBookmarks(parseBookmarks(j.bookmarks));
      // Report theme round-trips via reportDetailFromContent → j.theme (additive,
      // mirrors bookmarks/filterPaneFormat). sanitizeTheme returns undefined when
      // none is set, leaving the Loom default.
      setTheme(sanitizeTheme(j.theme));
      // Filters-pane format round-trips via reportDetailFromContent → j.filterPaneFormat.
      { const fpf = parseFilterPaneFormat(j.filterPaneFormat); setFilterPaneFormat(Object.keys(fpf).length ? fpf : null); }
      setDrill(null); setSelectedVisualIds(new Set());
      historyRef.current = { past: [], future: [] }; prevSnapRef.current = null; restoringRef.current = false;

      const dpages: DPage[] = (j.pages || []).map((p: any, pi: number): DPage => {
        const pc = p.config || {};
        return {
          id: uid('p'),
          name: p.displayName || p.name || `Page ${pi + 1}`,
          filters: reFilters(p.filters),
          // Page options (persisted under page.config — round-trips once the GET
          // helper surfaces it; read defensively so it's a no-op until then).
          hidden: !!pc.hidden,
          interactions: parseInteractions(pc.interactions),
          canvasType: typeof pc.type === 'string' ? (pc.type as CanvasType) : undefined,
          background: pc.background && typeof pc.background === 'object' ? pc.background : undefined,
          size: pc.size && typeof pc.size === 'object' ? pc.size : undefined,
          // wave-2 page options (drillthrough target fields + tooltip-page binding).
          // Read defensively — they round-trip once the /definition sanitizer
          // whitelists them; a no-op until then (works in-session regardless).
          drillthrough: pc.drillthrough && Array.isArray(pc.drillthrough.fields)
            ? { fields: (pc.drillthrough.fields as any[]).map((f) => ({ table: f?.table, column: f?.column, measure: f?.measure })).filter((f) => f.column || f.measure) }
            : undefined,
          tooltipPage: pc.tooltipPage && typeof pc.tooltipPage === 'object'
            ? { enabled: !!pc.tooltipPage.enabled, boundField: pc.tooltipPage.boundField || undefined }
            : undefined,
          // wave-7 free-form elements — defensively hydrated by the sibling
          // registry (drops unknown kinds/keys, caps counts). Reads `p.elements`
          // (the additive sibling of `p.visuals`); a no-op [] until the route
          // sanitizer persists them, so already-saved reports stay unchanged.
          elements: parseElements(p.elements),
          visuals: (p.visuals || []).map((v: any): DVisual => {
            const cfgWells = v.config?.wells;
            const reUid = (a: any): WellField[] => (Array.isArray(a) ? a : []).map((f: any) => ({ uid: uid('f'), ...f }));
            let wells: Wells;
            if (cfgWells) {
              // Rehydrate the base + additive authoring wells (queryVisual folds
              // the additive ones at query time; here we keep them distinct).
              wells = {
                category: reUid(cfgWells.category), values: reUid(cfgWells.values), legend: reUid(cfgWells.legend),
                secondaryValues: reUid(cfgWells.secondaryValues), target: reUid(cfgWells.target),
                minimum: reUid(cfgWells.minimum), maximum: reUid(cfgWells.maximum),
                smallMultiples: reUid(cfgWells.smallMultiples), tooltips: reUid(cfgWells.tooltips),
                details: reUid(cfgWells.details),
                size: reUid(cfgWells.size), playAxis: reUid(cfgWells.playAxis),
                latitude: reUid(cfgWells.latitude), longitude: reUid(cfgWells.longitude),
              };
            } else {
              // Back-compat: seed a single well from the legacy `field` string.
              const parsed = parseFieldRef(v.field);
              const into: WellName = parsed?.measure ? 'values' : 'category';
              wells = { category: [], values: [], legend: [] };
              if (parsed) wells[into] = [parsed.measure ? parsed : { ...parsed, aggregation: undefined }];
            }
            const lay = v.config?.layout;
            // Absolute px layout is authoritative when the saved record marks it
            // (unit:'px') or carries values that can't be a 12-col grid span
            // (w>12 / h>24). Anything else is a LEGACY flow record → migrated to
            // absolute below (per-page, in reading order).
            const isAbs = lay && (lay.unit === 'px' || Number(lay.w) > 12 || Number(lay.h) > 24);
            return {
              id: uid('v'),
              type: (v.type as VisualType) || 'table',
              title: v.title || '',
              wells,
              w: Math.min(12, Math.max(1, Number(v.config?.layout?.w) || 6)),
              h: Math.max(1, Number(v.config?.layout?.h) || 4),
              layout: isAbs
                ? {
                    x: Math.max(0, Number(lay.x) || 0), y: Math.max(0, Number(lay.y) || 0),
                    w: Math.max(1, Number(lay.w) || 200), h: Math.max(1, Number(lay.h) || 160),
                    z: Number.isFinite(Number(lay.z)) ? Number(lay.z) : undefined,
                  }
                : undefined,
              format: (v.config?.format as ReportVisualFormat | undefined) || undefined,
              analytics: parseAnalytics(v.config?.analytics),
              filters: reFilters(v.config?.filters),
              // wave-2 object state (Selection pane + Arrange). Read defensively —
              // round-trips once the /definition sanitizer whitelists them; works
              // in-session regardless. `z` defaults to list order below if absent.
              hidden: v.config?.hidden === true || v.config?.layout?.hidden === true,
              locked: v.config?.locked === true || v.config?.layout?.locked === true,
              z: Number.isFinite(Number(v.config?.layout?.z)) ? Number(v.config.layout.z) : undefined,
              groupId: typeof v.config?.groupId === 'string' ? v.config.groupId : undefined,
              // wave-4 script-visual config — read defensively from the persisted
              // (additively-whitelisted) config.language / config.script. Only
              // materializes for a script visual; a no-op for every other type.
              // Wave-5: a slicer rehydrates its persisted config.slicerStyle (the
              // chosen PBI slicer interaction style) the same additive way.
              config: ((v.type as VisualType) === 'scriptVisual')
                ? {
                    language: v.config?.language === 'r' ? 'r' : 'python',
                    script: typeof v.config?.script === 'string' ? v.config.script : '',
                  }
                : ((v.type as VisualType) === 'slicer' && typeof v.config?.slicerStyle === 'string')
                  ? { slicerStyle: v.config.slicerStyle as SlicerStyle }
                  : undefined,
            };
          }),
        };
      });
      // Back-compat migration: any page whose visuals still lack an absolute
      // `layout` (legacy 12-col flow records) is shelf-packed into px rects on the
      // page sheet — so an old report opens as a sensible free-form layout and
      // nothing renders at 0×0. Already-absolute pages pass through untouched.
      const migrated = dpages.map((p) => {
        if (!p.visuals.length || p.visuals.every((v) => v.layout)) return p;
        const dims = pageDims(p);
        const need = p.visuals.filter((v) => !v.layout);
        const haveBottom = p.visuals.filter((v) => v.layout)
          .reduce((m, v) => Math.max(m, (v.layout!.y + v.layout!.h)), 0);
        const offset = haveBottom ? haveBottom + 16 : 0;
        const placed = new Map(
          migrateFlowToAbsolute(need, dims).map((v) => [v.id, { ...v.layout, y: v.layout.y + offset }]),
        );
        return { ...p, visuals: p.visuals.map((v) => (v.layout ? v : { ...v, layout: placed.get(v.id) })) };
      });
      setPages(migrated.length ? migrated : [{ id: uid('p'), name: 'Page 1', visuals: [] }]);
      setActivePage(0);
      setDirty(false);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);

  // ── load fields (model schema) ───────────────────────────────────────────────
  const loadFields = useCallback(async () => {
    // New report (id === 'new') has no item to read a model from yet — skip the
    // fetch (avoids /api/items/report/new/fields 404). The AAS-bind gate already
    // explains that fields appear once the report is saved + a model is bound.
    if (id === 'new') {
      setTables([]); setFieldsErr(null); setFieldsLoading(false);
      return;
    }
    setFieldsLoading(true); setFieldsErr(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/fields`);
      const j = await r.json();
      if (j.ok) { setTables(j.tables || []); }
      else { setTables([]); setFieldsErr(j.error || `HTTP ${r.status}`); }
    } catch (e: any) { setTables([]); setFieldsErr(e?.message || String(e)); }
    finally { setFieldsLoading(false); }
  }, [id]);

  useEffect(() => { loadDetail(); loadFields(); }, [loadDetail, loadFields]);

  const page = pages[activePage];
  const selected = useMemo(
    () => (page?.visuals || []).find((v) => v.id === selectedVisual) || null,
    [page, selectedVisual],
  );
  // wave-7: the selected node is an ELEMENT when its id resolves in page.elements
  // (ids are unique across visuals + elements). Drives the Build pane to show the
  // element property pickers instead of the visual well editors.
  const selectedElement = useMemo(
    () => (page?.elements || []).find((e) => e.id === selectedVisual) || null,
    [page, selectedVisual],
  );

  // ── wave-3: effective (personalize-overlaid) visuals for the active page ──────
  // In personalize mode each saved visual is merged with its per-user override at
  // RENDER time (applyOverride preserves the id, so visualRows + selection still
  // key correctly). Both the canvas render AND the live query iterate these, so a
  // personalized FIELD swap re-queries real data and a TYPE swap re-renders live.
  // When personalize is OFF this is the SAME reference as page.visuals (no change).
  const effectiveVisuals = useMemo<DVisual[]>(
    // applyOverride is generic over personalize's structural DVisual (its Wells is
    // an index signature the designer's fixed-keys Wells doesn't structurally
    // satisfy); the cast pins the return to the designer DVisual it actually
    // produces (applyOverride only spreads `{ ...v, type, wells }`, preserving the
    // concrete shape — id, w/h, format, hidden, etc. all survive).
    () => (personalize.active
      ? (page?.visuals || []).map((v) => (personalize.applyOverride as unknown as (x: DVisual) => DVisual)(v))
      : (page?.visuals || [])),
    [page?.visuals, personalize.active, personalize.map, personalize.applyOverride],
  );

  // A cross-filter selection is page-scoped — clear it when the active page changes.
  useEffect(() => { setSelection(null); }, [activePage]);

  // Record an undo snapshot whenever pages / report filters / bookmarks change.
  // Stores the PREVIOUS references (immutable — mutators always produce new
  // arrays), so it's cheap. Skipped on the initial load + on undo/redo restores.
  useEffect(() => {
    const snap: HistSnap = { pages, reportFilters, bookmarks };
    if (prevSnapRef.current === null) { prevSnapRef.current = snap; return; }
    if (restoringRef.current) { restoringRef.current = false; prevSnapRef.current = snap; return; }
    const h = historyRef.current;
    h.past.push(prevSnapRef.current);
    if (h.past.length > 50) h.past.shift();
    h.future = [];
    prevSnapRef.current = snap;
    setHistTick((t) => t + 1);
  }, [pages, reportFilters, bookmarks]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    h.future.push({ pages, reportFilters, bookmarks });
    const prev = h.past.pop() as HistSnap;
    restoringRef.current = true;
    setPages(prev.pages); setReportFilters(prev.reportFilters); setBookmarks(prev.bookmarks);
    setDirty(true); setSelection(null); setHistTick((t) => t + 1);
  }, [pages, reportFilters, bookmarks]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    h.past.push({ pages, reportFilters, bookmarks });
    const next = h.future.pop() as HistSnap;
    restoringRef.current = true;
    setPages(next.pages); setReportFilters(next.reportFilters); setBookmarks(next.bookmarks);
    setDirty(true); setSelection(null); setHistTick((t) => t + 1);
  }, [pages, reportFilters, bookmarks]);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  // Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo. Ignored
  // while typing in an input/textarea so field edits aren't hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ── live render: query each visual on the active page ─────────────────────────
  // `scopeFilters` = report + page filters; the visual's own filters are merged in
  // here. The merged set is sent to the route (forward-compatible WHERE/FILTER) AND
  // re-applied client-side in VisualBody so a filter is visible immediately.
  const runVisual = useCallback(async (v: DVisual, scopeFilters: ReportFilter[] = []) => {
    // AI visuals self-query (decomposition tree / key influencers) or have no
    // wells (smart narrative / Q&A) — never run them through the host effect.
    if (AI_SELF_QUERY.has(v.type)) return;
    if (!hasBinding(v)) return;
    const applicable = [...scopeFilters, ...(v.filters || [])];
    setVisualRows((p) => ({ ...p, [v.id]: { rows: p[v.id]?.rows || [], loading: true, err: null } }));
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visual: queryVisual(v), filters: wireFilters(applicable), dataSource }),
      });
      const j = await r.json();
      if (j.ok) setVisualRows((p) => ({ ...p, [v.id]: { rows: j.rows || [], loading: false, err: null } }));
      else setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: j.error || `HTTP ${r.status}` } }));
    } catch (e: any) {
      setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: e?.message || String(e) } }));
    }
  }, [id, dataSource]);

  // Re-query a visual whenever its binding signature or applicable filters change.
  const bindingSig = (v: DVisual) => `${v.type}|${JSON.stringify(queryVisual(v).wells)}|${JSON.stringify(v.filters || [])}`;
  useEffect(() => {
    if (!bound || !page) return;
    const drillScope = drill && drill.toPage === activePage ? drill.filters : [];
    const scope = [...reportFilters, ...drillScope, ...(page.filters || [])];
    // Iterate the effective (personalize-overlaid) visuals so a personalized field
    // swap re-queries; AI self-querying visuals are skipped (runVisual no-ops them).
    // Wave-5: a SLICER must never filter its OWN value list (PBI behaviour) — when a
    // slicer pick lands in page.filters, every other visual cross-filters, but the
    // slicer itself re-queries with its own filter (its stable slc_ id) REMOVED, so
    // its options stay whole and you can still deselect. Identical scope (byte-for-
    // byte) for every non-slicer visual.
    effectiveVisuals.forEach((v) => {
      if (AI_SELF_QUERY.has(v.type) || !hasBinding(v)) return;
      if (v.type === 'slicer') {
        const selfId = slicerFilterId(v.wells.category?.[0] ?? null, '');
        runVisual(v, scope.filter((f) => f.id !== selfId));
      } else {
        runVisual(v, scope);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, activePage, effectiveVisuals.map(bindingSig).join('~'), JSON.stringify(reportFilters), JSON.stringify(page?.filters || []), JSON.stringify(drill?.toPage === activePage ? drill?.filters : [])]);

  // ── mutation helpers ─────────────────────────────────────────────────────────
  const mutatePage = useCallback((fn: (p: DPage) => DPage) => {
    // Personalize is a reading mode (PBI parity): the shared definition is
    // read-only while it's active, so any edit (drag / resize / well change /
    // arrange) is a no-op and overrides never reach the saved model.
    if (personalizeActiveRef.current) return;
    setPages((prev) => prev.map((p, i) => (i === activePage ? fn(p) : p)));
    setDirty(true);
  }, [activePage]);

  const mutateVisual = useCallback((vid: string, fn: (v: DVisual) => DVisual) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.map((v) => (v.id === vid ? fn(v) : v)) }));
  }, [mutatePage]);

  const addVisual = useCallback((type: VisualType, seed?: { language: 'python' | 'r' }) => {
    const isKpi = COMPACT_TYPES.has(type);
    mutatePage((p) => {
      const dims = pageDims(p);
      // Default size (px) ~ the PBI default-drop footprint; KPI/card visuals are
      // smaller. Cascade each new visual down-right so they don't stack exactly.
      const w = isKpi ? 280 : 480;
      const h = isKpi ? 200 : 320;
      const n = p.visuals.length;
      const x = Math.min(dims.width - w, 40 + (n % 6) * 28);
      const y = Math.min(dims.height - h, 40 + (n % 6) * 28);
      const z = p.visuals.reduce((m, vv) => Math.max(m, (vv.layout?.z ?? -1)), -1) + 1;
      // A seeded script visual carries its chosen language label + an empty script.
      const title = seed
        ? (seed.language === 'r' ? 'R visual' : 'Python visual')
        : (VISUALS.find((x) => x.type === type)?.label || type);
      const v: DVisual = {
        id: uid('v'), type, title,
        wells: { category: [], values: [], legend: [] },
        w: isKpi ? 3 : 6, h: isKpi ? 3 : 4,
        layout: { x: Math.max(0, x), y: Math.max(0, y), w, h, z },
        ...(seed ? { config: { language: seed.language, script: '' } } : {}),
      };
      setSelectedVisual(v.id);
      return { ...p, visuals: [...p.visuals, v] };
    });
  }, [mutatePage]);

  const removeVisual = useCallback((vid: string) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.filter((v) => v.id !== vid) }));
    if (selectedVisual === vid) setSelectedVisual(null);
  }, [mutatePage, selectedVisual]);

  // ── wave-7: canvas-element mutators + union-layout glue ──────────────────────
  // Elements live on `page.elements` (sibling of `visuals`) but share the SAME
  // absolute sheet + integer z-space. These two pure helpers let every geometry
  // mutator (move / align / distribute / z-order) run over the UNION of both
  // arrays and scatter the result back to the correct array by id — so a shape
  // and a chart interleave in one paint order (PBI parity). Pages with no
  // elements are returned untouched (no stray `elements:[]` is introduced).
  const unionNodes = useCallback((p: DPage): Array<{ id: string; layout: AbsRect }> => ([
    ...p.visuals.filter((v) => v.layout).map((v) => ({ id: v.id, layout: v.layout as AbsRect })),
    ...(p.elements || []).map((e) => ({ id: e.id, layout: e.layout })),
  ]), []);
  const scatterLayouts = useCallback((p: DPage, byId: Map<string, AbsRect>): DPage => {
    const np: DPage = { ...p, visuals: p.visuals.map((v) => (byId.has(v.id) ? { ...v, layout: byId.get(v.id)! } : v)) };
    if (p.elements && p.elements.length) {
      np.elements = p.elements.map((e) => (byId.has(e.id) ? { ...e, layout: byId.get(e.id)! } : e));
    }
    return np;
  }, []);

  /** Patch one element (mirrors mutateVisual). The sibling renderers/property
   *  pane call this through `elemCtx.onChange(id, updater)` — direct manipulation
   *  on the structured element model (no-freeform-config). */
  const mutateElement = useCallback((eid: string, fn: (e: CanvasElement) => CanvasElement) => {
    mutatePage((p) => ({ ...p, elements: (p.elements || []).map((e) => (e.id === eid ? fn(e) : e)) }));
  }, [mutatePage]);

  /** Insert a new element (Insert gallery). Mirrors addVisual's drop convention:
   *  the registry's per-kind default footprint + a down-right cascade, with the
   *  authoritative z = max-existing-z (over visuals AND elements) + 1 so it paints
   *  on top. newElement() seeds the kind-specific defaults; selection follows it. */
  const addElement = useCallback((kind: ElementKind) => {
    mutatePage((p) => {
      const dims = pageDims(p);
      const count = p.visuals.length + (p.elements?.length || 0);
      const layout = defaultElementLayout(kind, dims, count);
      const maxZ = unionNodes(p).reduce((m, n) => Math.max(m, n.layout.z ?? -1), -1);
      const el = newElement(kind, { ...layout, z: maxZ + 1 });
      setSelectedVisual(el.id);
      setSelectedVisualIds(new Set());
      return { ...p, elements: [...(p.elements || []), el] };
    });
  }, [mutatePage, unionNodes]);

  /** Remove one element (element chrome's delete / property-pane delete). */
  const removeElement = useCallback((eid: string) => {
    mutatePage((p) => ({ ...p, elements: (p.elements || []).filter((e) => e.id !== eid) }));
    if (selectedVisual === eid) setSelectedVisual(null);
  }, [mutatePage, selectedVisual]);

  /** Union-aware delete (canvas keyboard Delete + marquee) — routes each id to the
   *  right array in ONE mutation (one undo entry) and clears it from selection. */
  const removeNodes = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const set = new Set(ids);
    mutatePage((p) => {
      const np: DPage = { ...p, visuals: p.visuals.filter((v) => !set.has(v.id)) };
      if (p.elements && p.elements.length) np.elements = p.elements.filter((e) => !set.has(e.id));
      return np;
    });
    if (selectedVisual && set.has(selectedVisual)) setSelectedVisual(null);
    setSelectedVisualIds((prev) => { const next = new Set(prev); ids.forEach((i) => next.delete(i)); return next; });
  }, [mutatePage, selectedVisual]);

  /** Single-step z-layering (Ctrl+] / Ctrl+[) over the visuals+elements union. */
  const reorderZStepUnion = useCallback((ids: string[], dir: 'forward' | 'backward') => {
    if (!ids.length) return;
    const set = new Set(ids);
    mutatePage((p) => {
      const union = unionNodes(p);
      if (!union.length) return p;
      const next = absReorderZStep(union, set, dir);
      const byId = new Map(next.map((n) => [n.id, n.layout]));
      return scatterLayouts(p, byId);
    });
  }, [mutatePage, unionNodes, scatterLayouts]);

  const addToWell = useCallback((vid: string, well: WellName, f: WellField) => {
    mutateVisual(vid, (v) => {
      const cur = v.wells[well] || [];
      if (cur.some((x) => fieldKey(x) === fieldKey(f))) return v;
      // Single-field wells: slicer field, the gauge/kpi Value/Target/Min/Max
      // wells, and the wave-3 decomposition-tree / key-influencers Analyze well
      // (exactly one measure). All others accept many.
      const single =
        (well === 'category' && v.type === 'slicer') ||
        well === 'target' || well === 'minimum' || well === 'maximum' ||
        ((v.type === 'gauge' || v.type === 'kpi') && well === 'values') ||
        ((v.type === 'decompositionTree' || v.type === 'keyInfluencers') && well === 'values');
      const base = single ? [] : cur;
      return { ...v, wells: { ...v.wells, [well]: [...base, f] } };
    });
  }, [mutateVisual]);
  const removeFromWell = useCallback((vid: string, well: WellName, fuid: string) => {
    mutateVisual(vid, (v) => ({ ...v, wells: { ...v.wells, [well]: (v.wells[well] || []).filter((x) => x.uid !== fuid) } }));
  }, [mutateVisual]);
  const setAgg = useCallback((vid: string, well: WellName, fuid: string, agg: Agg) => {
    mutateVisual(vid, (v) => ({ ...v, wells: { ...v.wells, [well]: (v.wells[well] || []).map((x) => (x.uid === fuid ? { ...x, aggregation: agg } : x)) } }));
  }, [mutateVisual]);

  // ── wave-3: shared ad-hoc query helper (the AI visuals self-query through this) ─
  // Generalizes runVisual's POST to /api/items/report/[id]/query for an arbitrary
  // structured visual spec (Copilot/AI), returning the REAL aggregated rows (Path-3
  // wells→SQL over the bound Loom semantic model). Optional `filters` (the
  // decomposition-tree's ancestor path folded as op:'eq' constraints) ride along as
  // the route's `filters`. Rejects with the route's honest error (e.g. multi-table)
  // VERBATIM so each AI surface can show its gate. No new backend route.
  const queryAdHoc = useCallback(async (
    spec: CopilotVisualSpec,
    adHocFilters?: ReportFilterInput[],
  ): Promise<Array<Record<string, unknown>>> => {
    const strip = (a?: CopilotWellField[]) =>
      (a || []).map((f) => ({ table: f.table, column: f.column, measure: f.measure, aggregation: f.aggregation }));
    const cat = strip(spec.wells?.category);
    const vals = strip(spec.wells?.values);
    const leg = strip(spec.wells?.legend);
    const first = vals[0] || cat[0];
    const field = first?.measure
      ? `[${first.measure}]`
      : first?.column
        ? `${first.table ? `'${first.table.replace(/'/g, "''")}'` : ''}[${first.column}]`
        : undefined;
    const visual = { type: spec.type, field, wells: { category: cat, values: vals, legend: leg } };
    const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visual, filters: adHocFilters ?? [], dataSource }),
    });
    const j = await r.json().catch(() => ({} as Record<string, unknown>));
    if (!r.ok || !j?.ok) throw new Error((j?.error as string) || `HTTP ${r.status}`);
    return (j.rows || []) as Array<Record<string, unknown>>;
  }, [id, dataSource]);

  // ── wave-2: multi-select + Arrange (group / lock / z-order / match-size) ──────
  // Ctrl/Shift-click a card toggles it in the Arrange set; a plain click selects
  // one (handled in the card). The set drives the Arrange toolbar below.
  const toggleMultiSelect = useCallback((vid: string) => {
    setSelectedVisualIds((prev) => {
      const next = new Set(prev);
      if (next.has(vid)) next.delete(vid); else next.add(vid);
      return next;
    });
    setSelectedVisual(vid);
  }, []);

  /** Visuals currently targeted by the Arrange toolbar (the multi-set, else the single selection). */
  const arrangeTargets = useCallback((): string[] => {
    if (selectedVisualIds.size > 0) return [...selectedVisualIds];
    return selectedVisual ? [selectedVisual] : [];
  }, [selectedVisualIds, selectedVisual]);

  /** Set hidden / locked on every targeted visual (Selection pane + Arrange). */
  const setVisualFlag = useCallback((ids: string[], patch: Partial<Pick<DVisual, 'hidden' | 'locked'>>) => {
    const set = new Set(ids);
    mutatePage((p) => {
      const np: DPage = { ...p, visuals: p.visuals.map((v) => (set.has(v.id) ? { ...v, ...patch } : v)) };
      // wave-7: lock/hide also applies to selected ELEMENTS (Arrange + Selection).
      if (p.elements && p.elements.length) np.elements = p.elements.map((e) => (set.has(e.id) ? { ...e, ...patch } : e));
      return np;
    });
  }, [mutatePage]);

  /** Match the px width (or height) of every targeted visual to the first
   *  (PBI "same size"). Operates on the absolute `layout` the free-form canvas
   *  renders; legacy grid w/h is matched too so a no-layout fallback stays sane. */
  const matchSize = useCallback((ids: string[], dim: 'w' | 'h') => {
    if (ids.length < 2) return;
    mutatePage((p) => {
      const union = unionNodes(p);
      const first = union.find((n) => n.id === ids[0]);
      if (!first) return p;
      const set = new Set(ids);
      const val = first.layout[dim];
      const byId = new Map<string, AbsRect>(
        union.filter((n) => set.has(n.id)).map((n) => [n.id, { ...n.layout, [dim]: val }]),
      );
      return scatterLayouts(p, byId);
    });
  }, [mutatePage, unionNodes, scatterLayouts]);

  /** Bring targeted visuals to front / send to back via absolute layout.z (PBI
   *  z-order). Re-numbers z so overlapping visuals layer correctly; preserves the
   *  array order so the Selection pane + list stay stable. */
  const reorderZ = useCallback((ids: string[], dir: 'front' | 'back') => {
    if (!ids.length) return;
    const set = new Set(ids);
    mutatePage((p) => {
      // Run over the visuals+elements UNION so a "bring to front" lifts a node
      // above BOTH arrays (shared z-space, PBI parity), then scatter z back.
      const union = unionNodes(p);
      if (!union.length) return p;
      const next = absReorderZ(union, set, dir);
      const byId = new Map(next.map((n) => [n.id, n.layout]));
      return scatterLayouts(p, byId);
    });
  }, [mutatePage, unionNodes, scatterLayouts]);

  /** Align selected visuals' edges/centers on the absolute canvas (PBI Format →
   *  Align). Distribute equalizes gaps. Both mutate the persisted `layout` over
   *  the visuals+elements union. */
  const alignSelection = useCallback((ids: string[], edge: AlignEdge) => {
    if (ids.length < 2) return;
    const set = new Set(ids);
    mutatePage((p) => {
      const aligned = absAlign(unionNodes(p), set, edge);
      const byId = new Map(aligned.map((n) => [n.id, n.layout]));
      return scatterLayouts(p, byId);
    });
  }, [mutatePage, unionNodes, scatterLayouts]);
  const distributeSelection = useCallback((ids: string[], axis: DistributeAxis) => {
    if (ids.length < 3) return;
    const set = new Set(ids);
    mutatePage((p) => {
      const dist = absDistribute(unionNodes(p), set, axis);
      const byId = new Map(dist.map((n) => [n.id, n.layout]));
      return scatterLayouts(p, byId);
    });
  }, [mutatePage, unionNodes, scatterLayouts]);

  // ── wave-4 free-form canvas handlers ─────────────────────────────────────────
  /** Commit a batch of drag/resize moves as ONE mutation → one undo entry. */
  const applyLayoutMoves = useCallback((moves: Array<{ id: string; layout: AbsRect }>) => {
    if (!moves.length) return;
    const byId = new Map(moves.map((m) => [m.id, m.layout]));
    mutatePage((p) => {
      // Drag/resize/nudge can move BOTH data visuals and elements (one merged
      // canvas node array) — write each move back to its array by id.
      const np: DPage = { ...p, visuals: p.visuals.map((v) => (byId.has(v.id) ? { ...v, layout: { ...v.layout, ...byId.get(v.id)! } } : v)) };
      if (p.elements && p.elements.length) {
        np.elements = p.elements.map((e) => (byId.has(e.id) ? { ...e, layout: { ...e.layout, ...byId.get(e.id)! } } : e));
      }
      return np;
    });
  }, [mutatePage]);

  /** Canvas selection: additive (ctrl/shift) toggles the multi-set; plain click
   *  selects one (clearing the multi-set); null clears everything. */
  const onCanvasSelect = useCallback((vid: string | null, additive: boolean) => {
    if (vid == null) { setSelectedVisual(null); setSelectedVisualIds(new Set()); return; }
    if (additive) { toggleMultiSelect(vid); return; }
    setSelectedVisual(vid); setSelectedVisualIds(new Set());
  }, [toggleMultiSelect]);

  /** Marquee result → multi-set (merged when additive). */
  const onCanvasMarquee = useCallback((ids: string[], additive: boolean) => {
    setSelectedVisualIds((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (const x of ids) next.add(x);
      return next;
    });
    if (ids[0]) setSelectedVisual(ids[0]);
  }, []);

  /** Group targeted visuals under one new groupId; ungroup clears it. */
  const groupVisuals = useCallback((ids: string[]) => {
    if (ids.length < 2) return;
    const gid = uid('grp');
    const set = new Set(ids);
    mutatePage((p) => {
      const np: DPage = { ...p, visuals: p.visuals.map((v) => (set.has(v.id) ? { ...v, groupId: gid } : v)) };
      if (p.elements && p.elements.length) np.elements = p.elements.map((e) => (set.has(e.id) ? { ...e, groupId: gid } : e));
      return np;
    });
  }, [mutatePage]);
  const ungroupVisuals = useCallback((ids: string[]) => {
    const set = new Set(ids);
    mutatePage((p) => {
      const np: DPage = { ...p, visuals: p.visuals.map((v) => (set.has(v.id) ? { ...v, groupId: undefined } : v)) };
      if (p.elements && p.elements.length) np.elements = p.elements.map((e) => (set.has(e.id) ? { ...e, groupId: undefined } : e));
      return np;
    });
  }, [mutatePage]);

  /** Select every member of a node's group (click a group badge / Selection pane)
   *  — across BOTH visuals and elements (a group can mix the two). */
  const selectGroup = useCallback((gid: string) => {
    const p = pages[activePage];
    const members = [
      ...(p?.visuals || []).filter((v) => v.groupId === gid).map((v) => v.id),
      ...(p?.elements || []).filter((e) => e.groupId === gid).map((e) => e.id),
    ];
    setSelectedVisualIds(new Set(members));
    if (members[0]) setSelectedVisual(members[0]);
  }, [pages, activePage]);

  // ── wave-2: drillthrough (navigate to a target page seeded from a selection) ──
  // A page is a drillthrough TARGET when it declares drillthrough.fields. From a
  // source visual with an active selection (a clicked table row / slicer pick),
  // the right-click menu offers each target whose fields the selection satisfies;
  // choosing one opens it filtered to the selected value(s) with a Back button.
  const drillSeedFor = useCallback((target: DPage, sel: VisualSelection | null): ReportFilter[] | null => {
    const fields = target.drillthrough?.fields || [];
    if (!fields.length || !sel) return null;
    const out: ReportFilter[] = [];
    for (const f of fields) {
      const want = (f.column || f.measure || '').toLowerCase();
      if (!want) continue;
      const con = sel.constraints.find((c) => {
        const k = c.field.toLowerCase();
        return k === want || k.endsWith(`[${want}]`) || k.endsWith(`.${want}`);
      });
      const val = con?.values?.[0];
      if (val == null) continue;
      out.push({ id: uid('flt'), table: f.table, column: f.column, measure: f.measure, op: 'eq', value: String(val) });
    }
    return out.length ? out : null;
  }, []);

  const navigateDrillthrough = useCallback((targetIndex: number, seed: ReportFilter[], label: string) => {
    setDrill({ fromPage: activePage, toPage: targetIndex, filters: seed, label });
    setActivePage(targetIndex);
    setSelectedVisual(null); setSelectedVisualIds(new Set());
  }, [activePage]);

  const exitDrillthrough = useCallback(() => {
    setDrill((d) => { if (d) setActivePage(d.fromPage); return null; });
  }, []);

  // ── wave-2: bookmarks (rich model — ./report/bookmarks-pane) ─────────────────
  // Build the host's CURRENT state into a capture source the pure
  // `captureBookmarkState` snapshots. Pages/visuals are keyed by their (session-
  // stable) ids — apply resolves ids back to live pages/visuals and skips any that
  // no longer exist, matching the bookmarks-pane contract.
  const buildCaptureSource = useCallback((scope: BookmarkScope): BookmarkCaptureSource => ({
    activePageId: pages[activePage]?.id || '',
    reportFilters,
    pages: pages.map((p) => ({
      id: p.id,
      filters: p.filters || [],
      visuals: (p.visuals || []).map((v) => ({ id: v.id, hidden: v.hidden, z: v.z, filters: v.filters || [] })),
    })),
    selection,
    scope,
    selectedVisualIds: scope === 'selectedVisuals' ? [...selectedVisualIds] : undefined,
  }), [pages, activePage, reportFilters, selection, selectedVisualIds]);

  // Add (replaceId omitted → append a NEW bookmark) or Update (replaceId set →
  // re-capture into the existing bookmark, preserving its id/name). Drives the
  // Bookmarks pane's Add popover + each card's Update action.
  const captureBookmark = useCallback((opts: { name?: string; scope: BookmarkScope; apply: BookmarkApply; replaceId?: string }) => {
    const state = captureBookmarkState(buildCaptureSource(opts.scope));
    setBookmarks((prev) => {
      if (opts.replaceId) {
        return prev.map((b) => (b.id === opts.replaceId
          ? { ...b, scope: opts.scope, apply: opts.apply, state, createdAt: new Date().toISOString() }
          : b));
      }
      return [...prev, newBookmark({ name: opts.name || `Bookmark ${prev.length + 1}`, scope: opts.scope, apply: opts.apply }, state)];
    });
    setDirty(true);
  }, [buildCaptureSource]);

  // Apply a bookmark — turn it into a structured patch (honoring its Data/Display/
  // Current-page toggles + scope) and restore the live model: active page, report/
  // page/visual filters, slicer selection, per-visual visibility + z-order. Ids
  // that no longer resolve are skipped (no throw).
  const applyBookmark = useCallback((bm: ReportBookmark) => {
    const patch = bookmarkToPatch(bm);
    if (patch.activePageId) {
      const idx = pages.findIndex((p) => p.id === patch.activePageId);
      if (idx >= 0) setActivePage(idx);
    }
    if (patch.reportFilters) setReportFilters(patch.reportFilters);
    const touchesPages = patch.pageFilters || patch.visualFilters || patch.visibility || patch.zOrder;
    if (touchesPages) {
      setPages((prev) => prev.map((p) => {
        let np = p;
        if (patch.pageFilters && patch.pageFilters[p.id]) np = { ...np, filters: patch.pageFilters![p.id] };
        if (patch.visualFilters || patch.visibility || patch.zOrder) {
          np = {
            ...np,
            visuals: np.visuals.map((v) => {
              let nv = v;
              if (patch.visibility && patch.visibility[v.id] !== undefined) nv = { ...nv, hidden: !patch.visibility![v.id] };
              if (patch.zOrder && patch.zOrder[v.id] !== undefined) nv = { ...nv, z: patch.zOrder![v.id] };
              if (patch.visualFilters && patch.visualFilters[v.id]) nv = { ...nv, filters: patch.visualFilters![v.id] };
              return nv;
            }),
          };
        }
        return np;
      }));
    }
    if (patch.selection !== undefined) setSelection(patch.selection);
    setDirty(true);
  }, [pages]);

  // List-only mutations (reorder / rename / delete) the Bookmarks pane emits.
  const changeBookmarks = useCallback((next: ReportBookmark[]) => {
    setBookmarks(next);
    setDirty(true);
  }, []);

  // ── wave-7: element-render context (the glue the sibling node renderers +
  //    property pane consume) ──────────────────────────────────────────────────
  // Every field below drives a REAL behaviour (no-vaporware): a data-bound text
  // token / measure-driven image src resolves a REAL aggregated value via the
  // shared /query (resolveToken → queryAdHoc); page/bookmark navigators + button
  // actions dispatch the SAME host handlers the chrome already uses; onChange
  // writes the structured element model back through mutateElement. Pure client +
  // the existing /query + /definition — zero Fabric / Power BI.

  /** Open a (route-clamped: https / mailto / data:image only) URL from a button,
   *  text-run, or image link. clampUrl on the /definition side keeps persisted
   *  links safe (javascript:/vbscript: rejected). */
  const onOpenUrl = useCallback((url: string) => {
    if (!url) return;
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked — no-op */ }
  }, []);

  /** Navigate to a page by index (page-navigator buttons) or by id (button
   *  pageNavigation action). Mirrors a page-tab click. */
  const onNavigatePage = useCallback((target: number | string) => {
    if (typeof target === 'number') { setActivePage(Math.max(0, Math.min(pages.length - 1, target))); return; }
    const idx = pages.findIndex((p) => p.id === target);
    if (idx >= 0) setActivePage(idx);
  }, [pages]);

  /** Resolve a data-bound element token to a REAL aggregated scalar through the
   *  shared /query (Path-3 wells→SQL over the bound Loom semantic model), honoring
   *  the active page + report (+ drillthrough) filter scope — exactly the scope a
   *  visual on this page sees. Returns the value column (the last selected column);
   *  the sibling renderer formats it via formatTokenValue + caches per token. */
  const resolveToken = useCallback(async (token: FieldToken): Promise<unknown> => {
    const drillScope = drill && drill.toPage === activePage ? drill.filters : [];
    // wireFilters yields the exact wire shape /query consumes (identical to the
    // per-visual runVisual POST); the cast bridges the two structurally-equal
    // filter types (FilterOp vs ReportFilterOp) across the module boundary.
    const scope = wireFilters([...reportFilters, ...drillScope, ...(page?.filters || [])]) as unknown as ReportFilterInput[];
    const rows = await queryAdHoc(tokenToSpec(token), scope);
    const row = rows[0];
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[keys.length - 1]] : null;
  }, [queryAdHoc, reportFilters, drill, activePage, page?.filters]);

  /** Dispatch a button element's action to the SAME host handlers the report
   *  chrome already uses — every branch DOES something real (no dead control):
   *   • back → exit drillthrough / back-bar    • bookmark → applyBookmark
   *   • pageNavigation / drillthrough → setActivePage / seeded drill
   *   • qna → open the Q&A / Copilot pane       • webUrl → open the clamped URL */
  const onElementAction = useCallback((action: ButtonAction) => {
    switch (action.type) {
      case 'back': exitDrillthrough(); break;
      case 'bookmark': { const bm = bookmarks.find((b) => b.id === action.bookmarkId); if (bm) applyBookmark(bm); break; }
      case 'pageNavigation': if (action.pageId) onNavigatePage(action.pageId); break;
      case 'drillthrough': {
        const idx = pages.findIndex((p) => p.id === action.pageId);
        if (idx >= 0) { const seed = selection ? drillSeedFor(pages[idx], selection) : null; navigateDrillthrough(idx, seed || [], pages[idx].name); }
        break;
      }
      case 'qna': setRightTab('copilot'); break;
      case 'webUrl': if (action.url) onOpenUrl(action.url); break;
    }
  }, [bookmarks, applyBookmark, pages, selection, exitDrillthrough, drillSeedFor, navigateDrillthrough, onNavigatePage, onOpenUrl]);

  /** The context object the sibling node renderers (renderElement /
   *  renderElementChrome) + the element property pane read. Memoized so the
   *  renderers' token-resolve effects don't thrash on every parent render. */
  const elemCtx = useMemo(() => ({
    reportId: id,
    readOnly: personalize.active,
    tables,
    pages: pages.map((p, i) => ({ id: p.id, name: p.name, index: i, hidden: !!p.hidden })),
    activePageId: page?.id ?? '',
    bookmarks,
    resolveToken,
    onNavigatePage,
    onApplyBookmark: applyBookmark,
    onAction: onElementAction,
    onChange: mutateElement,
    onRemove: removeElement,
    onOpenUrl,
  }), [id, personalize.active, tables, pages, page?.id, bookmarks, resolveToken, onNavigatePage, applyBookmark, onElementAction, mutateElement, removeElement, onOpenUrl]);

  // ── pages ──────────────────────────────────────────────────────────────────
  const addPage = () => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  };
  const renamePage = (pid: string, name: string) => {
    setPages((prev) => prev.map((p) => (p.id === pid ? { ...p, name } : p)));
    setDirty(true);
  };
  const deletePage = (pid: string) => {
    setPages((prev) => {
      const next = prev.filter((p) => p.id !== pid);
      const safe = next.length ? next : [{ id: uid('p'), name: 'Page 1', visuals: [] }];
      setActivePage((ap) => Math.max(0, Math.min(ap, safe.length - 1)));
      return safe;
    });
    setDirty(true);
  };
  /** Duplicate a page (deep-clone its visuals + wells with fresh client ids). */
  const duplicatePage = (pid: string) => {
    setPages((prev) => {
      const idx = prev.findIndex((p) => p.id === pid);
      if (idx < 0) return prev;
      const src = prev[idx];
      const cloneWells = (w: Wells): Wells => {
        const c = (a?: WellField[]) => (a || []).map((f) => ({ ...f, uid: uid('f') }));
        return {
          category: c(w.category), values: c(w.values), legend: c(w.legend),
          secondaryValues: c(w.secondaryValues), target: c(w.target),
          minimum: c(w.minimum), maximum: c(w.maximum),
          smallMultiples: c(w.smallMultiples), tooltips: c(w.tooltips), details: c(w.details),
          size: c(w.size), playAxis: c(w.playAxis), latitude: c(w.latitude), longitude: c(w.longitude),
        };
      };
      const dup: DPage = {
        ...src,
        id: uid('p'),
        name: `${src.name} (copy)`,
        interactions: undefined, // visual ids change → drop the old matrix
        filters: (src.filters || []).map((f) => ({ ...f, id: uid('flt') })),
        visuals: src.visuals.map((v) => ({ ...v, id: uid('v'), wells: cloneWells(v.wells), filters: (v.filters || []).map((f) => ({ ...f, id: uid('flt') })) })),
        // wave-7: deep-clone canvas ELEMENTS with fresh ids too — Power BI carries
        // Insert objects (text / shape / image / button / page+bookmark navigators)
        // onto a duplicated page. Without this the `...src` spread would share the
        // SAME elements array + ids across both pages (editing the copy would mutate
        // the source, and element ids would collide page-to-page); map to independent
        // objects so each page owns its own. Mirrors the `visuals` deep-clone above.
        elements: src.elements ? src.elements.map((e): CanvasElement => ({ ...e, id: uid('el') })) : undefined,
      };
      const next = [...prev.slice(0, idx + 1), dup, ...prev.slice(idx + 1)];
      setActivePage(idx + 1);
      return next;
    });
    setSelectedVisual(null);
    setDirty(true);
  };
  /** Toggle a page's hidden flag (hidden pages are still authored + persisted). */
  const toggleHidePage = (pid: string) => {
    setPages((prev) => prev.map((p) => (p.id === pid ? { ...p, hidden: !p.hidden } : p)));
    setDirty(true);
  };

  // ── Power BI Copilot actions (applied to the SAME in-memory designer state) ──
  // The Copilot pane proposes structured specs (never DAX); the user approves and
  // these handlers add the visual / page to the active page. The visual then
  // live-renders via …/query and persists on the existing Save (PUT …/definition).
  const applyCopilotVisual = useCallback((spec: CopilotVisualSpec) => {
    const reUid = (a?: Array<{ table?: string; column?: string; measure?: string; aggregation?: Agg }>): WellField[] =>
      (a || []).map((f) => ({ uid: uid('f'), ...f }));
    const v: DVisual = {
      id: uid('v'),
      type: spec.type,
      title: spec.title || VISUALS.find((x) => x.type === spec.type)?.label || spec.type,
      wells: {
        category: reUid(spec.wells?.category),
        values: reUid(spec.wells?.values),
        legend: reUid(spec.wells?.legend),
      },
      w: spec.w && spec.w >= 2 ? Math.min(12, spec.w) : (spec.type === 'card' ? 3 : 6),
      h: spec.h && spec.h >= 1 ? spec.h : 4,
    };
    mutatePage((p) => {
      const dims = pageDims(p);
      const isKpi = COMPACT_TYPES.has(spec.type);
      const w = isKpi ? 280 : 480; const h = isKpi ? 200 : 320;
      const n = p.visuals.length;
      const z = p.visuals.reduce((m, vv) => Math.max(m, (vv.layout?.z ?? -1)), -1) + 1;
      const vv: DVisual = { ...v, layout: {
        x: Math.max(0, Math.min(dims.width - w, 40 + (n % 6) * 28)),
        y: Math.max(0, Math.min(dims.height - h, 40 + (n % 6) * 28)), w, h, z,
      } };
      setSelectedVisual(vv.id);
      return { ...p, visuals: [...p.visuals, vv] };
    });
  }, [mutatePage]);

  const addCopilotPage = useCallback((name?: string) => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: (name || '').trim() || `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  }, []);

  // ── save ─────────────────────────────────────────────────────────────────────
  // Build the wire `/definition` body from the in-memory designer model (shared
  // by the existing-item Save and the first-save create flow). dataSource is
  // ignored by …/definition (owned by …/data-source) but kept for completeness.
  const buildDefinitionBody = useCallback(() => ({
    pages: pages.map((p) => ({
      name: p.name,
      filters: wireFilters(p.filters || []),
      // Page config (canvas type/size/background, hidden, interaction matrix). The
      // route's sanitizePageConfig drops empty fields, so a plain page persists
      // nothing extra. wireInteractions strips empty buckets. The wave-2
      // drillthrough / tooltipPage keys are ADDITIVE — today's sanitizer ignores
      // them (harmless), and they round-trip once it whitelists them.
      config: {
        ...(p.canvasType ? { type: p.canvasType } : {}),
        ...(p.size ? { size: p.size } : {}),
        ...(p.background ? { background: p.background } : {}),
        ...(p.hidden ? { hidden: true } : {}),
        ...(wireInteractions(p.interactions) ? { interactions: wireInteractions(p.interactions) } : {}),
        ...(p.drillthrough && p.drillthrough.fields.length ? { drillthrough: { fields: p.drillthrough.fields } } : {}),
        ...(p.tooltipPage && p.tooltipPage.enabled ? { tooltipPage: p.tooltipPage } : {}),
      },
      visuals: p.visuals.map((v, vi) => ({
        visualType: v.type,
        title: v.title,
        // Persist the FULL authoring wells (base + additive); queryVisual folds
        // them for the /query call — they round-trip here for faithful reload.
        wells: wireWells(v.wells),
        // ABSOLUTE free-form layout (px). `unit:'px'` is the marker the loader
        // reads to treat x/y/w/h as canvas pixels (not 12-col grid spans) — so a
        // round-trip is lossless and never re-migrates. z = paint order. A visual
        // that somehow lacks `layout` falls back to its legacy grid w/h.
        layout: v.layout
          ? { x: Math.round(v.layout.x), y: Math.round(v.layout.y), w: Math.round(v.layout.w), h: Math.round(v.layout.h), z: v.layout.z ?? vi, unit: 'px' }
          : { x: 0, y: 0, w: v.w, h: v.h, z: v.z ?? vi },
        format: v.format,
        analytics: v.analytics,
        filters: wireFilters(v.filters || []),
        // Wave-2 object state — ADDITIVE (today's sanitizer drops unknown visual
        // keys; persists once it whitelists them). In-session use is unaffected.
        ...(v.hidden ? { hidden: true } : {}),
        ...(v.locked ? { locked: true } : {}),
        ...(v.groupId ? { groupId: v.groupId } : {}),
        // Wave-4 script-visual config — ADDITIVE, same as the wave-2 keys above.
        // language round-trips back to config.language; the script text to
        // config.script. Omitted for every non-script visual (config is undefined).
        ...(v.config?.language ? { language: v.config.language } : {}),
        ...(v.config?.script ? { script: v.config.script } : {}),
        // Wave-5 slicer style — ADDITIVE, same pattern; round-trips the chosen PBI
        // slicer interaction style. Omitted for every non-slicer visual.
        ...(v.config?.slicerStyle ? { slicerStyle: v.config.slicerStyle } : {}),
      })),
      // Wave-7 free-form ELEMENTS — ADDITIVE sibling of `visuals` (NOT under
      // config). wireElements cleans + caps; the /definition route's
      // sanitizeElements is the security/structure gate (whitelists kind/layout/
      // per-kind props + runs every URL through clampUrl). Today's sanitizer +
      // the read-only viewer + the PBIR provisioner IGNORE an unknown `elements`
      // key, so this is back-compat safe; it round-trips once the route
      // whitelists it. `?? []` keeps the key present + harmless when empty.
      elements: wireElements(p.elements) ?? [],
    })),
    reportFilters: wireFilters(reportFilters),
    // Top-level bookmarks (PBI Bookmarks pane). The rich `wireBookmarks` shape —
    // { name, scope, apply{data,display,currentPage}, state{activePageId,
    // pageFilters, reportFilters, visibility, zOrder, …} } — is exactly what the
    // /definition route's sanitizeBookmark whitelists into state.content.bookmarks
    // (additive; viewer + PBIR provisioner ignore it).
    bookmarks: wireBookmarks(bookmarks) ?? [],
    // Filters-pane format (pane colors) — additive, sanitizer-whitelisted; omitted
    // when nothing is set (wireFilterPaneFormat returns undefined → route drops it).
    filterPaneFormat: wireFilterPaneFormat(filterPaneFormat),
    // Report theme (wave-3) — additive on state.content.theme (mirrors bookmarks /
    // filterPaneFormat). Omitted when none is set so a default report persists nothing.
    theme: theme ?? undefined,
    dataSource,
  }), [pages, reportFilters, bookmarks, filterPaneFormat, theme, dataSource]);

  const save = useCallback(async () => {
    // Brand-new report: route Save to the create-then-redirect flow (the
    // /definition route has no create path for id === 'new').
    if (isNew) {
      setCreateErr(null);
      setCreateName((prev) => prev || reportName.trim() || 'Untitled report');
      setCreateOpen(true);
      return;
    }
    setSaveBusy(true); setSaveMsg(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDefinitionBody()),
      });
      const j = await r.json();
      if (j.ok) { setDirty(false); setSaveMsg({ ok: true, text: `Saved ${j.pageCount} page(s), ${j.visualCount} visual(s).` }); }
      else setSaveMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [isNew, id, reportName, buildDefinitionBody]);

  // ── first-save create: mint the real item, persist layout + data source, open it ──
  // Lazily load the caller's workspaces when the create dialog opens (the report
  // needs a home workspace, just like every other focused editor's /new gate).
  useEffect(() => {
    if (!createOpen || workspaces !== null) return;
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        if (j.ok) {
          const list = (j.workspaces || []) as { id: string; name: string }[];
          setWorkspaces(list);
          setCreateWsId((prev) => prev || list[0]?.id || '');
        } else { setWorkspaces([]); setWsErr(j.error || `HTTP ${r.status}`); }
      } catch (e: any) { setWorkspaces([]); setWsErr(e?.message || String(e)); }
    })();
  }, [createOpen, workspaces]);

  const createNewReport = useCallback(async () => {
    const name = createName.trim() || reportName.trim() || 'Untitled report';
    if (!createWsId) { setCreateErr('Select a workspace for the new report.'); return; }
    setCreateBusy(true); setCreateErr(null);
    try {
      // 1. Mint the real Cosmos `report` item (generic create route).
      const cr = await fetch('/api/cosmos-items/report', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: createWsId, displayName: name }),
      });
      const cj = await cr.json().catch(() => ({} as any));
      if (!cr.ok || !cj?.ok || !cj.item?.id) throw new Error(cj?.error || `Could not create the report (HTTP ${cr.status}).`);
      const newId: string = cj.item.id;

      // 2. Persist the designed pages/visuals/filters against the new id.
      const dr = await fetch(`/api/items/report/${encodeURIComponent(newId)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDefinitionBody()),
      });
      const dj = await dr.json().catch(() => ({} as any));
      if (!dr.ok || !dj?.ok) throw new Error(dj?.error || `Saving the report layout failed (HTTP ${dr.status}).`);

      // 3. Persist the chosen data source if one was bound in-session. Non-fatal:
      //    a validation reject shouldn't strand the created report — the live
      //    editor will show its honest "pick a data source" gate.
      if (isBound(dataSource) && dataSource) {
        await fetch(`/api/items/report/${encodeURIComponent(newId)}/data-source`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataSource }),
        }).catch(() => { /* swallow — re-pickable in the live editor */ });
      }

      // 4. Open the live editor (full Save / Publish / fields now wired to a real id).
      setDirty(false);
      router.push(`/items/report/${encodeURIComponent(newId)}`);
      // intentionally leave createBusy=true while we navigate away
    } catch (e: any) {
      setCreateErr(e?.message || String(e)); setCreateBusy(false);
    }
  }, [createName, reportName, createWsId, buildDefinitionBody, dataSource, router]);


  // ── data source: persist the chosen source (PUT …/data-source) ────────────────
  // The picker hands us the chosen ReportDataSource; we persist it on the report
  // item's state.dataSource. For a not-yet-saved report (id === 'new') the source
  // is held in session and committed on first Save. If the v2 data-source route
  // isn't present we keep the selection active for the session and say so (honest
  // gate, no silent no-op) — the default AAS source already drives /fields + /query.
  const applyDataSource = useCallback(async (ds: ReportDataSource) => {
    if (id === 'new') {
      setDataSource(ds); setDsOpen(false); setDirty(true);
      setDsNote({ ok: true, text: `Data source set (${describeSource(ds)}). Save the report to persist it.` });
      return;
    }
    setDsSaving(true); setDsNote(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/data-source`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataSource: ds }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setDataSource(parseDataSource(j.dataSource) ?? ds);
        setDsNote({ ok: true, text: `Data source saved (${describeSource(ds)}).` });
      } else {
        setDataSource(ds);
        setDsNote({ ok: false, text: j?.error || `Selection active for this session (data-source route returned HTTP ${r.status}).` });
      }
    } catch (e: any) {
      setDataSource(ds);
      setDsNote({ ok: false, text: `Selection active for this session (${e?.message || String(e)}).` });
    } finally {
      setDsSaving(false); setDsOpen(false); loadFields();
    }
  }, [id, loadFields]);

  // ── publish ───────────────────────────────────────────────────────────────────
  // Default target is the Azure-native Organization gallery (Cosmos snapshot);
  // Power BI is opt-in (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi + a workspace). Either
  // way we POST to the canonical publish route and surface its real response or an
  // honest gate naming the missing target — never a silent success.
  const doPublish = useCallback(async () => {
    setPublishBusy(true); setPublishMsg(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: publishTarget }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setPublishMsg({ ok: true, text: j.message || (publishTarget === 'powerbi'
          ? 'Published to the Power BI workspace.'
          : 'Published to the Organization gallery (/org-reports).') });
      } else {
        setPublishMsg({ ok: false, text: j?.error || `Publishing requires the report publish route / target to be configured (HTTP ${r.status}).` });
      }
    } catch (e: any) { setPublishMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setPublishBusy(false); }
  }, [id, publishTarget]);

  // ── wave-3: export (PBI Export ▸ PDF / PPTX / PNG + Print) ────────────────────
  // visualId → that visual's last real /query rows (data in == data out) for the
  // dependency-free client exporters (print HTML + PNG raster reuse these rows).
  const rowsByVisual = useMemo(() => {
    const m: Record<string, Array<Record<string, unknown>>> = {};
    for (const k of Object.keys(visualRows)) m[k] = visualRows[k].rows;
    return m;
  }, [visualRows]);

  // Build the self-contained, theme-aware print/PNG document for a scope.
  const getPrintHtml = useCallback((scope: ExportScope) => buildReportPrintHtml(
    pages as PrintPage[], rowsByVisual, theme ?? null, scope, page?.id, reportName || 'Report',
  ), [pages, rowsByVisual, theme, page?.id, reportName]);

  // Always-on client "Print / Save as PDF" — never a dead button (zero infra).
  const onExportPrint = useCallback((scope: ExportScope) => {
    printReport(scope, getPrintHtml).catch(() => { /* pop-up/print blocked — no-op */ });
  }, [getPrintHtml]);

  // Always-on client PNG of the live canvas grid (SVG foreignObject → canvas).
  const onExportPng = useCallback(async () => {
    setExportMsg(null);
    const el = gridRef.current;
    if (!el) { setExportMsg({ ok: false, text: 'Add a visual to the page before exporting a PNG.' }); return; }
    try {
      const blob = await pngOfElement(el);
      downloadBlobObject(`${slugify(reportName || 'report')}-${slugify(page?.name || 'page')}.png`, blob);
    } catch (e: any) {
      setExportMsg({ ok: false, text: `PNG export failed (${e?.message || String(e)}). Use Print / Save as PDF instead.` });
    }
  }, [reportName, page?.name]);

  // High-fidelity export → the report /export route. Azure-native loom-native
  // renderer by default; downloads REAL bytes on a binary 200, else surfaces the
  // route's honest gate (e.g. set LOOM_REPORT_RENDERER) verbatim — never silent.
  const onServerExport = useCallback(async (format: ExportFormat, scope: ExportScope) => {
    setExportMsg(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'loom-native', format, scope }),
      });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (r.ok && !ct.includes('application/json')) {
        const blob = await r.blob();
        downloadBlobObject(`${slugify(reportName || 'report')}.${format.toLowerCase()}`, blob);
        setExportMsg({ ok: true, text: `Exported ${format}.` });
      } else {
        const j = await r.json().catch(() => ({} as Record<string, unknown>));
        setExportMsg({
          ok: false,
          text: (j?.error as string)
            || `High-fidelity ${format} export needs the Loom report renderer (set LOOM_REPORT_RENDERER) — use Print / Save as PDF for a no-setup file. (HTTP ${r.status})`,
        });
      }
    } catch (e: any) { setExportMsg({ ok: false, text: e?.message || String(e) }); }
  }, [id, reportName]);

  // ── wave-3: shared AI-visual wiring (one bundle for every AI surface) ─────────
  // narrativePageRows = the active page's REAL /query rows for its NON-AI visuals;
  // the smart narrative summarizes these (it never fetches page data itself).
  const narrativePageRows: SmartNarrativeVisualRows[] = useMemo(
    () => (page?.visuals || [])
      .filter((v) => !AI_TYPES.has(v.type) && hasBinding(v))
      .map((v) => ({ visualTitle: v.title || undefined, type: v.type, rows: visualRows[v.id]?.rows || [] }))
      .filter((v) => v.rows.length > 0),
    [page?.visuals, visualRows],
  );
  const aiWiring: AiVisualWiring = useMemo(() => ({
    reportId: id, tables, queryAdHoc, onApplyVisual: applyCopilotVisual, pageRows: narrativePageRows,
  }), [id, tables, queryAdHoc, applyCopilotVisual, narrativePageRows]);

  // ── wave-4: script-visual host wiring (mirrors aiWiring) ──────────────────────
  // The script visual's editor edits live here: a language toggle / code change
  // patches the visual's config.{language,script}. mutateVisual marks the report
  // dirty (same persist path Format + wells use), so the edit rides the existing
  // Save (PUT …/definition) — additive config keys, no new persistence work here.
  const scriptWiring = useMemo(() => ({
    onChange: (vid: string, patch: { script?: string; language?: 'python' | 'r' }) =>
      mutateVisual(vid, (v) => ({ ...v, config: { ...(v.config || {}), ...patch } })),
  }), [mutateVisual]);

  // ── ribbon ───────────────────────────────────────────────────────────────────
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Report', actions: [
        { label: isNew ? 'Create report' : (saveBusy ? 'Saving…' : 'Save'), icon: <Save20Regular />, onClick: save, disabled: saveBusy || (!isNew && !dirty), title: isNew ? 'Name and create this report' : 'persist the whole report definition' },
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: () => { loadDetail(); loadFields(); }, title: 'reload definition + model fields' },
      ]},
      { label: 'Edit', actions: [
        { label: 'Undo', icon: <ArrowUndo20Regular />, onClick: undo, disabled: !canUndo, title: 'Undo (Ctrl+Z)' },
        { label: 'Redo', icon: <ArrowRedo20Regular />, onClick: redo, disabled: !canRedo, title: 'Redo (Ctrl+Y)' },
      ]},
      { label: 'Data', actions: [
        { label: 'Data source', icon: <Database20Regular />, onClick: () => setDsOpen(true), title: `Bind data — ${describeSource(dataSource)}` },
        { label: 'Publish', icon: <CloudArrowUp20Regular />, onClick: () => { setPublishMsg(null); setPublishOpen(true); }, disabled: isNew, title: isNew ? 'Save the report before publishing' : 'Publish to the Organization gallery' },
      ]},
      { label: 'Insert', actions: [
        { label: 'New page', icon: <Add20Regular />, onClick: addPage, title: 'add a report page' },
      ]},
    ]},
    // ── View tab (wave-3): report Themes + viewer Personalize ────────────────────
    { id: 'view', label: 'View', groups: [
      { label: 'Theme', actions: [
        { label: 'Themes', icon: <ColorRegular />, onClick: () => setThemesOpen(true), title: 'Restyle every visual — palette, font, background (Loom + custom themes)' },
      ]},
      // PBI "View" page-layout toggles — independent (snap-to-grid + gridlines).
      { label: 'Page layout', actions: [
        {
          label: 'Snap to grid', icon: <GridDots20Regular />,
          onClick: () => setSnapGrid((s) => !s),
          appearance: snapGrid ? 'primary' : undefined,
          title: 'Snap visuals to the grid when moving or resizing (Power BI "Snap objects to grid")',
        },
        {
          label: 'Gridlines', icon: <Grid20Regular />,
          onClick: () => setShowGrid((s) => !s),
          appearance: showGrid ? 'primary' : undefined,
          title: 'Show alignment gridlines on the canvas',
        },
      ]},
      { label: 'Reading', actions: [
        {
          label: personalize.active ? 'Personalizing' : 'Personalize',
          icon: <Edit20Regular />,
          onClick: () => personalize.toggleActive(),
          appearance: personalize.active ? 'primary' : undefined,
          title: 'Change visual types / fields for your own view — temporary, per-user, not saved',
        },
      ]},
    ]},
  ], [save, saveBusy, dirty, loadDetail, loadFields, dataSource, id, isNew, undo, redo, canUndo, canRedo, personalize.active, personalize.toggleActive, snapGrid, showGrid]);

  // ── left: pages ──────────────────────────────────────────────────────────────
  const leftPanel = (
    <div className={styles.pane}>
      <div className={styles.toolbar}>
        <Subtitle2>Pages</Subtitle2>
        <div className={styles.spacer} />
        <Tooltip content="Add page" relationship="label">
          <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={addPage} />
        </Tooltip>
      </div>
      {pages.map((p, i) => (
        <div key={p.id} className={mergeClasses(styles.pageRow, i === activePage && styles.pageRowActive)}
          onClick={() => { setActivePage(i); setSelectedVisual(null); }}>
          <Text className={mergeClasses(styles.pageRowName, p.hidden && styles.muted)}>{p.name}</Text>
          {p.hidden && (
            <Tooltip content="Hidden from report viewers" relationship="label">
              <EyeOff16Regular />
            </Tooltip>
          )}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label="page actions" onClick={(e) => e.stopPropagation()} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <RenamePageItem name={p.name} onRename={(n) => renamePage(p.id, n)} />
                <MenuItem icon={<Copy20Regular />} onClick={() => duplicatePage(p.id)}>Duplicate page</MenuItem>
                <MenuItem icon={p.hidden ? <Eye16Regular /> : <EyeOff16Regular />} onClick={() => toggleHidePage(p.id)}>
                  {p.hidden ? 'Unhide page' : 'Hide page'}
                </MenuItem>
                <MenuItem icon={<Delete20Regular />} onClick={() => deletePage(p.id)}>Delete page</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      ))}
      {pages.length === 0 && <Caption1 className={styles.muted}>No pages.</Caption1>}
    </div>
  );

  // ── free-form canvas render-props ─────────────────────────────────────────────
  // The wave-4 FreeFormCanvas owns positioning (absolute drag/resize/snap/guides);
  // the host supplies each visual's HEADER chrome + live BODY as render-props so
  // the existing VisualBody (/query render — UNCHANGED) and the card controls
  // (lock / hide / remove / drill / personalize) ride straight in. Every
  // interactive control carries data-ff-nodrag so clicking it never starts a move.
  const pageDimsActive = pageDims(page);
  const ffVisuals: Array<DVisual & { layout: AbsRect }> = effectiveVisuals.map((v, i) => ({
    ...v,
    layout: v.layout ?? { x: 24 + (i % 6) * 24, y: 24 + (i % 6) * 24, w: 480, h: 320, z: i },
  }));
  // ── wave-7: MERGE elements + data visuals into ONE FreeFormCanvas node array.
  // Element nodes adapt to the canvas's generic FFVisual (id + layout + locked? /
  // hidden? / groupId?) and carry the element on `__el`, so drag / resize / select
  // / marquee / snap / guides / keyboard all work on them unchanged, and the
  // shared `layout.z` interleaves paint order with the data visuals (PBI parity).
  const elementsActive = page?.elements || [];
  const canvasNodes: FFNode[] = [
    ...ffVisuals.map((v) => ({ ...v })),
    ...elementsActive.map((e) => ({
      id: e.id, layout: e.layout, locked: e.locked, hidden: e.hidden, groupId: e.groupId, __el: e,
    })),
  ];
  // Node count drives the empty-state / canvas / Arrange gates — a page with only
  // elements (no data visual) must still render the canvas + toolbars.
  const nodeCount = (page?.visuals.length || 0) + elementsActive.length;
  const canvasBg: CSSProperties = {
    ...(themeVars || {}),
    ...(page?.background?.color
      ? { backgroundColor: applyAlpha(page.background.color, page.background.transparency) }
      : {}),
  };

  const renderVisualChrome = (v: DVisual): ReactElement => {
    const fmt = v.format;
    const showTitle = fmt?.showTitle !== false;
    const titleText = (fmt?.titleText && fmt.titleText.trim()) || v.title || '(untitled)';
    const locked = !!v.locked;
    const drillTargets = (selection && selection.sourceId === v.id)
      ? pages.map((tp, ti) => ({ tp, ti, seed: drillSeedFor(tp, selection) }))
          .filter((x) => x.ti !== activePage && x.seed && x.seed.length)
      : [];
    return (
      <>
        <Badge appearance="tint" size="small" data-ff-nodrag>{VISUALS.find((x) => x.type === v.type)?.label || v.type}</Badge>
        {v.groupId && (
          <Tooltip content="Select group" relationship="label">
            <Badge appearance="outline" size="small" color="brand" data-ff-nodrag style={{ cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); selectGroup(v.groupId as string); }}>Group</Badge>
          </Tooltip>
        )}
        {v.hidden && <Badge appearance="tint" size="small" color="warning" data-ff-nodrag>Hidden</Badge>}
        {showTitle
          ? <Text className={styles.vcardTitle} weight="semibold">{titleText}</Text>
          : <div className={styles.spacer} />}
        {drillTargets.length > 0 && (
          <span data-ff-nodrag>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Tooltip content="Drill through" relationship="label">
                  <Button size="small" appearance="subtle" icon={<ArrowExpand20Regular />} aria-label="drill through" onClick={(e) => e.stopPropagation()} />
                </Tooltip>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuGroupHeader>Drill through to</MenuGroupHeader>
                  {drillTargets.map(({ tp, ti, seed }) => (
                    <MenuItem key={tp.id} onClick={(e) => { e.stopPropagation(); navigateDrillthrough(ti, seed as ReportFilter[], tp.name); }}>{tp.name}</MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
          </span>
        )}
        {personalize.active ? (
          <span data-ff-nodrag>
            <PersonalizePopover
              visual={v as unknown as PersonalizeVisual}
              override={personalize.overrideFor(v.id)}
              fields={fieldOptions(tables)}
              onChangeType={(t) => personalize.setOverride(v.id, { type: t })}
              onSwapField={(well, fields) => personalize.setOverride(v.id, { wells: { [well]: fields } })}
              onReset={() => personalize.resetVisual(v.id)}
            />
          </span>
        ) : (
          <span data-ff-nodrag style={{ display: 'inline-flex', gap: tokens.spacingHorizontalXXS }}>
            <Tooltip content={locked ? 'Unlock' : 'Lock'} relationship="label">
              <Button size="small" appearance="subtle" icon={locked ? <LockClosed20Regular /> : <LockOpen20Regular />}
                onClick={(e) => { e.stopPropagation(); setVisualFlag([v.id], { locked: !locked }); }} />
            </Tooltip>
            <Tooltip content={v.hidden ? 'Show' : 'Hide'} relationship="label">
              <Button size="small" appearance="subtle" icon={v.hidden ? <EyeOff20Regular /> : <Eye20Regular />}
                onClick={(e) => { e.stopPropagation(); setVisualFlag([v.id], { hidden: !v.hidden }); }} />
            </Tooltip>
            <Tooltip content="Bring to front" relationship="label">
              <Button size="small" appearance="subtle" icon={<PositionToFront20Regular />}
                onClick={(e) => { e.stopPropagation(); reorderZ([v.id], 'front'); }} />
            </Tooltip>
            <Tooltip content="Send to back" relationship="label">
              <Button size="small" appearance="subtle" icon={<PositionToBack20Regular />}
                onClick={(e) => { e.stopPropagation(); reorderZ([v.id], 'back'); }} />
            </Tooltip>
            <Tooltip content="Remove visual" relationship="label">
              <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                onClick={(e) => { e.stopPropagation(); removeVisual(v.id); }} />
            </Tooltip>
          </span>
        )}
      </>
    );
  };

  const renderVisualBody = (v: DVisual): ReactElement => {
    const drillFilters = drill && drill.toPage === activePage ? drill.filters : [];
    const merged = [...reportFilters, ...drillFilters, ...(page?.filters || []), ...(v.filters || [])];
    const interactionMode: InteractionMode = selection && selection.sourceId !== v.id && page
      ? resolveInteraction({ visuals: page.visuals, interactions: page.interactions }, selection.sourceId, v.id)
      : 'none';
    return (
      <VisualBody visual={v} state={visualRows[v.id]} styles={styles} filters={merged}
        selection={selection} interactionMode={interactionMode}
        themeChart={themeChart} ai={aiWiring} script={scriptWiring} reportId={id}
        onSelect={(sel) => setSelection(sel)}
        // Wave-5 slicer → page-filters channel. A slicer emit (or clear) REPLACES the
        // filter carrying its own stable id in the active page's filters, then the
        // re-query effect re-runs every visual with the new scope (the slicer itself
        // excludes its own id, so its list stays whole). applyFilters paints it
        // immediately; wells-to-sql's WHERE applies it server-side. Page edits are
        // a no-op while personalizing (mutatePage guards), matching every other edit.
        onPageFilter={(f, removeId) => mutatePage((p) => ({
          ...p,
          filters: [...(p.filters || []).filter((x) => x.id !== removeId), ...(f ? [f] : [])],
        }))}
        onSlicerStyle={(s) => mutateVisual(v.id, (vv) => ({ ...vv, config: { ...(vv.config || {}), slicerStyle: s } }))} />
    );
  };

  // ── center: canvas ───────────────────────────────────────────────────────────
  const main = (
    <div className={styles.canvasWrap}>
      <div className={styles.toolbar}>
        <Badge appearance="filled" color="brand">Report · Loom-native · {describeSource(dataSource)}</Badge>
        {reportName && <Subtitle2>{reportName}{page ? ` — ${page.name}` : ''}</Subtitle2>}
        <div className={styles.spacer} />
        {dirty && <Badge appearance="tint" color="warning">Unsaved</Badge>}
        {/* Export (PBI Export ▸ PDF / PPTX / PNG + always-on Print/PNG). Print &
            PNG always produce a real file client-side; the high-fidelity formats
            hit the /export route (real bytes or an honest renderer gate). */}
        <ExportMenu
          reportId={id}
          pbiEnabled={pbiPublishEnabled}
          currentPageName={page?.name}
          disabled={isNew || !page || page.visuals.length === 0}
          onServerExport={onServerExport}
          onPrint={onExportPrint}
          onPng={onExportPng}
        />
        <Button appearance="primary" icon={<Save20Regular />} disabled={saveBusy || (!isNew && !dirty)} onClick={save}>
          {isNew ? 'Create report' : (saveBusy ? 'Saving…' : 'Save')}
        </Button>
      </div>

      {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
      {saveMsg && <MessageBar intent={saveMsg.ok ? 'success' : 'error'}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
      {dsNote && <MessageBar intent={dsNote.ok ? 'success' : 'warning'}><MessageBarBody>{dsNote.text}</MessageBarBody></MessageBar>}
      {exportMsg && <MessageBar intent={exportMsg.ok ? 'success' : 'warning'}><MessageBarBody>{exportMsg.text}</MessageBarBody></MessageBar>
      }
      {/* Personalize (reading mode) banner — temporary, per-user, unsaved. */}
      {personalize.active && (
        <PersonalizeBanner count={personalize.count} onResetAll={personalize.resetAll} onExit={() => personalize.setActive(false)} />
      )}
      {!bound && !loading && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Choose a data source</MessageBarTitle>
            This report isn&apos;t bound to data yet. Click <strong>Data source</strong> to bind a Loom <strong>semantic model</strong>
            {' '}(Azure-native — Synapse / lakehouse, no Power BI or Fabric required), build one from a SQL query, or bind an
            {' '}Azure Analysis Services tabular model. You can lay out pages and visuals now; they render once a source is bound.
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="primary" icon={<Database20Regular />} onClick={() => setDsOpen(true)}>Data source</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading report…" />}

      {/* Drillthrough: on a target page, a Back bar returns to the source page. */}
      {drill && drill.toPage === activePage && (
        <div className={styles.backBar}>
          <Button size="small" appearance="primary" icon={<ArrowExit20Regular />} onClick={exitDrillthrough}>Back</Button>
          <Caption1>Drilled through{drill.label ? ` to ${drill.label}` : ''} — this page is filtered to the selected value.</Caption1>
        </div>
      )}

      {/* Arrange toolbar — acts on the multi-selection (Ctrl/Shift-click) or the
          single selection. Every control mutates the real, persisted layout.
          Hidden in personalize (reading) mode, where the definition is read-only. */}
      {!loading && !personalize.active && page && nodeCount > 0 && arrangeTargets().length > 0 && (
        <ArrangeBar
          styles={styles}
          targets={arrangeTargets()}
          // ArrangeBar reads only id / locked / hidden / groupId — pass the
          // visuals+elements union so lock/hide/group state is correct for an
          // element selection too (elements satisfy those four fields).
          visuals={[...page.visuals, ...(elementsActive as unknown as DVisual[])]}
          onLock={(lock) => setVisualFlag(arrangeTargets(), { locked: lock })}
          onHide={(hide) => setVisualFlag(arrangeTargets(), { hidden: hide })}
          onMatch={(dim) => matchSize(arrangeTargets(), dim)}
          onZ={(dir) => reorderZ(arrangeTargets(), dir)}
          onAlign={(edge) => alignSelection(arrangeTargets(), edge)}
          onDistribute={(axis) => distributeSelection(arrangeTargets(), axis)}
          onGroup={() => groupVisuals(arrangeTargets())}
          onUngroup={() => ungroupVisuals(arrangeTargets())}
          onClear={() => setSelectedVisualIds(new Set())}
        />
      )}

      {!loading && page && nodeCount === 0 && (
        <EmptyState
          icon={<DataBarVerticalRegular />}
          title="Design your first visual"
          body="Pick a visualization from the Visualizations pane on the right, then drag model fields into its wells. Every visual renders live against the bound data source. Insert text boxes, shapes, images, buttons, and navigators from the Elements gallery below it."
        />
      )}

      {!loading && page && nodeCount > 0 && (
        <div ref={gridRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <FreeFormCanvas<FFNode>
            visuals={canvasNodes}
            page={{ width: pageDimsActive.width, height: pageDimsActive.height, background: canvasBg }}
            selectedId={selectedVisual}
            selectedIds={selectedVisualIds}
            snapToGrid={snapGrid}
            showGrid={showGrid}
            readOnly={personalize.active}
            onSelect={onCanvasSelect}
            onMarquee={onCanvasMarquee}
            onLayout={applyLayoutMoves}
            // Union-aware delete (routes each id to its array); Ctrl+] / Ctrl+[
            // single-steps z over the shared visuals+elements z-space.
            onDelete={removeNodes}
            onZStep={reorderZStepUnion}
            // wave-7: an ELEMENT node drags from ANYWHERE on its body (PBI parity);
            // a data visual keeps header-only drag so its cross-filter clicks live.
            dragBody={(n) => !!n.__el}
            renderChrome={(n) => (n.__el ? renderElementChrome(n.__el, elemCtx) : renderVisualChrome(n))}
            renderVisual={(n) => (n.__el ? renderElement(n.__el, elemCtx) : renderVisualBody(n))}
            frameStyle={(n) => {
              // Elements paint their own surface (shape fill / image / text) edge to
              // edge — no card frame chrome over them.
              if (n.__el) return {};
              // Wave-3 Format-pane chrome over the frame: per-visual background,
              // border, and shadow (the same fmt the old card applied — no regress).
              const fmt = n.format;
              const s: CSSProperties = {};
              if (fmt?.background?.color) s.backgroundColor = applyAlpha(fmt.background.color, fmt.background.transparency);
              if (fmt?.border?.show) {
                s.border = `1px solid ${fmt.border.color || tokens.colorNeutralStroke1}`;
                if (fmt.border.radius != null) s.borderRadius = fmt.border.radius;
              }
              if (fmt?.shadow?.show) s.boxShadow = tokens.shadow16;
              return s;
            }}
          />
        </div>
      )}
    </div>
  );

  // ── right: visualizations + fields ──────────────────────────────────────────
  // Size presets — fractions of the page sheet (the free-form canvas is absolute,
  // so S/M/L/XL set the visual's px width to ¼ / ½ / ¾ / full page width with a
  // proportional height, the keyboard-accessible alternative to dragging a grip).
  const sizes: { label: string; frac: number; w: number }[] = [
    { label: 'S', frac: 0.25, w: 3 }, { label: 'M', frac: 0.5, w: 6 },
    { label: 'L', frac: 0.75, w: 9 }, { label: 'XL', frac: 1, w: 12 },
  ];
  const rightPanel = (
    <div className={styles.pane}>
      <TabList selectedValue={rightTab}
        onTabSelect={(_e, d) => setRightTab(d.value as RightTab)} size="small">
        <Tab value="build" icon={<DataBarVerticalRegular />}>Build</Tab>
        <Tab value="format" icon={<ColorRegular />}>Format</Tab>
        <Tab value="analytics" icon={<DataTrending20Regular />}>Analytics</Tab>
        <Tab value="filters" icon={<Filter20Regular />}>Filters</Tab>
        <Tab value="interactions" icon={<Options20Regular />}>Interactions</Tab>
        <Tab value="bookmarks" icon={<BookmarkMultiple20Regular />}>Bookmarks</Tab>
        <Tab value="selection" icon={<Layer20Regular />}>Selection</Tab>
        <Tab value="copilot" icon={<Sparkle20Regular />}>Power BI Copilot</Tab>
      </TabList>
      {rightTab === 'bookmarks' && (
        <BookmarksPane
          bookmarks={bookmarks}
          onChange={changeBookmarks}
          onCapture={captureBookmark}
          onApply={applyBookmark}
          currentName={page?.name ? `${page.name} view` : undefined}
        />
      )}
      {rightTab === 'selection' && (
        <SelectionPane
          visuals={(page?.visuals || []).map((v) => ({ ...v, z: v.layout?.z ?? v.z }))}
          selectedId={selectedVisual}
          onSelect={(vid) => { setSelectedVisual(vid); setSelectedVisualIds(new Set()); }}
          onToggleVisible={(vid, hidden) => setVisualFlag([vid], { hidden })}
          onReorderZ={(zById) => mutatePage((p) => ({
            ...p,
            // Mirror the new paint order into BOTH the legacy `z` and the absolute
            // `layout.z` the free-form canvas layers visuals by — kept in sync.
            visuals: p.visuals.map((v) => (zById[v.id] !== undefined
              ? { ...v, z: zById[v.id], layout: v.layout ? { ...v.layout, z: zById[v.id] } : v.layout }
              : v)),
          }))}
          onGroup={(ids) => groupVisuals(ids)}
          onUngroup={(gid) => {
            const ids = (pages[activePage]?.visuals || []).filter((v) => v.groupId === gid).map((v) => v.id);
            ungroupVisuals(ids);
          }}
        />
      )}
      {rightTab === 'copilot' && (
        <ReportPowerBiCopilot
          reportId={id}
          tables={tables}
          pageIndex={activePage}
          pageName={page?.name || ''}
          visualCount={page?.visuals.length || 0}
          onApplyVisual={applyCopilotVisual}
          onAddPage={addCopilotPage}
        />
      )}
      {rightTab === 'format' && (
        selected ? (
          <FormatPane
            visualType={selected.type}
            format={selected.format}
            condFields={fieldOptions(tables)}
            onChange={(f) => mutateVisual(selected.id, (v) => ({ ...v, format: f }))}
          />
        ) : (
          // PBI parity: with nothing selected, the Format pane formats the PAGE.
          <PageFormatPanel
            styles={styles}
            page={page}
            fieldOpts={fieldOptions(tables)}
            onChange={(patch) => mutatePage((p) => ({ ...p, ...patch }))}
          />
        )
      )}
      {rightTab === 'analytics' && (
        <AnalyticsPane
          visualType={selected?.type ?? null}
          analytics={selected?.analytics}
          seriesNames={selected ? seriesNamesFromRows(visualRows[selected.id]?.rows || []) : []}
          onChange={(a) => { if (selected) mutateVisual(selected.id, (v) => ({ ...v, analytics: a })); }}
        />
      )}
      {rightTab === 'filters' && (
        <FiltersPane
          tables={tables}
          reportFilters={reportFilters}
          pageFilters={page?.filters || []}
          visualFilters={selected ? (selected.filters || []) : null}
          selectedTitle={selected?.title || null}
          onReport={(next) => { setReportFilters(next); setDirty(true); }}
          onPage={(next) => mutatePage((p) => ({ ...p, filters: next }))}
          onVisual={(next) => { if (selected) mutateVisual(selected.id, (v) => ({ ...v, filters: next })); }}
          // Format the filter pane (Loom swatch colors) — supplying onFilterPaneFormat
          // un-hides the "Format filter pane" section (it gates on the callback).
          filterPaneFormat={filterPaneFormat}
          onFilterPaneFormat={(next) => { setFilterPaneFormat(next); setDirty(true); }}
          // Drillthrough scope: when this page is an active drillthrough target, the
          // carried seed filters show as a read-mostly scope card; clearing one
          // broadens the drilled view (re-queries via the drill effect).
          drillthroughFilters={drill && drill.toPage === activePage ? drill.filters : null}
          onClearDrillthrough={(fid) => setDrill((d) => (d && d.toPage === activePage ? { ...d, filters: d.filters.filter((f) => f.id !== fid) } : d))}
        />
      )}
      {rightTab === 'interactions' && (
        <InteractionsEditor
          visuals={(page?.visuals || []).map((v) => ({ id: v.id, type: v.type, title: v.title }))}
          interactions={page?.interactions}
          selectedSourceId={selectedVisual}
          onChange={(next) => mutatePage((p) => ({ ...p, interactions: next }))}
        />
      )}
      {rightTab === 'build' && (
      <>
      <Title3>Visualizations</Title3>
      <div className={styles.gallery}>
        {VISUALS.filter((vt) => vt.group !== 'ai').map((vt) => {
          // Two tiles share type 'scriptVisual' (Python / R) — distinguish them by
          // the seed language for the React key AND the active state, and carry the
          // seed into add / type-change so the right language is applied.
          const active = selected?.type === vt.type
            && (!vt.seed || ((selected?.config?.language as 'python' | 'r') || 'python') === vt.seed.language);
          const key = vt.seed ? `${vt.type}:${vt.seed.language}` : vt.type;
          return (
            <Tooltip key={key} content={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`} relationship="label">
              <button type="button"
                aria-label={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`}
                aria-pressed={active}
                className={mergeClasses(styles.galleryBtn, active && styles.galleryBtnActive)}
                onClick={() => (selected
                  ? mutateVisual(selected.id, (v) => ({
                      ...v, type: vt.type,
                      ...(vt.seed ? { config: { ...(v.config || {}), language: vt.seed.language, script: v.config?.script ?? '' } } : {}),
                    }))
                  : addVisual(vt.type, vt.seed))}>
                <span className={mergeClasses(styles.galleryIcon, active && styles.galleryIconActive)} aria-hidden>{vt.icon}</span>
                <Caption1 className={styles.galleryLabel}>{vt.label}</Caption1>
              </button>
            </Tooltip>
          );
        })}
      </div>

      {/* AI visuals (real backends) — smart narrative + Q&A over Azure OpenAI;
          decomposition tree + key influencers over REAL /query SQL. */}
      <div className={styles.wellHead}>
        <Sparkle20Regular aria-hidden style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>AI visuals</Subtitle2>
      </div>
      <div className={styles.gallery}>
        {VISUALS.filter((vt) => vt.group === 'ai').map((vt) => (
          <Tooltip key={vt.type} content={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`} relationship="label">
            <button type="button"
              aria-label={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`}
              aria-pressed={selected?.type === vt.type}
              className={mergeClasses(styles.galleryBtn, selected?.type === vt.type && styles.galleryBtnActive)}
              onClick={() => (selected ? mutateVisual(selected.id, (v) => ({ ...v, type: vt.type })) : addVisual(vt.type))}>
              <span className={mergeClasses(styles.galleryIcon, selected?.type === vt.type && styles.galleryIconActive)} aria-hidden>{vt.icon}</span>
              <Caption1 className={styles.galleryLabel}>{vt.label}</Caption1>
            </button>
          </Tooltip>
        ))}
      </div>

      {/* Wave-7 ELEMENTS (Power BI "Insert") — text boxes, shapes, images,
          buttons, and page / bookmark navigators. The sibling gallery renders the
          per-kind tiles; onInsert drops a real element onto the canvas (it then
          drags / resizes / aligns / persists like any node, and its data-bound
          tokens resolve through the shared /query). */}
      <div className={styles.wellHead}>
        <Add20Regular aria-hidden style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Elements</Subtitle2>
      </div>
      <ElementsGallery onInsert={addElement} />

      <Divider />

      {!selected && !selectedElement && <Caption1 className={styles.muted}>Select a visual on the canvas, or click a visualization above to add one, then assign fields. Add a text box, shape, image, button, or navigator from the Elements gallery.</Caption1>}

      {/* A selected ELEMENT shows its structured per-kind property pickers (the
          sibling ElementProperties) instead of the visual well editors. onChange
          accepts a full element OR an updater so it satisfies either sibling
          signature; every picker writes the real element model (no-freeform-config:
          structured pickers + a WYSIWYG rich-text box, not a config blob). */}
      {selectedElement && (
        <ElementProperties
          {...{
            element: selectedElement,
            ctx: elemCtx,
            tables,
            pages: pages.map((p, i) => ({ id: p.id, name: p.name, index: i, hidden: !!p.hidden })),
            bookmarks,
            reportId: id,
            resolveToken,
            onChange: (next: CanvasElement | ((e: CanvasElement) => CanvasElement)) =>
              mutateElement(selectedElement.id, (e) => (typeof next === 'function' ? (next as (x: CanvasElement) => CanvasElement)(e) : next)),
            onRemove: () => removeElement(selectedElement.id),
          }}
        />
      )}

      {selected && (
        <>
          <div className={styles.section}>
            <Caption1><strong>Title</strong></Caption1>
            <Input size="small" value={selected.title}
              onChange={(_e, d) => mutateVisual(selected.id, (v) => ({ ...v, title: d.value }))} />
          </div>
          <div className={styles.section}>
            <Caption1><strong>Size</strong></Caption1>
            <div className={styles.toolbar}>
              {sizes.map((s) => {
                const dims = pageDims(page);
                const targetW = Math.round(dims.width * s.frac) - (s.frac < 1 ? 24 : 0);
                const active = selected.layout ? Math.abs(selected.layout.w - targetW) <= 4 : selected.w === s.w;
                return (
                  <Button key={s.label} size="small" appearance={active ? 'primary' : 'outline'}
                    onClick={() => mutateVisual(selected.id, (v) => {
                      const w = Math.max(80, targetW);
                      const h = Math.round(w * 0.66);
                      const base = v.layout ?? { x: 24, y: 24, w, h, z: 0 };
                      const x = Math.min(base.x, Math.max(0, dims.width - w));
                      const y = Math.min(base.y, Math.max(0, dims.height - h));
                      return { ...v, w: s.w, layout: { ...base, x, y, w, h } };
                    })}>{s.label}</Button>
                );
              })}
            </div>
          </div>

          {wellsFor(selected.type).map((w) => (
            <WellEditor key={w.name} visual={selected} well={w.name} label={w.label} tables={tables} styles={styles}
              onAdd={(well, f) => addToWell(selected.id, well, f)}
              onRemove={(well, fuid) => removeFromWell(selected.id, well, fuid)}
              onAgg={(well, fuid, agg) => setAgg(selected.id, well, fuid, agg)}
              onDrop={(well, f) => addToWell(selected.id, well, f)} />
          ))}
        </>
      )}

      <Divider />

      <div className={styles.toolbar}>
        <Title3>Fields</Title3>
        <div className={styles.spacer} />
        <Tooltip content="Reload model fields" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadFields} />
        </Tooltip>
      </div>
      {fieldsLoading && <Spinner size="tiny" label="Reading model…" />}
      {fieldsErr && !fieldsLoading && (
        <MessageBar intent="warning"><MessageBarBody>{fieldsErr}</MessageBarBody></MessageBar>
      )}
      {!fieldsLoading && tables.length > 0 && (
        <Tree aria-label="Model fields">
          {tables.map((t) => (
            <TreeItem key={t.name} itemType="branch" value={t.name}>
              <TreeItemLayout>{t.name}</TreeItemLayout>
              <Tree>
                {t.measures.map((m) => (
                  <TreeItem key={`m:${m.name}`} itemType="leaf" value={`m:${t.name}.${m.name}`}>
                    <TreeItemLayout iconBefore={<NumberSymbol20Regular />}>
                      <span className={styles.chip} draggable
                        onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify({ measure: m.name }))}>
                        {m.name}
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
                {t.columns.map((c) => (
                  <TreeItem key={`c:${c.name}`} itemType="leaf" value={`c:${t.name}.${c.name}`}>
                    <TreeItemLayout>
                      <span className={styles.chip} draggable
                        onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify({ table: t.name, column: c.name }))}>
                        {c.name}
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          ))}
        </Tree>
      )}
      {!fieldsLoading && tables.length === 0 && !fieldsErr && (
        <Caption1 className={styles.muted}>No model fields. Bind a data source (ribbon → Data source) to populate the Fields tree.</Caption1>
      )}
      </>
      )}
    </div>
  );

  return (
    <>
      <ItemEditorChrome item={item} id={id} ribbon={ribbon}
        leftPanel={leftPanel} main={main} rightPanel={rightPanel} rightPanelLabel="Build" />

      {/* Data source picker (semantic-model default · direct-query · AAS) */}
      <DataSourcePicker
        open={dsOpen}
        reportId={id}
        value={dataSource}
        onChange={applyDataSource}
        onDismiss={() => setDsOpen(false)}
        saving={dsSaving}
      />

      {/* First-save: name + workspace → mint the real item, then open it (id==='new') */}
      <Dialog open={createOpen} onOpenChange={(_e, d) => { if (!createBusy) setCreateOpen(d.open); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Create report</DialogTitle>
            <DialogContent>
              <div className={styles.section}>
                <Caption1 className={styles.muted}>
                  Saves this report to a workspace so its full Save / Publish / data-source actions run against a
                  real item. Your current pages, visuals, filters{isBound(dataSource) ? ', and data source' : ''} are
                  carried over.
                </Caption1>
                {wsErr && (
                  <MessageBar intent="warning"><MessageBarBody>
                    <MessageBarTitle>Workspaces not reachable</MessageBarTitle>{wsErr}
                  </MessageBarBody></MessageBar>
                )}
                {workspaces !== null && workspaces.length === 0 && !wsErr && (
                  <MessageBar intent="warning"><MessageBarBody>
                    <MessageBarTitle>No workspaces yet</MessageBarTitle>
                    Create a workspace first (Home → New workspace), then return to create this report.
                  </MessageBarBody></MessageBar>
                )}
                <Field label="Name">
                  <Input value={createName} placeholder="Untitled report"
                    onChange={(_e, d) => setCreateName(d.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && createWsId && !createBusy) createNewReport(); }} />
                </Field>
                <Field label="Workspace">
                  <Dropdown
                    placeholder={workspaces === null ? 'Loading workspaces…' : (workspaces.length ? 'Select a workspace' : 'No workspaces available')}
                    disabled={workspaces === null || workspaces.length === 0}
                    value={(workspaces || []).find((w) => w.id === createWsId)?.name || ''}
                    selectedOptions={createWsId ? [createWsId] : []}
                    onOptionSelect={(_e, d) => setCreateWsId(d.optionValue || '')}>
                    {(workspaces || []).map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
                  </Dropdown>
                </Field>
                {createErr && (
                  <MessageBar intent="error"><MessageBarBody>
                    <MessageBarTitle>Create failed</MessageBarTitle>{createErr}
                  </MessageBarBody></MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={createBusy} onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance="primary" icon={createBusy ? <Spinner size="tiny" /> : <Save20Regular />}
                disabled={createBusy || !createWsId} onClick={createNewReport}>
                {createBusy ? 'Creating…' : 'Create report'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Publish — Azure-native Org gallery default · Power BI opt-in */}
      <Dialog open={publishOpen} onOpenChange={(_e, d) => setPublishOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Publish report</DialogTitle>
            <DialogContent>
              <div className={styles.section}>
                <Caption1 className={styles.muted}>
                  Publish a snapshot so colleagues can view it. The default is the Azure-native
                  Organization gallery (<code>/org-reports</code>) — no Power BI or Fabric required.
                </Caption1>
                <Field label="Target">
                  <RadioGroup value={publishTarget} onChange={(_e, d) => setPublishTarget(d.value as 'org' | 'powerbi')}>
                    <Radio value="org" label="Organization gallery (Azure-native, default)" />
                    <Radio value="powerbi" disabled={!pbiPublishEnabled}
                      label={pbiPublishEnabled ? 'Power BI workspace (opt-in)' : 'Power BI workspace — set NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi to enable'} />
                  </RadioGroup>
                </Field>
                {publishMsg && (
                  <MessageBar intent={publishMsg.ok ? 'success' : 'warning'}>
                    <MessageBarBody>{publishMsg.text}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPublishOpen(false)}>Close</Button>
              <Button appearance="primary" icon={publishBusy ? <Spinner size="tiny" /> : <CloudArrowUp20Regular />}
                disabled={publishBusy} onClick={doPublish}>
                {publishBusy ? 'Publishing…' : 'Publish'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Themes (wave-3) — built-in Loom themes + structured custom builder +
          Power-BI-theme-JSON import/export. Restyles every visual live and
          round-trips on Save via state.content.theme (no-fabric-dependency:
          plain client styling over the Synapse/AAS path). */}
      <Dialog open={themesOpen} onOpenChange={(_e, d) => setThemesOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Report theme</DialogTitle>
            <DialogContent>
              <ThemesPane theme={theme ?? null} onChange={(t) => { setTheme(t ?? undefined); setDirty(true); }} />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setThemesOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/** Inline rename control rendered inside the page's action menu. */
function RenamePageItem({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  if (!editing) {
    return <MenuItem icon={<Edit20Regular />} persistOnClick onClick={(e) => { e?.preventDefault?.(); setVal(name); setEditing(true); }}>Rename page</MenuItem>;
  }
  return (
    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, padding: tokens.spacingVerticalXS }}>
      <Input size="small" value={val} autoFocus onClick={(e) => e.stopPropagation()}
        onChange={(_e, d) => setVal(d.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { onRename(val.trim() || name); setEditing(false); } }} />
      <Button size="small" appearance="primary" onClick={() => { onRename(val.trim() || name); setEditing(false); }}>OK</Button>
    </div>
  );
}

// ── Page-format surface (PBI "Format your report page", shown when nothing is selected) ──

const CANVAS_TYPE_OPTS: { id: CanvasType; label: string }[] = [
  { id: '16:9', label: '16:9 (widescreen)' },
  { id: '4:3', label: '4:3 (standard)' },
  { id: 'letter', label: 'Letter' },
  { id: 'tooltip', label: 'Tooltip' },
  { id: 'custom', label: 'Custom' },
];

/**
 * The Format pane's no-selection surface: format the PAGE (canvas type +
 * background), matching Power BI. Every control is structured (a Dropdown / swatch
 * radiogroup / numeric Input) and persists on the page's config via /definition.
 *
 * Wave-2 adds the page's Drillthrough TARGET fields and the Tooltip-page binding
 * (both structured field pickers, never typed config) — the authoring home for
 * the drillthrough + report-page-tooltip features.
 */
function PageFormatPanel({ styles, page, fieldOpts, onChange }: {
  styles: Styles; page?: DPage; fieldOpts: FieldOpt[]; onChange: (patch: Partial<DPage>) => void;
}) {
  if (!page) {
    return <EmptyState icon={<ColorRegular />} title="No page" body="Add a page to format its canvas type and background." />;
  }
  const bg = page.background || {};
  const setBg = (p: Partial<NonNullable<DPage['background']>>) => onChange({ background: { ...(page.background || {}), ...p } });
  const ct = page.canvasType || '16:9';
  const dtFields = page.drillthrough?.fields || [];
  const optKey = (o: WellFieldRef) => o.measure ? `m:${o.measure}` : `c:${o.table}.${o.column}`;
  const addDrillField = (key: string) => {
    const o = fieldOpts.find((f) => f.key === key);
    if (!o) return;
    const ref: WellFieldRef = { table: o.table, column: o.column, measure: o.measure };
    if (dtFields.some((f) => optKey(f) === optKey(ref))) return;
    onChange({ drillthrough: { fields: [...dtFields, ref] } });
  };
  const removeDrillField = (key: string) => {
    onChange({ drillthrough: { fields: dtFields.filter((f) => optKey(f) !== key) } });
  };
  return (
    <div className={styles.pane} style={{ padding: 0 }}>
      <Caption1 className={styles.muted}>
        No visual selected — format the report <strong>page</strong> (Power BI parity). Select a visual on the canvas to format it instead.
      </Caption1>
      <div className={styles.section}>
        <Caption1><strong>Canvas type</strong></Caption1>
        <Dropdown size="small" aria-label="canvas type"
          value={CANVAS_TYPE_OPTS.find((c) => c.id === ct)?.label || '16:9 (widescreen)'}
          selectedOptions={[ct]}
          onOptionSelect={(_e, d) => onChange({ canvasType: (d.optionValue as CanvasType) || '16:9' })}>
          {CANVAS_TYPE_OPTS.map((c) => <Option key={c.id} value={c.id} text={c.label}>{c.label}</Option>)}
        </Dropdown>
      </div>
      <div className={styles.section}>
        <Caption1><strong>Page background</strong></Caption1>
        <div className={styles.pageSwatchRow} role="radiogroup" aria-label="page background color">
          <button type="button" role="radio" aria-checked={!bg.color} aria-label="None" title="None"
            className={mergeClasses(styles.pageSwatchDot, !bg.color && styles.pageSwatchActive)}
            style={{ backgroundColor: tokens.colorNeutralBackground1 }} onClick={() => setBg({ color: undefined })} />
          {LOOM_DATA_PALETTE.map((sw) => (
            <button key={sw.token} type="button" role="radio" aria-checked={bg.color === sw.token} aria-label={sw.label} title={sw.label}
              className={mergeClasses(styles.pageSwatchDot, bg.color === sw.token && styles.pageSwatchActive)}
              style={{ backgroundColor: sw.token }} onClick={() => setBg({ color: sw.token })} />
          ))}
        </div>
        {bg.color && (
          <>
            <Caption1 className={styles.muted}>Transparency (%)</Caption1>
            <Input size="small" type="number" min={0} max={100} aria-label="page background transparency"
              value={bg.transparency != null ? String(bg.transparency) : '0'}
              onChange={(_e, d) => setBg({ transparency: Math.min(100, Math.max(0, Math.round(Number(d.value) || 0))) })} />
          </>
        )}
      </div>

      <Divider />

      {/* Drillthrough: declare this page a drillthrough TARGET by adding fields.
          Any source visual whose selected data point carries one of these fields
          then offers "Drill through → <this page>", opening it filtered. */}
      <div className={styles.section}>
        <Caption1><strong>Drillthrough fields</strong></Caption1>
        <Caption1 className={styles.muted}>
          Make this page a drillthrough target. A source visual containing one of these fields gets a
          right-click <strong>Drill through</strong> to this page, opening it filtered to the value.
        </Caption1>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="outline" icon={<Add20Regular />}>Add drillthrough field</Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {fieldOpts.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
              {fieldOpts.map((o) => (
                <MenuItem key={o.key} onClick={() => addDrillField(o.key)}>{o.label}</MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        {dtFields.map((f) => (
          <div key={optKey(f)} className={styles.token}>
            <span className={styles.tokenName}>{f.measure || `${f.table ? `${f.table}.` : ''}${f.column}`}</span>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
              aria-label="remove drillthrough field" onClick={() => removeDrillField(optKey(f))} />
          </div>
        ))}
        {dtFields.length === 0 && <Caption1 className={styles.muted}>Not a drillthrough target.</Caption1>}
      </div>

      <Divider />

      {/* Report-page tooltip: designate THIS page as a hover tooltip bound to a
          field (PBI Format page → Page information → Tooltip). Structured pickers
          only (no typed config); persists on page.config.tooltipPage via /definition.
          The hover-consume render that shows this page over a matching mark is a
          follow-on wave — disclosed honestly below (no silent dead control). */}
      <div className={styles.section}>
        <Caption1><strong>Tooltip page</strong></Caption1>
        <Caption1 className={styles.muted}>
          Use this page as a hover tooltip. Set <strong>Canvas type</strong> to <strong>Tooltip</strong>, turn this on,
          and bind the field whose mark shows it.
        </Caption1>
        <Checkbox label="Use as a report-page tooltip"
          checked={!!page.tooltipPage?.enabled}
          onChange={(_e, d) => onChange({ tooltipPage: { enabled: !!d.checked, boundField: page.tooltipPage?.boundField } })} />
        {page.tooltipPage?.enabled && (
          <>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button size="small" appearance="outline" icon={<Add20Regular />}>
                  {page.tooltipPage?.boundField ? 'Change bound field' : 'Bind a field'}
                </Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {fieldOpts.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
                  {fieldOpts.map((o) => (
                    <MenuItem key={o.key}
                      onClick={() => onChange({ tooltipPage: { enabled: true, boundField: { table: o.table, column: o.column, measure: o.measure } } })}>
                      {o.label}
                    </MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
            {page.tooltipPage?.boundField && (
              <div className={styles.token}>
                <span className={styles.tokenName}>
                  {page.tooltipPage.boundField.measure || `${page.tooltipPage.boundField.table ? `${page.tooltipPage.boundField.table}.` : ''}${page.tooltipPage.boundField.column}`}
                </span>
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
                  aria-label="clear bound field"
                  onClick={() => onChange({ tooltipPage: { enabled: true, boundField: undefined } })} />
              </div>
            )}
            <Caption1 className={styles.muted}>
              The binding saves with the page. The hover popover that mini-renders this page over a matching mark
              ships in a follow-on wave (see the parity doc).
            </Caption1>
          </>
        )}
      </div>

      <Caption1 className={styles.muted}>Canvas type + background persist with the page. Use the page menu to duplicate or hide a page.</Caption1>
    </div>
  );
}

// ── wave-2 right-rail panes + Arrange toolbar (local components) ──────────────

/**
 * Arrange toolbar (PBI Format → Arrange). Acts on the multi-selection (Ctrl/Shift-
 * click) or the single selection: lock/unlock, hide/show, match width/height,
 * z-order (front/back), group/ungroup. Every control mutates the persisted layout
 * — no dead buttons (ui-parity.md / no-vaporware.md).
 */
function ArrangeBar({ styles, targets, visuals, onLock, onHide, onMatch, onZ, onAlign, onDistribute, onGroup, onUngroup, onClear }: {
  styles: Styles; targets: string[]; visuals: DVisual[];
  onLock: (lock: boolean) => void; onHide: (hide: boolean) => void;
  onMatch: (dim: 'w' | 'h') => void; onZ: (dir: 'front' | 'back') => void;
  onAlign: (edge: AlignEdge) => void; onDistribute: (axis: DistributeAxis) => void;
  onGroup: () => void; onUngroup: () => void; onClear: () => void;
}) {
  const set = new Set(targets);
  const picked = visuals.filter((v) => set.has(v.id));
  const allLocked = picked.length > 0 && picked.every((v) => v.locked);
  const allHidden = picked.length > 0 && picked.every((v) => v.hidden);
  const anyGrouped = picked.some((v) => v.groupId);
  const multi = targets.length >= 2;
  const canDistribute = targets.length >= 3;
  return (
    <div className={styles.arrangeBar} role="toolbar" aria-label="Arrange selected visuals">
      <Badge appearance="tint" color="brand">{targets.length} selected</Badge>
      <Tooltip content={allLocked ? 'Unlock' : 'Lock'} relationship="label">
        <Button size="small" appearance="subtle" icon={allLocked ? <LockClosed20Regular /> : <LockOpen20Regular />}
          onClick={() => onLock(!allLocked)}>{allLocked ? 'Unlock' : 'Lock'}</Button>
      </Tooltip>
      <Tooltip content={allHidden ? 'Show' : 'Hide'} relationship="label">
        <Button size="small" appearance="subtle" icon={allHidden ? <EyeOff20Regular /> : <Eye20Regular />}
          onClick={() => onHide(!allHidden)}>{allHidden ? 'Show' : 'Hide'}</Button>
      </Tooltip>
      {/* Align — PBI Format ▸ Align (left/center/right/top/middle/bottom). Acts on
          the absolute canvas rects; needs ≥2 selected. */}
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button size="small" appearance="subtle" icon={<AlignLeft20Regular />} disabled={!multi}>Align</Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuGroupHeader>Align</MenuGroupHeader>
            <MenuItem icon={<AlignLeft20Regular />} onClick={() => onAlign('left')}>Align left</MenuItem>
            <MenuItem icon={<AlignCenterHorizontal20Regular />} onClick={() => onAlign('center')}>Align center</MenuItem>
            <MenuItem icon={<AlignRight20Regular />} onClick={() => onAlign('right')}>Align right</MenuItem>
            <MenuDivider />
            <MenuItem icon={<AlignTop20Regular />} onClick={() => onAlign('top')}>Align top</MenuItem>
            <MenuItem icon={<AlignCenterVertical20Regular />} onClick={() => onAlign('middle')}>Align middle</MenuItem>
            <MenuItem icon={<AlignBottom20Regular />} onClick={() => onAlign('bottom')}>Align bottom</MenuItem>
            <MenuDivider />
            <MenuGroupHeader>Distribute</MenuGroupHeader>
            <MenuItem icon={<AlignSpaceEvenlyHorizontal20Regular />} disabled={!canDistribute} onClick={() => onDistribute('horizontal')}>Distribute horizontally</MenuItem>
            <MenuItem icon={<AlignSpaceEvenlyVertical20Regular />} disabled={!canDistribute} onClick={() => onDistribute('vertical')}>Distribute vertically</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <Tooltip content="Match width" relationship="label">
        <Button size="small" appearance="subtle" icon={<ArrowExpand20Regular />} disabled={!multi} onClick={() => onMatch('w')}>Match width</Button>
      </Tooltip>
      <Tooltip content="Match height" relationship="label">
        <Button size="small" appearance="subtle" disabled={!multi} onClick={() => onMatch('h')}>Match height</Button>
      </Tooltip>
      <Tooltip content="Bring to front" relationship="label">
        <Button size="small" appearance="subtle" icon={<PositionToFront20Regular />} onClick={() => onZ('front')} />
      </Tooltip>
      <Tooltip content="Send to back" relationship="label">
        <Button size="small" appearance="subtle" icon={<PositionToBack20Regular />} onClick={() => onZ('back')} />
      </Tooltip>
      <Tooltip content="Group" relationship="label">
        <Button size="small" appearance="subtle" icon={<Group20Regular />} disabled={!multi} onClick={onGroup}>Group</Button>
      </Tooltip>
      <Tooltip content="Ungroup" relationship="label">
        <Button size="small" appearance="subtle" icon={<GroupDismiss20Regular />} disabled={!anyGrouped} onClick={onUngroup}>Ungroup</Button>
      </Tooltip>
      <div className={styles.spacer} />
      <Button size="small" appearance="subtle" onClick={onClear}>Clear</Button>
    </div>
  );
}

// The Selection pane (PBI Selection pane) and Bookmarks pane (PBI Bookmarks pane)
// are the canonical components imported from ./report/selection-pane and
// ./report/bookmarks-pane and MOUNTED in the right rail above. The previously-
// inline duplicates (with a flat bookmark model the /definition route dropped on
// save) were removed in favor of the richer panes (drag z-order + grouping +
// scope + Data/Display/Current-page apply toggles + visibility/z capture) whose
// model the route sanitizer already mirrors.

export default ReportDesigner;
