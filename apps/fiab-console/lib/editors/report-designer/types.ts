// types.ts — all model types for the report-designer.
// No JSX; no 'use client' needed.

import type { AbsRect } from '../report/use-canvas-layout';
import type { ReportVisualFormat } from '../report/format-pane';
import type { ReportAnalytics } from '../report/analytics-pane';
import type { ReportFilter } from '../report/filters-pane';
import type { PageInteractions } from '../report/interactions';
import type { CanvasElement } from '../report/canvas-elements';
import type { SlicerStyle } from '../report/slicer-visual';
import type { CopilotVisualSpec } from '@/lib/components/report/report-powerbi-copilot';
import type { ReportFilterInput } from '@/lib/azure/wells-to-sql';
import type { SmartNarrativeVisualRows } from '../report/ai-visuals/smart-narrative';

// ── Visual types ──────────────────────────────────────────────────────────────

export type VisualType =
  | 'table' | 'matrix' | 'card' | 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'slicer'
  | 'combo' | 'waterfall' | 'funnel' | 'gauge' | 'kpi' | 'treemap' | 'multiRowCard' | 'ribbon'
  | 'map'
  | 'decompositionTree' | 'keyInfluencers' | 'smartNarrative' | 'qna'
  | 'scriptVisual';

export type Agg = 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max';
export const AGGS: Agg[] = ['Sum', 'Avg', 'Count', 'Min', 'Max'];

export type WellName =
  | 'category' | 'values' | 'legend'
  | 'secondaryValues' | 'target' | 'minimum' | 'maximum' | 'smallMultiples' | 'tooltips' | 'details'
  | 'size' | 'playAxis' | 'latitude' | 'longitude';

export interface WellField {
  uid: string;
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: Agg;
}

export interface Wells {
  category: WellField[];
  values: WellField[];
  legend: WellField[];
  secondaryValues?: WellField[];
  target?: WellField[];
  minimum?: WellField[];
  maximum?: WellField[];
  smallMultiples?: WellField[];
  tooltips?: WellField[];
  details?: WellField[];
  size?: WellField[];
  playAxis?: WellField[];
  latitude?: WellField[];
  longitude?: WellField[];
}

export type CanvasType = '16:9' | '4:3' | 'letter' | 'tooltip' | 'custom';

export const PAGE_DIMS: Record<CanvasType, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 960, height: 720 },
  letter: { width: 1056, height: 816 },
  tooltip: { width: 320, height: 240 },
  custom: { width: 1280, height: 720 },
};

export function pageDims(p?: { canvasType?: CanvasType; size?: { width?: number; height?: number } }): { width: number; height: number } {
  if (p?.size?.width && p?.size?.height) return { width: p.size.width, height: p.size.height };
  return PAGE_DIMS[p?.canvasType || '16:9'] || PAGE_DIMS['16:9'];
}

export interface DVisual {
  id: string;
  type: VisualType;
  title: string;
  wells: Wells;
  w: number;
  h: number;
  layout?: AbsRect;
  format?: ReportVisualFormat;
  analytics?: ReportAnalytics;
  filters?: ReportFilter[];
  hidden?: boolean;
  locked?: boolean;
  z?: number;
  groupId?: string;
  config?: { language?: 'python' | 'r'; script?: string; slicerStyle?: SlicerStyle };
}

export interface WellFieldRef { table?: string; column?: string; measure?: string }

export interface DPage {
  id: string;
  name: string;
  visuals: DVisual[];
  filters?: ReportFilter[];
  hidden?: boolean;
  interactions?: PageInteractions;
  canvasType?: CanvasType;
  background?: { color?: string; transparency?: number };
  size?: { width?: number; height?: number };
  drillthrough?: { fields: WellFieldRef[] };
  tooltipPage?: { enabled: boolean; boundField?: WellFieldRef };
  elements?: CanvasElement[];
}

export type FFNode =
  | (DVisual & { layout: AbsRect; __el?: undefined })
  | { id: string; layout: AbsRect; locked?: boolean; hidden?: boolean; groupId?: string; __el: CanvasElement };

export interface FieldColumn { name: string; dataType: string; summarizeBy?: string; isHidden: boolean }
export interface FieldMeasure { name: string; isHidden: boolean }
export interface FieldTable { name: string; columns: FieldColumn[]; measures: FieldMeasure[] }

export interface VisualState { rows: Array<Record<string, unknown>>; loading: boolean; err: string | null }

export type GalleryCat = 'bars' | 'lines' | 'proportion' | 'points' | 'tables' | 'cards' | 'filters' | 'script';

export interface AiVisualWiring {
  reportId: string;
  tables: FieldTable[];
  queryAdHoc: (spec: CopilotVisualSpec, filters?: ReportFilterInput[]) => Promise<Array<Record<string, unknown>>>;
  onApplyVisual: (spec: CopilotVisualSpec) => void;
  pageRows: SmartNarrativeVisualRows[];
}

export type RightTab = 'build' | 'format' | 'analytics' | 'filters' | 'interactions' | 'bookmarks' | 'selection' | 'syncSlicers' | 'whatIf' | 'performance' | 'copilot' | 'ask';
