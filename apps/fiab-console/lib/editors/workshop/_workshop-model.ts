/**
 * _workshop-model — plain (non-'use client') persisted-state types for the
 * Workshop (Atelier) app builder, following the `_plan-model.ts` convention.
 * Extracted verbatim from workshop-app-builder.tsx so server-side consumers
 * (the publish BFF route, the workshop bundle codegen in _palantir-codegen.ts)
 * can import the Cosmos-persisted shapes without a server→client layering
 * inversion. The builder re-exports these, so existing importers are unchanged.
 *
 * All imports below are type-only (fully erased at compile time) — this module
 * stays free of React / Next at runtime.
 */

import type { LoomChartType } from '@/lib/components/charts/loom-chart';
import type { AtelierFilterOp } from '@/lib/editors/_family-utils';

// ───────────────────────── types (persisted in Cosmos item state) ─────────────────────────

export type WorkshopVarType = 'object-set-filter' | 'string' | 'number' | 'boolean' | 'date';

export interface WorkshopVariable {
  id: string;
  name: string;
  type: WorkshopVarType;
  /** object-set-filter: the ontology object type it filters. */
  entityType?: string;
  /** Scalar default value (string-encoded). */
  defaultValue?: string;
}

export type WorkshopWidgetKind = 'table' | 'chart' | 'metric' | 'filter' | 'form' | 'button' | 'text' | 'image' | 'link' | 'divider' | 'badge' | 'iframe' | 'heading' | 'progress' | 'spacer' | 'timestamp' | 'kpi-row' | 'gauge' | 'callout' | 'quote' | 'rating' | 'tag-list' | 'delta' | 'checklist' | 'avatar' | 'code-block' | 'key-value' | 'countdown' | 'stat-pair' | 'mini-table' | 'breadcrumb' | 'json-view';

export interface WorkshopWidgetLayout { x: number; y: number; w: number; h: number }

export type WorkshopEventTrigger = 'click' | 'row-select' | 'page-load';
export type WorkshopEventEffect = 'set-variable' | 'clear-variable' | 'run-action' | 'refresh';
export type WorkshopAggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface WorkshopEvent {
  id: string;
  trigger: WorkshopEventTrigger;
  effect: WorkshopEventEffect;
  /** set-variable / clear-variable target. */
  targetVariableId?: string;
  /** set-variable: scalar literal value. */
  value?: string;
  /** set-variable into an object-set-filter variable: the predicate column/op. */
  filterColumn?: string;
  filterOp?: AtelierFilterOp;
  /** row-select: which column of the selected row supplies the value. */
  selectionColumn?: string;
  /** run-action target. */
  actionEntityType?: string;
  actionKind?: 'create' | 'update' | 'delete';
}

export interface WorkshopWidget {
  id: string;
  title: string;
  kind: WorkshopWidgetKind;
  layout?: WorkshopWidgetLayout;
  /** ontology object type this widget binds to (table / chart / metric / filter / form). */
  entityType?: string;
  /** object-set-filter variables that constrain this widget's reads (data widgets). */
  appliesVariableIds?: string[];
  // chart
  chartType?: LoomChartType;
  groupBy?: string;
  aggFn?: WorkshopAggFn;
  aggColumn?: string;
  // metric
  metricFn?: WorkshopAggFn;
  metricColumn?: string;
  // filter
  filterColumn?: string;
  filterOp?: AtelierFilterOp;
  targetVariableId?: string;
  filterControl?: 'dropdown' | 'text';
  // form (real CRUD)
  formKind?: 'create' | 'update' | 'delete';
  // text
  text?: string;
  // image / iframe — the source URL (https only, enforced at render).
  src?: string;
  // link — the target URL (https only) shown as a styled anchor.
  href?: string;
  // badge — Fluent badge color name.
  badgeColor?: 'brand' | 'success' | 'warning' | 'danger' | 'informative';
  // progress — percent 0..100 (string-encoded; supports {{variable}}).
  progressValue?: string;
  // heading — visual level 1..3.
  headingLevel?: 1 | 2 | 3;
  // kpi-row — comma list of "Label=value" pairs; values support {{variable}}.
  kpiItems?: string;
  // gauge — value/min/max (string-encoded; value supports {{variable}}).
  gaugeValue?: string;
  gaugeMin?: string;
  gaugeMax?: string;
  // callout — Fluent MessageBar intent.
  calloutIntent?: 'info' | 'success' | 'warning' | 'error';
  // rating — value out of max stars (string-encoded; value supports {{variable}}).
  ratingValue?: string;
  ratingMax?: string;
  // tag-list — comma list of tags rendered as badges.
  tags?: string;
  // delta — current vs previous value; renders signed change with color.
  deltaValue?: string;
  deltaPrevious?: string;
  // checklist — newline list; lines starting "[x]" render checked.
  checklistItems?: string;
  // avatar — display name (initials derived) + optional caption.
  avatarName?: string;
  avatarCaption?: string;
  // code-block — monospace pre-formatted content.
  code?: string;
  // key-value — newline list of "Key: value" pairs; values support {{variable}}.
  keyValues?: string;
  // countdown — ISO date (yyyy-mm-dd) to count down to.
  countdownTo?: string;
  // stat-pair — two labeled stats side by side ("Label=value" each; {{variable}} ok).
  statLeft?: string;
  statRight?: string;
  // mini-table — first line = comma headers; following lines = comma rows.
  miniTable?: string;
  // breadcrumb — comma list of trail segments.
  crumbs?: string;
  // json-view — JSON text pretty-printed (or shown raw when invalid).
  json?: string;
  // button + table events
  events?: WorkshopEvent[];
}
