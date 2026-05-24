'use client';

/**
 * Editor registry — maps an item-type slug to a rich editor component.
 * Slugs not in the map fall back to the generic shell in the
 * /items/[type]/[id] route. Phases 2-4 wire all the major editors
 * here; the rest stay on the generic chrome until a focused editor
 * is shipped.
 */

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

export interface EditorProps { item: FabricItemType; id: string; }

type EditorComponent = ComponentType<EditorProps>;

const reg = (loader: () => Promise<{ [k: string]: EditorComponent }>, name: string): EditorComponent =>
  dynamic(() => loader().then((m) => ({ default: m[name] })), { ssr: false });

export const EDITOR_REGISTRY: Record<string, EditorComponent> = {
  // Phase 2
  'lakehouse':            reg(() => import('./lakehouse-editor'),         'LakehouseEditor'),
  'notebook':             reg(() => import('./notebook-editor'),          'NotebookEditor'),
  'data-pipeline':        reg(() => import('./data-pipeline-editor'),     'DataPipelineEditor'),
  'dataflow':             reg(() => import('./dataflow-gen2-editor'),     'DataflowGen2Editor'),
  'mirrored-database':    reg(() => import('./mirrored-database-editor'), 'MirroredDatabaseEditor'),
  'spark-job-definition': reg(() => import('./phase2-misc-editors'),      'SparkJobDefinitionEditor'),
  'environment':          reg(() => import('./phase2-misc-editors'),      'EnvironmentEditor'),
  'copy-job':             reg(() => import('./phase2-misc-editors'),      'CopyJobEditor'),
  'dbt-job':              reg(() => import('./phase2-misc-editors'),      'DbtJobEditor'),

  // Phase 3
  'eventhouse':           reg(() => import('./phase3-editors'),           'EventhouseEditor'),
  'kql-database':         reg(() => import('./phase3-editors'),           'KqlDatabaseEditor'),
  'kql-queryset':         reg(() => import('./phase3-editors'),           'KqlQuerysetEditor'),
  'kql-dashboard':        reg(() => import('./phase3-editors'),           'KqlDashboardEditor'),
  'eventstream':          reg(() => import('./phase3-editors'),           'EventstreamEditor'),
  'activator':            reg(() => import('./phase3-editors'),           'ActivatorEditor'),
  'warehouse':            reg(() => import('./phase3-editors'),           'WarehouseEditor'),
  'semantic-model':       reg(() => import('./phase3-editors'),           'SemanticModelEditor'),
  'report':               reg(() => import('./phase3-editors'),           'ReportEditor'),
  'dashboard':            reg(() => import('./phase3-editors'),           'DashboardEditor'),
  'paginated-report':     reg(() => import('./phase3-editors'),           'PaginatedReportEditor'),
  'scorecard':            reg(() => import('./phase3-editors'),           'ScorecardEditor'),

  // Phase 4
  'ml-model':             reg(() => import('./phase4-editors'),           'MlModelEditor'),
  'ml-experiment':        reg(() => import('./phase4-editors'),           'MlExperimentEditor'),
  'graphql-api':          reg(() => import('./phase4-editors'),           'GraphqlApiEditor'),
  'user-data-function':   reg(() => import('./phase4-editors'),           'UserDataFunctionEditor'),
  'variable-library':     reg(() => import('./phase4-editors'),           'VariableLibraryEditor'),
  'ontology':             reg(() => import('./phase4-editors'),           'OntologyEditor'),
  'graph-model':          reg(() => import('./phase4-editors'),           'GraphModelEditor'),
  'plan':                 reg(() => import('./phase4-editors'),           'PlanEditor'),
  'map':                  reg(() => import('./phase4-editors'),           'MapEditor'),
  'operations-agent':     reg(() => import('./phase4-editors'),           'OperationsAgentEditor'),
  'data-agent':           reg(() => import('./phase4-editors'),           'DataAgentEditor'),
};

export function getEditor(slug: string): EditorComponent | null {
  return EDITOR_REGISTRY[slug] ?? null;
}
