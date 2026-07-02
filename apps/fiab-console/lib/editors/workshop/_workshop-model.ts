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

export type WorkshopWidgetKind = 'table' | 'chart' | 'metric' | 'filter' | 'form' | 'button' | 'text';

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
  // button + table events
  events?: WorkshopEvent[];
}
