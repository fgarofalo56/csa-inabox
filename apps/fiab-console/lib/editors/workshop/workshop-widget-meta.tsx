'use client';

/**
 * workshop-widget-meta — the widget palette metadata (label / icon / hint /
 * data-bound flag) and default canvas sizes for EVERY Workshop widget kind,
 * incl. the WS-4.5 advanced widgets (object-view / links / map / pivot /
 * timeline / aip-copilot). Extracted from workshop-app-builder.tsx so the
 * builder stays under its ratchet ceiling and the advanced-widget module can
 * share the same registry (single source of truth).
 *
 * Fluent v9 icons only + Loom tokens downstream — no hard-coded styling here.
 */
import type { ReactElement } from 'react';
import {
  Table20Regular, DataUsage20Regular, NumberSymbol20Regular, DocumentText20Regular,
  Apps20Regular, Filter20Regular, Form20Regular, Cursor20Regular, Edit20Regular,
  ArrowMaximize20Regular, Flash20Regular, Code20Regular, Sparkle20Regular,
  ChevronRight16Regular, ChevronDown16Regular, Play20Regular,
  Eye20Regular, Link20Regular, Map20Regular, Grid20Regular, Timeline20Regular, BrainCircuit20Regular,
} from '@fluentui/react-icons';
import type { WorkshopWidgetKind } from './_workshop-model';

export const DEFAULT_SIZE: Record<WorkshopWidgetKind, { w: number; h: number }> = {
  table: { w: 448, h: 288 },
  chart: { w: 400, h: 272 },
  metric: { w: 224, h: 144 },
  filter: { w: 288, h: 128 },
  form: { w: 384, h: 320 },
  button: { w: 224, h: 96 },
  text: { w: 336, h: 160 },
  image: { w: 336, h: 224 },
  link: { w: 224, h: 80 },
  divider: { w: 448, h: 48 },
  badge: { w: 224, h: 80 },
  iframe: { w: 448, h: 320 },
  heading: { w: 448, h: 80 },
  progress: { w: 336, h: 80 },
  spacer: { w: 224, h: 64 },
  timestamp: { w: 224, h: 64 },
  'kpi-row': { w: 448, h: 112 },
  gauge: { w: 288, h: 128 },
  callout: { w: 448, h: 96 },
  quote: { w: 400, h: 112 },
  rating: { w: 224, h: 80 },
  'tag-list': { w: 336, h: 80 },
  delta: { w: 224, h: 96 },
  checklist: { w: 336, h: 160 },
  avatar: { w: 224, h: 96 },
  'code-block': { w: 448, h: 160 },
  'key-value': { w: 336, h: 160 },
  countdown: { w: 224, h: 96 },
  'stat-pair': { w: 336, h: 112 },
  'mini-table': { w: 448, h: 176 },
  breadcrumb: { w: 448, h: 64 },
  'json-view': { w: 448, h: 176 },
  tabs: { w: 448, h: 192 },
  accordion: { w: 448, h: 192 },
  sparkline: { w: 224, h: 80 },
  'video-embed': { w: 448, h: 288 },
  'map-embed': { w: 448, h: 288 },
  // WS-4.5 advanced widgets
  'object-view': { w: 480, h: 360 },
  links: { w: 400, h: 288 },
  map: { w: 480, h: 320 },
  pivot: { w: 480, h: 288 },
  timeline: { w: 400, h: 320 },
  'aip-copilot': { w: 336, h: 224 },
};

export interface WidgetMeta { label: string; icon: ReactElement; hint: string; data: boolean }

export const KIND_META: Record<WorkshopWidgetKind, WidgetMeta> = {
  table: { label: 'Object Table', icon: <Table20Regular />, hint: 'Rows of an ontology object type, filtered by variables', data: true },
  chart: { label: 'Chart', icon: <DataUsage20Regular />, hint: 'Aggregate (GROUP BY) over an object type', data: true },
  metric: { label: 'Metric', icon: <NumberSymbol20Regular />, hint: 'A single aggregated KPI number', data: true },
  filter: { label: 'Filter', icon: <Filter20Regular />, hint: 'A control that writes an object-set-filter variable', data: true },
  form: { label: 'Form', icon: <Form20Regular />, hint: 'Create / update / delete an object — real write-back', data: true },
  button: { label: 'Button', icon: <Cursor20Regular />, hint: 'Fires events: set a variable, run an action, open an overlay, refresh', data: false },
  text: { label: 'Text', icon: <DocumentText20Regular />, hint: 'Markdown-lite label with {{variable}} interpolation', data: false },
  image: { label: 'Image', icon: <Apps20Regular />, hint: 'An https image by URL', data: false },
  link: { label: 'Link', icon: <ArrowMaximize20Regular />, hint: 'A styled link to an https URL', data: false },
  divider: { label: 'Divider', icon: <Edit20Regular />, hint: 'A horizontal section divider', data: false },
  badge: { label: 'Badge', icon: <Flash20Regular />, hint: 'A colored status badge with {{variable}} interpolation', data: false },
  iframe: { label: 'Embed', icon: <Code20Regular />, hint: 'Embed an https page (iframe)', data: false },
  heading: { label: 'Heading', icon: <DocumentText20Regular />, hint: 'A section heading (levels 1–3) with {{variable}} interpolation', data: false },
  progress: { label: 'Progress', icon: <DataUsage20Regular />, hint: 'A progress bar (0–100%), value supports {{variable}}', data: false },
  spacer: { label: 'Spacer', icon: <ArrowMaximize20Regular />, hint: 'Blank layout spacing', data: false },
  timestamp: { label: 'Timestamp', icon: <Flash20Regular />, hint: 'Shows when the page was last refreshed', data: false },
  'kpi-row': { label: 'KPI Row', icon: <NumberSymbol20Regular />, hint: 'A row of labeled KPI chips — values support {{variable}}', data: false },
  gauge: { label: 'Gauge', icon: <DataUsage20Regular />, hint: 'A value against a min–max range, colored by fill', data: false },
  callout: { label: 'Callout', icon: <Flash20Regular />, hint: 'A highlighted MessageBar note (info/success/warning/error)', data: false },
  quote: { label: 'Quote', icon: <DocumentText20Regular />, hint: 'A styled blockquote with {{variable}} interpolation', data: false },
  rating: { label: 'Rating', icon: <Sparkle20Regular />, hint: 'Star rating (value / max), value supports {{variable}}', data: false },
  'tag-list': { label: 'Tags', icon: <Filter20Regular />, hint: 'A wrapping row of tag badges', data: false },
  delta: { label: 'Delta', icon: <DataUsage20Regular />, hint: 'Current vs previous — signed change, colored by direction', data: false },
  checklist: { label: 'Checklist', icon: <Form20Regular />, hint: 'A static checklist — prefix a line with [x] to check it', data: false },
  avatar: { label: 'Avatar', icon: <Cursor20Regular />, hint: 'An initials avatar with name + caption', data: false },
  'code-block': { label: 'Code', icon: <Code20Regular />, hint: 'Monospace pre-formatted block', data: false },
  'key-value': { label: 'Key–Value', icon: <Table20Regular />, hint: 'Key: value lines with {{variable}} interpolation', data: false },
  countdown: { label: 'Countdown', icon: <Flash20Regular />, hint: 'Days remaining until a date', data: false },
  'stat-pair': { label: 'Stat Pair', icon: <NumberSymbol20Regular />, hint: 'Two labeled stats side by side, {{variable}} values', data: false },
  'mini-table': { label: 'Mini Table', icon: <Table20Regular />, hint: 'A small static table (CSV: first line headers)', data: false },
  breadcrumb: { label: 'Breadcrumb', icon: <ChevronRight16Regular />, hint: 'A navigation trail of segments', data: false },
  'json-view': { label: 'JSON', icon: <Code20Regular />, hint: 'Pretty-printed JSON block', data: false },
  tabs: { label: 'Tabs', icon: <Apps20Regular />, hint: 'A tab strip with per-tab text content + nested widgets', data: false },
  accordion: { label: 'Accordion', icon: <ChevronDown16Regular />, hint: 'Collapsible titled sections', data: false },
  sparkline: { label: 'Sparkline', icon: <DataUsage20Regular />, hint: 'A tiny inline trend line from a number list', data: false },
  'video-embed': { label: 'Video', icon: <Play20Regular />, hint: 'Embed an https video player (sandboxed iframe)', data: false },
  'map-embed': { label: 'Map Embed', icon: <ArrowMaximize20Regular />, hint: 'Embed an https map view (sandboxed iframe)', data: false },
  // WS-4.5 advanced widgets over real backends
  'object-view': { label: 'Object View', icon: <Eye20Regular />, hint: 'A drill-in detail view of the selected object — properties, links, timeseries, map (real AGE)', data: true },
  links: { label: 'Linked Objects', icon: <Link20Regular />, hint: 'Objects linked to the selected object, grouped by link type (real AGE graph)', data: true },
  map: { label: 'Map', icon: <Map20Regular />, hint: 'A MapLibre-compatible map of an object type\'s geo rows (real Synapse geopoints)', data: true },
  pivot: { label: 'Pivot', icon: <Grid20Regular />, hint: 'A row × column pivot matrix aggregating a measure (real Synapse rows)', data: true },
  timeline: { label: 'Timeline', icon: <Timeline20Regular />, hint: 'A time-ordered event stream from an object type (real Synapse rows)', data: true },
  'aip-copilot': { label: 'AIP Copilot', icon: <BrainCircuit20Regular />, hint: 'A per-surface Copilot grounded in this app\'s ontology + variables', data: false },
};
