'use client';

// constants.tsx — gallery metadata, visual type sets, and chart-render mapping.
// Has JSX (VISUALS icon elements) so this file uses .tsx + 'use client'.

import type { ReactElement } from 'react';
import {
  Table20Regular, Grid20Regular, TextNumberFormat20Regular, TextBulletListSquare20Regular,
  Gauge20Regular, DataBarVertical20Regular, DataBarHorizontal20Regular, DataLine20Regular,
  DataArea20Regular, DataPie20Regular, DataScatter20Regular, DataWaterfall20Regular,
  DataFunnel20Regular, DataHistogram20Regular, DataUsage20Regular, ChartMultiple20Regular,
  RibbonStar20Regular, DataTreemap20Regular, Map20Regular, DataTrending20Regular,
  Filter20Regular, Code20Regular, BracesVariable20Regular, Sparkle20Regular, Question20Regular,
} from '@fluentui/react-icons';
import { CARTESIAN_VISUAL_TYPES } from '../report/analytics-pane';
import type { VisualType, GalleryCat } from './types';

export const GALLERY_CATS: { key: GalleryCat; label: string; accent: string }[] = [
  { key: 'bars',       label: 'Bar & column',   accent: 'var(--loom-accent-blue)' },
  { key: 'lines',      label: 'Line & area',    accent: 'var(--loom-accent-teal)' },
  { key: 'proportion', label: 'Proportion',     accent: 'var(--loom-accent-amber)' },
  { key: 'points',     label: 'Scatter & maps', accent: 'var(--loom-accent-violet)' },
  { key: 'tables',     label: 'Tables',         accent: 'var(--loom-accent-cyan)' },
  { key: 'cards',      label: 'Cards & KPIs',   accent: 'var(--loom-accent-emerald)' },
  { key: 'filters',    label: 'Slicers',        accent: 'var(--loom-accent-indigo2)' },
  { key: 'script',     label: 'Script visuals', accent: 'var(--loom-accent-magenta)' },
];

export const VISUALS: { type: VisualType; label: string; icon: ReactElement; group?: 'ai'; cat?: GalleryCat; seed?: { language: 'python' | 'r' } }[] = [
  { type: 'table',        label: 'Table',          icon: <Table20Regular />,             cat: 'tables' },
  { type: 'matrix',       label: 'Matrix',         icon: <Grid20Regular />,              cat: 'tables' },
  { type: 'card',         label: 'Card',           icon: <TextNumberFormat20Regular />,  cat: 'cards' },
  { type: 'multiRowCard', label: 'Multi-row card', icon: <TextBulletListSquare20Regular />, cat: 'cards' },
  { type: 'kpi',          label: 'KPI',            icon: <DataTrending20Regular />,      cat: 'cards' },
  { type: 'gauge',        label: 'Gauge',          icon: <Gauge20Regular />,             cat: 'cards' },
  { type: 'column',       label: 'Column chart',   icon: <DataBarVertical20Regular />,   cat: 'bars' },
  { type: 'bar',          label: 'Bar chart',      icon: <DataBarHorizontal20Regular />, cat: 'bars' },
  { type: 'waterfall',    label: 'Waterfall',      icon: <DataWaterfall20Regular />,     cat: 'bars' },
  { type: 'funnel',       label: 'Funnel',         icon: <DataFunnel20Regular />,        cat: 'bars' },
  { type: 'line',         label: 'Line chart',     icon: <DataLine20Regular />,          cat: 'lines' },
  { type: 'area',         label: 'Area chart',     icon: <DataArea20Regular />,          cat: 'lines' },
  { type: 'combo',        label: 'Line + column',  icon: <ChartMultiple20Regular />,     cat: 'lines' },
  { type: 'ribbon',       label: 'Ribbon chart',   icon: <RibbonStar20Regular />,        cat: 'lines' },
  { type: 'pie',          label: 'Pie chart',      icon: <DataPie20Regular />,           cat: 'proportion' },
  { type: 'donut',        label: 'Donut chart',    icon: <DataUsage20Regular />,         cat: 'proportion' },
  { type: 'treemap',      label: 'Treemap',        icon: <DataTreemap20Regular />,       cat: 'proportion' },
  { type: 'scatter',      label: 'Scatter',        icon: <DataScatter20Regular />,       cat: 'points' },
  { type: 'map',          label: 'Map',            icon: <Map20Regular />,               cat: 'points' },
  { type: 'slicer',       label: 'Slicer',         icon: <Filter20Regular />,            cat: 'filters' },
  { type: 'scriptVisual', label: 'Python visual',  icon: <Code20Regular />,          seed: { language: 'python' }, cat: 'script' },
  { type: 'scriptVisual', label: 'R visual',       icon: <BracesVariable20Regular />, seed: { language: 'r' },     cat: 'script' },
  { type: 'smartNarrative',    label: 'Smart narrative',    icon: <Sparkle20Regular />,       group: 'ai' },
  { type: 'qna',               label: 'Q&A',                icon: <Question20Regular />,      group: 'ai' },
  { type: 'decompositionTree', label: 'Decomposition tree', icon: <DataHistogram20Regular />, group: 'ai' },
  { type: 'keyInfluencers',    label: 'Key influencers',    icon: <DataTrending20Regular />,  group: 'ai' },
];

export const AI_TYPES = new Set<VisualType>(['decompositionTree', 'keyInfluencers', 'smartNarrative', 'qna']);
export const AI_SELF_QUERY = AI_TYPES;
export const SCRIPT_TYPES = new Set<VisualType>(['scriptVisual']);

export const CHART_RENDER: Partial<Record<VisualType, string>> = {
  bar: 'bar', column: 'column', line: 'line', area: 'area', pie: 'pie', donut: 'donut', scatter: 'scatter',
  combo: 'combo', ribbon: 'ribbon', waterfall: 'waterfall', funnel: 'funnel', treemap: 'treemap',
};
export const CHART_TYPES = new Set<VisualType>(Object.keys(CHART_RENDER) as VisualType[]);
export const CARTESIAN_TYPES = CARTESIAN_VISUAL_TYPES;
export const KPI_TYPES = new Set<VisualType>(['card']);
export const GAUGE_KPI = new Set<VisualType>(['gauge', 'kpi']);
export const COMPACT_TYPES = new Set<VisualType>(['card', 'kpi', 'gauge']);
