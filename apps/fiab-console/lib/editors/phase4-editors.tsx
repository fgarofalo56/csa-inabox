'use client';

/**
 * Phase 4 editors — Data Science, APIs / Functions, Fabric IQ.
 *
 * MlModelEditor binds a Loom item (Cosmos GUID) to a REAL Azure Machine
 * Learning registered model (state.modelName + optional state.workspaceName)
 * and drives the AML model registry via the BFF — the route id is never used
 * as the model name (fixes the confirmed 404 crash). MlExperimentEditor is
 * wired live to the AI Foundry hub jobs/runs.
 *   GET  /api/items/ml-model/[id]            → bound model + versions (412 unbound)
 *   GET  /api/items/ml-model/[id]/bind       → AML workspaces + models + binding
 *   POST /api/items/ml-model/[id]/bind       → persist binding
 *   POST /api/items/ml-model/[id]/register   → register a new model version
 *   GET/POST /api/items/ml-model/[id]/endpoint → list / create online endpoint
 *   GET /api/items/ml-experiment/[id]        → job OR experiment grouping of runs
 * No mock data; all fetches content-type-guarded; errors surface in MessageBar.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Card, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option, Switch,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Bot24Regular, Database20Regular, Add20Regular, Sparkle20Regular,
  Link20Regular, Flash20Regular, Dismiss16Regular,
  ShieldCheckmark20Regular, Mail16Regular, ArrowSync16Regular,
  DataUsage20Regular, ArrowUpload16Regular,
  Settings20Regular, Money20Regular, BranchFork20Regular,
  Table20Regular, ChartMultiple20Regular,
  ArrowDownload16Regular, ArrowSortUp16Regular, ArrowSortDown16Regular,
  Save16Regular, DataTrending20Regular, Play20Regular, Pulse20Regular,
  Cube20Regular, Calculator20Regular, Ruler20Regular, Layer20Regular,
  ChevronRight16Regular, ChevronDown16Regular, ChevronLeft16Regular,
  Add16Regular, Edit16Regular, CheckmarkCircle20Regular, ArrowUndo16Regular,
} from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { getItem } from '@/lib/api/workspaces';
import type { MonitorRuleRecord } from '@/lib/azure/activator-monitor';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemBrowseGate } from './new-item-gate';
import { safeModelJson } from './model-fetch';
import { DataAgentResultViz } from './data-agent-result-viz';
import { DataAgentConfigCopilotPanel } from './data-agent-config-copilot';
import { mergeSuggestionIntoSources } from './_da-config-merge';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { ComputePicker } from '@/lib/components/compute-picker';
import { KeyValueRows } from '@/lib/components/ui/key-value-rows';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { ForceDirectedGraph } from '@/lib/components/graph/force-directed-graph';
import { type MapLayer, type MapLayerType } from '@/lib/components/graph/geojson-map';
import {
  AzureMapsCanvas, AZURE_MAPS_STYLES, DEFAULT_BASEMAP, DEFAULT_CONTROLS,
  featurePropertyKeys, type AzureMapsView, type AzureMapsControls,
} from '@/lib/components/graph/azure-maps-canvas';
import { GraphTypeEditor } from '@/lib/components/graph/graph-type-editor';
// Ontology typed-model (Foundry object/link/action types) — pure logic + types
// shared with the BFF routes. The typed-modeling surface in OntologyEditor drives
// this model; deriveSourceFromObjectTypes() keeps state.source in sync so the AGE
// instance/link/action routes keep resolving the declared type names.
import {
  migrateOntologyState, deriveSourceFromObjectTypes, normalizeOntoActionTypes, isOntoIdent,
  ONTO_BASE_TYPES, ONTO_BASE_TYPE_LABELS, ONTO_KEY_ELIGIBLE_TYPES, ONTO_STATUSES, ONTO_COLORS,
  ONTO_CARDINALITIES, ONTO_CARDINALITY_LABELS, ONTO_PARAM_TYPES, ONTO_PARAM_TYPE_LABELS, ONTO_ACTION_KINDS,
  type OntoObjectType, type OntoProperty, type OntoLinkType, type OntoActionType, type OntoActionParam,
  type OntoBaseType, type OntoCardinality, type OntoParamType, type OntoStatus, type OntoColor, type OntoDatasource,
} from './ontology-model';
// Pure-logic helpers extracted for vitest coverage. See
// `lib/editors/__tests__/family-utils.test.ts`.
import {
  validateVarValue,
  parseOntologyHierarchy,
  computeGeoBbox,
  bboxToZoom,
  parseUdfFunctions,
  normalizeDaSources,
  daSupportsExampleQueries,
  shapeDaHistory,
  canSendDaQuestion,
  type VarType,
  type UdfFunction,
  type DaSourceType,
  type OntologyEntityBinding,
  type DaSource,
} from './_family-utils';
import {
  cellKey, getCell, rowTotal, periodTotal, grandTotal,
  cloneScenarioCells, dropScenarioCells, computeVariance, newId,
  defaultScenarios, defaultPlanningSheet,
  flattenPlanCells, filterPlanRows, sortPlanRows,
  periodSeries, forecastPeriods, linearFit, ganttLayout, planInsights,
  applyMappingsToActuals,
  // EPM core — cube model, member hierarchies, roll-ups, guided formulas.
  emptyPlanModel, defaultPlanModel, orderMembers,
  orderedLineItems, lineItemValueAt, lineItemRowTotal, leafInputItems,
  evalFormula, formulaToText, validateModel, validateFormulaRows,
  qfSum, qfAverage, qfDifference, qfRatioPct, qfGrowthPct,
  type PlanScenario, type PlanScenarioKind,
  type PlanningSheet, type PlanSemanticModelRef, type PlanBackingDb,
  type PlanCellRow, type PlanRowSortKey, type PeriodPoint, type GanttBar,
  type PlanSourceMapping, type PlanLineItem,
  type PlanModel, type PlanDimension, type PlanMember, type PlanMeasure,
  type PlanAggKind, type PlanDimensionAxis, type PlanFormulaToken,
  type PlanFormulaFn, type PlanFormulaOp, type ModelIssue,
} from './_plan-model';

/**
 * Defensive array coercion for persisted Cosmos state. Legacy / hand-edited /
 * partially-migrated records can store an array field as a string, object, null
 * or undefined; calling `.map`/`.length`/`.filter` on those throws at render
 * (e.g. the reported `eo.map is not a function` on a data-agent whose `sources`
 * was persisted as a comma-separated STRING). Every read of a persisted array
 * field below funnels through `arr()` so an odd shape renders an empty list
 * instead of crashing the editor. See .claude/rules/no-vaporware.md.
 */
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  monaco: {
    width: '100%', minHeight: '180px', maxWidth: '100%',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase200, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingVerticalM },
  /* Icon + title section header for icon-less Subtitle2 sections. */
  secHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  secHeadIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },

  /* ---- Plan Model (cube) tab — dimension / measure cards (web3 elevation) ---- */
  planModelCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderLeftWidth: '4px', borderLeftColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  planModelCardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  planModelCardIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  planMemberRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
  },
  planIndent: { width: tokens.spacingHorizontalL, flexShrink: 0 },
  planFormulaPreview: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`, wordBreak: 'break-word',
  },
  planTokenChip: {
    display: 'inline-flex', alignItems: 'center',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1,
  },

  /* ---- Data-agent build tab — sectioned, card-based, web-3.0 ---- */
  daSection: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  daSectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  daSectionIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  daAddBar: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  daSrcCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px', borderLeftColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  daSrcHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  daSrcIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorBrandForeground1,
  },
  daFieldLabel: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS },

  /* ---- Data-agent test chat: flex column with a scrollable thread that grows
     and a composer pinned at the bottom so Send is ALWAYS reachable. ---- */
  chatShell: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    height: '62vh',
    gap: tokens.spacingVerticalS,
  },
  chatHead: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, flexShrink: 0 },
  chatThread: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  chatRowUser: { alignSelf: 'flex-end', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: tokens.spacingVerticalXS },
  chatRowBot: { alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: tokens.spacingVerticalXS },
  bubbleUser: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderRadius: '12px 12px 2px 12px',
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: tokens.fontSizeBase300, lineHeight: '20px',
  },
  bubbleBot: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderRadius: '12px 12px 12px 2px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: tokens.fontSizeBase300, lineHeight: '20px',
  },
  bubbleErr: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderRadius: '12px 12px 12px 2px',
    backgroundColor: tokens.colorStatusDangerBackground1,
    border: `1px solid ${tokens.colorStatusDangerBorder1}`,
    color: tokens.colorStatusDangerForeground1,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: tokens.fontSizeBase300, lineHeight: '20px',
  },
  chatMeta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100, paddingLeft: tokens.spacingHorizontalXS },
  chatComposer: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexShrink: 0,
    paddingTop: tokens.spacingVerticalXS,
  },
  chatSource: {
    fontFamily: 'monospace', fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, overflowX: 'auto',
    marginTop: tokens.spacingVerticalXS, whiteSpace: 'pre', color: tokens.colorNeutralForeground1,
  },

  /* ---- Ontology data-bindings + Activator triggers (v3.28) ---- */
  ontoBindGrid: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalL,
    marginTop: tokens.spacingVerticalS,
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  ontoSection: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  ontoSectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  ontoSectionIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  ontoSectionHint: { color: tokens.colorNeutralForeground3 },
  ontoBindRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px', borderLeftColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'background-color, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, boxShadow: tokens.shadow2 },
  },
  ontoSourceGrid: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: tokens.spacingHorizontalL,
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  ontoBindRowSpacer: { flex: 1 },
  ontoEmpty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3, textAlign: 'center',
  },
  ontoLoading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3 },
  ontoStartBtn: { alignSelf: 'flex-start' },
  /* ---- Typed modeling surface (object / link / action types) ---- */
  tmTabPanel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalM },
  tmCardGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: tokens.spacingHorizontalM,
  },
  tmCardMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS },
  tmPropRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) auto auto auto',
    gap: tokens.spacingHorizontalS, alignItems: 'flex-end',
    '@media (max-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  tmParamRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) auto auto',
    gap: tokens.spacingHorizontalS, alignItems: 'flex-end',
    '@media (max-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  tmDialogScroll: {
    maxHeight: '62vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    paddingRight: tokens.spacingHorizontalS,
  },
  tmSubBlock: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  /* Weave (Semantic Ontology) Phase 1 — object instances + write-back actions */
  ontoActionCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px', borderLeftColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  ontoActionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  ontoTableWrap: {
    overflowX: 'auto', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  ontoTableMeta: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    color: tokens.colorNeutralForeground3,
  },
  ontoCellId: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2 },
  ontoSortHeader: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    cursor: 'pointer', userSelect: 'none', background: 'none', border: 'none',
    padding: 0, font: 'inherit', color: 'inherit',
  },

  /* ---- Plan PowerTable / Intelligence / InfoBridge (audit-T64 finish) ---- */
  planSection: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  planSectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  planSectionIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  planToolbar: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
  },
  planGridScroll: { overflowX: 'auto', maxHeight: '460px', overflowY: 'auto', borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}` },
  planSortable: { cursor: 'pointer', userSelect: 'none' },
  planEmpty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, borderRadius: tokens.borderRadiusLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3, textAlign: 'center',
  },
  planKpiRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  planKpi: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '140px', flex: '1 1 140px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px', borderLeftColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  planKpiValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightHero700 },
  planInsight: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2,
  },
  ganttRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: '3px 0' },
  ganttLabel: { width: '180px', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ganttTrack: { position: 'relative', flex: 1, height: '20px', borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralBackground3 },
  ganttBar: { position: 'absolute', top: '3px', height: '14px', borderRadius: tokens.borderRadiusSmall, minWidth: '4px' },
});

// ----- ML Model -----

// MlModelEditor (+ stage transitions, register-from-run, run lineage) lives in
// its own module now; re-exported here so the editor registry import stays stable.
export { MlModelEditor } from './ml-model-editor';

// =====================================================================
// v2.x — Phase 4 misc editors wired to real persistence.
//
// Pattern: each editor uses the generic Cosmos-backed item route:
//   GET    /api/items/<slug>/<id>       → returns the WorkspaceItem
//   PATCH  /api/items/<slug>/<id>       → { state: {...} } persists
// State is the editor's source of truth. Where a real Azure runtime
// exists today (APIM for graphql-api, ADX for graph-model materialize),
// a dedicated action endpoint is also wired. Where the runtime is not
// yet deployed (Foundry Agent Service, Functions code-deploy, Activator
// hooks for ontology/plan), an honest MessageBar surfaces what is and
// isn't live in this build.
// =====================================================================

interface ItemDoc { id: string; displayName: string; state?: Record<string, unknown>; updatedAt?: string }

function useItemState<T extends Record<string, unknown>>(slug: string, id: string, fallback: T) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronously-readable copy of the last save error so callers (e.g. publish)
  // can surface the REAL reason right after `await save()` returns false, rather
  // than a generic "Save failed" (React state is stale in the same tick).
  const saveErrorRef = useRef<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [state, setStateRaw] = useState<T>(fallback);
  // Phase 4.5 — dirty flag: any external setState call (typing, button click,
  // patch/etc.) flips this true. load() / save() reset it false. SaveBar +
  // Ctrl+S handler read it to gate behavior.
  const [dirty, setDirty] = useState(false);
  // Suppress dirty when load() applies server state.
  const suppressDirty = useRef(false);

  const setState = useCallback<typeof setStateRaw>((updater) => {
    setStateRaw(updater as any);
    if (!suppressDirty.current) setDirty(true);
  }, []);

  const load = useCallback(async () => {
    // Pre-save gate: /items/<type>/new fires useItemState before any Cosmos
    // record exists. Skip the fetch so the editor renders its `fallback`
    // initial state until the user saves and we have a real id.
    if (!id || id === 'new') {
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return; }
      const doc = j as ItemDoc;
      if (doc.state && typeof doc.state === 'object') {
        suppressDirty.current = true;
        setStateRaw({ ...fallback, ...(doc.state as T) });
        setDirty(false);
        // Release the suppression on next tick so user-triggered setState
        // calls after this load() correctly mark dirty.
        queueMicrotask(() => { suppressDirty.current = false; });
      }
      setSavedAt(doc.updatedAt || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, id]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (next?: T) => {
    setSaving(true); setError(null); saveErrorRef.current = null;
    if (!id || id === 'new') {
      const msg = 'Cannot save: this agent has no id yet (open it from a workspace, or create it first).';
      saveErrorRef.current = msg; setError(msg); setSaving(false);
      return false;
    }
    try {
      const payload = next ?? state;
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error || `HTTP ${r.status}`;
        saveErrorRef.current = msg; setError(msg); return false;
      }
      setSavedAt(j?.updatedAt || new Date().toISOString());
      // Phase 4.5: explicit save success → no longer dirty. When called
      // programmatically with a `next` arg (publish-then-save, materialize-
      // then-save, deploy-then-save), also clear dirty — the next arg IS
      // the snapshot we just persisted.
      setDirty(false);
      return true;
    } catch (e: any) {
      const msg = e?.message || String(e);
      saveErrorRef.current = msg; setError(msg); return false;
    }
    finally { setSaving(false); }
  }, [slug, id, state]);

  /** Synchronous getter for the last save error (valid immediately after save()). */
  const lastSaveError = useCallback(() => saveErrorRef.current, []);

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  return { state, setState, loading, saving, error, savedAt, save, reload: load, dirty, lastSaveError };
}

function SaveBar({ saving, savedAt, error, onSave, extraRight, dirty }: {
  saving: boolean; savedAt: string | null; error: string | null;
  onSave: () => void; extraRight?: ReactNode;
  // Phase 4.5 — when provided, gates Save button + shows "unsaved" badge.
  dirty?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, padding: `${tokens.spacingVerticalS} 0`, borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
      <Button appearance="primary" onClick={onSave} disabled={saving || dirty === false}>
        {saving ? 'Saving…' : dirty === false ? 'Saved' : 'Save (Ctrl+S)'}
      </Button>
      {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
      {savedAt && !saving && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>}
      {error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Caption1>}
      <div style={{ flex: 1 }} />
      {extraRight}
    </div>
  );
}

// ----- GraphQL API (Cosmos state + real APIM publish) -----
const GQL_SAMPLE = `type Query {\n  customers(region: String, first: Int = 10): [Customer!]!\n}\ntype Customer { id: ID! name: String! orders: [Order!]! }\ntype Order { id: ID! total: Float! }`;
interface GqlState { displayName: string; path: string; serviceUrl: string; sdl: string; description: string; subscriptionRequired: boolean; lastPublishedAt?: string; lastPublishedTo?: string; [k: string]: unknown }
export function GraphqlApiEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<GqlState>('graphql-api', id, {
    displayName: '', path: '', serviceUrl: '', sdl: GQL_SAMPLE, description: '', subscriptionRequired: true,
  });
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  // Test query console.
  const [queryText, setQueryText] = useState('query {\n  __typename\n}');
  const [queryVars, setQueryVars] = useState('');
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryResp, setQueryResp] = useState<{ status: number; body: string } | null>(null);
  const [queryErr, setQueryErr] = useState<string | null>(null);

  const runQuery = useCallback(async () => {
    setQueryBusy(true); setQueryErr(null); setQueryResp(null);
    let variables: any = {};
    if (queryVars.trim()) {
      try { variables = JSON.parse(queryVars); } catch (e: any) { setQueryErr(`Variables must be valid JSON: ${e?.message}`); setQueryBusy(false); return; }
    }
    try {
      const r = await fetch(`/api/items/graphql-api/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: queryText, variables }),
      });
      const j = await r.json();
      if (!j.ok) { setQueryErr(j.error || `HTTP ${r.status}`); return; }
      setQueryResp({ status: j.status, body: j.body });
    } catch (e: any) { setQueryErr(e?.message || String(e)); }
    finally { setQueryBusy(false); }
  }, [id, queryText, queryVars]);

  const publish = useCallback(async () => {
    setPublishing(true); setPublishMsg(null);
    const ok = await save();
    if (!ok) { setPublishing(false); return; }
    try {
      const r = await fetch(`/api/items/graphql-api/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: state.displayName || item.displayName || id,
          path: state.path || id,
          sdl: state.sdl,
          serviceUrl: state.serviceUrl || undefined,
          description: state.description || undefined,
          subscriptionRequired: state.subscriptionRequired,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setPublishMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      // v3.28 Phase 4.5: functional setState so SDL/path edits made WHILE the
      // publish POST is in flight aren't reset by the old `state` snapshot.
      let merged: GqlState | null = null;
      setState((prev) => {
        merged = { ...prev, lastPublishedAt: new Date().toISOString(), lastPublishedTo: j.api?.id || id };
        return merged;
      });
      if (merged) await save(merged);
      setPublishMsg({ intent: 'success', text: `Published to APIM as ${j.api?.name || id}` });
    } catch (e: any) { setPublishMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPublishing(false); }
  }, [id, item.displayName, state, save, setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Schema', actions: [
        { label: 'Reload', onClick: reload },
        { label: publishing ? 'Publishing…' : 'Publish to APIM', onClick: publish, disabled: publishing || saving },
      ]},
      { label: 'Run', actions: [
        { label: queryBusy ? 'Running…' : 'Run query', onClick: runQuery, disabled: queryBusy },
      ]},
      { label: 'Resolvers', actions: [
        { label: 'Edit resolver policies', onClick: () => window.location.assign(`/items/apim-policy/${encodeURIComponent(id)}?scope=api&apiId=${encodeURIComponent(id)}`) },
      ]},
    ]},
  ], [reload, publish, publishing, saving, queryBusy, runQuery, id]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <div className={s.secHead}><Settings20Regular className={s.secHeadIcon} /><Subtitle2>API configuration</Subtitle2></div>
        {/* v3.28 Phase 4.5: functional setState so publish-to-APIM (which calls
            setState(next) after the request) doesn't clobber concurrent typing. */}
        <Caption1>Display name</Caption1>
        <Input value={state.displayName} onChange={(_, d) => setState((p) => ({ ...p, displayName: d.value }))} placeholder={item.displayName || id} />
        <Caption1>URL path suffix (under APIM gateway)</Caption1>
        <Input value={state.path} onChange={(_, d) => setState((p) => ({ ...p, path: d.value }))} placeholder={id} />
        <Caption1>Backend service URL (optional resolver target)</Caption1>
        <Input value={state.serviceUrl} onChange={(_, d) => setState((p) => ({ ...p, serviceUrl: d.value }))} placeholder="https://backend.example.com/graphql" />
        <Caption1>Description</Caption1>
        <Input value={state.description} onChange={(_, d) => setState((p) => ({ ...p, description: d.value }))} />
        {/* Subscription required — now a live form control (the deferred ribbon
            button is removed; this persists to Cosmos and is sent on publish). */}
        <Field label="Subscription required (consumers need an APIM subscription key)">
          <Switch
            checked={!!state.subscriptionRequired}
            onChange={(_, d) => setState((p) => ({ ...p, subscriptionRequired: d.checked }))}
            label={state.subscriptionRequired ? 'Yes' : 'No (anonymous)'}
          />
        </Field>
        <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Table20Regular className={s.secHeadIcon} /><Subtitle2>Schema (SDL)</Subtitle2></div>
        <MonacoTextarea value={state.sdl} onChange={(v) => setState((p) => ({ ...p, sdl: v }))} language="graphql" height={260} minHeight={200} ariaLabel="GraphQL SDL" />
        {state.lastPublishedAt && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Last published {new Date(state.lastPublishedAt).toLocaleString()} → <code>{state.lastPublishedTo}</code>
          </Caption1>
        )}
        {publishMsg && (
          <MessageBar intent={publishMsg.intent}>
            <MessageBarBody>{publishMsg.text}</MessageBarBody>
          </MessageBar>
        )}

        {/* Test query console — runs against the published APIM GraphQL endpoint. */}
        <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Play20Regular className={s.secHeadIcon} /><Subtitle2>Test query console</Subtitle2></div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Runs against the published APIM GraphQL endpoint. Publish first if you haven&apos;t.</Caption1>
        <MonacoTextarea value={queryText} onChange={setQueryText} language="graphql" height={140} minHeight={100} ariaLabel="GraphQL query" />
        <Caption1>Variables (JSON, optional)</Caption1>
        <Textarea value={queryVars} onChange={(_, d) => setQueryVars(d.value)} rows={2} placeholder={'{ "region": "EU" }'} />
        <Button appearance="primary" onClick={runQuery} disabled={queryBusy} style={{ alignSelf: 'flex-start' }}>{queryBusy ? 'Running…' : 'Run query'}</Button>
        {queryErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{queryErr}</MessageBarBody></MessageBar>}
        {queryResp && (
          <>
            <Caption1>HTTP {queryResp.status}</Caption1>
            <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 240 }}>{queryResp.body || '(empty)'}</div>
          </>
        )}

        {/* Resolver authoring is the APIM synthetic-GraphQL set-graphql-resolver
            policy at field scope — honest gate, deep-links to the policy editor. */}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Field resolvers</MessageBarTitle>
            GraphQL resolvers are authored as <code>set-graphql-resolver</code> / <code>&lt;http-data-source&gt;</code> policies at the API scope. Use the <strong>Edit resolver policies</strong> ribbon action (opens the apim-policy editor for this API) to map each field to its backend.
          </MessageBarBody>
        </MessageBar>

        <SaveBar
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
          extraRight={<Button onClick={publish} disabled={publishing || saving}>{publishing ? 'Publishing…' : 'Publish to APIM'}</Button>}
        />
      </div>
    } />
  );
}

// ----- User Data Function (Fabric UDF — code, test/invoke, connections, libraries) -----
const UDF_SAMPLE = `import datetime\nimport fabric.functions as fn\nimport logging\n\nudf = fn.UserDataFunctions()\n\n@udf.function()\ndef compute_score(user_id: str, weight: float = 1.0) -> dict:\n    logging.info('Python UDF trigger function processed a request.')\n    return {"user": user_id, "score": weight * 42}`;
interface UdfLibrary { name: string; version?: string; kind: 'pypi' | 'wheel' }
interface UdfState {
  runtime: 'python';
  entrypoint: string;
  source: string;
  connections: string;
  libraries: UdfLibrary[];
  // Set once the item is published to a Fabric workspace.
  fabricEndpoint?: string;
  fabricWorkspaceId?: string;
  fabricItemId?: string;
  [k: string]: unknown;
}

export function UserDataFunctionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<UdfState>('user-data-function', id, {
    runtime: 'python', entrypoint: 'compute_score', source: UDF_SAMPLE, connections: '', libraries: [],
  });

  // Functions parsed from the source — drives the explorer + Test panel.
  const functions = useMemo<UdfFunction[]>(() => parseUdfFunctions(state.source || ''), [state.source]);

  // Test / Run panel.
  const [testFn, setTestFn] = useState('');
  const [testParams, setTestParams] = useState<Record<string, string>>({});
  const [testBusy, setTestBusy] = useState(false);
  const [testOut, setTestOut] = useState<{ ok: boolean; status?: number; body?: string } | null>(null);
  const [testGate, setTestGate] = useState<string | null>(null);
  const selectedFn = functions.find((f) => f.name === testFn) || functions[0];

  // Generate invocation code dialog.
  const [genOpen, setGenOpen] = useState(false);
  const [genTarget, setGenTarget] = useState<'notebook' | 'python' | 'openapi'>('notebook');

  // Library form.
  const [libName, setLibName] = useState('');
  const [libVer, setLibVer] = useState('');
  const [libKind, setLibKind] = useState<'pypi' | 'wheel'>('pypi');

  const addLibrary = () => {
    if (!libName.trim()) return;
    setState((p) => ({ ...p, libraries: [...arr<UdfLibrary>(p.libraries), { name: libName.trim(), version: libVer.trim() || undefined, kind: libKind }] }));
    setLibName(''); setLibVer('');
  };
  const removeLibrary = (name: string) => setState((p) => ({ ...p, libraries: arr<UdfLibrary>(p.libraries).filter((l) => l.name !== name) }));

  const runTest = useCallback(async () => {
    if (!selectedFn) return;
    setTestBusy(true); setTestOut(null); setTestGate(null);
    // Coerce typed params: numbers/bools parsed, everything else string.
    const parameters: Record<string, unknown> = {};
    for (const p of selectedFn.params) {
      const raw = testParams[p.name] ?? '';
      if (p.type && /int|float|number/i.test(p.type)) parameters[p.name] = raw === '' ? null : Number(raw);
      else if (p.type && /bool/i.test(p.type)) parameters[p.name] = raw === 'true';
      else parameters[p.name] = raw;
    }
    try {
      const r = await fetch(`/api/items/user-data-function/${encodeURIComponent(id)}/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ functionName: selectedFn.name, parameters }),
      });
      const j = await r.json();
      if (r.status === 409 && j.gated) { setTestGate(j.hint || j.error); return; }
      setTestOut({ ok: j.ok, status: j.status, body: j.body || j.error });
    } catch (e: any) { setTestOut({ ok: false, body: e?.message || String(e) }); }
    finally { setTestBusy(false); }
  }, [id, selectedFn, testParams]);

  const invocationCode = useMemo(() => {
    const fn = selectedFn;
    if (!fn) return '# Add a function to generate invocation code';
    const argList = fn.params.map((p) => `${p.name}=${p.type && /int|float|number/i.test(p.type) ? '0' : '"value"'}`).join(', ');
    if (genTarget === 'notebook') {
      return `# Fabric Notebook (mssparkutils)\nimport notebookutils\nresult = notebookutils.udf.run("${item.displayName || id}", "${fn.name}", { ${fn.params.map((p) => `"${p.name}": "value"`).join(', ')} })\ndisplay(result)`;
    }
    if (genTarget === 'python') {
      return `# Python client (external app)\nimport requests\nfrom azure.identity import DefaultAzureCredential\n\ntoken = DefaultAzureCredential().get_token("https://api.fabric.microsoft.com/.default").token\nresp = requests.post(\n    "<UDF_ENDPOINT>/functions/${fn.name}/invoke",\n    headers={"Authorization": f"Bearer {token}"},\n    json={ ${fn.params.map((p) => `"${p.name}": "value"`).join(', ')} },\n)\nprint(resp.status_code, resp.json())`;
    }
    // OpenAPI fragment for the function.
    const props = fn.params.map((p) => `        "${p.name}": { "type": "${p.type && /int|float|number/i.test(p.type) ? 'number' : p.type && /bool/i.test(p.type) ? 'boolean' : 'string'}" }`).join(',\n');
    return `{\n  "openapi": "3.0.1",\n  "info": { "title": "${item.displayName || id}", "version": "1.0" },\n  "paths": {\n    "/functions/${fn.name}/invoke": {\n      "post": {\n        "operationId": "${fn.name}",\n        "requestBody": { "content": { "application/json": { "schema": {\n          "type": "object",\n          "properties": {\n${props}\n          }\n        } } } },\n        "responses": { "200": { "description": "OK" } }\n      }\n    }\n  }\n}`;
  }, [selectedFn, genTarget, id, item.displayName]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Function', actions: [
        { label: 'Reload', onClick: reload },
        { label: saving ? 'Publishing…' : 'Publish', onClick: () => save(), disabled: saving || dirty === false, title: 'Saves source + definition to Cosmos (publish)' },
      ]},
      { label: 'Tools', actions: [
        { label: 'Generate invocation code', onClick: () => setGenOpen(true), disabled: functions.length === 0 },
      ]},
    ]},
  ], [reload, save, saving, dirty, functions.length]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div style={{ padding: tokens.spacingVerticalS }}>
          <Caption1 style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, color: tokens.colorNeutralForeground3 }}>Functions ({functions.length})</Caption1>
          {functions.length === 0 && <Body1 style={{ padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>No <code>@udf.function()</code> definitions found.</Body1>}
          <Tree aria-label="Functions">
            {functions.map((f) => (
              <TreeItem key={f.name} itemType="leaf" onClick={() => setTestFn(f.name)} style={{ background: f.name === (testFn || functions[0]?.name) ? tokens.colorNeutralBackground2 : undefined }}>
                <TreeItemLayout>
                  <span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{f.name}({f.params.map((p) => p.name).join(', ')})</span>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
            <Field label="Runtime"><Input value="python (fabric-user-data-functions)" disabled /></Field>
            <Field label="Default entrypoint"><Input value={state.entrypoint} onChange={(_, d) => setState((p) => ({ ...p, entrypoint: d.value }))} /></Field>
          </div>

          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Flash20Regular className={s.secHeadIcon} /><Subtitle2>function_app.py</Subtitle2></div>
          <MonacoTextarea value={state.source} onChange={(v) => setState((p) => ({ ...p, source: v }))} language="python" height={280} minHeight={200} ariaLabel="Function source" />

          {/* Test / Run panel */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Play20Regular className={s.secHeadIcon} /><Subtitle2>Test / Run</Subtitle2></div>
          <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Field label="Function">
              <Dropdown
                placeholder={functions.length ? 'Select a function' : 'No functions to run'}
                value={selectedFn?.name || ''}
                selectedOptions={selectedFn ? [selectedFn.name] : []}
                onOptionSelect={(_, d) => { setTestFn(d.optionValue || ''); setTestParams({}); }}
              >
                {functions.map((f) => <Option key={f.name} value={f.name}>{f.name}</Option>)}
              </Dropdown>
            </Field>
            {selectedFn?.params.map((p) => (
              <Field key={p.name} label={`${p.name}${p.type ? ` : ${p.type}` : ''}${p.default ? ` (default ${p.default})` : ''}`}>
                <Input value={testParams[p.name] ?? ''} onChange={(_, d) => setTestParams((cur) => ({ ...cur, [p.name]: d.value }))} placeholder={p.default || ''} />
              </Field>
            ))}
            <Button appearance="primary" onClick={runTest} disabled={testBusy || !selectedFn} style={{ alignSelf: 'flex-start' }}>{testBusy ? 'Running…' : 'Run'}</Button>
            {testGate && (
              <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Function not published yet</MessageBarTitle>{testGate}</MessageBarBody></MessageBar>
            )}
            {testOut && (
              <>
                <Caption1>Output {testOut.status != null ? `(HTTP ${testOut.status})` : ''}</Caption1>
                <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>{testOut.body || '(empty)'}</div>
              </>
            )}
          </div>

          {/* Manage connections */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Link20Regular className={s.secHeadIcon} /><Subtitle2>Manage connections (Fabric data sources)</Subtitle2></div>
          <Input value={state.connections} onChange={(_, d) => setState((p) => ({ ...p, connections: d.value }))} placeholder="fin-warehouse, ldn-gold-lakehouse" />

          {/* Library management */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><DataUsage20Regular className={s.secHeadIcon} /><Subtitle2>Library management</Subtitle2></div>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Package"><Input value={libName} onChange={(_, d) => setLibName(d.value)} placeholder="numpy" /></Field>
            <Field label="Version"><Input value={libVer} onChange={(_, d) => setLibVer(d.value)} placeholder="2.0.0" style={{ width: 120 }} /></Field>
            <Field label="Type">
              <Dropdown value={libKind} selectedOptions={[libKind]} onOptionSelect={(_, d) => d.optionValue && setLibKind(d.optionValue as 'pypi' | 'wheel')}>
                <Option value="pypi">PyPI</Option>
                <Option value="wheel">Private wheel</Option>
              </Dropdown>
            </Field>
            <Button onClick={addLibrary} disabled={!libName.trim()}>Add library</Button>
          </div>
          <Table size="small" aria-label="Libraries">
            <TableHeader><TableRow><TableHeaderCell>Package</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
            <TableBody>
              {arr<{ name: string; version?: string; kind: string }>(state.libraries).length === 0 && <TableRow><TableCell>No libraries added.</TableCell><TableCell /><TableCell /><TableCell /></TableRow>}
              {arr<{ name: string; version?: string; kind: string }>(state.libraries).map((l) => (
                <TableRow key={l.name}>
                  <TableCell><strong>{l.name}</strong></TableCell>
                  <TableCell>{l.version || 'latest'}</TableCell>
                  <TableCell>{l.kind}</TableCell>
                  <TableCell><Button size="small" onClick={() => removeLibrary(l.name)}>Remove</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

          {/* Generate invocation code dialog */}
          <Dialog open={genOpen} onOpenChange={(_, d) => { if (!d.open) setGenOpen(false); }}>
            <DialogSurface style={{ maxWidth: '90vw', width: 760 }}>
              <DialogBody>
                <DialogTitle>Generate invocation code — {selectedFn?.name}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <TabList selectedValue={genTarget} onTabSelect={(_, d) => setGenTarget(d.value as typeof genTarget)}>
                      <Tab value="notebook">Notebook</Tab>
                      <Tab value="python">Python client</Tab>
                      <Tab value="openapi">OpenAPI</Tab>
                    </TabList>
                    <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 320 }}>{invocationCode}</div>
                    <Button onClick={() => navigator.clipboard?.writeText(invocationCode).catch(() => {})}>Copy</Button>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setGenOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ----- Variable Library (Cosmos, typed key/value with value sets) -----
// v3.27: extended to Fabric's 7 variable types — String/Integer/Number/
// Boolean/DateTime/Guid/ItemReference/ConnectionReference. Plus the
// Loom-native `secret-ref` for KV / env-var lookups.
// `VarType` is imported from `_family-utils` (see the top-of-file
// import block — it matches the vitest contract).
interface VarDef { name: string; type: VarType; default: string; dev?: string; test?: string; prod?: string; description?: string; }
// `activeValueSet` mirrors Fabric's per-workspace active value set (settings.json).
interface VlState { variables: VarDef[]; activeValueSet?: string; [k: string]: unknown }
const VL_VALUE_SETS: Array<'default' | 'dev' | 'test' | 'prod'> = ['default', 'dev', 'test', 'prod'];

const VAR_TYPE_LABELS: Record<VarType, string> = {
  string: 'String',
  integer: 'Integer',
  number: 'Number',
  bool: 'Boolean',
  datetime: 'DateTime',
  guid: 'Guid',
  'item-ref': 'ItemReference',
  'connection-ref': 'ConnectionReference',
  'secret-ref': 'SecretReference',
};
const VAR_TYPE_PLACEHOLDERS: Record<VarType, string> = {
  string: '',
  integer: '0',
  number: '0.0',
  bool: 'true | false',
  datetime: 'YYYY-MM-DDThh:mm:ssZ',
  guid: '00000000-0000-0000-0000-000000000000',
  'item-ref': 'Loom item id (Cosmos)',
  'connection-ref': 'connection id (ADF Linked Service / Power Platform connection)',
  'secret-ref': 'kv-uri or env var name',
};

// `validateVarValue` is imported from `_family-utils` (see top-of-file
// imports — vitest coverage at `lib/editors/__tests__/family-utils.test.ts`).

export function VariableLibraryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<VlState>('variable-library', id, {
    variables: [
      { name: 'ENV', type: 'string', default: 'dev' },
      { name: 'BatchSize', type: 'number', default: '5000' },
      { name: 'EnableCopilot', type: 'bool', default: 'true' },
    ],
  });
  const [tab, setTab] = useState<typeof VL_VALUE_SETS[number]>('default');
  // v3.28 Phase 4.5: functional setState so concurrent edits + the auto-reload
  // from useItemState's PATCH response don't clobber rapid typing.
  const update = (idx: number, patch: Partial<VarDef>) => {
    setState((prev) => {
      const next = [...arr<VarDef>(prev.variables)];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, variables: next };
    });
  };
  const addRow = () => setState((prev) => {
    const cur = arr<VarDef>(prev.variables);
    return { ...prev, variables: [...cur, { name: `var${cur.length + 1}`, type: 'string', default: '' }] };
  });
  const deleteRow = (idx: number) => setState((prev) => ({
    ...prev,
    variables: arr<VarDef>(prev.variables).filter((_, i) => i !== idx),
  }));
  const valueKey = tab === 'default' ? 'default' : tab;

  // Resolve panel — calls the real dereference layer (/resolve), which pulls
  // secret-ref variables out of Key Vault and expands @{variables.NAME}.
  const [resolved, setResolved] = useState<Array<{ name: string; type: string; value: string; secret: boolean; resolvedFromKv?: boolean; error?: string }> | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [expandText, setExpandText] = useState('@{variables.ENV}/batch?size=@{variables.BatchSize}');
  const [expandOut, setExpandOut] = useState<string | null>(null);
  const runResolve = useCallback(async () => {
    if (id === 'new') { setResolveErr('Save the library before resolving.'); return; }
    setResolveBusy(true); setResolveErr(null);
    try {
      const r = await fetch(`/api/items/variable-library/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ valueSet: tab, text: expandText }),
      });
      const j = await r.json();
      if (!j.ok) { setResolveErr(j.error || 'resolve failed'); setResolved([]); return; }
      setResolved(j.resolved || []);
      setExpandOut(j.expanded ?? null);
    } catch (e: any) { setResolveErr(e?.message || String(e)); setResolved([]); }
    finally { setResolveBusy(false); }
  }, [id, tab, expandText]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Variables', actions: [
        { label: 'New variable', onClick: addRow },
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
      { label: 'Value sets', actions: [
        { label: 'dev', onClick: () => setTab('dev'), appearance: tab === 'dev' ? 'primary' : 'subtle' },
        { label: 'test', onClick: () => setTab('test'), appearance: tab === 'test' ? 'primary' : 'subtle' },
        { label: 'prod', onClick: () => setTab('prod'), appearance: tab === 'prod' ? 'primary' : 'subtle' },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, tab, addRow]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            {VL_VALUE_SETS.map((v) => <Tab key={v} value={v}>{v}</Tab>)}
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <MessageBar intent="info">
            <MessageBarBody>
              Reference variables in pipelines / notebooks as <code>@{'{'}variables.NAME{'}'}</code>. The active value set is resolved at runtime by the executor.
            </MessageBarBody>
          </MessageBar>
          {/* Active value set — mirrors Fabric's per-workspace active set. The
              runtime executor reads state.activeValueSet to resolve values. */}
          <Field label="Active value set (resolved at runtime)">
            <Dropdown
              value={state.activeValueSet || 'default'}
              selectedOptions={[state.activeValueSet || 'default']}
              onOptionSelect={(_, d) => d.optionValue && setState((p) => ({ ...p, activeValueSet: d.optionValue }))}
            >
              {VL_VALUE_SETS.map((v) => <Option key={v} value={v}>{`${v}${v === (state.activeValueSet || 'default') ? ' (active)' : ''}`}</Option>)}
            </Dropdown>
          </Field>
          <Table aria-label="Variables" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Value ({tab})</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell />
            </TableRow></TableHeader>
            <TableBody>
              {arr<VarDef>(state.variables).map((v, i) => {
                const val = (v as any)[valueKey] ?? '';
                const validationErr = validateVarValue(v.type, val);
                return (
                  <TableRow key={i}>
                    <TableCell><Input value={v.name} onChange={(_, d) => update(i, { name: d.value })} /></TableCell>
                    <TableCell>
                      <select value={v.type} onChange={(e) => update(i, { type: e.target.value as VarType })}
                        style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                        {Object.entries(VAR_TYPE_LABELS).map(([t, label]) => (
                          <option key={t} value={t}>{label}</option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                        <Input value={val} onChange={(_, d) => update(i, { [valueKey]: d.value } as any)}
                          placeholder={VAR_TYPE_PLACEHOLDERS[v.type]} />
                        {validationErr && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{validationErr}</Caption1>}
                      </div>
                    </TableCell>
                    <TableCell><Input value={v.description ?? ''} onChange={(_, d) => update(i, { description: d.value })} placeholder="optional" /></TableCell>
                    <TableCell><Button size="small" onClick={() => deleteRow(i)}>Delete</Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ New variable</Button>

          {/* Resolve / dereference — the real substitution layer. */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalM }}><Play20Regular className={s.secHeadIcon} /><Subtitle2>Resolve values ({tab})</Subtitle2></div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Resolves every variable for the <strong>{tab}</strong> value set and expands <code>@{'{'}variables.NAME{'}'}</code> below.
            <code> secret-ref</code> variables are dereferenced from Key Vault (value masked).
          </Caption1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Textarea value={expandText} onChange={(_, d) => setExpandText(d.value)} rows={2} placeholder="@{variables.ENV}/path" />
            <Button appearance="primary" onClick={runResolve} disabled={resolveBusy || id === 'new'} style={{ alignSelf: 'flex-start' }}>
              {resolveBusy ? 'Resolving…' : 'Resolve'}
            </Button>
            {resolveErr && <MessageBar intent="error"><MessageBarBody>{resolveErr}</MessageBarBody></MessageBar>}
            {expandOut != null && (
              <>
                <Caption1>Expanded</Caption1>
                <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 120 }}>{expandOut || '(empty)'}</div>
              </>
            )}
            {resolved && resolved.length > 0 && (
              <Table size="small" aria-label="Resolved values">
                <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Resolved value</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {resolved.map((rv) => (
                    <TableRow key={rv.name}>
                      <TableCell><strong>{rv.name}</strong></TableCell>
                      <TableCell>{rv.type}{rv.secret && rv.resolvedFromKv ? <> <Badge appearance="tint" color="success">Key Vault</Badge></> : null}</TableCell>
                      <TableCell style={{ fontFamily: 'monospace' }}>
                        {rv.error ? <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{rv.error}</Caption1> : (rv.value || '(empty)')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
      </>
    } />
  );
}

// ----- Ontology (text-stored OWL/RDF; class tree parsed client-side) -----
const ONTO_SAMPLE = `# Turtle-ish — define entity types and a parent hierarchy.\n# Each line: "ClassName : ParentClass  -- description"\nThing :  -- root\nParty : Thing -- person or org\nCustomer : Party -- buying party\nVendor : Party -- selling party\nOrder : Thing -- transaction record\nFlight : Thing -- aviation event\n`;
interface OntoState {
  source: string;
  /** Most-recent lakehouse bound (also recorded per-binding in entityBindings). */
  boundLakehouseId?: string;
  /** Most-recent warehouse bound. */
  boundWarehouseId?: string;
  /** Entity-type → data-source bindings (see _family-utils OntologyEntityBinding). */
  entityBindings?: OntologyEntityBinding[];
  /** Backing Cosmos activator item id, created lazily on first trigger. */
  activatorId?: string;
  activatorWorkspaceId?: string;
  /**
   * Typed object types (Foundry "object types") — the structured model that
   * replaces the freeform DSL textarea as the source of truth. The typed-modeling
   * surface persists these; deriveSourceFromObjectTypes() keeps `source` in sync.
   */
  objectTypes?: OntoObjectType[];
  /** Typed link types between object types (Foundry "link types"). */
  linkTypes?: OntoLinkType[];
  /**
   * Weave (Semantic Ontology) Phase 1 — declared write-back action types. Each
   * runs create/update/delete cypher over the bound PG + Apache AGE graph store.
   * Typed (OntoActionType); normalizeOntoActionTypes() is backward-compatible
   * with the legacy { name, objectType, kind, params: string[] } shape.
   */
  actionTypes?: OntoActionType[];
  [k: string]: unknown;
}

/** A declared Weave action type (mirror of lib/azure/weave-ontology-store WeaveActionType). */
interface WeaveActionTypeDecl {
  name: string;
  objectType: string;
  kind: 'create' | 'update' | 'delete';
  params?: string[];
}

// `parseOntologyHierarchy` is imported from `_family-utils` (vitest coverage
// at `lib/editors/__tests__/family-utils.test.ts`).

// Render the parsed ontology class hierarchy as an IS_A force-directed graph.
function OntologyHierarchyViz({ classes }: { classes: { name: string; parent?: string; description?: string }[] }) {
  const g = useMemo(() => {
    const ids = new Set(classes.map((c) => c.name));
    const nodes = classes.map((c) => ({ id: c.name, label: c.name }));
    const edges = classes
      .filter((c) => c.parent && ids.has(c.parent))
      .map((c) => ({ source: c.name, target: c.parent as string, label: 'is_a' }));
    return { nodes, edges };
  }, [classes]);
  if (g.nodes.length === 0) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add a class to see the hierarchy graph.</Caption1>;
  return <ForceDirectedGraph nodes={g.nodes} edges={g.edges} width={320} height={260} />;
}

/**
 * Weave (Semantic Ontology) Phase 1 — object instance write-back + write-back
 * action types over the bound PG + Apache AGE graph store.
 *
 *   • Objects: list instances of a declared object type, create a new instance
 *     (POST /api/items/ontology/[id]/objects → real AGE vertex).
 *   • Write-back actions: declare create/update/delete action types (persisted on
 *     state.actionTypes), then RUN them (POST /api/items/ontology/[id]/run-action
 *     → real AGE transaction). This is the Palantir-class write-back surface.
 *
 * All controls call the real BFF; when the AGE backend env (LOOM_WEAVE_PG_FQDN)
 * is unset the routes return a 503 with a gate that this panel surfaces in a
 * Fluent MessageBar (intent="warning") naming the env var + bicep module — per
 * no-vaporware.md (honest gate, full UI still renders). Azure-native; no Fabric.
 */
function WeaveInstancePanel({
  id,
  classes,
  actionTypes,
  onActionTypesChange,
}: {
  id: string;
  classes: { name: string }[];
  actionTypes: WeaveActionTypeDecl[];
  onActionTypesChange: (next: WeaveActionTypeDecl[]) => void;
}) {
  const s = useStyles();
  const classNames = useMemo(() => classes.map((c) => c.name), [classes]);

  // ── Objects (instances) ──
  const [objType, setObjType] = useState('');
  const [objects, setObjects] = useState<Array<{ id: string; objectType: string; properties: Record<string, unknown> }>>([]);
  const [objLoading, setObjLoading] = useState(false);
  const [objMsg, setObjMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [newProps, setNewProps] = useState('{}');
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'id', dir: 'asc' });

  useEffect(() => { if (!objType && classNames.length) setObjType(classNames[0]); }, [classNames, objType]);

  const loadObjects = useCallback(async (t: string) => {
    if (!id || id === 'new' || !t) return;
    setObjLoading(true); setObjMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/objects?objectType=${encodeURIComponent(t)}&top=100`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || j.gate.reason || ''}` : '';
        setObjMsg({ intent: r.status === 503 ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        setObjects([]);
        return;
      }
      setObjects(Array.isArray(j.objects) ? j.objects : []);
    } catch (e: any) {
      setObjMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setObjLoading(false); }
  }, [id]);

  useEffect(() => { if (objType) void loadObjects(objType); }, [objType, loadObjects]);

  const createObject = useCallback(async () => {
    if (!objType) { setObjMsg({ intent: 'error', text: 'Pick an object type.' }); return; }
    let properties: Record<string, unknown> = {};
    if (newProps.trim()) {
      try { properties = JSON.parse(newProps); } catch { setObjMsg({ intent: 'error', text: 'Properties must be valid JSON (an object of scalar values).' }); return; }
      if (typeof properties !== 'object' || Array.isArray(properties)) { setObjMsg({ intent: 'error', text: 'Properties must be a JSON object.' }); return; }
    }
    setCreating(true); setObjMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/objects`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectType: objType, properties }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || j.gate.reason || ''}` : '';
        setObjMsg({ intent: r.status === 503 ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setObjMsg({ intent: 'success', text: `Created ${objType} instance (AGE vertex id ${j.object?.id}).` });
      setNewProps('{}');
      await loadObjects(objType);
    } catch (e: any) {
      setObjMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setCreating(false); }
  }, [id, objType, newProps, loadObjects]);

  // ── Write-back action types ──
  const [actDlgOpen, setActDlgOpen] = useState(false);
  const [actName, setActName] = useState('');
  const [actObjType, setActObjType] = useState('');
  const [actKind, setActKind] = useState<'create' | 'update' | 'delete'>('create');
  const [actDlgErr, setActDlgErr] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [runParams, setRunParams] = useState<Record<string, string>>({});

  const openActDlg = useCallback(() => {
    setActName(''); setActObjType(classNames[0] || ''); setActKind('create'); setActDlgErr(null); setActDlgOpen(true);
  }, [classNames]);

  const addActionType = useCallback(() => {
    const name = actName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setActDlgErr('Action name must start with a letter/underscore (letters, digits, _).'); return; }
    if (actionTypes.some((a) => a.name === name)) { setActDlgErr(`Action "${name}" already exists.`); return; }
    if (!actObjType) { setActDlgErr('Pick an object type.'); return; }
    onActionTypesChange([...actionTypes, { name, objectType: actObjType, kind: actKind }]);
    setActDlgOpen(false);
  }, [actName, actObjType, actKind, actionTypes, onActionTypesChange]);

  const removeActionType = useCallback((name: string) => {
    onActionTypesChange(actionTypes.filter((a) => a.name !== name));
  }, [actionTypes, onActionTypesChange]);

  const runAction = useCallback(async (action: WeaveActionTypeDecl) => {
    setRunningAction(action.name); setRunMsg(null);
    const params: Record<string, unknown> = {};
    if (action.kind === 'update' || action.kind === 'delete') {
      const idVal = (runParams[`${action.name}.id`] || '').trim();
      if (!idVal) { setRunMsg({ intent: 'error', text: `"${action.name}" needs the target object id.` }); setRunningAction(null); return; }
      params.id = idVal;
    }
    if (action.kind === 'create' || action.kind === 'update') {
      const raw = (runParams[`${action.name}.props`] || '').trim();
      if (raw) {
        try { Object.assign(params, JSON.parse(raw)); } catch { setRunMsg({ intent: 'error', text: 'Properties must be valid JSON.' }); setRunningAction(null); return; }
      }
    }
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/run-action`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action.name, params }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || j.gate.reason || ''}` : '';
        setRunMsg({ intent: r.status === 503 ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      const detail = j.kind === 'delete' ? `deleted ${j.deleted ?? 0}` : `vertex id ${j.object?.id}`;
      setRunMsg({ intent: 'success', text: `Action "${action.name}" (${j.kind}) ran on ${j.objectType} — ${detail}.` });
      if (objType === action.objectType) await loadObjects(objType);
    } catch (e: any) {
      setRunMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setRunningAction(null); }
  }, [id, runParams, objType, loadObjects]);

  const toggleSort = useCallback((col: string) => {
    setSort((prev) => (prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  }, []);

  const objColumns = objects.length ? Object.keys(objects[0].properties || {}) : [];

  const sortedObjects = useMemo(() => {
    const get = (o: { id: string; properties: Record<string, unknown> }) =>
      sort.col === 'id' ? o.id : o.properties?.[sort.col];
    const arr = [...objects].sort((a, b) => {
      const av = get(a); const bv = get(b);
      const an = typeof av === 'number' ? av : Number(av);
      const bn = typeof bv === 'number' ? bv : Number(bv);
      let cmp: number;
      if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== '') cmp = an - bn;
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [objects, sort]);

  if (id === 'new') {
    return (
      <div className={s.ontoSection}>
        <Subtitle2>Objects & write-back actions</Subtitle2>
        <MessageBar intent="info"><MessageBarBody>Save the ontology to enable object instances + write-back actions over the graph store.</MessageBarBody></MessageBar>
      </div>
    );
  }

  const SortIcon = ({ col }: { col: string }) =>
    sort.col !== col ? null : sort.dir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />;

  return (
    <div className={s.ontoBindGrid}>
      {/* ── Object instances ── */}
      <div className={s.ontoSection}>
        <div className={s.ontoSectionHead}>
          <span className={s.ontoSectionIcon}><Database20Regular /></span>
          <div>
            <Subtitle2>Objects <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
            <Caption1 as="p" block className={s.ontoSectionHint}>
              Object instances of a declared type, persisted as Apache AGE vertices on the bound PostgreSQL graph store. Real write-back — Azure-native, no Fabric.
            </Caption1>
          </div>
        </div>
        {classNames.length === 0 ? (
          <MessageBar intent="info"><MessageBarBody>Add an entity (object type) first.</MessageBarBody></MessageBar>
        ) : (
          <>
            <Field label="Object type">
              <Dropdown value={objType} selectedOptions={objType ? [objType] : []} onOptionSelect={(_, d) => setObjType(d.optionValue || '')} placeholder="Select an object type">
                {classNames.map((c) => <Option key={c} value={c}>{c}</Option>)}
              </Dropdown>
            </Field>
            <Field label="New instance properties (JSON object of scalars)" hint='e.g. {"name": "Acme", "tier": 1}'>
              <Textarea value={newProps} onChange={(_, d) => setNewProps(d.value)} resize="vertical" />
            </Field>
            <Button appearance="primary" icon={creating ? <Spinner size="tiny" /> : <Add20Regular />} onClick={createObject} disabled={creating || !objType} className={s.ontoStartBtn}>
              {creating ? 'Creating…' : `Create ${objType || 'object'}`}
            </Button>
            {objMsg && <MessageBar intent={objMsg.intent}><MessageBarBody>{objMsg.text}</MessageBarBody></MessageBar>}
            {objLoading ? (
              <div className={s.ontoLoading}><Spinner size="tiny" /><Caption1>Loading instances…</Caption1></div>
            ) : objects.length === 0 ? (
              <div className={s.ontoEmpty}><Caption1>No {objType} instances yet. Create one above to materialize an AGE vertex.</Caption1></div>
            ) : (
              <>
                <div className={s.ontoTableMeta}>
                  <Caption1>{objects.length} {objects.length === 1 ? 'instance' : 'instances'}</Caption1>
                  <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={() => void loadObjects(objType)} disabled={objLoading}>Refresh</Button>
                </div>
                <div className={s.ontoTableWrap}>
                  <Table size="small" aria-label={`${objType} instances`} sortable>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell aria-sort={sort.col === 'id' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <button type="button" className={s.ontoSortHeader} onClick={() => toggleSort('id')}>id<SortIcon col="id" /></button>
                        </TableHeaderCell>
                        {objColumns.map((c) => (
                          <TableHeaderCell key={c} aria-sort={sort.col === c ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button type="button" className={s.ontoSortHeader} onClick={() => toggleSort(c)}>{c}<SortIcon col={c} /></button>
                          </TableHeaderCell>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedObjects.map((o) => (
                        <TableRow key={o.id}>
                          <TableCell><span className={s.ontoCellId}>{o.id}</span></TableCell>
                          {objColumns.map((c) => <TableCell key={c}>{String(o.properties?.[c] ?? '')}</TableCell>)}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Write-back actions ── */}
      <div className={s.ontoSection}>
        <div className={s.ontoSectionHead}>
          <span className={s.ontoSectionIcon}><Flash20Regular /></span>
          <div>
            <Subtitle2>Write-back actions <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
            <Caption1 as="p" block className={s.ontoSectionHint}>
              Declare create / update / delete actions over the object types, then run them. Each runs a real AGE transaction against the graph store (Palantir-class write-back).
            </Caption1>
          </div>
        </div>
        <Button appearance="primary" icon={<Add20Regular />} onClick={openActDlg} disabled={classNames.length === 0} className={s.ontoStartBtn}>
          Declare action type
        </Button>
        {actionTypes.length === 0 ? (
          <div className={s.ontoEmpty}><Caption1>No actions declared. Use <strong>Declare action type</strong> to add a create / update / delete action.</Caption1></div>
        ) : (
          actionTypes.map((a) => (
            <div key={a.name} className={s.ontoActionCard}>
              <div className={s.ontoActionHead}>
                <Badge appearance="tint" color={a.kind === 'create' ? 'success' : a.kind === 'delete' ? 'danger' : 'brand'}>{a.kind}</Badge>
                <Body1><strong>{a.name}</strong></Body1>
                <Caption1 className={s.ontoSectionHint}>→ {a.objectType}</Caption1>
                <span className={s.ontoBindRowSpacer} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove action ${a.name}`} onClick={() => removeActionType(a.name)}>Remove</Button>
              </div>
              {(a.kind === 'update' || a.kind === 'delete') && (
                <Field label="Target object id (AGE vertex id)">
                  <Input value={runParams[`${a.name}.id`] || ''} onChange={(_, d) => setRunParams((p) => ({ ...p, [`${a.name}.id`]: d.value }))} placeholder="844424930131969" />
                </Field>
              )}
              {(a.kind === 'create' || a.kind === 'update') && (
                <Field label="Properties">
                  <KeyValueRows key={`${a.name}.props`} value={runParams[`${a.name}.props`] || ''}
                    onChange={(json) => setRunParams((p) => ({ ...p, [`${a.name}.props`]: json }))}
                    keyPlaceholder="name" valuePlaceholder="Acme" />
                </Field>
              )}
              <Button appearance="secondary" icon={runningAction === a.name ? <Spinner size="tiny" /> : <Play20Regular />} onClick={() => runAction(a)} disabled={runningAction === a.name} className={s.ontoStartBtn}>
                {runningAction === a.name ? 'Running…' : `Run ${a.name}`}
              </Button>
            </div>
          ))
        )}
        {runMsg && <MessageBar intent={runMsg.intent}><MessageBarBody>{runMsg.text}</MessageBarBody></MessageBar>}
      </div>

      {/* Declare action type dialog */}
      <Dialog open={actDlgOpen} onOpenChange={(_, d) => setActDlgOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Declare write-back action type</DialogTitle>
            <DialogContent>
              <Field label="Action name" required>
                <Input value={actName} onChange={(_, d) => setActName(d.value)} placeholder="createCustomer" />
              </Field>
              <Field label="Object type" required>
                <Dropdown value={actObjType} selectedOptions={actObjType ? [actObjType] : []} onOptionSelect={(_, d) => setActObjType(d.optionValue || '')} placeholder="Select an object type">
                  {classNames.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Kind" required>
                <Dropdown value={actKind} selectedOptions={[actKind]} onOptionSelect={(_, d) => setActKind((d.optionValue as 'create' | 'update' | 'delete') || 'create')}>
                  <Option value="create">create</Option>
                  <Option value="update">update</Option>
                  <Option value="delete">delete</Option>
                </Dropdown>
              </Field>
              {actDlgErr && <MessageBar intent="error"><MessageBarBody>{actDlgErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setActDlgOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={addActionType}>Declare action</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/**
 * Typed modeling surface (Foundry-class object / link / action types) layered over
 * the structured ontology model (`lib/editors/ontology-model.ts`). It reads the
 * typed model via migrateOntologyState(state) (migrating the legacy DSL on first
 * load), lets the user author object types + their typed properties, primary/title
 * keys, an Azure-native datasource backing (ADLS Delta lakehouse / Synapse SQL
 * warehouse — never Fabric), link types between object types, and write-back action
 * types with typed parameters. Every change persists to Cosmos via persistOnto and
 * re-derives state.source so the AGE instance/link/action routes keep resolving the
 * declared type names. No vaporware: real Cosmos persistence; honest gates where a
 * datasource list is empty.
 */
function OntologyTypedModelPanel({
  id, state, persistOnto, lakehouses, warehouses, saving,
}: {
  id: string;
  state: OntoState;
  persistOnto: (next: OntoState) => void;
  lakehouses: { id: string; displayName: string }[];
  warehouses: { id: string; displayName: string }[];
  saving: boolean;
}) {
  const s = useStyles();
  const model = useMemo(() => migrateOntologyState(state), [state]);
  const { objectTypes, linkTypes, actionTypes } = model;
  const objNames = useMemo(() => objectTypes.map((o) => o.apiName), [objectTypes]);
  const [tab, setTab] = useState<'objects' | 'links' | 'actions'>('objects');

  const commit = useCallback((patch: { objectTypes?: OntoObjectType[]; linkTypes?: OntoLinkType[]; actionTypes?: OntoActionType[] }) => {
    const nextObj = patch.objectTypes ?? objectTypes;
    const nextLink = patch.linkTypes ?? linkTypes;
    const nextAct = patch.actionTypes ?? actionTypes;
    persistOnto({ ...state, objectTypes: nextObj, linkTypes: nextLink, actionTypes: nextAct, source: deriveSourceFromObjectTypes(nextObj) });
  }, [state, persistOnto, objectTypes, linkTypes, actionTypes]);

  // ───────────────────────── Object-type dialog ─────────────────────────
  interface OtDraft {
    index: number | null;
    apiName: string; displayName: string; pluralDisplayName: string; description: string;
    status: OntoStatus; color: '' | OntoColor;
    properties: OntoProperty[];
    primaryKey: string; titleKey: string;
    dsKind: '' | 'lakehouse' | 'warehouse'; dsSourceId: string; dsTable: string; dsPkColumn: string;
  }
  const blankOt = (): OtDraft => ({
    index: null, apiName: '', displayName: '', pluralDisplayName: '', description: '',
    status: 'active', color: '', properties: [], primaryKey: '', titleKey: '',
    dsKind: '', dsSourceId: '', dsTable: '', dsPkColumn: '',
  });
  const [otOpen, setOtOpen] = useState(false);
  const [ot, setOt] = useState<OtDraft>(blankOt);
  const [otErr, setOtErr] = useState<string | null>(null);
  const patchOt = (p: Partial<OtDraft>) => setOt((d) => ({ ...d, ...p }));

  const openNewOt = () => { setOt(blankOt()); setOtErr(null); setOtOpen(true); };
  const openEditOt = (i: number) => {
    const o = objectTypes[i];
    const ds = o.datasource;
    setOt({
      index: i, apiName: o.apiName, displayName: o.displayName || '', pluralDisplayName: o.pluralDisplayName || '',
      description: o.description || '', status: o.status || 'active', color: o.color || '',
      properties: o.properties.map((p) => ({ ...p })),
      primaryKey: o.primaryKey || '', titleKey: o.titleKey || '',
      dsKind: ds?.kind || '', dsSourceId: ds?.sourceItemId || '', dsTable: ds?.table || '', dsPkColumn: ds?.primaryKeyColumn || '',
    });
    setOtErr(null); setOtOpen(true);
  };

  const otKeyEligible = useMemo(() => ot.properties.filter((p) => isOntoIdent(p.apiName) && ONTO_KEY_ELIGIBLE_TYPES.has(p.baseType)), [ot.properties]);
  const otAllNamed = useMemo(() => ot.properties.filter((p) => isOntoIdent(p.apiName)), [ot.properties]);

  const saveOt = () => {
    const apiName = ot.apiName.trim();
    if (!isOntoIdent(apiName)) { setOtErr('API name must start with a letter/underscore (≤63 letters, digits, _).'); return; }
    if (objectTypes.some((o, i) => o.apiName === apiName && i !== ot.index)) { setOtErr(`Object type "${apiName}" already exists.`); return; }
    const seen = new Set<string>();
    for (const p of ot.properties) {
      if (!isOntoIdent(p.apiName.trim())) { setOtErr('Every property needs a valid API name (letter/underscore start).'); return; }
      if (seen.has(p.apiName.trim())) { setOtErr(`Duplicate property "${p.apiName.trim()}".`); return; }
      seen.add(p.apiName.trim());
    }
    if (ot.dsKind && !ot.dsSourceId) { setOtErr('Pick a source item for the datasource, or clear the datasource kind.'); return; }
    const properties: OntoProperty[] = ot.properties.map((p) => ({
      apiName: p.apiName.trim(),
      ...(p.displayName ? { displayName: p.displayName } : {}),
      baseType: p.baseType,
      ...(p.arrayOf ? { arrayOf: true } : {}),
      ...(p.required ? { required: true } : {}),
      ...(p.description ? { description: p.description } : {}),
    }));
    let datasource: OntoDatasource | undefined;
    if (ot.dsKind && ot.dsSourceId) {
      const list = ot.dsKind === 'lakehouse' ? lakehouses : warehouses;
      const disp = list.find((x) => x.id === ot.dsSourceId)?.displayName;
      datasource = {
        kind: ot.dsKind, sourceItemId: ot.dsSourceId,
        ...(disp ? { sourceDisplayName: disp } : {}),
        ...(ot.dsTable.trim() ? { table: ot.dsTable.trim() } : {}),
        ...(ot.dsPkColumn.trim() ? { primaryKeyColumn: ot.dsPkColumn.trim() } : {}),
        boundAt: new Date().toISOString(),
      };
    }
    const base = ot.index === null ? ({} as Partial<OntoObjectType>) : objectTypes[ot.index];
    const pk = seen.has(ot.primaryKey) && ONTO_KEY_ELIGIBLE_TYPES.has(properties.find((p) => p.apiName === ot.primaryKey)!.baseType) ? ot.primaryKey : undefined;
    const title = seen.has(ot.titleKey) ? ot.titleKey : undefined;
    const next: OntoObjectType = {
      ...(base.parent ? { parent: base.parent } : {}),
      ...(base.groups ? { groups: base.groups } : {}),
      ...(base.icon ? { icon: base.icon } : {}),
      ...(base.visibility ? { visibility: base.visibility } : {}),
      apiName,
      ...(ot.displayName.trim() ? { displayName: ot.displayName.trim() } : {}),
      ...(ot.pluralDisplayName.trim() ? { pluralDisplayName: ot.pluralDisplayName.trim() } : {}),
      ...(ot.description.trim() ? { description: ot.description.trim() } : {}),
      ...(ot.color ? { color: ot.color } : {}),
      status: ot.status,
      properties,
      ...(pk ? { primaryKey: pk } : {}),
      ...(title ? { titleKey: title } : {}),
      ...(datasource ? { datasource } : {}),
    };
    const arr2 = [...objectTypes];
    if (ot.index === null) arr2.push(next); else arr2[ot.index] = next;
    commit({ objectTypes: arr2 });
    setOtOpen(false);
  };

  const removeOt = (i: number) => {
    const removed = objectTypes[i].apiName;
    commit({
      objectTypes: objectTypes.filter((_, idx) => idx !== i),
      linkTypes: linkTypes.filter((l) => l.fromType !== removed && l.toType !== removed),
      actionTypes: actionTypes.filter((a) => a.objectType !== removed),
    });
  };

  // ───────────────────────── Link-type dialog ─────────────────────────
  interface LtDraft { index: number | null; apiName: string; displayName: string; fromType: string; toType: string; cardinality: OntoCardinality; foreignKeyProperty: string; description: string; }
  const blankLt = (): LtDraft => ({ index: null, apiName: '', displayName: '', fromType: objNames[0] || '', toType: objNames[0] || '', cardinality: 'one-to-many', foreignKeyProperty: '', description: '' });
  const [ltOpen, setLtOpen] = useState(false);
  const [lt, setLt] = useState<LtDraft>(blankLt);
  const [ltErr, setLtErr] = useState<string | null>(null);
  const patchLt = (p: Partial<LtDraft>) => setLt((d) => ({ ...d, ...p }));
  const openNewLt = () => { setLt(blankLt()); setLtErr(null); setLtOpen(true); };
  const openEditLt = (i: number) => {
    const l = linkTypes[i];
    setLt({ index: i, apiName: l.apiName, displayName: l.displayName || '', fromType: l.fromType, toType: l.toType, cardinality: l.cardinality, foreignKeyProperty: l.foreignKeyProperty || '', description: l.description || '' });
    setLtErr(null); setLtOpen(true);
  };
  const saveLt = () => {
    const apiName = lt.apiName.trim();
    if (!isOntoIdent(apiName)) { setLtErr('API name must start with a letter/underscore (≤63 letters, digits, _).'); return; }
    if (linkTypes.some((l, i) => l.apiName === apiName && i !== lt.index)) { setLtErr(`Link type "${apiName}" already exists.`); return; }
    if (!objNames.includes(lt.fromType) || !objNames.includes(lt.toType)) { setLtErr('Pick a from and to object type.'); return; }
    if (lt.foreignKeyProperty.trim() && !isOntoIdent(lt.foreignKeyProperty.trim())) { setLtErr('Foreign-key property must be a valid API name.'); return; }
    const next: OntoLinkType = {
      apiName,
      ...(lt.displayName.trim() ? { displayName: lt.displayName.trim() } : {}),
      fromType: lt.fromType, toType: lt.toType, cardinality: lt.cardinality,
      ...(lt.foreignKeyProperty.trim() ? { foreignKeyProperty: lt.foreignKeyProperty.trim() } : {}),
      ...(lt.description.trim() ? { description: lt.description.trim() } : {}),
    };
    const arr2 = [...linkTypes];
    if (lt.index === null) arr2.push(next); else arr2[lt.index] = next;
    commit({ linkTypes: arr2 });
    setLtOpen(false);
  };
  const removeLt = (i: number) => commit({ linkTypes: linkTypes.filter((_, idx) => idx !== i) });

  // ───────────────────────── Action-type dialog ─────────────────────────
  interface AtDraft { index: number | null; name: string; objectType: string; kind: OntoActionType['kind']; description: string; parameters: OntoActionParam[]; }
  const blankAt = (): AtDraft => ({ index: null, name: '', objectType: objNames[0] || '', kind: 'create', description: '', parameters: [] });
  const [atOpen, setAtOpen] = useState(false);
  const [at, setAt] = useState<AtDraft>(blankAt);
  const [atErr, setAtErr] = useState<string | null>(null);
  const patchAt = (p: Partial<AtDraft>) => setAt((d) => ({ ...d, ...p }));
  const openNewAt = () => { setAt(blankAt()); setAtErr(null); setAtOpen(true); };
  const openEditAt = (i: number) => {
    const a = actionTypes[i];
    setAt({ index: i, name: a.name, objectType: a.objectType, kind: a.kind, description: a.description || '', parameters: a.parameters.map((p) => ({ ...p })) });
    setAtErr(null); setAtOpen(true);
  };
  const saveAt = () => {
    const name = at.name.trim();
    if (!isOntoIdent(name)) { setAtErr('Action name must start with a letter/underscore (≤63 letters, digits, _).'); return; }
    if (actionTypes.some((a, i) => a.name === name && i !== at.index)) { setAtErr(`Action "${name}" already exists.`); return; }
    if (!objNames.includes(at.objectType)) { setAtErr('Pick a target object type.'); return; }
    const seen = new Set<string>();
    for (const p of at.parameters) {
      if (!isOntoIdent(p.apiName.trim())) { setAtErr('Every parameter needs a valid API name (letter/underscore start).'); return; }
      if (seen.has(p.apiName.trim())) { setAtErr(`Duplicate parameter "${p.apiName.trim()}".`); return; }
      seen.add(p.apiName.trim());
    }
    const parameters: OntoActionParam[] = at.parameters.map((p) => ({
      apiName: p.apiName.trim(), type: p.type, ...(p.required ? { required: true } : {}),
      ...(p.prompt ? { prompt: p.prompt } : {}),
    }));
    const next: OntoActionType = { name, objectType: at.objectType, kind: at.kind, ...(at.description.trim() ? { description: at.description.trim() } : {}), parameters };
    const arr2 = [...actionTypes];
    if (at.index === null) arr2.push(next); else arr2[at.index] = next;
    commit({ actionTypes: arr2 });
    setAtOpen(false);
  };
  const removeAt = (i: number) => commit({ actionTypes: actionTypes.filter((_, idx) => idx !== i) });

  const dsList = ot.dsKind === 'warehouse' ? warehouses : lakehouses;
  const colorBadge: Record<OntoColor, 'brand' | 'success' | 'warning' | 'danger' | 'informative' | 'subtle'> = {
    brand: 'brand', success: 'success', warning: 'warning', danger: 'danger', informative: 'informative', subtle: 'subtle',
  };

  return (
    <div className={s.ontoSection}>
      <div className={s.ontoSectionHead}>
        <span className={s.ontoSectionIcon}><Cube20Regular /></span>
        <div>
          <Subtitle2>Typed model</Subtitle2>
          <Caption1 as="p" block className={s.ontoSectionHint}>
            Author object types, typed properties, primary / title keys, an Azure-native datasource backing
            (ADLS Delta lakehouse / Synapse SQL warehouse — no Fabric), link types, and write-back action types.
            Saved to Cosmos; the class DSL stays in sync automatically.
          </Caption1>
        </div>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="objects" icon={<Cube20Regular />}>Object types ({objectTypes.length})</Tab>
        <Tab value="links" icon={<Link20Regular />}>Link types ({linkTypes.length})</Tab>
        <Tab value="actions" icon={<Play20Regular />}>Actions ({actionTypes.length})</Tab>
      </TabList>

      {/* ── Object types ── */}
      {tab === 'objects' && (
        <div className={s.tmTabPanel}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={openNewOt} disabled={saving} className={s.ontoStartBtn}>Add object type</Button>
          {objectTypes.length === 0 ? (
            <EmptyState icon={<Cube20Regular />} title="No object types yet" body="Add an object type to model your domain — each becomes a node type backed by an Azure-native datasource." />
          ) : (
            <div className={s.tmCardGrid}>
              {objectTypes.map((o, i) => (
                <div key={o.apiName} className={s.ontoActionCard}>
                  <div className={s.ontoActionHead}>
                    <Cube20Regular />
                    <Body1><strong>{o.displayName || o.apiName}</strong></Body1>
                    {o.color && <Badge appearance="tint" color={colorBadge[o.color]}>{o.color}</Badge>}
                    {o.status && <Badge appearance="outline" color={o.status === 'active' ? 'success' : o.status === 'deprecated' ? 'danger' : 'warning'}>{o.status}</Badge>}
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label={`Edit ${o.apiName}`} onClick={() => openEditOt(i)} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${o.apiName}`} onClick={() => removeOt(i)} />
                  </div>
                  <Caption1 className={s.ontoSectionHint}><code>{o.apiName}</code>{o.parent ? <> · is_a <code>{o.parent}</code></> : null}</Caption1>
                  {o.description && <Caption1>{o.description}</Caption1>}
                  <div className={s.tmCardMeta}>
                    <Badge appearance="ghost" icon={<Table20Regular />}>{o.properties.length} prop{o.properties.length === 1 ? '' : 's'}</Badge>
                    {o.primaryKey && <Badge appearance="ghost" color="brand">PK: {o.primaryKey}</Badge>}
                    {o.titleKey && <Badge appearance="ghost">title: {o.titleKey}</Badge>}
                    {o.datasource && <Badge appearance="tint" color={o.datasource.kind === 'lakehouse' ? 'brand' : 'success'} icon={<Database20Regular />}>{o.datasource.sourceDisplayName || o.datasource.kind}{o.datasource.table ? ` · ${o.datasource.table}` : ''}</Badge>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Link types ── */}
      {tab === 'links' && (
        <div className={s.tmTabPanel}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={openNewLt} disabled={saving || objNames.length === 0} title={objNames.length === 0 ? 'Add an object type first' : undefined} className={s.ontoStartBtn}>Add link type</Button>
          {objNames.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>Add at least one object type before declaring link types.</MessageBarBody></MessageBar>
          ) : linkTypes.length === 0 ? (
            <EmptyState icon={<Link20Regular />} title="No link types yet" body="Declare a relationship between two object types (one-to-one, one-to-many, or many-to-many)." />
          ) : (
            <div className={s.tmCardGrid}>
              {linkTypes.map((l, i) => (
                <div key={l.apiName} className={s.ontoActionCard}>
                  <div className={s.ontoActionHead}>
                    <Link20Regular />
                    <Body1><strong>{l.displayName || l.apiName}</strong></Body1>
                    <Badge appearance="tint" color="informative">{ONTO_CARDINALITY_LABELS[l.cardinality]}</Badge>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label={`Edit ${l.apiName}`} onClick={() => openEditLt(i)} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${l.apiName}`} onClick={() => removeLt(i)} />
                  </div>
                  <Caption1 className={s.ontoSectionHint}><code>{l.fromType}</code> → <code>{l.toType}</code>{l.foreignKeyProperty ? <> · FK <code>{l.foreignKeyProperty}</code></> : null}</Caption1>
                  {l.description && <Caption1>{l.description}</Caption1>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Action types ── */}
      {tab === 'actions' && (
        <div className={s.tmTabPanel}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={openNewAt} disabled={saving || objNames.length === 0} title={objNames.length === 0 ? 'Add an object type first' : undefined} className={s.ontoStartBtn}>Add action type</Button>
          {objNames.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>Add at least one object type before declaring actions.</MessageBarBody></MessageBar>
          ) : actionTypes.length === 0 ? (
            <EmptyState icon={<Play20Regular />} title="No action types yet" body="Declare a typed create / update / delete write-back action with parameters that run on the AGE graph store." />
          ) : (
            <div className={s.tmCardGrid}>
              {actionTypes.map((a, i) => (
                <div key={a.name} className={s.ontoActionCard}>
                  <div className={s.ontoActionHead}>
                    <Play20Regular />
                    <Body1><strong>{a.name}</strong></Body1>
                    <Badge appearance="tint" color={a.kind === 'create' ? 'success' : a.kind === 'delete' ? 'danger' : 'brand'}>{a.kind}</Badge>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label={`Edit ${a.name}`} onClick={() => openEditAt(i)} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${a.name}`} onClick={() => removeAt(i)} />
                  </div>
                  <Caption1 className={s.ontoSectionHint}>on <code>{a.objectType}</code> · {a.parameters.length} param{a.parameters.length === 1 ? '' : 's'}</Caption1>
                  {a.parameters.length > 0 && (
                    <div className={s.tmCardMeta}>
                      {a.parameters.map((p) => <Badge key={p.apiName} appearance="ghost">{p.apiName}: {ONTO_PARAM_TYPE_LABELS[p.type]}{p.required ? '*' : ''}</Badge>)}
                    </div>
                  )}
                  {a.description && <Caption1>{a.description}</Caption1>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Object-type dialog ── */}
      <Dialog open={otOpen} onOpenChange={(_, d) => setOtOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{ot.index === null ? 'Add object type' : `Edit ${ot.apiName}`}</DialogTitle>
            <DialogContent>
              <div className={s.tmDialogScroll}>
                <Field label="API name" required hint={ot.index === null ? 'Stable identifier (letter/underscore start). Cannot be changed after creation.' : 'Locked after creation to keep links/actions resolving.'}>
                  <Input value={ot.apiName} disabled={ot.index !== null} onChange={(_, d) => patchOt({ apiName: d.value })} placeholder="Customer" />
                </Field>
                <Field label="Display name"><Input value={ot.displayName} onChange={(_, d) => patchOt({ displayName: d.value })} placeholder="Customer" /></Field>
                <Field label="Plural display name"><Input value={ot.pluralDisplayName} onChange={(_, d) => patchOt({ pluralDisplayName: d.value })} placeholder="Customers" /></Field>
                <Field label="Description"><Textarea value={ot.description} onChange={(_, d) => patchOt({ description: d.value })} placeholder="A buying party." /></Field>
                <Field label="Status">
                  <Dropdown value={ot.status} selectedOptions={[ot.status]} onOptionSelect={(_, d) => patchOt({ status: (d.optionValue as OntoStatus) || 'active' })}>
                    {ONTO_STATUSES.map((st) => <Option key={st} value={st}>{st}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Accent color">
                  <Dropdown value={ot.color || '(none)'} selectedOptions={ot.color ? [ot.color] : ['']} onOptionSelect={(_, d) => patchOt({ color: (d.optionValue as OntoColor) || '' })}>
                    <Option value="">(none)</Option>
                    {ONTO_COLORS.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                </Field>

                <div className={s.tmSubBlock}>
                  <div className={s.ontoActionHead}>
                    <Table20Regular />
                    <Subtitle2>Properties</Subtitle2>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" icon={<Add16Regular />} onClick={() => patchOt({ properties: [...ot.properties, { apiName: '', baseType: 'string' }] })}>Add property</Button>
                  </div>
                  {ot.properties.length === 0 ? (
                    <Caption1 className={s.ontoSectionHint}>No properties yet. Add typed properties (string, integer, date, geopoint, …).</Caption1>
                  ) : ot.properties.map((p, pi) => (
                    <div key={pi} className={s.tmPropRow}>
                      <Field label={pi === 0 ? 'API name' : undefined}>
                        <Input value={p.apiName} onChange={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, apiName: d.value } : x) })} placeholder="email" />
                      </Field>
                      <Field label={pi === 0 ? 'Base type' : undefined}>
                        <Dropdown value={ONTO_BASE_TYPE_LABELS[p.baseType]} selectedOptions={[p.baseType]} onOptionSelect={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, baseType: (d.optionValue as OntoBaseType) || 'string' } : x) })}>
                          {ONTO_BASE_TYPES.map((bt) => <Option key={bt} value={bt}>{ONTO_BASE_TYPE_LABELS[bt]}</Option>)}
                        </Dropdown>
                      </Field>
                      <Switch checked={!!p.arrayOf} label="Array" onChange={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, arrayOf: d.checked } : x) })} />
                      <Switch checked={!!p.required} label="Required" onChange={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, required: d.checked } : x) })} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove property ${p.apiName || pi + 1}`} onClick={() => patchOt({ properties: ot.properties.filter((_, xi) => xi !== pi) })} />
                    </div>
                  ))}
                </div>

                <Field label="Primary key" hint="Key-eligible scalar property uniquely identifying an instance.">
                  <Dropdown value={ot.primaryKey || '(none)'} selectedOptions={ot.primaryKey ? [ot.primaryKey] : ['']} onOptionSelect={(_, d) => patchOt({ primaryKey: d.optionValue || '' })} disabled={otKeyEligible.length === 0} placeholder={otKeyEligible.length === 0 ? 'Add a key-eligible property first' : 'Select a property'}>
                    <Option value="">(none)</Option>
                    {otKeyEligible.map((p) => <Option key={p.apiName} value={p.apiName}>{p.apiName}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Title property" hint="The property used as the instance label.">
                  <Dropdown value={ot.titleKey || '(none)'} selectedOptions={ot.titleKey ? [ot.titleKey] : ['']} onOptionSelect={(_, d) => patchOt({ titleKey: d.optionValue || '' })} disabled={otAllNamed.length === 0} placeholder={otAllNamed.length === 0 ? 'Add a property first' : 'Select a property'}>
                    <Option value="">(none)</Option>
                    {otAllNamed.map((p) => <Option key={p.apiName} value={p.apiName}>{p.apiName}</Option>)}
                  </Dropdown>
                </Field>

                <div className={s.tmSubBlock}>
                  <div className={s.ontoActionHead}>
                    <Database20Regular />
                    <Subtitle2>Datasource backing</Subtitle2>
                    <Caption1 className={s.ontoSectionHint}>Azure-native — ADLS Delta lakehouse or Synapse SQL warehouse. No Fabric.</Caption1>
                  </div>
                  <Field label="Kind">
                    <Dropdown value={ot.dsKind ? (ot.dsKind === 'lakehouse' ? 'Lakehouse' : 'Warehouse') : '(none)'} selectedOptions={ot.dsKind ? [ot.dsKind] : ['']} onOptionSelect={(_, d) => patchOt({ dsKind: (d.optionValue as 'lakehouse' | 'warehouse') || '', dsSourceId: '' })}>
                      <Option value="">(none)</Option>
                      <Option value="lakehouse">Lakehouse (ADLS Delta)</Option>
                      <Option value="warehouse">Warehouse (Synapse SQL)</Option>
                    </Dropdown>
                  </Field>
                  {ot.dsKind && (dsList.length === 0 ? (
                    <MessageBar intent="warning"><MessageBarBody>No {ot.dsKind}s available in this workspace{id === 'new' ? ' — save the ontology first' : ''}. Create a {ot.dsKind} to bind instances.</MessageBarBody></MessageBar>
                  ) : (
                    <>
                      <Field label="Source item" required>
                        <Dropdown value={dsList.find((x) => x.id === ot.dsSourceId)?.displayName || ''} selectedOptions={ot.dsSourceId ? [ot.dsSourceId] : []} onOptionSelect={(_, d) => patchOt({ dsSourceId: d.optionValue || '' })} placeholder={`Select a ${ot.dsKind}`}>
                          {dsList.map((x) => <Option key={x.id} value={x.id}>{x.displayName}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Table" hint="Backing table (e.g. dbo.Customer or a Delta table name).">
                        <Input value={ot.dsTable} onChange={(_, d) => patchOt({ dsTable: d.value })} placeholder="dbo.Customer" />
                      </Field>
                      <Field label="Primary-key column" hint="Source column that is the object's primary key.">
                        <Input value={ot.dsPkColumn} onChange={(_, d) => patchOt({ dsPkColumn: d.value })} placeholder="CustomerID" />
                      </Field>
                    </>
                  ))}
                </div>
                {otErr && <MessageBar intent="error"><MessageBarBody>{otErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOtOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={saveOt}>{ot.index === null ? 'Add object type' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ── Link-type dialog ── */}
      <Dialog open={ltOpen} onOpenChange={(_, d) => setLtOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{lt.index === null ? 'Add link type' : `Edit ${lt.apiName}`}</DialogTitle>
            <DialogContent>
              <div className={s.tmDialogScroll}>
                <Field label="API name" required>
                  <Input value={lt.apiName} onChange={(_, d) => patchLt({ apiName: d.value })} placeholder="placedBy" />
                </Field>
                <Field label="Display name"><Input value={lt.displayName} onChange={(_, d) => patchLt({ displayName: d.value })} placeholder="Placed by" /></Field>
                <Field label="From object type" required>
                  <Dropdown value={lt.fromType} selectedOptions={[lt.fromType]} onOptionSelect={(_, d) => patchLt({ fromType: d.optionValue || '' })}>
                    {objNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="To object type" required>
                  <Dropdown value={lt.toType} selectedOptions={[lt.toType]} onOptionSelect={(_, d) => patchLt({ toType: d.optionValue || '' })}>
                    {objNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Cardinality" required>
                  <Dropdown value={ONTO_CARDINALITY_LABELS[lt.cardinality]} selectedOptions={[lt.cardinality]} onOptionSelect={(_, d) => patchLt({ cardinality: (d.optionValue as OntoCardinality) || 'one-to-many' })}>
                    {ONTO_CARDINALITIES.map((c) => <Option key={c} value={c}>{ONTO_CARDINALITY_LABELS[c]}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Foreign-key property" hint="Property on the FK-holding side that materializes the link (one-to-one / one-to-many).">
                  <Input value={lt.foreignKeyProperty} onChange={(_, d) => patchLt({ foreignKeyProperty: d.value })} placeholder="customerId" />
                </Field>
                <Field label="Description"><Textarea value={lt.description} onChange={(_, d) => patchLt({ description: d.value })} /></Field>
                {ltErr && <MessageBar intent="error"><MessageBarBody>{ltErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setLtOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={saveLt}>{lt.index === null ? 'Add link type' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ── Action-type dialog ── */}
      <Dialog open={atOpen} onOpenChange={(_, d) => setAtOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{at.index === null ? 'Add action type' : `Edit ${at.name}`}</DialogTitle>
            <DialogContent>
              <div className={s.tmDialogScroll}>
                <Field label="Action name" required>
                  <Input value={at.name} onChange={(_, d) => patchAt({ name: d.value })} placeholder="createOrder" />
                </Field>
                <Field label="Target object type" required>
                  <Dropdown value={at.objectType} selectedOptions={[at.objectType]} onOptionSelect={(_, d) => patchAt({ objectType: d.optionValue || '' })}>
                    {objNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Kind" required>
                  <Dropdown value={at.kind} selectedOptions={[at.kind]} onOptionSelect={(_, d) => patchAt({ kind: (d.optionValue as OntoActionType['kind']) || 'create' })}>
                    {ONTO_ACTION_KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Description"><Textarea value={at.description} onChange={(_, d) => patchAt({ description: d.value })} /></Field>
                <div className={s.tmSubBlock}>
                  <div className={s.ontoActionHead}>
                    <Settings20Regular />
                    <Subtitle2>Parameters</Subtitle2>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" icon={<Add16Regular />} onClick={() => patchAt({ parameters: [...at.parameters, { apiName: '', type: 'string' }] })}>Add parameter</Button>
                  </div>
                  {at.parameters.length === 0 ? (
                    <Caption1 className={s.ontoSectionHint}>No parameters yet. Add typed parameters the action accepts at run time.</Caption1>
                  ) : at.parameters.map((p, pi) => (
                    <div key={pi} className={s.tmParamRow}>
                      <Field label={pi === 0 ? 'API name' : undefined}>
                        <Input value={p.apiName} onChange={(_, d) => patchAt({ parameters: at.parameters.map((x, xi) => xi === pi ? { ...x, apiName: d.value } : x) })} placeholder="amount" />
                      </Field>
                      <Field label={pi === 0 ? 'Type' : undefined}>
                        <Dropdown value={ONTO_PARAM_TYPE_LABELS[p.type]} selectedOptions={[p.type]} onOptionSelect={(_, d) => patchAt({ parameters: at.parameters.map((x, xi) => xi === pi ? { ...x, type: (d.optionValue as OntoParamType) || 'string' } : x) })}>
                          {ONTO_PARAM_TYPES.map((pt) => <Option key={pt} value={pt}>{ONTO_PARAM_TYPE_LABELS[pt]}</Option>)}
                        </Dropdown>
                      </Field>
                      <Switch checked={!!p.required} label="Required" onChange={(_, d) => patchAt({ parameters: at.parameters.map((x, xi) => xi === pi ? { ...x, required: d.checked } : x) })} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove parameter ${p.apiName || pi + 1}`} onClick={() => patchAt({ parameters: at.parameters.filter((_, xi) => xi !== pi) })} />
                    </div>
                  ))}
                </div>
                {atErr && <MessageBar intent="error"><MessageBarBody>{atErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAtOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={saveAt}>{at.index === null ? 'Add action type' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export function OntologyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<OntoState>('ontology', id, { source: ONTO_SAMPLE });
  const classes = parseOntologyHierarchy(state.source || '');
  const [materializing, setMaterializing] = useState(false);
  const [matMsg, setMatMsg] = useState<string | null>(null);

  // ── Lakehouse/Warehouse entity binding + Activator triggers (v3.28) ──
  // The deferred gate is lifted: bindings are persisted on the ontology item
  // (state.entityBindings) via /api/items/ontology/[id]/bind, and triggers are
  // real Azure Monitor scheduledQueryRules created via
  // /api/items/ontology/[id]/activator. Both default Azure-native (no Fabric).
  const [lakehouses, setLakehouses] = useState<{ id: string; displayName: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; displayName: string }[]>([]);
  const [entityBindings, setEntityBindings] = useState<OntologyEntityBinding[]>([]);
  const [bindingsLoaded, setBindingsLoaded] = useState(false);
  const [bindDlgOpen, setBindDlgOpen] = useState(false);
  const [bindBusy, setBindBusy] = useState(false);
  const [bindMsg, setBindMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [bindSourceKind, setBindSourceKind] = useState<'lakehouse' | 'warehouse'>('lakehouse');
  const [bindSourceId, setBindSourceId] = useState('');
  const [bindEntityTypes, setBindEntityTypes] = useState<string[]>([]);
  // Activator trigger creation.
  const [activatorBusy, setActivatorBusy] = useState(false);
  const [activatorMsg, setActivatorMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [actEntityType, setActEntityType] = useState('');
  const [actEmail, setActEmail] = useState('');
  const [actTable, setActTable] = useState('');

  // Load existing bindings + the lakehouse/warehouse candidate lists for this
  // ontology's workspace (resolved server-side from the item).
  const loadBindings = useCallback(async () => {
    if (!id || id === 'new') { setBindingsLoaded(true); return; }
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/bind`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { setBindingsLoaded(true); return; }
      const j = await r.json();
      if (j?.ok) {
        setLakehouses(Array.isArray(j.lakehouses) ? j.lakehouses : []);
        setWarehouses(Array.isArray(j.warehouses) ? j.warehouses : []);
        setEntityBindings(Array.isArray(j.entityBindings) ? j.entityBindings : []);
      }
    } catch { /* surfaced via the bind MessageBar on action */ }
    finally { setBindingsLoaded(true); }
  }, [id]);
  useEffect(() => { void loadBindings(); }, [loadBindings]);

  // Entity types that have a data-source binding (eligible for triggers).
  const boundEntityTypes = useMemo(() => {
    const set = new Set<string>();
    for (const b of entityBindings) for (const et of b.entityTypes || []) set.add(et);
    return Array.from(set);
  }, [entityBindings]);

  const openBindDlg = useCallback(() => {
    setBindMsg(null);
    setBindSourceKind('lakehouse');
    setBindSourceId('');
    setBindEntityTypes([]);
    setBindDlgOpen(true);
  }, []);

  const submitBinding = useCallback(async () => {
    if (!bindSourceId) { setBindMsg({ intent: 'error', text: 'Pick a source item.' }); return; }
    if (bindEntityTypes.length === 0) { setBindMsg({ intent: 'error', text: 'Select at least one entity type.' }); return; }
    const sourceList = bindSourceKind === 'lakehouse' ? lakehouses : warehouses;
    const sourceDisplayName = sourceList.find((s) => s.id === bindSourceId)?.displayName || bindSourceId;
    setBindBusy(true); setBindMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceKind: bindSourceKind, sourceItemId: bindSourceId, sourceDisplayName, entityTypes: bindEntityTypes }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setBindMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setEntityBindings(Array.isArray(j.entityBindings) ? j.entityBindings : []);
      setBindMsg({ intent: 'success', text: `Bound ${sourceDisplayName} → ${bindEntityTypes.join(', ')}.` });
      setBindDlgOpen(false);
    } catch (e: any) {
      setBindMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBindBusy(false); }
  }, [id, bindSourceKind, bindSourceId, bindEntityTypes, lakehouses, warehouses]);

  const removeBinding = useCallback(async (b: OntologyEntityBinding) => {
    // Durably remove the binding via the bind route's DELETE handler, which
    // strips it from state.entityBindings and reconciles the bound* pointers.
    // Optimistically drop it locally, then reconcile from the server's
    // authoritative list (or roll back on failure).
    const prev = entityBindings;
    setEntityBindings((cur) => cur.filter((x) => x.sourceItemId !== b.sourceItemId));
    setBindMsg(null);
    try {
      const r = await fetch(
        `/api/items/ontology/${encodeURIComponent(id)}/bind?sourceItemId=${encodeURIComponent(b.sourceItemId)}`,
        { method: 'DELETE' },
      );
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        setEntityBindings(prev); // roll back
        setBindMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` });
        return;
      }
      setEntityBindings(Array.isArray(j.entityBindings) ? j.entityBindings : []);
      setBindMsg({ intent: 'success', text: `Removed binding ${b.sourceDisplayName}.` });
    } catch (e: any) {
      setEntityBindings(prev); // roll back
      setBindMsg({ intent: 'error', text: e?.message || String(e) });
    }
  }, [id, entityBindings]);

  const createTrigger = useCallback(async () => {
    if (!actEntityType) { setActivatorMsg({ intent: 'error', text: 'Pick an entity type.' }); return; }
    const binding = entityBindings.find((b) => (b.entityTypes || []).includes(actEntityType));
    setActivatorBusy(true); setActivatorMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/activator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityType: actEntityType,
          sourceKind: binding?.sourceKind,
          sourceItemId: binding?.sourceItemId,
          sourceTable: actTable.trim() || undefined,
          action: actEmail.trim() ? { target: actEmail.trim() } : undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setActivatorMsg({ intent: 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setActivatorMsg({ intent: 'success', text: `Trigger '${j.rule?.name || actEntityType}-change' created on Azure Monitor (fires on INSERT/UPDATE/DELETE of ${actEntityType}).` });
    } catch (e: any) {
      setActivatorMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setActivatorBusy(false); }
  }, [id, actEntityType, actEmail, actTable, entityBindings]);

  // Add entity / Add relationship dialogs. Both append a line to the ontology
  // DSL (`Name : Parent -- description`) and persist via useItemState.save().
  const [entityDlgOpen, setEntityDlgOpen] = useState(false);
  const [relDlgOpen, setRelDlgOpen] = useState(false);
  const [entName, setEntName] = useState('');
  const [entParent, setEntParent] = useState('');
  const [entDesc, setEntDesc] = useState('');
  const [relChild, setRelChild] = useState('');
  const [relParent, setRelParent] = useState('');
  const [dlgErr, setDlgErr] = useState<string | null>(null);

  const openEntityDlg = () => { setEntName(''); setEntParent(''); setEntDesc(''); setDlgErr(null); setEntityDlgOpen(true); };
  const openRelDlg = () => { setRelChild(''); setRelParent(''); setDlgErr(null); setRelDlgOpen(true); };

  // Persist eagerly for existing items; for /new the Cosmos row doesn't exist
  // yet so save() would 404 — the user persists with the Save button instead.
  const persistOnto = useCallback((next: OntoState) => {
    setState(() => next);
    if (id && id !== 'new') save(next);
  }, [id, setState, save]);

  const appendSource = useCallback((line: string) => {
    persistOnto({ ...state, source: `${(state.source || '').replace(/\s*$/, '')}\n${line}\n` });
  }, [state, persistOnto]);

  const addEntity = useCallback(() => {
    const name = entName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Entity name must start with a letter/underscore (letters, digits, _).'); return; }
    if (classes.some((c) => c.name === name)) { setDlgErr(`Entity "${name}" already exists.`); return; }
    const parent = entParent.trim();
    const desc = entDesc.trim();
    appendSource(`${name} : ${parent} ${desc ? `-- ${desc}` : ''}`.trimEnd());
    setEntityDlgOpen(false);
  }, [entName, entParent, entDesc, classes, appendSource]);

  const addRelationship = useCallback(() => {
    const child = relChild.trim();
    const parent = relParent.trim();
    if (!child || !parent) { setDlgErr('Pick both a child and a parent entity.'); return; }
    if (child === parent) { setDlgErr('Child and parent must differ.'); return; }
    // IS_A is the `Child : Parent` edge in the DSL. Rewrite the child's
    // existing line (keeping any description) so we set the parent in place
    // rather than appending a duplicate class definition.
    const lineRe = new RegExp(`^(\\s*)${child}(\\s*:)[^\\n]*$`, 'm');
    let nextSource: string;
    if (lineRe.test(state.source || '')) {
      nextSource = (state.source || '').replace(lineRe, (_m, indent: string) => {
        const existing = classes.find((c) => c.name === child);
        const desc = existing?.description ? ` -- ${existing.description}` : '';
        return `${indent}${child} : ${parent}${desc}`;
      });
    } else {
      nextSource = `${(state.source || '').replace(/\s*$/, '')}\n${child} : ${parent} -- is_a\n`;
    }
    persistOnto({ ...state, source: nextSource });
    setRelDlgOpen(false);
  }, [relChild, relParent, classes, state, persistOnto]);

  // v3.27: D-upgrade — materialize the ontology hierarchy as a graph-model.
  // Each class becomes a node type; parent → child edges become an `is_a`
  // relationship type. The new graph-model can then be ADX-materialized
  // via its own /materialize endpoint to create real KQL tables.
  const materializeToGraphModel = useCallback(async () => {
    if (classes.length === 0) {
      setMatMsg('No classes parsed — nothing to materialize.');
      return;
    }
    setMaterializing(true); setMatMsg(null);
    try {
      const nodes = classes.map(c => ({
        name: c.name,
        properties: [
          { name: 'id', type: 'string' },
          ...(c.description ? [{ name: 'description', type: 'string' }] : []),
        ],
      }));
      const hasParents = classes.some(c => c.parent);
      const edges = hasParents
        ? [{ name: 'IS_A', properties: [{ name: 'inheritedAt', type: 'datetime' }] }]
        : [];
      const r = await fetch('/api/items/graph-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'default',
          displayName: `${item.displayName || 'Ontology'} graph (from ontology ${id})`,
          state: {
            nodes,
            edges,
            database: 'loomdb-default',
            sourceOntologyId: id,
            sourceOntologyClasses: classes.length,
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMatMsg(`Failed: ${j.error || `HTTP ${r.status}`}`); return; }
      setMatMsg(`Materialized as graph-model id=${j.item?.id || j.id} with ${nodes.length} node type(s) + ${edges.length} edge type(s). Open the graph-model editor and click Materialize to push to ADX.`);
    } catch (e: any) {
      setMatMsg(`Failed: ${e?.message || String(e)}`);
    } finally { setMaterializing(false); }
  }, [classes, id, item.displayName]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Author', actions: [
        { label: 'Add entity', onClick: openEntityDlg, disabled: saving, title: 'Add an ontology class' },
        { label: 'Add relationship', onClick: openRelDlg, disabled: saving || classes.length < 1, title: classes.length < 1 ? 'Add at least one entity first' : 'Add an IS_A relationship between two classes' },
      ]},
      { label: 'Bind', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: materializing ? 'Materializing…' : 'Materialize', onClick: materializeToGraphModel, disabled: materializing || classes.length === 0 },
        { label: 'Bind to data source', onClick: openBindDlg, disabled: id === 'new' || classes.length === 0, title: id === 'new' ? 'Save the ontology first' : classes.length === 0 ? 'Add an entity first' : 'Bind a Lakehouse / Warehouse to entity types' },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, materializeToGraphModel, materializing, classes.length, openBindDlg, id]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Ontology runtime</MessageBarTitle>
            <strong>Materialize as graph-model</strong> converts the parsed class hierarchy into a graph-model item (one node type per class, IS_A edge type for parent relationships) that can then be ADX-materialized to real KQL tables. Use <strong>Bind to data source</strong> (Home ribbon) to map Lakehouse / Warehouse tables onto entity types, then create <strong>Activator triggers</strong> below that fire on entity changes (real Azure Monitor alert rules — no Microsoft Fabric required).
          </MessageBarBody>
        </MessageBar>

        {/* ── Typed modeling surface (object / link / action types) ── */}
        <OntologyTypedModelPanel id={id} state={state} persistOnto={persistOnto} lakehouses={lakehouses} warehouses={warehouses} saving={saving} />

        <div className={s.ontoSourceGrid}>
          <div>
            <Subtitle2>Source ({classes.length} classes)</Subtitle2>
            <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalSNudge, color: tokens.colorNeutralForeground3 }}>
              One class per line — DSL: <code>ClassName : ParentClass -- description</code> (parent and
              description optional). Example: <code>Account : Party -- a customer account</code>. Indentation is
              ignored; <code>Child : Parent</code> defines the IS_A hierarchy.
            </Caption1>
            {/* Warn when nothing parses, so the editor doesn't silently produce a
                0-class ontology that materialize/bind/run-action can't act on. */}
            {classes.length === 0 && (state.source || '').trim().length > 0 && (
              <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalSNudge }}>
                <MessageBarBody>
                  The source has content but parsed to <strong>0 classes</strong>. Each class needs its own line
                  in the form <code>ClassName : ParentClass -- description</code>. Fix the grammar above and the
                  class hierarchy will populate.
                </MessageBarBody>
              </MessageBar>
            )}
            {/* v3.28 Phase 4.5: functional setState — materializeToGraphModel
                does NOT write back to state, so this is defensive but cheap. */}
            <MonacoTextarea value={state.source} onChange={(v) => setState((p) => ({ ...p, source: v }))} language="json" height={400} minHeight={320} ariaLabel="Ontology source" />
          </div>
          <div>
            <Subtitle2>Class hierarchy</Subtitle2>
            <Tree aria-label="Class hierarchy">
              {classes.map((c) => (
                <TreeItem itemType="leaf" key={c.name}>
                  <TreeItemLayout>
                    <strong>{c.name}</strong>
                    {c.parent && <Caption1 style={{ marginLeft: tokens.spacingHorizontalSNudge, color: tokens.colorNeutralForeground3 }}>: {c.parent}</Caption1>}
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
            <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Hierarchy graph</Subtitle2>
            <OntologyHierarchyViz classes={classes} />
            <Button appearance="primary" disabled={materializing || classes.length === 0} onClick={materializeToGraphModel} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}>
              {materializing ? 'Materializing…' : `Materialize as graph-model (${classes.length} class${classes.length === 1 ? '' : 'es'})`}
            </Button>
            {matMsg && (
              <MessageBar intent={matMsg.startsWith('Failed') ? 'error' : 'success'} style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>{matMsg}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        </div>

        {/* ── Data bindings + Activator triggers (deferred gate lifted v3.28) ── */}
        <div className={s.ontoBindGrid}>
          <div className={s.ontoSection}>
            <div className={s.ontoSectionHead}>
              <span className={s.ontoSectionIcon}><Link20Regular /></span>
              <div>
                <Subtitle2>Data bindings{entityBindings.length > 0 ? <Badge appearance="tint" color="informative" style={{ marginLeft: tokens.spacingHorizontalS }}>{entityBindings.length}</Badge> : null}</Subtitle2>
                <Caption1 as="p" block className={s.ontoSectionHint}>
                  Map Lakehouse / Warehouse tables onto ontology entity types. Rows of the bound source become instances of the entity. Azure-native (no Fabric).
                </Caption1>
              </div>
            </div>
            <Button appearance="primary" icon={<Database20Regular />} onClick={openBindDlg} disabled={id === 'new' || classes.length === 0} className={s.ontoStartBtn}>
              Bind to data source
            </Button>
            {!bindingsLoaded && id !== 'new' ? (
              <div className={s.ontoLoading}><Spinner size="tiny" /><Caption1>Loading data bindings…</Caption1></div>
            ) : id === 'new' ? (
              <div className={s.ontoEmpty}><Caption1>Save the ontology to enable binding.</Caption1></div>
            ) : entityBindings.length === 0 ? (
              <div className={s.ontoEmpty}><Caption1>No data sources bound yet. Use <strong>Bind to data source</strong> to connect a Lakehouse or Warehouse.</Caption1></div>
            ) : (
              entityBindings.map((b) => (
                <div key={b.sourceItemId} className={s.ontoBindRow}>
                  <Badge appearance="tint" color={b.sourceKind === 'lakehouse' ? 'brand' : 'success'}>{b.sourceKind}</Badge>
                  <Body1><strong>{b.sourceDisplayName}</strong></Body1>
                  <Caption1 className={s.ontoSectionHint}>→ {(b.entityTypes || []).join(', ')}</Caption1>
                  <span className={s.ontoBindRowSpacer} />
                  <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove binding ${b.sourceDisplayName}`} onClick={() => removeBinding(b)}>Remove</Button>
                </div>
              ))
            )}
            {bindMsg && !bindDlgOpen && (
              <MessageBar intent={bindMsg.intent}><MessageBarBody>{bindMsg.text}</MessageBarBody></MessageBar>
            )}
          </div>

          <div className={s.ontoSection}>
            <div className={s.ontoSectionHead}>
              <span className={s.ontoSectionIcon}><Flash20Regular /></span>
              <div>
                <Subtitle2>Activator triggers</Subtitle2>
                <Caption1 as="p" block className={s.ontoSectionHint}>
                  Fire a real Azure Monitor alert when a bound entity changes (INSERT / UPDATE / DELETE). The first trigger creates a backing Activator item.
                </Caption1>
              </div>
            </div>
            {boundEntityTypes.length === 0 ? (
              <MessageBar intent="info"><MessageBarBody>Bind a data source first — triggers run on bound entity types.</MessageBarBody></MessageBar>
            ) : (
              <>
                <Field label="Entity type" required>
                  <Dropdown value={actEntityType} selectedOptions={actEntityType ? [actEntityType] : []} onOptionSelect={(_, d) => setActEntityType(d.optionValue || '')} placeholder="Select a bound entity type">
                    {boundEntityTypes.map((et) => <Option key={et} value={et}>{et}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Source table (optional override)" hint="Defaults to the entity-change event table (LOOM_ACTIVATOR_DEFAULT_TABLE).">
                  <Input value={actTable} onChange={(_, d) => setActTable(d.value)} placeholder="dbo.Customer" />
                </Field>
                <Field label="Notify email (optional)">
                  <Input value={actEmail} onChange={(_, d) => setActEmail(d.value)} placeholder="oncall@contoso.com" />
                </Field>
                <Button appearance="primary" icon={activatorBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={createTrigger} disabled={activatorBusy || !actEntityType} className={s.ontoStartBtn}>
                  {activatorBusy ? 'Creating…' : 'Create trigger'}
                </Button>
              </>
            )}
            {activatorMsg && (
              <MessageBar intent={activatorMsg.intent}><MessageBarBody>{activatorMsg.text}</MessageBarBody></MessageBar>
            )}
          </div>
        </div>

        {/* ── Weave Phase 1: object instances + write-back actions (PG + AGE) ── */}
        <WeaveInstancePanel
          id={id}
          classes={classes}
          actionTypes={Array.isArray(state.actionTypes) ? state.actionTypes : []}
          onActionTypesChange={(next) => persistOnto({ ...state, actionTypes: normalizeOntoActionTypes(next) })}
        />

        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

        {/* Bind-to-data-source dialog: source kind → source item → entity types. */}
        <Dialog open={bindDlgOpen} onOpenChange={(_, d) => setBindDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Bind data source to entity types</DialogTitle>
              <DialogContent>
                <Field label="Source kind" required>
                  <Dropdown
                    value={bindSourceKind === 'lakehouse' ? 'Lakehouse' : 'Warehouse'}
                    selectedOptions={[bindSourceKind]}
                    onOptionSelect={(_, d) => { setBindSourceKind((d.optionValue as 'lakehouse' | 'warehouse') || 'lakehouse'); setBindSourceId(''); }}
                  >
                    <Option value="lakehouse">Lakehouse</Option>
                    <Option value="warehouse">Warehouse</Option>
                  </Dropdown>
                </Field>
                <Field label="Source item" required>
                  {(bindSourceKind === 'lakehouse' ? lakehouses : warehouses).length === 0 ? (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No {bindSourceKind}s in this workspace. Create one first.</Caption1>
                  ) : (
                    <Dropdown
                      value={(bindSourceKind === 'lakehouse' ? lakehouses : warehouses).find((s) => s.id === bindSourceId)?.displayName || ''}
                      selectedOptions={bindSourceId ? [bindSourceId] : []}
                      onOptionSelect={(_, d) => setBindSourceId(d.optionValue || '')}
                      placeholder={`Select a ${bindSourceKind}`}
                    >
                      {(bindSourceKind === 'lakehouse' ? lakehouses : warehouses).map((s) => <Option key={s.id} value={s.id}>{s.displayName}</Option>)}
                    </Dropdown>
                  )}
                </Field>
                <Field label="Entity types" required hint="Classes whose instances live in this source. Suggested matches (same name as a table) are pre-selected.">
                  <Dropdown
                    multiselect
                    value={bindEntityTypes.join(', ')}
                    selectedOptions={bindEntityTypes}
                    onOptionSelect={(_, d) => setBindEntityTypes(d.selectedOptions)}
                    placeholder="Select one or more entity types"
                  >
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                {bindMsg && bindDlgOpen && <MessageBar intent={bindMsg.intent}><MessageBarBody>{bindMsg.text}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setBindDlgOpen(false)} disabled={bindBusy}>Cancel</Button>
                <Button appearance="primary" onClick={submitBinding} disabled={bindBusy} icon={bindBusy ? <Spinner size="tiny" /> : undefined}>{bindBusy ? 'Binding…' : 'Bind'}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={entityDlgOpen} onOpenChange={(_, d) => setEntityDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add entity (ontology class)</DialogTitle>
              <DialogContent>
                <Field label="Class name" required>
                  <Input value={entName} onChange={(_, d) => setEntName(d.value)} placeholder="Invoice" />
                </Field>
                <Field label="Parent class (optional)">
                  <Dropdown value={entParent} selectedOptions={entParent ? [entParent] : []} onOptionSelect={(_, d) => setEntParent(d.optionValue || '')} placeholder="(none — root)">
                    <Option value="">(none — root)</Option>
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Description (optional)">
                  <Input value={entDesc} onChange={(_, d) => setEntDesc(d.value)} placeholder="billing document" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setEntityDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addEntity}>Add entity</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={relDlgOpen} onOpenChange={(_, d) => setRelDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add relationship (IS_A)</DialogTitle>
              <DialogContent>
                <Caption1>Sets the parent of one class to another (the IS_A hierarchy this ontology models).</Caption1>
                <Field label="Child class" required>
                  <Dropdown value={relChild} selectedOptions={relChild ? [relChild] : []} onOptionSelect={(_, d) => setRelChild(d.optionValue || '')} placeholder="Select a class">
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Parent class" required>
                  <Dropdown value={relParent} selectedOptions={relParent ? [relParent] : []} onOptionSelect={(_, d) => setRelParent(d.optionValue || '')} placeholder="Select a class">
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setRelDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addRelationship}>Add relationship</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

// ----- Graph Model (Cosmos config + real ADX materialize) -----
interface GraphDecl { name: string; properties: { name: string; type: string }[] }
interface GraphState { nodes: GraphDecl[]; edges: GraphDecl[]; database: string; lastMaterializedAt?: string; [k: string]: unknown }

// Derive a force-directed graph from the graph-model schema: one node per
// node type, one edge per edge type. Edges that recorded srcType/dstType
// connect the right node types; otherwise they fan from the first node type.
function GraphModelSchemaViz({ nodes, edges }: { nodes: GraphDecl[]; edges: GraphDecl[] }) {
  const g = useMemo(() => {
    const vizNodes = nodes.map((n) => ({ id: n.name, label: n.name }));
    const ids = new Set(vizNodes.map((n) => n.id));
    const vizEdges = edges.map((e) => {
      const src = e.properties?.find((p) => p.name === 'srcType')?.type;
      const dst = e.properties?.find((p) => p.name === 'dstType')?.type;
      // srcType/dstType were stored as property *types* in the add dialog when
      // a from/to node was chosen; fall back to first/last node type.
      const source = (src && ids.has(src) ? src : nodes[0]?.name) || e.name;
      const target = (dst && ids.has(dst) ? dst : nodes[nodes.length - 1]?.name) || e.name;
      return { source, target, label: e.name };
    });
    return { nodes: vizNodes, edges: vizEdges };
  }, [nodes, edges]);
  if (g.nodes.length === 0) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add a node type to see the schema graph.</Caption1>;
  return <ForceDirectedGraph nodes={g.nodes} edges={g.edges} height={300} />;
}

export function GraphModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<GraphState>('graph-model', id, {
    nodes: [{ name: 'Customer', properties: [{ name: 'name', type: 'string' }] }],
    edges: [{ name: 'PLACED', properties: [{ name: 'at', type: 'datetime' }] }],
    database: 'loomdb-default',
  });
  const [materializing, setMaterializing] = useState(false);
  const [matResult, setMatResult] = useState<any>(null);

  // Add entity / Add relationship dialogs — append a typed declaration to
  // state.nodes[] / state.edges[]. The edit flows the dirty flag so SaveBar
  // (and Ctrl+S) persist to Cosmos via useItemState.save().
  const [nodeDlgOpen, setNodeDlgOpen] = useState(false);
  const [edgeDlgOpen, setEdgeDlgOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [propsText, setPropsText] = useState('');
  const [edgeSrc, setEdgeSrc] = useState('');
  const [edgeDst, setEdgeDst] = useState('');
  const [dlgErr, setDlgErr] = useState<string | null>(null);

  // Parse "name:type, name2:type2" → [{name,type}]. Blank → [].
  const parseProps = (txt: string): { name: string; type: string }[] =>
    txt.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [n, t] = p.split(':').map((x) => x.trim());
      return { name: n, type: (t || 'string') };
    });

  const openNodeDlg = () => { setNewName(''); setPropsText(''); setDlgErr(null); setNodeDlgOpen(true); };
  const openEdgeDlg = () => { setNewName(''); setPropsText(''); setEdgeSrc(''); setEdgeDst(''); setDlgErr(null); setEdgeDlgOpen(true); };

  // Add buttons mutate state + flip dirty; the user persists with Save / Ctrl+S
  // (or Materialize, which saves first). For an already-persisted item we also
  // fire save(next) so the addition lands immediately; for /new items save()
  // would 404 (no Cosmos row yet), so we skip the eager save there.
  const persistIfExisting = (next: GraphState) => {
    setState(() => next);
    if (id && id !== 'new') save(next);
  };

  const addEntity = useCallback(() => {
    const name = newName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Entity name must start with a letter/underscore (letters, digits, _).'); return; }
    if (arr<{ name: string }>(state.nodes).some((n) => n.name === name)) { setDlgErr(`Entity "${name}" already exists.`); return; }
    persistIfExisting({ ...state, nodes: [...arr<GraphDecl>(state.nodes), { name, properties: parseProps(propsText) }] });
    setNodeDlgOpen(false);
  }, [newName, propsText, state, id, setState, save]);

  const addRelationship = useCallback(() => {
    const name = newName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Relationship name must start with a letter/underscore (letters, digits, _).'); return; }
    if (arr<{ name: string }>(state.edges).some((e) => e.name === name)) { setDlgErr(`Relationship "${name}" already exists.`); return; }
    const props = parseProps(propsText);
    // src/dst node types captured as edge properties so the materialize step +
    // queries can reference the connected node types.
    if (edgeSrc.trim()) props.unshift({ name: 'srcType', type: 'string' });
    if (edgeDst.trim()) props.unshift({ name: 'dstType', type: 'string' });
    persistIfExisting({ ...state, edges: [...arr<GraphDecl>(state.edges), { name, properties: props }] });
    setEdgeDlgOpen(false);
  }, [newName, propsText, edgeSrc, edgeDst, state, id, setState, save]);

  const materialize = useCallback(async () => {
    setMaterializing(true); setMatResult(null);
    const ok = await save();
    if (!ok) { setMaterializing(false); return; }
    try {
      const r = await fetch(`/api/items/graph-model/${encodeURIComponent(id)}/materialize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: state.database, nodes: arr(state.nodes), edges: arr(state.edges) }),
      });
      const j = await r.json();
      setMatResult(j);
      if (r.ok && j.ok) {
        // v3.28 Phase 4.5: stale-closure fix. Previously `next = { ...state, ... }`
        // captured `state` at click-time and clobbered any typing that happened
        // during the in-flight POST. Use functional setState + capture the merged
        // result for the immediate save() call so what we PATCH matches what
        // the user sees.
        let merged: GraphState | null = null;
        setState((prev) => {
          merged = { ...prev, lastMaterializedAt: new Date().toISOString() };
          return merged;
        });
        if (merged) await save(merged);
      }
    } catch (e: any) { setMatResult({ ok: false, error: e?.message || String(e) }); }
    finally { setMaterializing(false); }
  }, [id, save, setState]);


  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Author', actions: [
        { label: 'Add entity', onClick: openNodeDlg, disabled: saving, title: 'Add a node type to the graph model' },
        { label: 'Add relationship', onClick: openEdgeDlg, disabled: saving, title: 'Add an edge type connecting node types' },
      ]},
      { label: 'Bind', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: materializing ? 'Materializing…' : 'Materialize', onClick: materialize, disabled: materializing || saving },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, materialize, materializing]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <Caption1>Target ADX database</Caption1>
        <Input value={state.database} onChange={(_, d) => setState((p) => ({ ...p, database: d.value }))} />
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
          <div style={{ minWidth: 0 }}>
            <div className={s.secHead}><BranchFork20Regular className={s.secHeadIcon} /><Subtitle2>Node types</Subtitle2></div>
            <GraphTypeEditor kind="node" types={arr(state.nodes)}
              onChange={(next) => setState((p) => ({ ...p, nodes: next }))} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className={s.secHead}><Link20Regular className={s.secHeadIcon} /><Subtitle2>Edge types</Subtitle2></div>
            <GraphTypeEditor kind="edge" types={arr(state.edges)}
              onChange={(next) => setState((p) => ({ ...p, edges: next }))} />
          </div>
        </div>
        <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><ChartMultiple20Regular className={s.secHeadIcon} /><Subtitle2>Schema graph</Subtitle2></div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Node types are vertices; edge types whose properties carry <code>srcType</code> / <code>dstType</code> connect them, others link to a shared hub.
        </Caption1>
        <GraphModelSchemaViz nodes={arr(state.nodes)} edges={arr(state.edges)} />
        {state.lastMaterializedAt && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Last materialized {new Date(state.lastMaterializedAt).toLocaleString()}</Caption1>
        )}
        {matResult && (
          <MessageBar intent={matResult.ok ? 'success' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{matResult.ok ? `Materialized to ${matResult.database}` : 'Materialize failed'}</MessageBarTitle>
              {matResult.created && (
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {matResult.created.map((c: any, i: number) => (
                    <li key={i} style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' }}>
                      {c.ok ? '[ok]' : '[err]'} {c.kind}:{c.name}{c.error ? ` — ${c.error}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {matResult.error && <span>{matResult.error}</span>}
            </MessageBarBody>
          </MessageBar>
        )}
        <SaveBar
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
          extraRight={<Button onClick={materialize} disabled={materializing || saving}>{materializing ? 'Materializing…' : 'Materialize to ADX'}</Button>}
        />

        <Dialog open={nodeDlgOpen} onOpenChange={(_, d) => setNodeDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add entity (node type)</DialogTitle>
              <DialogContent>
                <Field label="Entity name" required>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="Customer" />
                </Field>
                <Field label="Properties (name:type, comma-separated)" hint="e.g. name:string, age:int, joined:datetime. An id:string column is always added at materialize.">
                  <Input value={propsText} onChange={(_, d) => setPropsText(d.value)} placeholder="name:string, region:string" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setNodeDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addEntity}>Add entity</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={edgeDlgOpen} onOpenChange={(_, d) => setEdgeDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add relationship (edge type)</DialogTitle>
              <DialogContent>
                <Field label="Relationship name" required>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="PLACED" />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
                  <Field label="From entity">
                    <Dropdown value={edgeSrc} selectedOptions={edgeSrc ? [edgeSrc] : []} onOptionSelect={(_, d) => setEdgeSrc(d.optionValue || '')} placeholder="(optional)">
                      {arr<{ name: string }>(state.nodes).map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="To entity">
                    <Dropdown value={edgeDst} selectedOptions={edgeDst ? [edgeDst] : []} onOptionSelect={(_, d) => setEdgeDst(d.optionValue || '')} placeholder="(optional)">
                      {arr<{ name: string }>(state.nodes).map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <Field label="Properties (name:type, comma-separated)" hint="src:string and dst:string columns are always added at materialize.">
                  <Input value={propsText} onChange={(_, d) => setPropsText(d.value)} placeholder="at:datetime, weight:real" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setEdgeDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addRelationship}>Add relationship</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

// ----- Plan (Cosmos task list) -----
interface PlanTask { title: string; owner: string; due: string; status: 'todo' | 'doing' | 'done'; dependsOn?: string }
type PlanApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';
interface PlanState {
  tasks: PlanTask[];
  // audit-T13 — approval workflow + semantic-model writeback link.
  approvalStatus?: PlanApprovalStatus;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalReason?: string | null;
  approverEmail?: string;
  linkedSemanticModelId?: string;
  // audit-T64 — EPM/CPM planning surface (budgets / forecasts / scenarios).
  sheets?: PlanningSheet[];
  scenarios?: PlanScenario[];
  activeSheetId?: string;
  activeScenarioId?: string;
  semanticModelRef?: PlanSemanticModelRef;
  backingDb?: PlanBackingDb;
  // EPM core — the multidimensional cube model (dimensions + measures).
  model?: PlanModel;
  // audit-T64 finish — InfoBridge source-system → line-item mappings.
  infoBridge?: PlanSourceMapping[];
  // Intelligence forecast horizon (periods to project); persisted per plan.
  forecastHorizon?: number;
  [k: string]: unknown;
}

/**
 * audit-T13 — Plan approval handoff + semantic-model writeback panel.
 *
 * Routes the plan through the Azure-native approval Logic App (Office 365
 * approval email; no Fabric / Power Automate) and, on approval, pushes the
 * plan's task status + approval state into a linked semantic model via XMLA.
 * Real backends only: POST /api/items/plan/[id]/approval and
 * POST /api/items/semantic-model/[linkedId]/model { planMetrics }. Honest
 * Fluent gates when the Logic App / XMLA endpoint isn't configured.
 */
function PlanApprovalPanel({
  id, tasks, state, setState, save,
}: {
  id: string;
  tasks: PlanTask[];
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
}) {
  const status: PlanApprovalStatus = (state.approvalStatus as PlanApprovalStatus) || 'none';
  const [approver, setApprover] = useState(state.approverEmail || '');
  const [linkedModel, setLinkedModel] = useState(state.linkedSemanticModelId || '');
  const [busy, setBusy] = useState<'request' | 'push' | null>(null);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);

  const statusColor: Record<PlanApprovalStatus, 'informative' | 'warning' | 'success' | 'danger'> = {
    none: 'informative', pending: 'warning', approved: 'success', rejected: 'danger',
  };
  const statusLabel: Record<PlanApprovalStatus, string> = {
    none: 'Not requested', pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
  };

  const requestApproval = useCallback(async () => {
    if (!approver.trim()) { setMsg({ intent: 'error', text: 'Enter an approver email first.' }); return; }
    if (!id || id === 'new') { setMsg({ intent: 'error', text: 'Save the plan before requesting approval.' }); return; }
    setBusy('request'); setMsg(null);
    try {
      const r = await fetch(`/api/items/plan/${encodeURIComponent(id)}/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approverEmail: approver.trim(), linkedSemanticModelId: linkedModel.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const gate = j?.gate;
        setMsg({ intent: gate ? 'warning' : 'error', text: gate ? `${gate.reason} ${gate.remediation}` : (j?.error || `HTTP ${r.status}`) });
        return;
      }
      setState((prev) => ({ ...prev, approvalStatus: 'pending', approverEmail: approver.trim(), linkedSemanticModelId: linkedModel.trim() || undefined }));
      setMsg({ intent: 'success', text: j?.message || 'Approval email sent.' });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(null); }
  }, [approver, linkedModel, id, setState]);

  const refreshStatus = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/plan/${encodeURIComponent(id)}/approval?action=status`);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setState((prev) => ({
          ...prev,
          approvalStatus: j.approvalStatus, approvedBy: j.approvedBy, approvedAt: j.approvedAt, approvalReason: j.approvalReason,
        }));
      }
    } catch { /* best-effort */ }
  }, [id, setState]);

  const pushMetrics = useCallback(async () => {
    const linkId = linkedModel.trim();
    if (!linkId) { setMsg({ intent: 'warning', text: 'Link a semantic model item id to push plan metrics into it.' }); return; }
    setBusy('push'); setMsg(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(linkId)}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planMetrics: { tasks, approvalStatus: status } }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.xmlaUnavailable) {
        setMsg({ intent: 'warning', text: j?.detail || 'XMLA endpoint not configured; metrics saved to model content.' });
      } else if (!r.ok || j?.ok === false) {
        setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` });
      } else {
        setMsg({ intent: 'success', text: `Plan metrics pushed (${j?.backend || 'loom-native'}). ${(j?.steps || []).join(' ')}` });
      }
      // Persist the link on the plan so the callback writeback can find it.
      if (linkId !== (state.linkedSemanticModelId || '')) {
        setState((prev) => ({ ...prev, linkedSemanticModelId: linkId }));
        await save({ ...state, linkedSemanticModelId: linkId });
      }
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(null); }
  }, [linkedModel, tasks, status, state, setState, save]);

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalL,
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusLarge,
        background: tokens.colorNeutralBackground2,
        boxShadow: tokens.shadow2,
      }}
    >
      {/* Section header — leading icon, title, status pill, inline timestamp/reason. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
        <ShieldCheckmark20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
        <Subtitle2>Approval workflow</Subtitle2>
        <Badge appearance="filled" color={statusColor[status]}>{statusLabel[status]}</Badge>
        {status === 'approved' && state.approvedBy && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            by {String(state.approvedBy)}{state.approvedAt ? ` · ${new Date(String(state.approvedAt)).toLocaleString()}` : ''}
          </Caption1>
        )}
        {status === 'rejected' && state.approvalReason && (
          <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{String(state.approvalReason)}</Caption1>
        )}
        {status === 'pending' && (
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowSync16Regular />}
            onClick={refreshStatus}
            style={{ marginLeft: 'auto' }}
          >
            Refresh status
          </Button>
        )}
      </div>

      <Caption1 style={{ color: tokens.colorNeutralForeground3, lineHeight: tokens.lineHeightBase200 }}>
        Routes this plan through the Azure-native approval Logic App (Office 365 approval email). On approval, plan
        metrics can be written into a linked semantic model via XMLA — no Microsoft Fabric / Power Automate required.
      </Caption1>

      <div style={{ height: 1, background: tokens.colorNeutralStroke2, alignSelf: 'stretch' }} />

      {/* Request approval row. */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Approver email" style={{ flex: '1 1 260px', minWidth: 240 }}>
          <Input
            type="email"
            value={approver}
            placeholder="approver@contoso.com"
            contentBefore={<Mail16Regular />}
            onChange={(_, d) => setApprover(d.value)}
            disabled={status === 'pending'}
          />
        </Field>
        <Button
          appearance="primary"
          icon={busy === 'request' ? <Spinner size="tiny" /> : <Mail16Regular />}
          onClick={requestApproval}
          disabled={busy !== null || status === 'pending'}
        >
          {busy === 'request' ? 'Sending…' : status === 'pending' ? 'Awaiting response…' : status === 'approved' ? 'Re-request approval' : 'Request approval'}
        </Button>
      </div>

      {/* Semantic-model writeback row. */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field
          label="Linked semantic model (item id)"
          hint="Plan metrics (_PlanTasks + _PlanMetrics measures) are written here on approval."
          style={{ flex: '1 1 300px', minWidth: 280 }}
        >
          <Input
            value={linkedModel}
            placeholder="semantic-model item id"
            contentBefore={<DataUsage20Regular />}
            onChange={(_, d) => setLinkedModel(d.value)}
          />
        </Field>
        <Button
          icon={busy === 'push' ? <Spinner size="tiny" /> : <ArrowUpload16Regular />}
          onClick={pushMetrics}
          disabled={busy !== null}
        >
          {busy === 'push' ? 'Pushing…' : 'Push plan metrics'}
        </Button>
      </div>

      {msg && (
        <MessageBar intent={msg.intent}>
          <MessageBarBody>
            <MessageBarTitle>
              {msg.intent === 'success' ? 'Done' : msg.intent === 'error' ? 'Could not complete' : msg.intent === 'warning' ? 'Action needed' : 'Status'}
            </MessageBarTitle>
            {msg.text}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

// ===================================================================
// audit-T64 — Plan (preview) EPM/CPM surface
//
// Azure-native parity of Microsoft Fabric's **Plan (preview)** Fabric IQ item:
// budgets, forecasts, scenario modeling, variance — over a bound semantic model
// (for actuals) and an opt-in Azure SQL backing store (for governed writeback).
// NO Microsoft Fabric dependency: planning cells persist to Cosmos by default
// and the entire surface works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
//   Backends: PATCH /api/items/plan/[id] (Cosmos),
//             GET/POST /api/items/plan/[id]/binding (semantic models + backing),
//             POST /api/items/plan/[id]/writeback (Azure SQL MERGE).
// ===================================================================

/** Seed planning collections so a legacy task-only plan still renders fully. */
function ensureSheets(prev: PlanState): PlanningSheet[] {
  const cur = arr<PlanningSheet>(prev.sheets);
  return cur.length ? cur : [defaultPlanningSheet()];
}
function ensureScenarios(prev: PlanState): PlanScenario[] {
  const cur = arr<PlanScenario>(prev.scenarios);
  return cur.length ? cur : defaultScenarios();
}
/** Seed the cube model so a legacy plan (no model) still renders the Model tab. */
function ensureModel(prev: PlanState): PlanModel {
  const m = prev.model;
  if (m && typeof m === 'object' && (Array.isArray(m.dimensions) || Array.isArray(m.measures))) {
    return { dimensions: arr<PlanDimension>(m.dimensions), measures: arr<PlanMeasure>(m.measures) };
  }
  return emptyPlanModel();
}
const fmtNum = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * Settings flyout — semantic-model connection + Azure SQL backing store, the
 * Azure-native parity of Fabric Plan's "Settings → model + database connection".
 */
function PlanSettingsFlyout({
  id, state, setState, open, onClose,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  open: boolean;
  onClose: () => void;
}) {
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [backing, setBacking] = useState<{ configured: boolean; server?: string; database?: string; gate?: { missing: string; reason: string; remediation: string } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    if (!open || !id || id === 'new') return;
    setLoading(true); setMsg(null);
    fetch(`/api/items/plan/${encodeURIComponent(id)}/binding`)
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        if (j?.ok) { setModels(arr(j.semanticModels)); setBacking(j.backing || null); }
        else setMsg({ intent: 'error', text: j?.error || 'Failed to load settings.' });
      })
      .catch((e) => setMsg({ intent: 'error', text: e?.message || String(e) }))
      .finally(() => setLoading(false));
  }, [open, id]);

  const ref = state.semanticModelRef;
  const selectModel = (modelId: string) => {
    const m = models.find((x) => x.id === modelId);
    setState((prev) => ({ ...prev, semanticModelRef: m ? { itemId: m.id, displayName: m.name } : undefined }));
  };
  const provision = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'error', text: 'Save the plan first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/items/plan/${encodeURIComponent(id)}/binding`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'provision' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`) });
        return;
      }
      setBacking({ configured: true, server: j.server, database: j.database });
      setState((prev) => ({ ...prev, backingDb: { kind: 'azure-sql', serverName: j.server, dbName: j.database, provisionedAt: new Date().toISOString() } }));
      setMsg({ intent: 'success', text: j.message || 'Backing store ready.' });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Plan settings</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              {loading && <Spinner size="tiny" label="Loading settings…" labelPosition="after" />}
              <Field label="Semantic model (actuals source)" hint="Plan-vs-actual variance reads measures from this bound model. Azure-native: Loom semantic model / AAS — no Power BI workspace required.">
                <Dropdown
                  placeholder={models.length ? 'Select a semantic model…' : 'No semantic models found'}
                  value={ref?.displayName || ''}
                  selectedOptions={ref ? [ref.itemId] : []}
                  onOptionSelect={(_, d) => selectModel(d.optionValue || '')}
                  disabled={models.length === 0}
                >
                  {models.map((m) => <Option key={m.id} value={m.id}>{m.name}</Option>)}
                </Dropdown>
              </Field>

              <div style={{ height: 1, background: tokens.colorNeutralStroke2 }} />

              <Subtitle2 style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}><Database20Regular /> Backing store (writeback)</Subtitle2>
              {backing?.configured ? (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Azure SQL configured</MessageBarTitle>
                    Writeback target: <strong>{backing.database}</strong> on <strong>{backing.server}</strong>. Saved planning cells MERGE into <code>dbo.loom_plan_cells</code>.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No Azure SQL writeback store</MessageBarTitle>
                    {backing?.gate?.reason || 'Planning cells persist to Cosmos and the plan is fully functional.'}{' '}
                    {backing?.gate ? <>Set <code>{backing.gate.missing}</code>. {backing.gate.remediation}</> : null}
                  </MessageBarBody>
                </MessageBar>
              )}
              <Button
                icon={busy ? <Spinner size="tiny" /> : <Database20Regular />}
                onClick={provision}
                disabled={busy || (backing?.configured === false && !!backing?.gate)}
                appearance={backing?.configured ? 'secondary' : 'primary'}
                style={{ alignSelf: 'flex-start' }}
              >
                {backing?.configured ? 'Re-provision tables' : 'Provision backing store'}
              </Button>

              {msg && (
                <MessageBar intent={msg.intent}>
                  <MessageBarBody>{msg.text}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>Done</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** The planning-sheet grid: dimensions on rows, periods on columns, scenarios, variance. */
function PlanningSheetPanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const sheets = ensureSheets(state);
  const scenarios = ensureScenarios(state);
  const activeSheetId = sheets.some((s) => s.id === state.activeSheetId) ? (state.activeSheetId as string) : sheets[0].id;
  const activeScenarioId = scenarios.some((s) => s.id === state.activeScenarioId) ? (state.activeScenarioId as string) : scenarios[0].id;
  const sheet = sheets.find((s) => s.id === activeSheetId) || sheets[0];
  const scenario = scenarios.find((s) => s.id === activeScenarioId) || scenarios[0];

  const [showVariance, setShowVariance] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  // Hierarchy drill-down (collapsed parent ids) + Formula builder target row.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [formulaEdit, setFormulaEdit] = useState<string | null>(null);
  const toggleCollapse = (liId: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(liId)) next.delete(liId); else next.add(liId);
    return next;
  });

  // All sheet mutations funnel through here so the seeded defaults persist.
  const mutateSheet = (sheetId: string, mut: (s: PlanningSheet) => PlanningSheet) =>
    setState((prev) => ({
      ...prev,
      sheets: ensureSheets(prev).map((s) => (s.id === sheetId ? mut(s) : s)),
      scenarios: ensureScenarios(prev),
      activeSheetId, activeScenarioId,
    }));

  const setCell = (lineItemId: string, periodId: string, raw: string) => {
    const value = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(value)) return;
    mutateSheet(sheet.id, (s) => ({ ...s, cells: { ...s.cells, [cellKey(lineItemId, periodId, activeScenarioId)]: value } }));
  };
  const setActual = (lineItemId: string, raw: string) => {
    const value = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(value)) return;
    mutateSheet(sheet.id, (s) => ({ ...s, actuals: { ...(s.actuals || {}), [lineItemId]: value } }));
  };
  const addLineItem = () => mutateSheet(sheet.id, (s) => ({ ...s, lineItems: [...s.lineItems, { id: newId('li'), name: 'New line item', kind: 'input' }] }));
  const renameLineItem = (liId: string, name: string) => mutateSheet(sheet.id, (s) => ({ ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, name } : li)) }));
  const removeLineItem = (liId: string) => mutateSheet(sheet.id, (s) => ({ ...s, lineItems: s.lineItems.filter((li) => li.id !== liId) }));
  const addPeriod = () => mutateSheet(sheet.id, (s) => ({ ...s, periods: [...s.periods, { id: newId('p'), label: `P${s.periods.length + 1}` }] }));
  const renamePeriod = (pId: string, label: string) => mutateSheet(sheet.id, (s) => ({ ...s, periods: s.periods.map((p) => (p.id === pId ? { ...p, label } : p)) }));
  const removePeriod = (pId: string) => mutateSheet(sheet.id, (s) => ({ ...s, periods: s.periods.filter((p) => p.id !== pId) }));

  // ----- Formula rows + member hierarchy (roll-up / drill-down) -----
  const addFormulaRow = () => {
    const fid = newId('li');
    mutateSheet(sheet.id, (s) => ({ ...s, lineItems: [...s.lineItems, { id: fid, name: 'New formula', kind: 'formula', formula: [] }] }));
    setFormulaEdit(fid); // open the builder immediately
  };
  const setLineItemFormula = (liId: string, formula: PlanFormulaToken[]) =>
    mutateSheet(sheet.id, (s) => ({ ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, kind: 'formula', formula } : li)) }));
  // Indent a row under the nearest preceding sibling (same depth) → makes a hierarchy.
  const indentRow = (liId: string) => mutateSheet(sheet.id, (s) => {
    const ordered = orderedLineItems(s.lineItems);
    const idx = ordered.findIndex((o) => o.item.id === liId);
    if (idx <= 0) return s;
    const me = ordered[idx];
    for (let i = idx - 1; i >= 0; i--) {
      if (ordered[i].depth === me.depth) {
        return { ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, parentId: ordered[i].item.id } : li)) };
      }
      if (ordered[i].depth < me.depth) break;
    }
    return s;
  });
  const outdentRow = (liId: string) => mutateSheet(sheet.id, (s) => {
    const me = s.lineItems.find((li) => li.id === liId);
    if (!me?.parentId) return s;
    const grand = s.lineItems.find((li) => li.id === me.parentId)?.parentId ?? null;
    return { ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, parentId: grand } : li)) };
  });
  // Apply a quick formula directly to a row (no dialog) — converts it to formula.
  const applyQuickFormula = (liId: string, tokens: PlanFormulaToken[]) => {
    setLineItemFormula(liId, tokens);
    setMsg({ intent: 'success', text: 'Quick formula applied. Open the formula to refine it.' });
  };

  const addSheet = () => {
    const ns = { ...defaultPlanningSheet(), id: newId('sheet'), name: `Sheet ${sheets.length + 1}`, cells: {}, actuals: {} };
    setState((prev) => ({ ...prev, sheets: [...ensureSheets(prev), ns], scenarios: ensureScenarios(prev), activeSheetId: ns.id, activeScenarioId }));
  };
  const setActiveSheet = (sid: string) => setState((prev) => ({ ...prev, sheets: ensureSheets(prev), scenarios: ensureScenarios(prev), activeSheetId: sid, activeScenarioId }));
  const setActiveScenario = (scid: string) => setState((prev) => ({ ...prev, sheets: ensureSheets(prev), scenarios: ensureScenarios(prev), activeSheetId, activeScenarioId: scid }));

  // Branch the active scenario into a new custom scenario, cloning every sheet's
  // cells so the new branch starts from the source's assumptions.
  const branchScenario = () => {
    const nid = newId('sc');
    setState((prev) => {
      const sc = ensureScenarios(prev);
      const src = sc.find((x) => x.id === activeScenarioId) || sc[0];
      const nextScenarios = [...sc, { id: nid, name: `${src.name} (copy)`, kind: 'custom' as PlanScenarioKind }];
      const nextSheets = ensureSheets(prev).map((s) => ({ ...s, cells: cloneScenarioCells(s.cells, activeScenarioId, nid) }));
      return { ...prev, scenarios: nextScenarios, sheets: nextSheets, activeSheetId, activeScenarioId: nid };
    });
  };
  const removeScenario = (scid: string) => {
    if (scenarios.length <= 1) { setMsg({ intent: 'warning', text: 'A plan needs at least one scenario.' }); return; }
    setState((prev) => {
      const sc = ensureScenarios(prev).filter((x) => x.id !== scid);
      const nextSheets = ensureSheets(prev).map((s) => ({ ...s, cells: dropScenarioCells(s.cells, scid) }));
      return { ...prev, scenarios: sc, sheets: nextSheets, activeSheetId, activeScenarioId: sc[0].id };
    });
  };
  const renameScenario = (scid: string, name: string) =>
    setState((prev) => ({ ...prev, scenarios: ensureScenarios(prev).map((x) => (x.id === scid ? { ...x, name } : x)), sheets: ensureSheets(prev), activeSheetId, activeScenarioId }));

  // Writeback the active sheet's cells (all scenarios) into Azure SQL.
  const writeback = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'warning', text: 'Save the plan first.' }); return; }
    // Only leaf-input cells are persisted — roll-up parents + formula rows are
    // computed, never stored (so a row converted to a parent/formula can't push
    // stale numbers). Mirrors flattenPlanCells / the SQL round-trip.
    const leafIds = new Set(leafInputItems(sheet.lineItems).map((li) => li.id));
    const cells = Object.entries(sheet.cells)
      .map(([k, value]) => {
        const [lineItemId, periodId, scenarioId] = k.split('|');
        return { lineItemId, periodId, scenarioId, value };
      })
      .filter((c) => leafIds.has(c.lineItemId));
    if (cells.length === 0) { setMsg({ intent: 'warning', text: 'No cells to write back yet.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await save(); // persist to Cosmos first (the always-works default)
      const r = await fetch(`/api/items/plan/${encodeURIComponent(id)}/writeback`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sheetId: sheet.id, cells }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: j?.gate ? `Saved to Cosmos. SQL writeback skipped: set ${j.gate.missing}. ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`) });
        return;
      }
      setMsg({ intent: 'success', text: j.message || `${j.written} cells written to Azure SQL.` });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  const variance = computeVariance(sheet, activeScenarioId, sheet.actuals || {});
  // Hierarchy-ordered rows (parents before children). A row is hidden when any
  // ancestor is collapsed (drill-down). Roll-up parents + formula rows render
  // read-only computed values; only leaf inputs are editable.
  const ordered = orderedLineItems(sheet.lineItems);
  const byId = new Map(sheet.lineItems.map((li) => [li.id, li]));
  const isHidden = (li: PlanLineItem) => {
    let pid = li.parentId;
    while (pid) { if (collapsed.has(pid)) return true; pid = byId.get(pid)?.parentId ?? null; }
    return false;
  };
  const visibleRows = ordered.filter((o) => !isHidden(o.item));
  // Candidate rows a formula can reference (every row in the sheet except itself).
  const formulaCandidates = sheet.lineItems.map((li) => ({ id: li.id, name: li.name }));
  const editingFormulaItem = formulaEdit ? byId.get(formulaEdit) : undefined;
  const varColspan = sheet.periods.length + (showVariance ? 6 : 3);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Planning sheet</MessageBarTitle>
          Build budgets / forecasts across periods, branch what-if scenarios, and compare plan vs actuals — the Azure-native
          parity of Microsoft Fabric Plan (preview). Cells persist to Cosmos; <strong>Write back</strong> MERGEs them into an
          Azure SQL store when one is configured (Settings). No Microsoft Fabric capacity required.
        </MessageBarBody>
      </MessageBar>

      {/* Toolbar: sheet · scenario · branch · variance · writeback · settings */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Sheet">
          <Dropdown value={sheet.name} selectedOptions={[sheet.id]} onOptionSelect={(_, d) => setActiveSheet(d.optionValue || sheet.id)} style={{ minWidth: 180 }}>
            {sheets.map((s) => <Option key={s.id} value={s.id}>{s.name}</Option>)}
          </Dropdown>
        </Field>
        <Button icon={<Add20Regular />} onClick={addSheet}>New sheet</Button>
        <Field label="Scenario">
          <Dropdown value={scenario.name} selectedOptions={[scenario.id]} onOptionSelect={(_, d) => setActiveScenario(d.optionValue || scenario.id)} style={{ minWidth: 180 }}>
            {scenarios.map((sc) => <Option key={sc.id} value={sc.id} text={sc.name}>{sc.name} · {sc.kind}</Option>)}
          </Dropdown>
        </Field>
        <Button icon={<BranchFork20Regular />} onClick={branchScenario}>Branch scenario</Button>
        <Switch label="Variance vs actuals" checked={showVariance} onChange={(_, d) => setShowVariance(d.checked)} />
        <div style={{ flex: 1 }} />
        <Button icon={<Calculator20Regular />} onClick={addFormulaRow}>Add formula row</Button>
        <Button icon={busy ? <Spinner size="tiny" /> : <ArrowUpload16Regular />} onClick={writeback} disabled={busy}>Write back</Button>
        <Button icon={<Settings20Regular />} onClick={() => setSettingsOpen(true)}>Settings</Button>
      </div>

      {/* Scenario rename / delete row */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge appearance="filled" color="brand">{scenario.kind}</Badge>
        <Input value={scenario.name} onChange={(_, d) => renameScenario(scenario.id, d.value)} style={{ maxWidth: 220 }} aria-label="Scenario name" />
        {scenarios.length > 1 && <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeScenario(scenario.id)}>Delete scenario</Button>}
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>
          Scenario total: <strong>{fmtNum(grandTotal(sheet, activeScenarioId))}</strong>
        </Caption1>
      </div>

      {/* Planning grid */}
      <Card style={{ padding: 0, overflowX: 'auto' }}>
        <Table aria-label="Planning sheet grid" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ minWidth: 200 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}><Money20Regular /> Line item</span>
              </TableHeaderCell>
              {sheet.periods.map((p) => (
                <TableHeaderCell key={p.id} style={{ minWidth: 90 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS }}>
                    <Input size="small" value={p.label} onChange={(_, d) => renamePeriod(p.id, d.value)} style={{ maxWidth: 70 }} aria-label="Period label" />
                    {sheet.periods.length > 1 && <Button size="small" appearance="transparent" icon={<Dismiss16Regular />} onClick={() => removePeriod(p.id)} aria-label="Remove period" />}
                  </span>
                </TableHeaderCell>
              ))}
              <TableHeaderCell style={{ minWidth: 90 }}>Total</TableHeaderCell>
              {showVariance && <TableHeaderCell style={{ minWidth: 100 }}>Actual</TableHeaderCell>}
              {showVariance && <TableHeaderCell style={{ minWidth: 80 }}>Δ</TableHeaderCell>}
              {showVariance && <TableHeaderCell style={{ minWidth: 70 }}>Δ%</TableHeaderCell>}
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.length === 0 && (
              <TableRow>
                <TableCell colSpan={varColspan}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3 }}>
                    <Money20Regular />
                    <Body1>No line items yet</Body1>
                    <Caption1>Add a line item to start building this plan&apos;s budget across periods.</Caption1>
                    <Button size="small" icon={<Add20Regular />} onClick={addLineItem} style={{ marginTop: tokens.spacingVerticalXS }}>Add line item</Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {visibleRows.map(({ item: li, depth, hasChildren }) => {
              const v = variance.find((x) => x.lineItemId === li.id);
              const isFormula = li.kind === 'formula';
              const isRollup = hasChildren; // any row with children = read-only roll-up
              const computed = isFormula || isRollup;
              const formulaText = isFormula && Array.isArray(li.formula) && li.formula.length
                ? formulaToText(li.formula, (ref) => byId.get(ref)?.name || ref) : '';
              return (
                <TableRow key={li.id}>
                  <TableCell>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, minWidth: 0 }}>
                      {Array.from({ length: depth }).map((_, i) => <span key={i} style={{ width: tokens.spacingHorizontalL, flexShrink: 0 }} />)}
                      {hasChildren ? (
                        <Button size="small" appearance="transparent" aria-label={collapsed.has(li.id) ? 'Expand' : 'Collapse'}
                          icon={collapsed.has(li.id) ? <ChevronRight16Regular /> : <ChevronDown16Regular />} onClick={() => toggleCollapse(li.id)} />
                      ) : isFormula ? (
                        <Calculator20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
                      ) : <span style={{ width: tokens.spacingHorizontalL, flexShrink: 0 }} />}
                      <Input value={li.name} onChange={(_, d) => renameLineItem(li.id, d.value)} aria-label="Line item name" style={{ minWidth: 0, fontWeight: isRollup ? tokens.fontWeightSemibold : undefined } as any} />
                    </span>
                    {formulaText && <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, fontFamily: 'monospace', marginLeft: tokens.spacingHorizontalL }}>= {formulaText}</Caption1>}
                  </TableCell>
                  {sheet.periods.map((p, pIdx) => (
                    <TableCell key={p.id}>
                      {computed ? (
                        <span style={{ display: 'inline-block', minWidth: 60, color: tokens.colorNeutralForeground2 }}>
                          {fmtNum(lineItemValueAt(sheet, activeScenarioId, li.id, pIdx))}
                        </span>
                      ) : (
                        <Input
                          type="number"
                          value={String(getCell(sheet.cells, li.id, p.id, activeScenarioId) || '')}
                          onChange={(_, d) => setCell(li.id, p.id, d.value)}
                          style={{ maxWidth: 80 }}
                          aria-label={`${li.name} ${p.label}`}
                        />
                      )}
                    </TableCell>
                  ))}
                  <TableCell><strong>{fmtNum(computed ? lineItemRowTotal(sheet, activeScenarioId, li.id) : rowTotal(sheet, activeScenarioId, li.id))}</strong></TableCell>
                  {showVariance && (
                    <TableCell>
                      {computed ? <span style={{ color: tokens.colorNeutralForeground4 }}>—</span> : (
                        <Input type="number" value={String((sheet.actuals || {})[li.id] || '')} onChange={(_, d) => setActual(li.id, d.value)} style={{ maxWidth: 90 }} aria-label={`Actual ${li.name}`} />
                      )}
                    </TableCell>
                  )}
                  {showVariance && (
                    <TableCell style={{ color: computed ? undefined : ((v?.delta || 0) < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1) }}>
                      {computed ? '—' : fmtNum(v?.delta || 0)}
                    </TableCell>
                  )}
                  {showVariance && (
                    <TableCell>{computed || v?.pct == null ? '—' : `${Math.round(v.pct * 100)}%`}</TableCell>
                  )}
                  <TableCell>
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button size="small" appearance="subtle" aria-label="Row actions" icon={<ChevronDown16Regular />} />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          {isFormula && <MenuItem icon={<Edit16Regular />} onClick={() => setFormulaEdit(li.id)}>Edit formula…</MenuItem>}
                          {!isFormula && !isRollup && (
                            <Menu>
                              <MenuTrigger disableButtonEnhancement>
                                <MenuItem icon={<Calculator20Regular />}>Quick formula</MenuItem>
                              </MenuTrigger>
                              <MenuPopover>
                                <MenuList>
                                  <MenuItem onClick={() => setFormulaEdit(li.id)}>Open builder…</MenuItem>
                                  <MenuDivider />
                                  <MenuItem onClick={() => applyQuickFormula(li.id, qfGrowthPct(li.id, -1))}>Growth % vs previous</MenuItem>
                                  <MenuItem onClick={() => applyQuickFormula(li.id, qfGrowthPct(li.id, -4))}>Growth % vs year ago</MenuItem>
                                </MenuList>
                              </MenuPopover>
                            </Menu>
                          )}
                          <MenuItem icon={<ChevronRight16Regular />} onClick={() => indentRow(li.id)}>Indent (nest)</MenuItem>
                          <MenuItem icon={<ChevronLeft16Regular />} onClick={() => outdentRow(li.id)} disabled={!li.parentId}>Outdent</MenuItem>
                          <MenuDivider />
                          <MenuItem icon={<Dismiss16Regular />} onClick={() => removeLineItem(li.id)}>Delete row</MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </TableCell>
                </TableRow>
              );
            })}
            {/* Period-total footer row */}
            <TableRow style={{ backgroundColor: tokens.colorNeutralBackground2 }}>
              <TableCell><strong>Total</strong></TableCell>
              {sheet.periods.map((p) => (
                <TableCell key={p.id}><strong>{fmtNum(periodTotal(sheet, activeScenarioId, p.id))}</strong></TableCell>
              ))}
              <TableCell><strong>{fmtNum(grandTotal(sheet, activeScenarioId))}</strong></TableCell>
              {showVariance && <TableCell><strong>{fmtNum(variance.reduce((a, x) => a + x.actual, 0))}</strong></TableCell>}
              {showVariance && <TableCell><strong>{fmtNum(variance.reduce((a, x) => a + x.delta, 0))}</strong></TableCell>}
              {showVariance && <TableCell />}
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
        <Button icon={<Add20Regular />} onClick={addLineItem}>Add line item</Button>
        <Button icon={<Calculator20Regular />} onClick={addFormulaRow}>Add formula row</Button>
        <Button icon={<Add20Regular />} onClick={addPeriod}>Add period</Button>
        <Button appearance="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</Button>
      </div>

      {(sheet.lineItems.some((li) => li.parentId) || sheet.lineItems.some((li) => li.kind === 'formula')) && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          <Layer20Regular style={{ verticalAlign: 'middle' }} /> Roll-up parents and formula rows are computed (read-only); only leaf inputs hold entered values.
        </Caption1>
      )}

      {state.semanticModelRef && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          <Link20Regular style={{ verticalAlign: 'middle' }} /> Actuals source: <strong>{state.semanticModelRef.displayName}</strong> (semantic model)
        </Caption1>
      )}

      {msg && (
        <MessageBar intent={msg.intent}>
          <MessageBarBody>{msg.text}</MessageBarBody>
        </MessageBar>
      )}

      <PlanSettingsFlyout id={id} state={state} setState={setState} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <FormulaBuilderDialog
        open={!!formulaEdit}
        onClose={() => setFormulaEdit(null)}
        initial={(editingFormulaItem?.formula as PlanFormulaToken[]) || []}
        rows={formulaCandidates.filter((r) => r.id !== formulaEdit)}
        onApply={(toks) => { if (formulaEdit) setLineItemFormula(formulaEdit, toks); }}
      />
    </div>
  );
}

/**
 * Inline multi-point SVG line chart for the Intelligence trend/forecast visual.
 * Pure SVG (no chart dep) over the REAL period-subtotal series; forecast points
 * render dashed. Azure-native — computed from plan cells, no Fabric.
 */
function PlanTrendChart({ points, height = 200 }: { points: PeriodPoint[]; height?: number }) {
  const width = 560;
  const padL = 48, padR = 16, padT = 16, padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const vals = points.map((p) => p.value);
  const max = Math.max(1, ...vals);
  const min = Math.min(0, ...vals);
  const span = Math.max(1, max - min);
  const x = (i: number) => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - min) / span) * innerH;
  const histPts = points.filter((p) => !p.forecast);
  const linePath = (subset: PeriodPoint[]) =>
    subset.map((p) => `${x(points.indexOf(p))},${y(p.value)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Plan trend chart" style={{ maxWidth: width }}>
      {/* gridlines + axis labels */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const gy = padT + innerH - f * innerH;
        return (
          <g key={f}>
            <line x1={padL} y1={gy} x2={width - padR} y2={gy} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
            <text x={padL - 6} y={gy + 3} textAnchor="end" fontSize={10} fill={tokens.colorNeutralForeground3}>
              {Math.round(min + f * span).toLocaleString()}
            </text>
          </g>
        );
      })}
      {/* historical line */}
      <polyline points={linePath(histPts)} fill="none" stroke={tokens.colorBrandStroke1} strokeWidth={2.5} />
      {/* forecast line (dashed) — joins last historical point onward */}
      {points.some((p) => p.forecast) && (
        <polyline
          points={linePath([histPts[histPts.length - 1], ...points.filter((p) => p.forecast)].filter(Boolean) as PeriodPoint[])}
          fill="none" stroke={tokens.colorPalettePurpleForeground2} strokeWidth={2.5} strokeDasharray="5 4"
        />
      )}
      {/* points + x labels */}
      {points.map((p, i) => (
        <g key={p.periodId}>
          <circle cx={x(i)} cy={y(p.value)} r={3.5} fill={p.forecast ? tokens.colorPalettePurpleForeground2 : tokens.colorBrandForeground1} />
          <text x={x(i)} y={height - 10} textAnchor="middle" fontSize={10} fill={tokens.colorNeutralForeground3}>{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** Mutate a single planning cell in the correct sheet (PowerTable two-way edit). */
function setPlanCellByKey(
  setState: (updater: (prev: PlanState) => PlanState) => void,
  sheetId: string, key: string, value: number,
) {
  setState((prev) => ({
    ...prev,
    sheets: ensureSheets(prev).map((sh) => (sh.id === sheetId ? { ...sh, cells: { ...sh.cells, [key]: value } } : sh)),
    scenarios: ensureScenarios(prev),
  }));
}

/**
 * PowerTable — the Azure-native parity of Fabric Plan's no-code, SQL-bound grid
 * (/fabric/iq/plan/powertable-overview). Flattens every plan cell into one
 * editable, sortable, filterable grid bound 1:1 to the `dbo.loom_plan_cells`
 * columns. Two-way writeback: edits persist to Cosmos (always) and MERGE into
 * Azure SQL (when configured). "Load from SQL" reads the persisted rows back.
 */
function PlanPowerTablePanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const s = useStyles();
  const sheets = ensureSheets(state);
  const scenarios = ensureScenarios(state);
  const rows = useMemo(() => flattenPlanCells(sheets, scenarios), [sheets, scenarios]);

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<PlanRowSortKey>('lineItem');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  // Persisted SQL rows (read-back) keyed by composite key for a "drift" badge.
  const [sqlByKey, setSqlByKey] = useState<Record<string, number> | null>(null);

  const view = useMemo(() => sortPlanRows(filterPlanRows(rows, query), sortKey, sortDir), [rows, query, sortKey, sortDir]);

  const toggleSort = (k: PlanRowSortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };
  const SortIcon = ({ k }: { k: PlanRowSortKey }) =>
    k !== sortKey ? null : sortDir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />;

  const editCell = (row: PlanCellRow, raw: string) => {
    const v = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v)) return;
    setPlanCellByKey(setState, row.sheetId, row.key, v);
  };

  // Two-way writeback: persist to Cosmos, then MERGE the visible sheet's cells
  // into Azure SQL via the real writeback route.
  const writeBackAll = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'warning', text: 'Save the plan first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await save();
      // Group cells by sheet and POST each (the route is per-sheet).
      let total = 0; let gated: string | null = null;
      for (const sheet of sheets) {
        const cells = Object.entries(sheet.cells).map(([k, value]) => {
          const [lineItemId, periodId, scenarioId] = k.split('|');
          return { lineItemId, periodId, scenarioId, value };
        });
        if (cells.length === 0) continue;
        const r = await fetch(`/api/items/plan/${encodeURIComponent(id)}/writeback`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sheetId: sheet.id, cells }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 503 && j?.gate) { gated = `${j.gate.reason} Set ${j.gate.missing}.`; break; }
        if (!r.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); setBusy(false); return; }
        total += Number(j.written || 0);
      }
      if (gated) setMsg({ intent: 'warning', text: `Saved to Cosmos. Azure SQL writeback skipped: ${gated}` });
      else setMsg({ intent: 'success', text: `${total} cell${total === 1 ? '' : 's'} written back to Azure SQL.` });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  const loadFromSql = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'warning', text: 'Save the plan first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/items/plan/${encodeURIComponent(id)}/writeback`);
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gate) { setMsg({ intent: 'warning', text: `${j.gate.reason} Set ${j.gate.missing}. PowerTable is bound to the in-editor (Cosmos) cells.` }); return; }
      if (!r.ok || !j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      const map: Record<string, number> = {};
      for (const c of j.cells || []) map[cellKey(c.lineItemId, c.periodId, c.scenarioId)] = Number(c.value);
      setSqlByKey(map);
      setMsg({ intent: 'success', text: `Loaded ${j.count} persisted row${j.count === 1 ? '' : 's'} from ${j.database}. Cells differing from the editor are flagged.` });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  const colName: Record<PlanRowSortKey, string> = { sheetName: 'Sheet', lineItem: 'Line item', period: 'Period', scenario: 'Scenario', value: 'Value' };

  return (
    <div className={s.planSection}>
      <div className={s.planSectionHead}>
        <span className={s.planSectionIcon}><Table20Regular /></span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Subtitle2>PowerTable</Subtitle2>
          <Caption1 as="p" block style={{ color: tokens.colorNeutralForeground3 }}>
            No-code, SQL-bound grid over every plan cell with two-way writeback — the Azure-native parity of Fabric Plan&apos;s PowerTable. Edit any value inline; it persists to Cosmos and MERGEs into <code>dbo.loom_plan_cells</code> on write back.
          </Caption1>
        </div>
        <Badge appearance="tint" color="brand">{rows.length} cell{rows.length === 1 ? '' : 's'}</Badge>
      </div>

      <div className={s.planToolbar}>
        <Field label="Filter rows" style={{ minWidth: 220, flex: '1 1 220px' }}>
          <Input value={query} onChange={(_, d) => setQuery(d.value)} placeholder="line item, period, scenario, value…" contentBefore={<ArrowDownload16Regular style={{ visibility: 'hidden', width: 0 }} />} />
        </Field>
        <Button icon={busy ? <Spinner size="tiny" /> : <Save16Regular />} onClick={writeBackAll} disabled={busy || saving}>Write back to SQL</Button>
        <Button icon={busy ? <Spinner size="tiny" /> : <ArrowDownload16Regular />} onClick={loadFromSql} disabled={busy}>Load from SQL</Button>
        <Button appearance="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>

      {rows.length === 0 ? (
        <div className={s.planEmpty}>
          <Table20Regular fontSize={28} />
          <Body1>No plan cells yet. Add line items and periods on the <strong>Planning</strong> sheet, then enter values — they appear here as an editable grid.</Body1>
        </div>
      ) : (
        <div className={s.planGridScroll}>
          <Table size="small" aria-label="PowerTable cell grid">
            <TableHeader>
              <TableRow>
                {(['sheetName', 'lineItem', 'period', 'scenario', 'value'] as PlanRowSortKey[]).map((k) => (
                  <TableHeaderCell key={k} className={s.planSortable} onClick={() => toggleSort(k)}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>{colName[k]}<SortIcon k={k} /></span>
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((row) => {
                const drift = sqlByKey && Object.prototype.hasOwnProperty.call(sqlByKey, row.key) && sqlByKey[row.key] !== row.value;
                return (
                  <TableRow key={row.key}>
                    <TableCell>{row.sheetName}</TableCell>
                    <TableCell>{row.lineItem}</TableCell>
                    <TableCell>{row.period}</TableCell>
                    <TableCell><Badge appearance="outline">{row.scenario}</Badge></TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}>
                        <Input type="number" value={String(row.value || '')} onChange={(_, d) => editCell(row, d.value)} style={{ maxWidth: 110 }} aria-label={`${row.lineItem} ${row.period} ${row.scenario}`} />
                        {drift && <Badge appearance="tint" color="warning" title={`Azure SQL has ${sqlByKey![row.key]}`}>SQL {fmtNum(sqlByKey![row.key])}</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

/**
 * Intelligence — Fabric Plan's auto-insights surface (variance reports, trend +
 * forecast, Gantt). Azure-native parity: every visual is computed from the real
 * plan cells / tasks (no Fabric, no mock). Forecast is an OLS extrapolation of
 * the period-subtotal trend; Gantt lays out the Project tasks by due date.
 */
function PlanIntelligencePanel({
  state, setState, scenarioName, activeScenarioId, sheet, tasks,
}: {
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  scenarioName: string;
  activeScenarioId: string;
  sheet: PlanningSheet;
  tasks: PlanTask[];
}) {
  const s = useStyles();
  const horizon = typeof state.forecastHorizon === 'number' ? state.forecastHorizon : 2;
  const series = useMemo(() => forecastPeriods(sheet, activeScenarioId, horizon), [sheet, activeScenarioId, horizon]);
  const hist = useMemo(() => periodSeries(sheet, activeScenarioId), [sheet, activeScenarioId]);
  const fit = useMemo(() => linearFit(hist.map((p) => p.value)), [hist]);
  const variance = useMemo(() => computeVariance(sheet, activeScenarioId, sheet.actuals || {}), [sheet, activeScenarioId]);
  const insights = useMemo(() => planInsights(sheet, activeScenarioId, variance), [sheet, activeScenarioId, variance]);
  const bars: GanttBar[] = useMemo(() => ganttLayout(tasks), [tasks]);

  const total = grandTotal(sheet, activeScenarioId);
  const forecastTotal = series.filter((p) => p.forecast).reduce((a, p) => a + p.value, 0);
  const trendLabel = fit.slope > 0 ? 'Upward' : fit.slope < 0 ? 'Downward' : 'Flat';
  const varianceWithActuals = variance.filter((v) => v.actual !== 0);
  const totalDelta = varianceWithActuals.reduce((a, v) => a + v.delta, 0);

  const barColor = (st: PlanTask['status'], overdue: boolean) =>
    overdue ? tokens.colorPaletteRedBackground3
      : st === 'done' ? tokens.colorPaletteGreenBackground3
        : st === 'doing' ? tokens.colorBrandBackground
          : tokens.colorNeutralForeground3;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
      {/* KPI strip */}
      <div className={s.planKpiRow}>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Scenario total ({scenarioName})</Caption1>
          <span className={s.planKpiValue}>{fmtNum(total)}</span>
        </div>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Trend (R² {fit.r2.toFixed(2)})</Caption1>
          <span className={s.planKpiValue} style={{ color: fit.slope < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>{trendLabel}</span>
        </div>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Forecast +{horizon} period{horizon === 1 ? '' : 's'}</Caption1>
          <span className={s.planKpiValue}>{fmtNum(forecastTotal)}</span>
        </div>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Variance vs actuals</Caption1>
          <span className={s.planKpiValue} style={{ color: totalDelta < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>{varianceWithActuals.length ? fmtNum(totalDelta) : '—'}</span>
        </div>
      </div>

      {/* Trend + forecast chart */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><DataTrending20Regular /></span>
          <div style={{ flex: 1 }}>
            <Subtitle2>Trend &amp; forecast</Subtitle2>
            <Caption1 as="p" block style={{ color: tokens.colorNeutralForeground3 }}>
              Period subtotals for <strong>{scenarioName}</strong>; dashed line is an ordinary-least-squares projection.
            </Caption1>
          </div>
          <Field label="Forecast periods" orientation="horizontal">
            <Dropdown
              value={String(horizon)} selectedOptions={[String(horizon)]} style={{ minWidth: 80 }}
              onOptionSelect={(_, d) => { const h = Number(d.optionValue); if (Number.isFinite(h)) setState((p) => ({ ...p, forecastHorizon: h })); }}
            >
              {[0, 1, 2, 3, 4, 6].map((h) => <Option key={h} value={String(h)}>{String(h)}</Option>)}
            </Dropdown>
          </Field>
        </div>
        {hist.length === 0 ? (
          <div className={s.planEmpty}><Body1>No periods to chart yet — add periods + values on the Planning sheet.</Body1></div>
        ) : (
          <PlanTrendChart points={series} />
        )}
      </div>

      {/* Computed insights */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><Sparkle20Regular /></span>
          <Subtitle2>Insights</Subtitle2>
          <Badge appearance="tint" color="informative">computed</Badge>
        </div>
        {insights.map((line, i) => (
          <div key={i} className={s.planInsight}>
            <ChartMultiple20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
            <Body1>{line}</Body1>
          </div>
        ))}
      </div>

      {/* Variance report */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><Money20Regular /></span>
          <Subtitle2>Variance report</Subtitle2>
        </div>
        <Table size="small" aria-label="Variance report">
          <TableHeader><TableRow>
            <TableHeaderCell>Line item</TableHeaderCell>
            <TableHeaderCell>Plan</TableHeaderCell>
            <TableHeaderCell>Actual</TableHeaderCell>
            <TableHeaderCell>Δ</TableHeaderCell>
            <TableHeaderCell>Δ%</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {variance.length === 0 && <TableRow><TableCell>No input line items.</TableCell><TableCell /><TableCell /><TableCell /><TableCell /></TableRow>}
            {variance.map((v) => (
              <TableRow key={v.lineItemId}>
                <TableCell>{v.name}</TableCell>
                <TableCell>{fmtNum(v.plan)}</TableCell>
                <TableCell>{fmtNum(v.actual)}</TableCell>
                <TableCell style={{ color: v.delta < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>{fmtNum(v.delta)}</TableCell>
                <TableCell>{v.pct == null ? '—' : `${Math.round(v.pct * 100)}%`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Actuals come from the Planning sheet / InfoBridge mappings (Azure-native — no Fabric).</Caption1>
      </div>

      {/* Gantt over project tasks */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><BranchFork20Regular /></span>
          <Subtitle2>Delivery Gantt</Subtitle2>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{tasks.length} task{tasks.length === 1 ? '' : 's'} · bars span dependency → due date</Caption1>
        </div>
        {bars.length === 0 ? (
          <div className={s.planEmpty}><Body1>No project tasks yet — add tasks (with due dates) on the <strong>Project tasks</strong> tab to populate the Gantt.</Body1></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
            {bars.map((b, i) => (
              <div key={i} className={s.ganttRow}>
                <Caption1 className={s.ganttLabel} title={b.title}>{b.title}</Caption1>
                <div className={s.ganttTrack}>
                  <div
                    className={s.ganttBar}
                    style={{ left: `${b.startPct * 100}%`, width: `${b.widthPct * 100}%`, backgroundColor: barColor(b.status, b.overdue) }}
                    title={`${b.status}${b.due ? ` · due ${b.due}` : ''}${b.overdue ? ' · overdue' : ''}${b.hasDep ? ' · has dependency' : ''}`}
                  />
                </div>
                <Caption1 style={{ width: 92, flexShrink: 0, color: b.overdue ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>{b.due || '—'}</Caption1>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * InfoBridge — Fabric Plan's source-system integration/mapping surface. The
 * Azure-native parity: map each plan line item to a source field (a Loom
 * semantic-model measure, warehouse/lakehouse column, or a manual value), persist
 * the mappings to Cosmos, and "Push to actuals" so mapped values flow into the
 * Planning variance overlay. Live automated pull from the bound model is an
 * honest XMLA-gated extension. No Microsoft Fabric dependency.
 */
function PlanInfoBridgePanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const st = useStyles();
  const sheets = ensureSheets(state);
  const scenarios = ensureScenarios(state);
  const activeSheetId = sheets.some((x) => x.id === state.activeSheetId) ? (state.activeSheetId as string) : sheets[0].id;
  const sheet = sheets.find((x) => x.id === activeSheetId) || sheets[0];
  const inputItems = sheet.lineItems.filter((li) => li.kind === 'input');
  const mappings = arr<PlanSourceMapping>(state.infoBridge);

  // Real owned source items for the picker (warehouse / lakehouse / semantic-model).
  const [sources, setSources] = useState<Record<string, { id: string; name: string }[]>>({});
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const loadSources = useCallback(async () => {
    for (const type of ['warehouse', 'lakehouse', 'semantic-model']) {
      try {
        const r = await fetch(`/api/items/by-type?types=${encodeURIComponent(type)}`);
        const j = await r.json().catch(() => ({}));
        const items = (j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
        setSources((prev) => ({ ...prev, [type]: items }));
      } catch { /* honest empty picker */ }
    }
  }, []);
  useEffect(() => { void loadSources(); }, [loadSources]);

  const mappingFor = (liId: string) => mappings.find((m) => m.lineItemId === liId);
  const upsertMapping = (liId: string, patch: Partial<PlanSourceMapping>) => {
    setState((prev) => {
      const cur = arr<PlanSourceMapping>(prev.infoBridge);
      const existing = cur.find((m) => m.lineItemId === liId);
      const next: PlanSourceMapping = existing
        ? { ...existing, ...patch }
        : { lineItemId: liId, sourceKind: 'manual', ...patch };
      return { ...prev, infoBridge: [...cur.filter((m) => m.lineItemId !== liId), next] };
    });
  };
  const clearMapping = (liId: string) =>
    setState((prev) => ({ ...prev, infoBridge: arr<PlanSourceMapping>(prev.infoBridge).filter((m) => m.lineItemId !== liId) }));

  // Close the loop: write mapped current-actuals into the active sheet's actuals
  // map (feeds the Planning variance overlay), then persist.
  const pushToActuals = async () => {
    if (mappings.length === 0) { setMsg({ intent: 'warning', text: 'Add at least one mapping first.' }); return; }
    let nextState: PlanState | null = null;
    setState((prev) => {
      const nextActuals = applyMappingsToActuals(sheet.actuals, arr<PlanSourceMapping>(prev.infoBridge));
      nextState = {
        ...prev,
        sheets: ensureSheets(prev).map((x) => (x.id === sheet.id ? { ...x, actuals: nextActuals } : x)),
        scenarios: ensureScenarios(prev),
      };
      return nextState;
    });
    if (nextState && id !== 'new') await save(nextState);
    const applied = mappings.filter((m) => typeof m.currentActual === 'number').length;
    setMsg({ intent: 'success', text: `Pushed ${applied} mapped value${applied === 1 ? '' : 's'} into ${sheet.name} actuals. Open the Planning tab → "Variance vs actuals" to see them.` });
  };

  const sourceKinds: PlanSourceMapping['sourceKind'][] = ['semantic-model', 'warehouse', 'lakehouse', 'manual'];
  const kindLabel: Record<PlanSourceMapping['sourceKind'], string> = {
    'semantic-model': 'Semantic model', warehouse: 'Warehouse', lakehouse: 'Lakehouse', manual: 'Manual',
  };

  return (
    <div className={st.planSection}>
      <div className={st.planSectionHead}>
        <span className={st.planSectionIcon}><Link20Regular /></span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Subtitle2>InfoBridge</Subtitle2>
          <Caption1 as="p" block style={{ color: tokens.colorNeutralForeground3 }}>
            Map each line item to a source system so planning stays aligned with actuals — the Azure-native parity of Fabric Plan&apos;s InfoBridge. Mappings persist to the plan; <strong>Push to actuals</strong> flows mapped values into the Planning variance overlay.
          </Caption1>
        </div>
        <Button appearance="primary" icon={<ArrowSync16Regular />} onClick={pushToActuals} disabled={saving}>Push to actuals</Button>
      </div>

      {state.semanticModelRef ? (
        <MessageBar intent="info">
          <MessageBarBody>
            Bound actuals model: <strong>{state.semanticModelRef.displayName}</strong>. Map a line item to a <em>Semantic model</em> measure here; automated live pull requires the model&apos;s XMLA endpoint (set <code>LOOM_AAS_XMLA_ENDPOINT</code> or use the manual value below). Mapped values feed the Planning variance overlay either way.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <MessageBar intent="warning">
          <MessageBarBody>
            No semantic model bound. Bind one in <strong>Settings</strong> (Planning tab) to map measures as actuals, or use <em>Manual</em> mappings — both feed variance.
          </MessageBarBody>
        </MessageBar>
      )}

      {inputItems.length === 0 ? (
        <div className={st.planEmpty}><Body1>No line items to map. Add input line items on the Planning sheet first.</Body1></div>
      ) : (
        <Table size="small" aria-label="InfoBridge source mappings">
          <TableHeader><TableRow>
            <TableHeaderCell>Line item</TableHeaderCell>
            <TableHeaderCell>Source kind</TableHeaderCell>
            <TableHeaderCell>Source item</TableHeaderCell>
            <TableHeaderCell>Field / measure</TableHeaderCell>
            <TableHeaderCell>Current actual</TableHeaderCell>
            <TableHeaderCell />
          </TableRow></TableHeader>
          <TableBody>
            {inputItems.map((li) => {
              const m = mappingFor(li.id);
              const kind = m?.sourceKind || 'manual';
              const list = kind === 'manual' ? [] : (sources[kind] || []);
              return (
                <TableRow key={li.id}>
                  <TableCell><strong>{li.name}</strong></TableCell>
                  <TableCell>
                    <Dropdown
                      value={kindLabel[kind]} selectedOptions={[kind]} style={{ minWidth: 150 }}
                      onOptionSelect={(_, d) => upsertMapping(li.id, { sourceKind: (d.optionValue as PlanSourceMapping['sourceKind']) || 'manual', sourceItemId: undefined, sourceName: undefined })}
                    >
                      {sourceKinds.map((k) => <Option key={k} value={k}>{kindLabel[k]}</Option>)}
                    </Dropdown>
                  </TableCell>
                  <TableCell>
                    {kind === 'manual' ? (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>
                    ) : list.length === 0 ? (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No {kindLabel[kind]} items</Caption1>
                    ) : (
                      <Dropdown
                        value={m?.sourceName || ''} selectedOptions={m?.sourceItemId ? [m.sourceItemId] : []} placeholder={`Select ${kindLabel[kind]}`} style={{ minWidth: 160 }}
                        onOptionSelect={(_, d) => { const it = list.find((x) => x.id === d.optionValue); upsertMapping(li.id, { sourceItemId: it?.id, sourceName: it?.name }); }}
                      >
                        {list.map((it) => <Option key={it.id} value={it.id}>{it.name}</Option>)}
                      </Dropdown>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input value={m?.field || ''} onChange={(_, d) => upsertMapping(li.id, { field: d.value })} placeholder={kind === 'semantic-model' ? 'measure name' : 'column'} style={{ maxWidth: 150 }} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" value={m?.currentActual != null ? String(m.currentActual) : ''} onChange={(_, d) => upsertMapping(li.id, { currentActual: d.value === '' ? undefined : Number(d.value) })} placeholder="actual value" style={{ maxWidth: 120 }} />
                  </TableCell>
                  <TableCell>{m && <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Clear mapping for ${li.name}`} onClick={() => clearMapping(li.id)} />}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
        <Button appearance="secondary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save mappings'}</Button>
      </div>

      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

// ===================================================================
// EPM core UI — guided Formula builder + Model (cube) tab.
//
// Parity with Microsoft Fabric IQ Plan's user formulas + multidimensional cube
// (Anaplan-style). The Formula builder is fully GUIDED (function palette + row
// picker + operator buttons + number field) — there is NO freeform expression
// box (.claude/rules loom_no_freeform_config). The Model tab defines dimensions
// (member hierarchies) + measures and validates them against a real backend
// (POST /api/items/plan/[id]/model). Azure-native; no Microsoft Fabric.
// ===================================================================

const FORMULA_OFFSETS: { value: string; label: string; offset: number }[] = [
  { value: '0', label: 'this period', offset: 0 },
  { value: '-1', label: 'previous period', offset: -1 },
  { value: '-4', label: 'year ago (−4)', offset: -4 },
];
const FORMULA_FNS: PlanFormulaFn[] = ['SUM', 'AVG', 'MIN', 'MAX', 'ABS'];
type FormulaPreset = 'custom' | 'sum' | 'avg' | 'diff' | 'ratio' | 'growthPrev' | 'growthYoY';

/**
 * Guided Formula builder — assemble a {@link PlanFormulaToken} AST from presets
 * + a function/operator/row palette. No freeform text; the only text inputs are
 * numeric. Live preview + structural validity gate before Apply.
 */
function FormulaBuilderDialog({
  open, onClose, initial, rows, onApply,
}: {
  open: boolean;
  onClose: () => void;
  initial: PlanFormulaToken[];
  rows: { id: string; name: string }[];
  onApply: (tokens: PlanFormulaToken[]) => void;
}) {
  const s = useStyles();
  const [tokens, setTokens] = useState<PlanFormulaToken[]>(initial);
  const [preset, setPreset] = useState<FormulaPreset>('custom');
  const [presetRows, setPresetRows] = useState<string[]>([]);
  const [presetA, setPresetA] = useState('');
  const [presetB, setPresetB] = useState('');
  const [insRow, setInsRow] = useState(rows[0]?.id || '');
  const [insOffset, setInsOffset] = useState('0');
  const [insNum, setInsNum] = useState('');

  useEffect(() => {
    if (open) {
      setTokens(Array.isArray(initial) ? initial : []);
      setPreset('custom'); setPresetRows([]); setPresetA(''); setPresetB('');
      setInsRow(rows[0]?.id || ''); setInsOffset('0'); setInsNum('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const labelFor = useCallback((ref: string) => rows.find((r) => r.id === ref)?.name || ref, [rows]);
  const preview = formulaToText(tokens, labelFor);
  // Structural validity probe — resolve every ref to 1 so only the *shape* is checked.
  const check = evalFormula(tokens, () => 1);

  const push = (t: PlanFormulaToken) => setTokens((p) => [...p, t]);
  const undo = () => setTokens((p) => p.slice(0, -1));
  const clear = () => setTokens([]);

  const generatePreset = () => {
    if (preset === 'sum' && presetRows.length) setTokens(qfSum(presetRows));
    else if (preset === 'avg' && presetRows.length) setTokens(qfAverage(presetRows));
    else if (preset === 'diff' && presetA && presetB) setTokens(qfDifference(presetA, presetB));
    else if (preset === 'ratio' && presetA && presetB) setTokens(qfRatioPct(presetA, presetB));
    else if (preset === 'growthPrev' && presetA) setTokens(qfGrowthPct(presetA, -1));
    else if (preset === 'growthYoY' && presetA) setTokens(qfGrowthPct(presetA, -4));
  };

  const presetNeedsMulti = preset === 'sum' || preset === 'avg';
  const presetNeedsTwo = preset === 'diff' || preset === 'ratio';
  const presetNeedsOne = preset === 'growthPrev' || preset === 'growthYoY';

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 680 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Calculator20Regular style={{ color: tokens.colorBrandForeground1 }} /> Formula builder
            </span>
          </DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Build a calculation from rows, operators, and functions — no typing of expressions. Row references resolve per
                period; pick &quot;previous period&quot; or &quot;year ago&quot; for growth calcs.
              </Caption1>

              {/* Quick presets */}
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap', padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2 }}>
                <Field label="Quick formula">
                  <Dropdown
                    value={{
                      custom: 'Custom', sum: 'Sum of rows', avg: 'Average of rows',
                      diff: 'Difference (a − b)', ratio: 'Ratio % (a ÷ b × 100)',
                      growthPrev: 'Growth % vs previous', growthYoY: 'Growth % vs year ago',
                    }[preset]}
                    selectedOptions={[preset]}
                    onOptionSelect={(_, d) => { setPreset((d.optionValue as FormulaPreset) || 'custom'); setPresetRows([]); setPresetA(''); setPresetB(''); }}
                    style={{ minWidth: 200 }}
                  >
                    <Option value="custom">Custom</Option>
                    <Option value="sum">Sum of rows</Option>
                    <Option value="avg">Average of rows</Option>
                    <Option value="diff">Difference (a − b)</Option>
                    <Option value="ratio">Ratio % (a ÷ b × 100)</Option>
                    <Option value="growthPrev">Growth % vs previous</Option>
                    <Option value="growthYoY">Growth % vs year ago</Option>
                  </Dropdown>
                </Field>
                {presetNeedsMulti && (
                  <Field label="Rows">
                    <Dropdown multiselect placeholder="Pick rows…" selectedOptions={presetRows}
                      value={presetRows.map(labelFor).join(', ')}
                      onOptionSelect={(_, d) => setPresetRows(d.selectedOptions)} style={{ minWidth: 220 }}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                {(presetNeedsTwo || presetNeedsOne) && (
                  <Field label={presetNeedsTwo ? 'Row a' : 'Row'}>
                    <Dropdown placeholder="Pick a row…" value={labelFor(presetA)} selectedOptions={presetA ? [presetA] : []}
                      onOptionSelect={(_, d) => setPresetA(d.optionValue || '')} style={{ minWidth: 160 }}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                {presetNeedsTwo && (
                  <Field label="Row b">
                    <Dropdown placeholder="Pick a row…" value={labelFor(presetB)} selectedOptions={presetB ? [presetB] : []}
                      onOptionSelect={(_, d) => setPresetB(d.optionValue || '')} style={{ minWidth: 160 }}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                {preset !== 'custom' && (
                  <Button appearance="primary" icon={<Sparkle20Regular />} onClick={generatePreset}
                    disabled={(presetNeedsMulti && presetRows.length === 0) || (presetNeedsTwo && (!presetA || !presetB)) || (presetNeedsOne && !presetA)}>
                    Generate
                  </Button>
                )}
              </div>

              {/* Manual palette */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                <Subtitle2>Build / refine</Subtitle2>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Row">
                    <Dropdown value={labelFor(insRow)} selectedOptions={insRow ? [insRow] : []}
                      onOptionSelect={(_, d) => setInsRow(d.optionValue || '')} style={{ minWidth: 150 }} disabled={rows.length === 0}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Period">
                    <Dropdown value={FORMULA_OFFSETS.find((o) => o.value === insOffset)?.label || 'this period'}
                      selectedOptions={[insOffset]} onOptionSelect={(_, d) => setInsOffset(d.optionValue || '0')} style={{ minWidth: 140 }}>
                      {FORMULA_OFFSETS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                    </Dropdown>
                  </Field>
                  <Button icon={<Add16Regular />} onClick={() => insRow && push({ k: 'row', ref: insRow, offset: Number(insOffset) || 0 })} disabled={!insRow}>Add row</Button>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Number">
                    <Input type="number" value={insNum} onChange={(_, d) => setInsNum(d.value)} style={{ maxWidth: 120 }} placeholder="0" />
                  </Field>
                  <Button icon={<Add16Regular />} onClick={() => { const v = Number(insNum); if (Number.isFinite(v)) { push({ k: 'num', value: v }); setInsNum(''); } }} disabled={insNum === ''}>Add number</Button>
                  <div style={{ flex: 1 }} />
                  <Button appearance="subtle" icon={<ArrowUndo16Regular />} onClick={undo} disabled={tokens.length === 0}>Undo</Button>
                  <Button appearance="subtle" onClick={clear} disabled={tokens.length === 0}>Clear</Button>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                  {(['+', '-', '*', '/'] as PlanFormulaOp[]).map((op) => (
                    <Button key={op} appearance="secondary" size="small" onClick={() => push({ k: 'op', op })}>
                      {op === '*' ? '×' : op === '/' ? '÷' : op}
                    </Button>
                  ))}
                  <Button appearance="secondary" size="small" onClick={() => push({ k: 'lp' })}>(</Button>
                  <Button appearance="secondary" size="small" onClick={() => push({ k: 'rp' })}>)</Button>
                  <Button appearance="secondary" size="small" onClick={() => push({ k: 'comma' })}>,</Button>
                  {FORMULA_FNS.map((fn) => (
                    <Button key={fn} appearance="secondary" size="small" onClick={() => { push({ k: 'fn', fn }); push({ k: 'lp' }); }}>{fn}()</Button>
                  ))}
                </div>
              </div>

              {/* Live preview + validity */}
              <Field label="Preview">
                <div className={s.planFormulaPreview} aria-live="polite">{preview}</div>
              </Field>
              {tokens.length > 0 && !check.ok && (
                <MessageBar intent="warning"><MessageBarBody>{check.error || 'Formula is incomplete.'}</MessageBarBody></MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={tokens.length === 0 || !check.ok} onClick={() => { onApply(tokens); onClose(); }}>
              Apply formula
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Member-hierarchy editor for one dimension — add/rename/indent/outdent/remove
 * members with parent/child nesting + roll-up semantics. Depth-first ordered.
 */
function DimensionMembersEditor({
  dimension, onChange,
}: {
  dimension: PlanDimension;
  onChange: (members: PlanMember[]) => void;
}) {
  const s = useStyles();
  const ordered = orderMembers(dimension.members);
  const byId = new Map(dimension.members.map((m) => [m.id, m]));

  const addMember = () => onChange([...dimension.members, { id: newId('mem'), label: 'New member' }]);
  const rename = (mid: string, label: string) => onChange(dimension.members.map((m) => (m.id === mid ? { ...m, label } : m)));
  const remove = (mid: string) => onChange(dimension.members
    .filter((m) => m.id !== mid)
    .map((m) => (m.parentId === mid ? { ...m, parentId: byId.get(mid)?.parentId ?? null } : m)));
  const indent = (mid: string) => {
    const idx = ordered.findIndex((o) => o.member.id === mid);
    if (idx <= 0) return;
    const me = ordered[idx];
    // Nearest preceding member at the SAME depth = a valid new parent (prev sibling).
    for (let i = idx - 1; i >= 0; i--) {
      if (ordered[i].depth === me.depth) { onChange(dimension.members.map((m) => (m.id === mid ? { ...m, parentId: ordered[i].member.id } : m))); return; }
      if (ordered[i].depth < me.depth) break;
    }
  };
  const outdent = (mid: string) => {
    const cur = byId.get(mid);
    if (!cur?.parentId) return;
    const grand = byId.get(cur.parentId)?.parentId ?? null;
    onChange(dimension.members.map((m) => (m.id === mid ? { ...m, parentId: grand } : m)));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
      {ordered.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No members yet.</Caption1>
      )}
      {ordered.map(({ member, depth, hasChildren }) => (
        <div key={member.id} className={s.planMemberRow}>
          {Array.from({ length: depth }).map((_, i) => <span key={i} className={s.planIndent} />)}
          {hasChildren ? <Layer20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
            : <span style={{ width: tokens.spacingHorizontalL, flexShrink: 0, color: tokens.colorNeutralForeground4, textAlign: 'center' }}>•</span>}
          <Input size="small" value={member.label} onChange={(_, d) => rename(member.id, d.value)} aria-label="Member label" style={{ flex: 1, minWidth: 100 }} />
          <Button size="small" appearance="subtle" icon={<ChevronRight16Regular />} onClick={() => indent(member.id)} aria-label="Indent member" title="Indent (nest under previous sibling)" />
          <Button size="small" appearance="subtle" icon={<ChevronLeft16Regular />} onClick={() => outdent(member.id)} aria-label="Outdent member" title="Outdent" disabled={!member.parentId} />
          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => remove(member.id)} aria-label="Remove member" />
        </div>
      ))}
      <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={addMember} style={{ alignSelf: 'flex-start', marginTop: tokens.spacingVerticalXS }}>Add member</Button>
    </div>
  );
}

const AGG_OPTIONS: { value: PlanAggKind; label: string }[] = [
  { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }, { value: 'count', label: 'Count' },
  { value: 'min', label: 'Min' }, { value: 'max', label: 'Max' },
];

/**
 * Model (cube) tab — define dimensions (member hierarchies) + measures, then
 * validate against the real backend. The structural foundation the planning
 * grid + formulas build on. Azure-native (Cosmos state); no Microsoft Fabric.
 */
function PlanModelPanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const s = useStyles();
  const model = ensureModel(state);
  const sheets = ensureSheets(state);
  const lineItemIds = useMemo(() => sheets.flatMap((sh) => sh.lineItems.map((li) => li.id)), [sheets]);
  const allLineItems = useMemo(() => sheets.flatMap((sh) => sh.lineItems.map((li) => ({ id: li.id, name: `${sh.name} · ${li.name}` }))), [sheets]);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ valid: boolean; issues: ModelIssue[]; message: string } | null>(null);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const setModel = (mut: (m: PlanModel) => PlanModel) =>
    setState((prev) => ({ ...prev, model: mut(ensureModel(prev)) }));

  const addDimension = () => setModel((m) => ({ ...m, dimensions: [...m.dimensions, { id: newId('dim'), name: `Dimension ${m.dimensions.length + 1}`, axis: 'row', members: [] }] }));
  const seedStarter = () => setState((prev) => ({ ...prev, model: defaultPlanModel() }));
  const removeDimension = (did: string) => setModel((m) => ({ ...m, dimensions: m.dimensions.filter((d) => d.id !== did) }));
  const patchDimension = (did: string, patch: Partial<PlanDimension>) => setModel((m) => ({ ...m, dimensions: m.dimensions.map((d) => (d.id === did ? { ...d, ...patch } : d)) }));

  const addMeasure = () => setModel((m) => ({ ...m, measures: [...m.measures, { id: newId('meas'), name: `Measure ${m.measures.length + 1}`, agg: 'sum' }] }));
  const removeMeasure = (mid: string) => setModel((m) => ({ ...m, measures: m.measures.filter((x) => x.id !== mid) }));
  const patchMeasure = (mid: string, patch: Partial<PlanMeasure>) => setModel((m) => ({ ...m, measures: m.measures.map((x) => (x.id === mid ? { ...x, ...patch } : x)) }));

  // "Add members as rows" — push a dimension's members (with parent mapping) onto
  // the active sheet as hierarchical line items, connecting the model to the grid.
  const addMembersToSheet = (dim: PlanDimension) => {
    const activeId = sheets.some((sh) => sh.id === state.activeSheetId) ? state.activeSheetId : sheets[0].id;
    setState((prev) => {
      const cur = ensureSheets(prev);
      const idMap = new Map<string, string>();
      dim.members.forEach((mem) => idMap.set(mem.id, newId('li')));
      const newItems: PlanLineItem[] = orderMembers(dim.members).map(({ member }) => ({
        id: idMap.get(member.id)!,
        name: member.label,
        kind: 'input',
        parentId: member.parentId ? (idMap.get(member.parentId) || null) : null,
      }));
      return {
        ...prev,
        sheets: cur.map((sh) => (sh.id === activeId ? { ...sh, lineItems: [...sh.lineItems, ...newItems] } : sh)),
      };
    });
    setMsg({ intent: 'success', text: `Added ${dim.members.length} member row(s) from "${dim.name}" to the planning sheet.` });
  };

  const validate = async () => {
    setBusy(true); setMsg(null); setResult(null);
    // Always run the pure validation locally so the surface works even pre-save.
    const local = validateModel(model, lineItemIds);
    const formulaIssues: ModelIssue[] = [];
    for (const sh of sheets) formulaIssues.push(...validateFormulaRows(sh).issues.map((iss) => ({ ...iss, message: sheets.length > 1 ? `[${sh.name}] ${iss.message}` : iss.message })));
    const localIssues = [...local.issues, ...formulaIssues];
    const localValid = localIssues.every((x) => x.level !== 'error');

    if (!id || id === 'new') {
      setResult({ valid: localValid, issues: localIssues, message: localValid ? 'Model valid (save the plan to persist).' : `${localIssues.filter((x) => x.level === 'error').length} error(s) found.` });
      setBusy(false);
      return;
    }
    try {
      await save(); // persist what we're validating
      const r = await fetch(`/api/items/plan/${encodeURIComponent(id)}/model`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, sheets }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setResult({ valid: !!j.valid, issues: arr<ModelIssue>(j.issues), message: j.message || (j.valid ? 'Model valid.' : 'Model has errors.') });
    } catch (e: any) {
      // Backend unreachable → fall back to the local pure validation (still real).
      setResult({ valid: localValid, issues: localIssues, message: localValid ? 'Model valid (validated locally).' : `${localIssues.filter((x) => x.level === 'error').length} error(s) found.` });
    } finally { setBusy(false); }
  };

  const hasModel = model.dimensions.length > 0 || model.measures.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Model (cube)</MessageBarTitle>
          Define the plan&apos;s <strong>dimensions</strong> (member hierarchies — Region → Country → Store) and reusable
          <strong> measures</strong>. This is the structural foundation: members roll up on the planning grid, and formulas
          compute over these rows. Azure-native — the model persists to Cosmos; no Microsoft Fabric capacity required.
        </MessageBarBody>
      </MessageBar>

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge appearance="filled" color="brand">{model.dimensions.length} dimension{model.dimensions.length === 1 ? '' : 's'}</Badge>
        <Badge appearance="outline">{model.measures.length} measure{model.measures.length === 1 ? '' : 's'}</Badge>
        <div style={{ flex: 1 }} />
        <Button icon={<Cube20Regular />} onClick={addDimension}>Add dimension</Button>
        <Button icon={<Ruler20Regular />} onClick={addMeasure}>Add measure</Button>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <CheckmarkCircle20Regular />} onClick={validate} disabled={busy}>
          {busy ? 'Validating…' : 'Validate model'}
        </Button>
      </div>

      {!hasModel && (
        <EmptyState
          icon={<Cube20Regular />}
          title="No cube defined yet"
          body="Add dimensions (member hierarchies) and measures to give this plan a multidimensional structure — or start from a sample Account hierarchy."
          primaryAction={{ label: 'Add dimension', onClick: addDimension }}
          secondaryAction={{ label: 'Start from sample', onClick: seedStarter }}
        />
      )}

      {hasModel && (
        <>
          {model.dimensions.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div className={s.secHead}><Cube20Regular className={s.secHeadIcon} /><Subtitle2>Dimensions</Subtitle2></div>
              <TileGrid minTileWidth={320}>
                {model.dimensions.map((d) => (
                  <div key={d.id} className={s.planModelCard}>
                    <div className={s.planModelCardHead}>
                      <span className={s.planModelCardIcon}><Cube20Regular /></span>
                      <Input value={d.name} onChange={(_, v) => patchDimension(d.id, { name: v.value })} aria-label="Dimension name" style={{ flex: 1, minWidth: 0 }} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeDimension(d.id)} aria-label="Remove dimension" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Field label="Axis" orientation="horizontal">
                        <Dropdown value={d.axis === 'row' ? 'Rows' : 'Columns'} selectedOptions={[d.axis]}
                          onOptionSelect={(_, v) => patchDimension(d.id, { axis: (v.optionValue as PlanDimensionAxis) || 'row' })} style={{ minWidth: 110 }}>
                          <Option value="row">Rows</Option>
                          <Option value="column">Columns</Option>
                        </Dropdown>
                      </Field>
                      <Badge appearance="outline">{d.members.length} member{d.members.length === 1 ? '' : 's'}</Badge>
                    </div>
                    <div style={{ height: 1, background: tokens.colorNeutralStroke2 }} />
                    <DimensionMembersEditor dimension={d} onChange={(members) => patchDimension(d.id, { members })} />
                    {d.axis === 'row' && d.members.length > 0 && (
                      <Button size="small" appearance="secondary" icon={<Layer20Regular />} onClick={() => addMembersToSheet(d)} style={{ alignSelf: 'flex-start' }}>
                        Add members as planning rows
                      </Button>
                    )}
                  </div>
                ))}
              </TileGrid>
            </div>
          )}

          {model.measures.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div className={s.secHead}><Ruler20Regular className={s.secHeadIcon} /><Subtitle2>Measures</Subtitle2></div>
              <TileGrid minTileWidth={280}>
                {model.measures.map((ms) => (
                  <div key={ms.id} className={s.planModelCard}>
                    <div className={s.planModelCardHead}>
                      <span className={s.planModelCardIcon}><Ruler20Regular /></span>
                      <Input value={ms.name} onChange={(_, v) => patchMeasure(ms.id, { name: v.value })} aria-label="Measure name" style={{ flex: 1, minWidth: 0 }} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeMeasure(ms.id)} aria-label="Remove measure" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <Field label="Aggregation">
                        <Dropdown value={AGG_OPTIONS.find((a) => a.value === ms.agg)?.label || 'Sum'} selectedOptions={[ms.agg]}
                          onOptionSelect={(_, v) => patchMeasure(ms.id, { agg: (v.optionValue as PlanAggKind) || 'sum' })} style={{ minWidth: 120 }}>
                          {AGG_OPTIONS.map((a) => <Option key={a.value} value={a.value}>{a.label}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Unit">
                        <Input value={ms.unit || ''} onChange={(_, v) => patchMeasure(ms.id, { unit: v.value })} placeholder="USD / % / FTE" style={{ maxWidth: 110 }} />
                      </Field>
                    </div>
                    <Field label="Scope (line item)" hint="Optional — restrict the measure to one line item.">
                      <Dropdown placeholder="Whole sheet" value={allLineItems.find((li) => li.id === ms.scopeLineItemId)?.name || ''}
                        selectedOptions={ms.scopeLineItemId ? [ms.scopeLineItemId] : []}
                        onOptionSelect={(_, v) => patchMeasure(ms.id, { scopeLineItemId: v.optionValue || undefined })} style={{ minWidth: 160 }}>
                        <Option value="">Whole sheet</Option>
                        {allLineItems.map((li) => <Option key={li.id} value={li.id}>{li.name}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                ))}
              </TileGrid>
            </div>
          )}
        </>
      )}

      {result && (
        <MessageBar intent={result.valid ? (result.issues.some((x) => x.level === 'warning') ? 'warning' : 'success') : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.valid ? 'Model valid' : 'Model has errors'}</MessageBarTitle>
            {result.message}
            {result.issues.length > 0 && (
              <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: tokens.spacingHorizontalL }}>
                {result.issues.map((iss, i) => (
                  <li key={i} style={{ color: iss.level === 'error' ? tokens.colorPaletteRedForeground1 : tokens.colorStatusWarningForeground1 }}>
                    {iss.level === 'error' ? '✕ ' : '⚠ '}{iss.message}
                  </li>
                ))}
              </ul>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
        <Button appearance="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save model'}</Button>
      </div>
    </div>
  );
}

export function PlanEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<PlanState>('plan', id, {
    tasks: [{ title: 'Define semantic model', owner: '', due: '', status: 'todo' }],
  });
  const [tab, setTab] = useState<'planning' | 'model' | 'tasks' | 'powertable' | 'intelligence' | 'infobridge'>('planning');

  // ----- Project-tasks helpers (audit-T13 surface, preserved) -----
  const update = (idx: number, patch: Partial<PlanTask>) => {
    setState((prev) => {
      const next = [...arr<PlanTask>(prev.tasks)];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, tasks: next };
    });
  };
  const add = () => setState((prev) => ({
    ...prev,
    tasks: [...arr<PlanTask>(prev.tasks), { title: '', owner: '', due: '', status: 'todo' }],
  }));
  const remove = (idx: number) => setState((prev) => ({
    ...prev,
    tasks: arr<PlanTask>(prev.tasks).filter((_, i) => i !== idx),
  }));

  const taskList = arr<PlanTask>(state.tasks);
  // Active sheet/scenario for the Intelligence tab (mirrors PlanningSheetPanel's
  // resolution so both surfaces read the same scenario the user is editing).
  const intelSheets = ensureSheets(state);
  const intelScenarios = ensureScenarios(state);
  const intelSheet = intelSheets.find((x) => x.id === state.activeSheetId) || intelSheets[0];
  const intelScenario = intelScenarios.find((x) => x.id === state.activeScenarioId) || intelScenarios[0];
  const counts = taskList.reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; },
    {} as Record<PlanTask['status'], number>,
  );
  const todo = counts.todo || 0;
  const doing = counts.doing || 0;
  const done = counts.done || 0;
  const total = taskList.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = taskList.filter(t => t.status !== 'done' && t.due && t.due < today).length;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Plan', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
      { label: 'Tasks', actions: [
        { label: 'New task', onClick: add },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, add]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="planning" icon={<Money20Regular />}>Planning</Tab>
          <Tab value="model" icon={<Cube20Regular />}>Model</Tab>
          <Tab value="tasks" icon={<ShieldCheckmark20Regular />}>Project tasks</Tab>
          <Tab value="powertable" icon={<Table20Regular />}>PowerTable</Tab>
          <Tab value="intelligence" icon={<ChartMultiple20Regular />}>Intelligence</Tab>
          <Tab value="infobridge" icon={<Link20Regular />}>InfoBridge</Tab>
        </TabList>

        {tab === 'planning' && (
          <PlanningSheetPanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}

        {tab === 'model' && (
          <PlanModelPanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}

        {tab === 'tasks' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Project tasks</MessageBarTitle>
                Track the plan&apos;s delivery tasks and route the plan through the Azure-native approval Logic App. On approval,
                plan metrics write back to a linked semantic model via XMLA (no Fabric / Power Automate).
              </MessageBarBody>
            </MessageBar>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge appearance="filled" color="brand">{total} task{total === 1 ? '' : 's'}</Badge>
              <Badge appearance="outline">to-do: {todo}</Badge>
              <Badge appearance="filled" color="warning">doing: {doing}</Badge>
              <Badge appearance="filled" color="success">done: {done}</Badge>
              {overdue > 0 && <Badge appearance="filled" color="danger">overdue: {overdue}</Badge>}
              <Caption1 style={{ marginLeft: tokens.spacingHorizontalS }}>{pct}% complete</Caption1>
              <div style={{ flex: 1, height: 6, backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall, overflow: 'hidden', minWidth: 120, maxWidth: 240 }}>
                <div style={{ width: `${pct}%`, height: '100%', backgroundColor: tokens.colorBrandStroke1, transition: 'width 0.2s' }} />
              </div>
            </div>
            <Table aria-label="Plan tasks" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Task</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Due</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Depends on</TableHeaderCell>
                <TableHeaderCell />
              </TableRow></TableHeader>
              <TableBody>
                {taskList.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell><Input value={t.title} onChange={(_, d) => update(i, { title: d.value })} /></TableCell>
                    <TableCell><Input value={t.owner} onChange={(_, d) => update(i, { owner: d.value })} /></TableCell>
                    <TableCell><Input type="date" value={t.due} onChange={(_, d) => update(i, { due: d.value })} /></TableCell>
                    <TableCell>
                      <select value={t.status} onChange={(e) => update(i, { status: e.target.value as PlanTask['status'] })}
                        style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                        <option value="todo">todo</option><option value="doing">doing</option><option value="done">done</option>
                      </select>
                    </TableCell>
                    <TableCell><Input value={t.dependsOn || ''} onChange={(_, d) => update(i, { dependsOn: d.value })} placeholder="task title" /></TableCell>
                    <TableCell><Button size="small" onClick={() => remove(i)}>Delete</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button onClick={add} style={{ alignSelf: 'flex-start' }}>+ New task</Button>
            <PlanApprovalPanel id={id} tasks={taskList} state={state} setState={setState} save={save} />
          </div>
        )}

        {tab === 'powertable' && (
          <PlanPowerTablePanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}
        {tab === 'intelligence' && (
          <PlanIntelligencePanel
            state={state}
            setState={setState}
            scenarioName={intelScenario.name}
            activeScenarioId={intelScenario.id}
            sheet={intelSheet}
            tasks={taskList}
          />
        )}
        {tab === 'infobridge' && (
          <PlanInfoBridgePanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}

        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Map (Fabric IQ Map — dataset binding + layers over Lakehouse/KQL/Ontology) -----
const GEO_SAMPLE = `{\n  "type": "FeatureCollection",\n  "features": [\n    { "type": "Feature", "properties": { "name": "Seattle" }, "geometry": { "type": "Point", "coordinates": [-122.33, 47.61] } }\n  ]\n}`;

/** Persisted data-source binding for the map (audit H7). */
interface MapBinding {
  source: '' | 'lakehouse' | 'kql' | 'ontology';
  // lakehouse (Synapse Serverless)
  database?: string; table?: string; sql?: string;
  // kql (ADX)
  kqlItemId?: string; db?: string; kql?: string;
  // ontology (Weave/AGE)
  ontologyItemId?: string; objectType?: string;
  latProp?: string; lonProp?: string; valueProp?: string; labelProp?: string;
  // shared column mapping (lakehouse/kql)
  latCol?: string; lonCol?: string; valueCol?: string; labelCol?: string;
  top?: number;
}
interface MapState {
  geojson: string;
  binding?: MapBinding;
  layers?: MapLayer[];
  /** Persisted interactive-canvas basemap style (one of AZURE_MAPS_STYLES). */
  basemap?: string;
  /** Persisted built-in map controls. */
  controls?: AzureMapsControls;
  /** Persisted camera view (center/zoom/bearing/pitch + auto-zoom). */
  view?: AzureMapsView;
  [k: string]: unknown;
}

const DEFAULT_LAYERS: MapLayer[] = [
  { id: 'pt', type: 'point', enabled: true, radius: 5 },
  { id: 'heat', type: 'heatmap', enabled: false, weightProp: 'value', radius: 26 },
];

/** Build a GeoJSON FeatureCollection from {lat,lon,value?,label?} geo rows. */
function geoRowsToGeoJSON(rows: Array<{ lat: number; lon: number; value?: number; label?: string }>): string {
  const features = rows.map((r) => ({
    type: 'Feature',
    properties: {
      ...(r.label != null ? { name: r.label } : {}),
      ...(r.value != null ? { value: r.value } : {}),
    },
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
  }));
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

interface ItemLite { id: string; displayName: string }

export function MapEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<MapState>('map', id, {
    geojson: GEO_SAMPLE, binding: { source: '' }, layers: DEFAULT_LAYERS,
  });
  const [validateMsg, setValidateMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [tab, setTab] = useState<'data' | 'json'>('data');

  // Source-item pickers (KQL databases / ontologies in the tenant).
  const [kqlItems, setKqlItems] = useState<ItemLite[] | null>(null);
  const [ontologyItems, setOntologyItems] = useState<ItemLite[] | null>(null);

  // Binding run state.
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const binding: MapBinding = state.binding || { source: '' };
  const layers: MapLayer[] = state.layers && state.layers.length ? state.layers : DEFAULT_LAYERS;

  const setBinding = useCallback((patch: Partial<MapBinding>) => {
    setState((p) => ({ ...p, binding: { ...(p.binding || { source: '' }), ...patch } }));
  }, [setState]);

  // Lazy-load pickers when the relevant source is chosen.
  useEffect(() => {
    if (binding.source === 'kql' && kqlItems === null) {
      fetch('/api/items?type=kql-database').then((r) => r.json()).then((j) => setKqlItems((j?.items || []).map((it: any) => ({ id: it.id, displayName: it.displayName })))).catch(() => setKqlItems([]));
    }
    if (binding.source === 'ontology' && ontologyItems === null) {
      fetch('/api/items?type=ontology').then((r) => r.json()).then((j) => setOntologyItems((j?.items || []).map((it: any) => ({ id: it.id, displayName: it.displayName })))).catch(() => setOntologyItems([]));
    }
  }, [binding.source, kqlItems, ontologyItems]);

  let parseErr: string | null = null;
  let featureCount = 0;
  let parsedGeo: unknown = null;
  let bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null = null;
  try {
    const j = JSON.parse(state.geojson);
    parsedGeo = j;
    featureCount = Array.isArray(j?.features) ? j.features.length : 0;
    bbox = computeGeoBbox(j);
  } catch (e: any) { parseErr = e?.message || String(e); }

  // Client-side subscription-key fallback: when the BFF token route gates but a
  // public key is present, the interactive canvas still lights up the basemap.
  const mapsKey = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY || undefined;

  // ── Interactive Azure Maps canvas config (persisted in item state) ───────────
  const basemap = state.basemap || DEFAULT_BASEMAP;
  const mapControls: AzureMapsControls = state.controls || DEFAULT_CONTROLS;
  const view: AzureMapsView = state.view || { autoZoom: true };
  const tooltipFieldKeys = useMemo(() => featurePropertyKeys(parsedGeo), [parsedGeo]);

  const setView = useCallback((v: AzureMapsView) => {
    setState((p) => ({ ...p, view: { ...(p.view || { autoZoom: true }), ...v } }));
  }, [setState]);
  const setBasemap = useCallback((style: string) => {
    setState((p) => ({ ...p, basemap: style }));
  }, [setState]);
  const setControl = useCallback((patch: Partial<AzureMapsControls>) => {
    setState((p) => ({ ...p, controls: { ...DEFAULT_CONTROLS, ...(p.controls || {}), ...patch } }));
  }, [setState]);
  const setAutoZoom = useCallback((on: boolean) => {
    setState((p) => ({ ...p, view: { ...(p.view || {}), autoZoom: on } }));
  }, [setState]);

  // Fullscreen the live map (Fullscreen API on the wrapper; the canvas fills it).
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const h = () => setIsFs(typeof document !== 'undefined' && !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = mapWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
    else { el.requestFullscreen?.().catch(() => {}); }
  }, []);
  const mapHeight = isFs ? Math.max(480, (typeof window !== 'undefined' ? window.innerHeight : 900) - 8) : 460;

  const runValidate = useCallback(() => {
    try {
      const j = JSON.parse(state.geojson);
      const fc = Array.isArray(j?.features) ? j.features.length : 0;
      setValidateMsg({ intent: 'success', text: `Valid GeoJSON — ${fc} feature(s) parsed.` });
    } catch (e: any) {
      setValidateMsg({ intent: 'error', text: `Invalid JSON: ${e?.message || String(e)}` });
    }
  }, [state.geojson]);

  // Run the binding against the real backend and fold the geo rows into the
  // map's GeoJSON so every layer renders live data (audit H7).
  const runBinding = useCallback(async () => {
    if (!binding.source) { setRunMsg({ intent: 'error', text: 'Pick a data source first.' }); return; }
    if (!id || id === 'new') { setRunMsg({ intent: 'error', text: 'Save the map once so it has an id, then bind data.' }); return; }
    setRunning(true); setRunMsg(null);
    try {
      const r = await fetch(`/api/items/map/${encodeURIComponent(id)}/data`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ binding }),
      });
      const j = await r.json();
      if (!j.ok) {
        setRunMsg({ intent: j.code && /not_configured|503/.test(String(j.code)) ? 'warning' : 'error', text: j.error || `HTTP ${r.status}` });
        return;
      }
      const rows = j.rows || [];
      setState((p) => ({ ...p, geojson: geoRowsToGeoJSON(rows) }));
      setRunMsg({ intent: rows.length ? 'success' : 'warning', text: `Bound ${rows.length} geo row(s) from ${binding.source}${j.total != null ? ` (${j.total} total)` : ''}. They render in the layers below — Save to persist.` });
    } catch (e: any) {
      setRunMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setRunning(false); }
  }, [binding, id, setState]);

  const setLayer = useCallback((lid: string, patch: Partial<MapLayer>) => {
    setState((p) => {
      const cur = (p.layers && p.layers.length ? p.layers : DEFAULT_LAYERS);
      return { ...p, layers: cur.map((l) => (l.id === lid ? { ...l, ...patch } : l)) };
    });
  }, [setState]);

  const addLayer = useCallback((type: MapLayerType) => {
    setState((p) => {
      const cur = (p.layers && p.layers.length ? p.layers : DEFAULT_LAYERS);
      const nl: MapLayer = { id: `${type}-${Date.now().toString(36)}`, type, enabled: true, weightProp: 'value', radius: type === 'heatmap' ? 26 : type === 'cluster' ? 10 : 5 };
      return { ...p, layers: [...cur, nl] };
    });
  }, [setState]);

  const removeLayer = useCallback((lid: string) => {
    setState((p) => ({ ...p, layers: (p.layers || DEFAULT_LAYERS).filter((l) => l.id !== lid) }));
  }, [setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Layer', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: running ? 'Binding…' : 'Run binding', onClick: runBinding, disabled: running || !binding.source },
        { label: 'Validate', onClick: runValidate },
      ]},
      { label: 'Add layer', actions: [
        { label: '+ Point', onClick: () => addLayer('point') },
        { label: '+ Heatmap', onClick: () => addLayer('heatmap') },
        { label: '+ Cluster', onClick: () => addLayer('cluster') },
        { label: '+ Choropleth', onClick: () => addLayer('choropleth') },
      ]},
    ]},
  ], [save, saving, dirty, running, runBinding, binding.source, runValidate, addLayer]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'data' | 'json')}>
          <Tab value="data">Data binding</Tab>
          <Tab value="json">GeoJSON (manual)</Tab>
        </TabList>

        {tab === 'data' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Subtitle2>Data source</Subtitle2>
            <Caption1>Bind this map to a Lakehouse table, a KQL query, or an Ontology entity. Loom runs it against the real Azure backend (Synapse Serverless / ADX / Weave) — no Power BI or Fabric required.</Caption1>
            <Field label="Source">
              <Dropdown
                placeholder="Pick a data source"
                value={binding.source ? ({ lakehouse: 'Lakehouse (Synapse SQL)', kql: 'KQL (Azure Data Explorer)', ontology: 'Ontology (Weave)' } as any)[binding.source] : ''}
                selectedOptions={binding.source ? [binding.source] : []}
                onOptionSelect={(_, d) => setBinding({ source: (d.optionValue as MapBinding['source']) || '' })}
              >
                <Option value="lakehouse" text="Lakehouse (Synapse SQL)">Lakehouse (Synapse SQL)</Option>
                <Option value="kql" text="KQL (Azure Data Explorer)">KQL (Azure Data Explorer)</Option>
                <Option value="ontology" text="Ontology (Weave)">Ontology (Weave)</Option>
              </Dropdown>
            </Field>

            {binding.source === 'lakehouse' && (
              <>
                <Field label="Database (Synapse Serverless DB)" hint="e.g. loom_lakehouse, or a paired mirror DB">
                  <Input value={binding.database || ''} onChange={(_, d) => setBinding({ database: d.value })} placeholder="loom_lakehouse" />
                </Field>
                <Field label="Table / view (or use a SQL query below)">
                  <Input value={binding.table || ''} onChange={(_, d) => setBinding({ table: d.value })} placeholder="[dbo].[stores]" />
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Field label="Latitude column"><Input value={binding.latCol || ''} onChange={(_, d) => setBinding({ latCol: d.value })} placeholder="lat" /></Field>
                  <Field label="Longitude column"><Input value={binding.lonCol || ''} onChange={(_, d) => setBinding({ lonCol: d.value })} placeholder="lon" /></Field>
                  <Field label="Value column (optional)"><Input value={binding.valueCol || ''} onChange={(_, d) => setBinding({ valueCol: d.value })} placeholder="revenue" /></Field>
                  <Field label="Label column (optional)"><Input value={binding.labelCol || ''} onChange={(_, d) => setBinding({ labelCol: d.value })} placeholder="name" /></Field>
                </div>
                <Field label="SQL override (optional — alias columns lat, lon, value, label)">
                  <Textarea value={binding.sql || ''} onChange={(_, d) => setBinding({ sql: d.value })} placeholder="SELECT TOP 500 latitude AS lat, longitude AS lon, sales AS value, store AS label FROM [dbo].[stores]" />
                </Field>
              </>
            )}

            {binding.source === 'kql' && (
              <>
                <Field label="KQL database item">
                  <Dropdown
                    placeholder={kqlItems === null ? 'Loading…' : 'Pick a KQL database'}
                    value={kqlItems?.find((k) => k.id === binding.kqlItemId)?.displayName || ''}
                    selectedOptions={binding.kqlItemId ? [binding.kqlItemId] : []}
                    onOptionSelect={(_, d) => setBinding({ kqlItemId: d.optionValue })}
                  >
                    {(kqlItems || []).map((k) => <Option key={k.id} value={k.id} text={k.displayName}>{k.displayName}</Option>)}
                  </Dropdown>
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Field label="Table"><Input value={binding.table || ''} onChange={(_, d) => setBinding({ table: d.value })} placeholder="Sightings" /></Field>
                  <Field label="Latitude column"><Input value={binding.latCol || ''} onChange={(_, d) => setBinding({ latCol: d.value })} placeholder="lat" /></Field>
                  <Field label="Longitude column"><Input value={binding.lonCol || ''} onChange={(_, d) => setBinding({ lonCol: d.value })} placeholder="lon" /></Field>
                  <Field label="Value column (optional)"><Input value={binding.valueCol || ''} onChange={(_, d) => setBinding({ valueCol: d.value })} placeholder="magnitude" /></Field>
                </div>
                <Field label="KQL override (optional — project lat, lon, value, label)">
                  <Textarea value={binding.kql || ''} onChange={(_, d) => setBinding({ kql: d.value })} placeholder={'Sightings\n| project lat=Latitude, lon=Longitude, value=Magnitude\n| take 500'} />
                </Field>
              </>
            )}

            {binding.source === 'ontology' && (
              <>
                <Field label="Ontology item">
                  <Dropdown
                    placeholder={ontologyItems === null ? 'Loading…' : 'Pick an ontology'}
                    value={ontologyItems?.find((o) => o.id === binding.ontologyItemId)?.displayName || ''}
                    selectedOptions={binding.ontologyItemId ? [binding.ontologyItemId] : []}
                    onOptionSelect={(_, d) => setBinding({ ontologyItemId: d.optionValue })}
                  >
                    {(ontologyItems || []).map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{o.displayName}</Option>)}
                  </Dropdown>
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Field label="Object type (declared class)"><Input value={binding.objectType || ''} onChange={(_, d) => setBinding({ objectType: d.value })} placeholder="Store" /></Field>
                  <Field label="Latitude property"><Input value={binding.latProp || ''} onChange={(_, d) => setBinding({ latProp: d.value })} placeholder="lat" /></Field>
                  <Field label="Longitude property"><Input value={binding.lonProp || ''} onChange={(_, d) => setBinding({ lonProp: d.value })} placeholder="lon" /></Field>
                  <Field label="Value property (optional)"><Input value={binding.valueProp || ''} onChange={(_, d) => setBinding({ valueProp: d.value })} placeholder="footfall" /></Field>
                  <Field label="Label property (optional)"><Input value={binding.labelProp || ''} onChange={(_, d) => setBinding({ labelProp: d.value })} placeholder="name" /></Field>
                </div>
              </>
            )}

            {binding.source && (
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                <Button appearance="primary" disabled={running} onClick={runBinding}>{running ? 'Binding…' : 'Run binding'}</Button>
                <Caption1>Runs the source live, then renders the rows in the layers below.</Caption1>
              </div>
            )}
            {runMsg && <MessageBar intent={runMsg.intent}><MessageBarBody>{runMsg.text}</MessageBarBody></MessageBar>}

            <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Layers &amp; symbology</Subtitle2>
            {layers.map((l) => (
              <div key={l.id} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, boxShadow: tokens.shadow2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Switch checked={l.enabled !== false} onChange={(_, d) => setLayer(l.id, { enabled: d.checked })} />
                  <Badge appearance="tint" color="brand">{l.type}</Badge>
                  <div style={{ flex: 1 }} />
                  <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeLayer(l.id)}>Remove</Button>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label="Weight / value property" style={{ minWidth: 160 }}>
                    <Input value={l.weightProp || ''} onChange={(_, d) => setLayer(l.id, { weightProp: d.value || undefined })} placeholder="value" />
                  </Field>
                  {l.type === 'point' && (
                    <Field label="Size by metric">
                      <Switch checked={!!l.sizeByMetric} onChange={(_, d) => setLayer(l.id, { sizeByMetric: d.checked })} label={l.sizeByMetric ? 'On' : 'Off'} />
                    </Field>
                  )}
                  {l.type === 'point' && l.sizeByMetric ? (
                    <>
                      <Field label="Min px" style={{ minWidth: 80 }}>
                        <Input type="number" value={String(l.sizeMin ?? '')} onChange={(_, d) => setLayer(l.id, { sizeMin: Number(d.value) || undefined })} placeholder="6" />
                      </Field>
                      <Field label="Max px" style={{ minWidth: 80 }}>
                        <Input type="number" value={String(l.sizeMax ?? '')} onChange={(_, d) => setLayer(l.id, { sizeMax: Number(d.value) || undefined })} placeholder="28" />
                      </Field>
                    </>
                  ) : (l.type !== 'choropleth' && (
                    <Field label="Radius (px)" style={{ minWidth: 90 }}>
                      <Input type="number" value={String(l.radius ?? '')} onChange={(_, d) => setLayer(l.id, { radius: Number(d.value) || undefined })} placeholder={l.type === 'heatmap' ? '26' : '7'} />
                    </Field>
                  ))}
                  <Field label="Opacity" style={{ minWidth: 90 }}>
                    <Input type="number" min={0} max={1} step={0.05} value={String(l.opacity ?? '')} onChange={(_, d) => setLayer(l.id, { opacity: d.value === '' ? undefined : Math.max(0, Math.min(1, Number(d.value))) })} placeholder="0.85" />
                  </Field>
                  <Field label="Min zoom" style={{ minWidth: 80 }}>
                    <Input type="number" value={String(l.minZoom ?? '')} onChange={(_, d) => setLayer(l.id, { minZoom: d.value === '' ? undefined : Number(d.value) })} placeholder="0" />
                  </Field>
                  <Field label="Max zoom" style={{ minWidth: 80 }}>
                    <Input type="number" value={String(l.maxZoom ?? '')} onChange={(_, d) => setLayer(l.id, { maxZoom: d.value === '' ? undefined : Number(d.value) })} placeholder="22" />
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  {l.weightProp ? (
                    <>
                      <Field label="Color low" style={{ minWidth: 130 }}>
                        <Input value={l.colorLow || ''} onChange={(_, d) => setLayer(l.id, { colorLow: d.value || undefined })} placeholder="#cfe4fa"
                          contentBefore={<span style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', backgroundColor: l.colorLow || '#cfe4fa' }} />} />
                      </Field>
                      <Field label="Color high" style={{ minWidth: 130 }}>
                        <Input value={l.colorHigh || ''} onChange={(_, d) => setLayer(l.id, { colorHigh: d.value || undefined })} placeholder="#0f6cbd"
                          contentBefore={<span style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', backgroundColor: l.colorHigh || '#0f6cbd' }} />} />
                      </Field>
                    </>
                  ) : (
                    <Field label="Color" style={{ minWidth: 130 }}>
                      <Input value={l.color || ''} onChange={(_, d) => setLayer(l.id, { color: d.value || undefined })} placeholder="#0f6cbd"
                        contentBefore={<span style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', backgroundColor: l.color || '#0f6cbd' }} />} />
                    </Field>
                  )}
                  {l.type !== 'heatmap' && (
                    <Field label="Tooltip fields" style={{ minWidth: 220 }}>
                      <Dropdown
                        multiselect
                        placeholder={tooltipFieldKeys.length ? 'All fields' : 'Run binding to populate'}
                        selectedOptions={l.tooltipFields || []}
                        value={(l.tooltipFields || []).join(', ')}
                        onOptionSelect={(_, d) => setLayer(l.id, { tooltipFields: d.selectedOptions })}
                      >
                        {tooltipFieldKeys.map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                </div>
              </div>
            ))}
            <Caption1>Add more from the ribbon (Point / Heatmap / Cluster / Choropleth). Choropleth shades Polygon features by weight; the others place glyphs at point geometry. Symbology persists with the map.</Caption1>
          </div>
        )}

        {tab === 'json' && (
          <>
            <Subtitle2>GeoJSON ({featureCount} feature{featureCount === 1 ? '' : 's'})</Subtitle2>
            <Caption1>Edited directly, or populated by Run binding. The map below renders it through the configured layers.</Caption1>
            <MonacoTextarea value={state.geojson} onChange={(v) => setState((p) => ({ ...p, geojson: v }))} language="json" height={280} minHeight={200} ariaLabel="GeoJSON" />
            {parseErr && <MessageBar intent="error"><MessageBarBody>Invalid JSON: {parseErr}</MessageBarBody></MessageBar>}
            {validateMsg && <MessageBar intent={validateMsg.intent}><MessageBarBody>{validateMsg.text}</MessageBarBody></MessageBar>}
          </>
        )}

        {parseErr ? (
          <MessageBar intent="error"><MessageBarBody>Cannot render the map — invalid GeoJSON: {parseErr}</MessageBarBody></MessageBar>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
              <Subtitle2 style={{ marginRight: tokens.spacingHorizontalS }}>Map</Subtitle2>
              <Field label="Basemap" orientation="horizontal">
                <Dropdown
                  value={AZURE_MAPS_STYLES.find((o) => o.value === basemap)?.label || basemap}
                  selectedOptions={[basemap]}
                  onOptionSelect={(_, d) => d.optionValue && setBasemap(d.optionValue)}
                  style={{ minWidth: 180 }}
                >
                  {AZURE_MAPS_STYLES.map((o) => <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>)}
                </Dropdown>
              </Field>
              <Switch checked={view.autoZoom !== false} onChange={(_, d) => setAutoZoom(d.checked)} label="Auto-zoom to data" />
              <div style={{ flex: 1 }} />
              <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Controls:</Caption1>
                <Switch checked={mapControls.zoom !== false} onChange={(_, d) => setControl({ zoom: d.checked })} label="Zoom" />
                <Switch checked={mapControls.compass !== false} onChange={(_, d) => setControl({ compass: d.checked })} label="Compass" />
                <Switch checked={mapControls.pitch !== false} onChange={(_, d) => setControl({ pitch: d.checked })} label="Pitch" />
                <Switch checked={mapControls.scale !== false} onChange={(_, d) => setControl({ scale: d.checked })} label="Scale" />
                <Button size="small" appearance="subtle" onClick={toggleFullscreen}>{isFs ? 'Exit full screen' : 'Full screen'}</Button>
              </span>
            </div>
            <div ref={mapWrapRef} style={{ width: '100%', backgroundColor: tokens.colorNeutralBackground1 }}>
              <AzureMapsCanvas
                tokenUrl={`/api/items/map/${encodeURIComponent(id)}/map-token`}
                fallbackSubscriptionKey={mapsKey}
                geojson={parsedGeo}
                layers={layers}
                style={basemap}
                controls={mapControls}
                view={view}
                onViewChange={setView}
                height={mapHeight}
              />
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Pan, scroll to zoom, right-drag to rotate/tilt. Turn off Auto-zoom to pin a custom center/zoom (saved with the map). Hover or click a feature for its tooltip. The basemap uses Azure Maps (no Power BI / Fabric); without an account a vector overlay still renders.
            </Caption1>
          </>
        )}
        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Operations Agent (Cosmos config + Phase 1 Foundry deploy stub) -----
interface AgentState {
  systemPrompt: string; model: string; tools: string;
  eventhouse: string; ontology: string;
  foundryAgentId?: string; foundryProjectId?: string; lastDeployedAt?: string;
  [k: string]: unknown;
}

interface DeployResponse {
  ok: boolean;
  deferred?: boolean;
  agentId?: string;
  projectId?: string;
  lastDeployedAt?: string;
  error?: string;
  hint?: string;
}

export function OperationsAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<AgentState>('operations-agent', id, {
    systemPrompt: 'You monitor real-time operational signals and trigger actions when thresholds are breached.',
    model: 'gpt-4o', tools: 'eventhouse-query, activator-trigger', eventhouse: '', ontology: '',
  });
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);

  const onDeploy = useCallback(async () => {
    setDeploying(true); setDeployResult(null);
    try {
      // Save first so the BFF reads the latest state from Cosmos.
      const saved = await save();
      if (!saved) {
        setDeployResult({ ok: false, error: 'Save failed before deploy — fix the save error and retry.' });
        return;
      }
      const r = await fetch(`/api/items/operations-agent/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
      const j: DeployResponse = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      setDeployResult(j);
      if (j.ok) await reload();
    } catch (e: any) {
      setDeployResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setDeploying(false);
    }
  }, [id, save, reload]);

  const deployedAgentId = state.foundryAgentId;
  const deployedAt = state.lastDeployedAt;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Agent', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: deploying ? 'Deploying…' : 'Deploy to Foundry', onClick: onDeploy, disabled: deploying || saving },
      ]},
    ]},
  ], [save, saving, dirty, onDeploy, deploying]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Foundry-deployed operations agent</MessageBarTitle>
            This agent&rsquo;s instructions, model, and tools are saved to your workspace. <strong>Deploy to Foundry</strong> publishes the agent definition to the Azure AI Foundry Agent Service, where it runs against your connected data and tools.
          </MessageBarBody>
        </MessageBar>
        {deployedAgentId && (
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
            <Caption1>Deployed agent:</Caption1>
            <Badge appearance="filled" color="success">{deployedAgentId}</Badge>
            {state.foundryProjectId && <Badge appearance="outline">project {state.foundryProjectId}</Badge>}
            {deployedAt && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>last deployed {new Date(deployedAt).toLocaleString()}</Caption1>}
          </div>
        )}
        {/* v3.28 Phase 4.5: functional setState so deploy/reload doesn't clobber typing. */}
        <Caption1>System prompt</Caption1>
        <Textarea value={state.systemPrompt} onChange={(_, d) => setState((p) => ({ ...p, systemPrompt: d.value }))} rows={6} />
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
          <div style={{ minWidth: 0 }}><Caption1>Model</Caption1><Input value={state.model} onChange={(_, d) => setState((p) => ({ ...p, model: d.value }))} /></div>
          <div style={{ minWidth: 0 }}><Caption1>Tools (comma)</Caption1><Input value={state.tools} onChange={(_, d) => setState((p) => ({ ...p, tools: d.value }))} /></div>
          <div style={{ minWidth: 0 }}><Caption1>Eventhouse binding</Caption1><Input value={state.eventhouse} onChange={(_, d) => setState((p) => ({ ...p, eventhouse: d.value }))} placeholder="eventhouse item id" /></div>
          <div style={{ minWidth: 0 }}><Caption1>Ontology binding</Caption1><Input value={state.ontology} onChange={(_, d) => setState((p) => ({ ...p, ontology: d.value }))} placeholder="ontology item id" /></div>
        </div>
        {deployResult && (
          <MessageBar intent={deployResult.ok ? 'success' : deployResult.deferred ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>
                {deployResult.ok ? 'Deployed to Foundry'
                  : deployResult.deferred ? 'Deploy deferred — Foundry not configured'
                  : 'Deploy failed'}
              </MessageBarTitle>
              {deployResult.ok && deployResult.agentId && (
                <>Agent <code>{deployResult.agentId}</code> upserted in project <code>{deployResult.projectId}</code>. The Foundry Agent Service is now the source of truth for runtime behavior.</>
              )}
              {deployResult.error && <div>{deployResult.error}</div>}
              {deployResult.hint && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Hint:</em> {deployResult.hint}</div>}
            </MessageBarBody>
          </MessageBar>
        )}
        <SaveBar
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
          extraRight={
            <Button appearance="primary" onClick={onDeploy} disabled={deploying || saving}>
              {deploying ? 'Deploying…' : 'Deploy to Foundry'}
            </Button>
          }
        />
      </div>
    } />
  );
}

// ----- Data Agent — typed five-source picker + per-source grounding +
// real grounded test chat + publish to Foundry Agent Service + Copilot
// Studio handoff. Backed by:
//   PATCH /api/items/data-agent/[id]            (Cosmos persist)
//   POST  /api/items/data-agent/[id]/chat       (live AOAI grounded chat)
//   POST  /api/items/data-agent/[id]/publish    (Foundry Agent Service)
//   GET   /api/items/by-type?types=...          (typed source picker)
interface DataAgentState {
  instructions: string;
  sources: DaSource[];
  description?: string;
  /** Optional custom display name / alias for the agent (shown in chat + on publish). */
  alias?: string;
  // Back-compat with the legacy free-text bag (read-only on load).
  systemPrompt?: string; model?: string;
  foundryAgentId?: string; foundryProjectId?: string; publishedAt?: string;
  lastDeployedAt?: string;
  /** Receipt of the last publish to Microsoft 365 Copilot (Copilot Studio). */
  m365Copilot?: { envId: string; agentId: string; agentName: string; agentState?: string; channelId?: string; m365CopilotEnabled?: boolean; publishedAt: string };
  [k: string]: unknown;
}

const DA_SOURCE_TYPES: { value: DaSourceType; label: string; itemType: string }[] = [
  { value: 'warehouse', label: 'Warehouse', itemType: 'warehouse' },
  { value: 'lakehouse', label: 'Lakehouse', itemType: 'lakehouse' },
  { value: 'kql', label: 'KQL database', itemType: 'kql-database' },
  { value: 'semantic-model', label: 'Semantic model', itemType: 'semantic-model' },
  { value: 'ai-search', label: 'AI Search', itemType: 'ai-search-index' },
  { value: 'ontology', label: 'Ontology', itemType: 'ontology' },
  { value: 'graph', label: 'Graph model', itemType: 'graph-model' },
];
// Schema-selection label per type (Fabric exposes Tables/Views/Functions for
// SQL + Eventhouse, model name for semantic models, none for graph/ontology).
const DA_SCHEMA_LABEL: Record<DaSourceType, string> = {
  warehouse: 'Tables / views / functions in scope (comma-separated)',
  lakehouse: 'Tables in scope (comma-separated)',
  kql: 'Tables / materialized views / functions in scope (comma-separated)',
  'semantic-model': 'Tables / model in scope (comma-separated)',
  'ai-search': 'Index fields in scope (optional, comma-separated)',
  ontology: 'Ontology is queried whole — no table scoping',
  graph: 'Graph is queried whole — no node/edge scoping',
};
const DA_INSTRUCTION_TEMPLATE = '## General knowledge\n\n## Table descriptions\n\n## When asked about\n';

// `normalizeDaSources` / `guessDaSourceType` / DaSource(Type) are imported from
// `_family-utils` (vitest coverage at lib/editors/__tests__/family-utils.test.ts)
// so the legacy-string migration is unit-tested without the Fluent UI bundle.

interface DaTool {
  source: string; type?: string; action: string; query?: string;
  // Real-execution metadata (task-008): the query was run read-only on the
  // Azure-native backend; these are the actual results or an honest gate.
  executed?: boolean; rowCount?: number; columns?: string[]; rows?: unknown[][]; gate?: string;
}
interface DaChatMsg { role: 'user' | 'assistant'; content: string; query?: string; sourceUsed?: string; error?: boolean; usage?: { totalTokens?: number }; model?: string; tools?: DaTool[] }

export function DataAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty, lastSaveError } = useItemState<DataAgentState>('data-agent', id, {
    instructions: 'Route financial / aggregated metrics to the semantic model; raw exploration to the lakehouse / warehouse; log analysis to the KQL database.',
    sources: [],
    description: '',
    alias: '',
  });
  // Initial tab honors a ?tab= deep-link (the /data-agent pane's "Configure"
  // and "Publish…" actions route here with ?tab=copilot / ?tab=publish).
  const [tab, setTab] = useState<'build' | 'copilot' | 'test' | 'publish' | 'inspect' | 'monitor'>(() => {
    if (typeof window === 'undefined') return 'build';
    const t = new URLSearchParams(window.location.search).get('tab');
    return (t === 'copilot' || t === 'test' || t === 'publish' || t === 'inspect' || t === 'monitor') ? t : 'build';
  });

  // ---- source picker data (real Loom items) ----
  const [pickerType, setPickerType] = useState<DaSourceType>('warehouse');
  const [available, setAvailable] = useState<Record<string, { id: string; name: string }[]>>({});
  const [pickerLoading, setPickerLoading] = useState(false);
  const loadAvailable = useCallback(async (t: DaSourceType) => {
    const cfg = DA_SOURCE_TYPES.find((x) => x.value === t)!;
    setPickerLoading(true);
    try {
      const r = await fetch(`/api/items/by-type?types=${encodeURIComponent(cfg.itemType)}`);
      const j = await r.json();
      const items = (j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
      setAvailable((prev) => ({ ...prev, [t]: items }));
    } catch { /* leave empty; user can still pick another type */ }
    finally { setPickerLoading(false); }
  }, []);
  useEffect(() => { if (!available[pickerType]) loadAvailable(pickerType); }, [pickerType, available, loadAvailable]);

  const [pickSel, setPickSel] = useState('');
  const addSource = () => {
    if (!pickSel || arr<DaSource>(state.sources).length >= 5) return;
    const opts = available[pickerType] || [];
    const chosen = opts.find((o) => o.id === pickSel);
    setState((p) => ({
      ...p,
      sources: [...arr<DaSource>(p.sources), {
        id: `${pickerType}:${pickSel}:${Date.now()}`,
        type: pickerType,
        name: chosen?.name || pickSel,
        tables: '', description: '', instructions: DA_INSTRUCTION_TEMPLATE, examples: [],
      }],
    }));
    setPickSel('');
  };
  const updateSource = (sid: string, patch: Partial<DaSource>) => {
    setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).map((x) => x.id === sid ? { ...x, ...patch } : x) }));
  };
  const removeSource = (sid: string) => setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).filter((x) => x.id !== sid) }));
  const updateSourceExamples = (sid: string, fn: (ex: { question: string; query: string }[]) => { question: string; query: string }[]) => {
    setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).map((x) => x.id === sid ? { ...x, examples: fn(arr(x.examples)) } : x) }));
  };
  const addExample = (sid: string) => updateSourceExamples(sid, (ex) => [...ex, { question: '', query: '' }]);

  // ---- test chat ----
  const [chat, setChat] = useState<DaChatMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  // Conversation history (persisted to Cosmos via /conversations).
  const [convId, setConvId] = useState<string | null>(null);
  const [convos, setConvos] = useState<{ id: string; title: string; updatedAt: string; turns: number }[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const loadConvos = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/conversations`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setConvos(j.conversations || []);
    } catch { /* non-fatal */ }
  }, [id]);
  useEffect(() => { if (id && id !== 'new') loadConvos(); }, [id, loadConvos]);

  const saveConvo = useCallback(async (thread: DaChatMsg[]) => {
    if (!thread.length || id === 'new') return;
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/conversations`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: convId || undefined, messages: thread }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok && j.conversation?.id) { setConvId(j.conversation.id); loadConvos(); }
    } catch { /* non-fatal */ }
  }, [id, convId, loadConvos]);

  const loadConvo = useCallback(async (cid: string) => {
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/conversations?conversationId=${encodeURIComponent(cid)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok && Array.isArray(j.conversation?.messages)) {
        setChat(j.conversation.messages as DaChatMsg[]);
        setConvId(cid);
      }
    } catch { /* non-fatal */ }
  }, [id]);

  const newChat = useCallback(() => { setChat([]); setConvId(null); }, []);
  // Keep the latest turn in view as the thread grows / a turn lands.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, asking]);
  const canSend = canSendDaQuestion(question, asking);
  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking) return;
    if (dirty) await save();
    // Build history from the thread BEFORE we append the new user turn.
    const history = shapeDaHistory(chat);
    const userTurn: DaChatMsg = { role: 'user', content: q };
    setChat((c) => [...c, userTurn]);
    setQuestion(''); setAsking(true);
    let assistantTurn: DaChatMsg;
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });
      // Content-type guard: a 404/500 returns an HTML page, not JSON — calling
      // r.json() on that throws "Unexpected token <" and the answer is lost.
      const res = await safeModelJson<{ answer?: string; query?: string; sourceUsed?: string; hint?: string; usage?: { totalTokens?: number }; model?: string; tools?: DaTool[] }>(r);
      const j = res.data;
      if (res.ok && j) {
        assistantTurn = { role: 'assistant', content: String(j.answer ?? ''), query: j.query, sourceUsed: j.sourceUsed, usage: j.usage, model: j.model, tools: j.tools };
      } else {
        const detail = res.error || j?.error || `HTTP ${res.status}`;
        const hint = j?.hint ? `\n\n${j.hint}` : '';
        assistantTurn = { role: 'assistant', content: `${detail}${hint}`, error: true };
      }
    } catch (e: any) {
      assistantTurn = { role: 'assistant', content: e?.message || String(e), error: true };
    } finally { setAsking(false); }
    setChat((c) => [...c, assistantTurn]);
    // Persist the conversation (only when the turn succeeded) so it survives
    // reload + can be resumed from History.
    if (!assistantTurn.error) void saveConvo([...chat, userTurn, assistantTurn]);
  }, [question, asking, chat, dirty, save, id, saveConvo]);

  // ---- publish ----
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<any>(null);
  const publish = useCallback(async () => {
    setPublishing(true); setPublishResult(null);
    try {
      // Only persist when there are unsaved edits — a redundant save that fails
      // (e.g. transient) shouldn't block publishing an already-saved agent.
      if (dirty) {
        const saved = await save();
        if (!saved) {
          setPublishResult({ ok: false, error: `Couldn't save before publishing: ${lastSaveError() || 'unknown save error'}` });
          return;
        }
      }
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: state.description, alias: state.alias || undefined }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!r.ok && j && j.ok === undefined) j.ok = false;
      setPublishResult(j);
      if (j.ok) await reload();
    } catch (e: any) { setPublishResult({ ok: false, error: e?.message || String(e) }); }
    finally { setPublishing(false); }
  }, [id, save, reload, dirty, lastSaveError, state.description, state.alias]);

  // ---- publish to Microsoft 365 Copilot (Copilot Studio) ----
  const [m365Envs, setM365Envs] = useState<{ id: string; displayName: string }[]>([]);
  const [m365EnvId, setM365EnvId] = useState('');
  const [m365EnvLoaded, setM365EnvLoaded] = useState(false);
  const [m365EnvError, setM365EnvError] = useState<string | null>(null);
  const [m365Available, setM365Available] = useState(true);
  const [m365Publishing, setM365Publishing] = useState(false);
  const [m365Result, setM365Result] = useState<any>(null);
  const loadM365Envs = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/m365-copilot`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        const envs = (j.environments || []) as { id: string; displayName: string }[];
        setM365Envs(envs);
        setM365EnvError(j.envError || null);
        // Prefer the persisted env, then the configured default, then the first.
        const persisted = state.m365Copilot?.envId;
        setM365EnvId((cur) => cur || persisted || j.defaultEnvId || envs[0]?.id || '');
      } else {
        setM365EnvError(j?.error || `HTTP ${r.status}`);
      }
    } catch (e: any) { setM365EnvError(e?.message || String(e)); }
    finally { setM365EnvLoaded(true); }
  }, [id, state.m365Copilot]);
  useEffect(() => { if (tab === 'publish' && !m365EnvLoaded) loadM365Envs(); }, [tab, m365EnvLoaded, loadM365Envs]);
  const publishM365 = useCallback(async () => {
    setM365Publishing(true); setM365Result(null);
    try {
      if (dirty) {
        const saved = await save();
        if (!saved) { setM365Result({ ok: false, error: `Couldn't save before publishing: ${lastSaveError() || 'unknown save error'}` }); return; }
      }
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/m365-copilot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId: m365EnvId || undefined, description: state.description, availableInM365Copilot: m365Available }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!r.ok && j && j.ok === undefined) j.ok = false;
      setM365Result(j);
      if (j.ok) await reload();
    } catch (e: any) { setM365Result({ ok: false, error: e?.message || String(e) }); }
    finally { setM365Publishing(false); }
  }, [id, m365EnvId, m365Available, dirty, save, reload, lastSaveError, state.description]);

  // ---- delete this agent (owner-scoped via the item DELETE route) ----
  const [deleting, setDeleting] = useState(false);
  const deleteAgent = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this data agent? This removes the agent and its configuration permanently. This cannot be undone.')) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setPublishResult({ ok: false, error: `Delete failed: ${j?.error || `HTTP ${r.status}`}` });
        return;
      }
      // Back to the workspace list after a successful delete.
      if (typeof window !== 'undefined') window.location.href = '/workspaces';
    } catch (e: any) {
      setPublishResult({ ok: false, error: `Delete failed: ${e?.message || String(e)}` });
    } finally { setDeleting(false); }
  }, [id]);

  // ---- run-steps inspector (debug a PUBLISHED agent via the Foundry Agent Service) ----
  const [inspectAgent, setInspectAgent] = useState('');
  const [inspectQuestion, setInspectQuestion] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<any>(null);
  const [inspectGate, setInspectGate] = useState<string | null>(null);
  // Prefill the agent name from the last publish (artifactId) when available.
  useEffect(() => {
    if (publishResult?.artifactId && !inspectAgent) setInspectAgent(String(publishResult.artifactId));
  }, [publishResult, inspectAgent]);
  const runInspect = useCallback(async () => {
    const agent = inspectAgent.trim(); const q = inspectQuestion.trim();
    // The agent name is OPTIONAL now — without a published Foundry agent the
    // inspector runs the Azure-native grounded backend over this item's sources
    // (no Microsoft Fabric / published asst_ required). Only the question + the
    // item id are needed.
    if (!q || inspecting) return;
    setInspecting(true); setInspectResult(null); setInspectGate(null);
    try {
      const r = await fetch('/api/data-agent/run-steps', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: agent || undefined, question: q, id }),
      });
      const j = await r.json();
      if (r.status === 501 || j?.code === 'not_configured') { setInspectGate(j?.hint || j?.error || 'No AOAI model deployed. Deploy one from the AI Foundry hub.'); return; }
      setInspectResult(j);
    } catch (e: any) { setInspectResult({ ok: false, error: e?.message || String(e) }); }
    finally { setInspecting(false); }
  }, [inspectAgent, inspectQuestion, inspecting, id]);

  // One-time migration: if a legacy record persisted `sources` as a string (or
  // any non-array shape), rewrite state to a clean DaSource[] so the agent both
  // renders AND can be re-saved in the new schema. Runs after load settles.
  useEffect(() => {
    if (loading) return;
    if (state.sources !== undefined && !Array.isArray(state.sources)) {
      const migrated = normalizeDaSources(state.sources);
      setState((p) => ({ ...p, sources: migrated }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, state.sources]);

  const sources = normalizeDaSources(state.sources);
  const instrLen = (typeof state.instructions === 'string' ? state.instructions : '').length;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Agent', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: 'Build', onClick: () => setTab('build') },
        { label: 'Config Copilot', onClick: () => setTab('copilot') },
        { label: 'Test chat', onClick: () => setTab('test') },
        { label: 'Publish', onClick: () => setTab('publish') },
        { label: 'Run inspector', onClick: () => setTab('inspect') },
        { label: 'Monitoring', onClick: () => setTab('monitor') },
      ]},
    ]},
  ], [save, saving, dirty]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="build">Build ({sources.length}/5 sources)</Tab>
            <Tab value="copilot">Config Copilot</Tab>
            <Tab value="test">Test chat</Tab>
            <Tab value="publish">Publish</Tab>
            <Tab value="inspect">Run inspector</Tab>
            <Tab value="monitor">Monitoring</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}

          {tab === 'build' && (
            <>
              {/* Agent identity + routing instructions */}
              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Bot24Regular /></span>
                  <Subtitle2>Agent</Subtitle2>
                </div>
                <Field label="Agent name / alias" hint="A friendly name for this data agent — shown in chat and used when publishing. Leave blank to use the item's name.">
                  <Input
                    value={state.alias || ''}
                    maxLength={128}
                    onChange={(_, d) => setState((p) => ({ ...p, alias: d.value }))}
                    placeholder={item.displayName || 'e.g. Casino Revenue Analyst'}
                  />
                </Field>
                <Field label={`Instructions (${instrLen}/15000)`} hint="Declare which source handles which kind of question — the agent uses this to route.">
                  <Textarea
                    value={state.instructions} maxLength={15000} rows={5}
                    onChange={(_, d) => setState((p) => ({ ...p, instructions: d.value }))}
                    placeholder="Route financial metrics to the semantic model; raw exploration to the lakehouse; log analysis to KQL…"
                  />
                </Field>
              </div>

              {/* Grounded data sources */}
              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Database20Regular /></span>
                  <Subtitle2>Data sources</Subtitle2>
                  <Badge appearance="tint" color={sources.length >= 5 ? 'warning' : 'brand'}>{sources.length}/5</Badge>
                </div>
                <div className={s.daAddBar}>
                  <Field label="Type">
                    <Dropdown value={DA_SOURCE_TYPES.find((t) => t.value === pickerType)?.label} selectedOptions={[pickerType]}
                      onOptionSelect={(_, d) => { if (d.optionValue) { setPickerType(d.optionValue as DaSourceType); setPickSel(''); } }}>
                      {DA_SOURCE_TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Item" style={{ minWidth: 220 }}>
                    <Dropdown value={(available[pickerType] || []).find((o) => o.id === pickSel)?.name || ''} selectedOptions={pickSel ? [pickSel] : []}
                      placeholder={pickerLoading ? 'Loading…' : ((available[pickerType] || []).length ? 'Select…' : 'None found')}
                      onOptionSelect={(_, d) => d.optionValue && setPickSel(d.optionValue)}>
                      {(available[pickerType] || []).map((o) => <Option key={o.id} value={o.id}>{o.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Button appearance="primary" icon={<Add20Regular />} onClick={addSource} disabled={!pickSel || sources.length >= 5}>Add source</Button>
                </div>

                {sources.map((src) => (
                  <div key={src.id} className={s.daSrcCard}>
                    <div className={s.daSrcHead}>
                      <span className={s.daSrcIcon}><Database20Regular /></span>
                      <strong>{src.name}</strong>
                      <Badge appearance="tint" color="brand">{DA_SOURCE_TYPES.find((t) => t.value === src.type)?.label || src.type}</Badge>
                      <div style={{ flex: 1 }} />
                      <Button size="small" appearance="subtle" onClick={() => removeSource(src.id)} style={{ color: tokens.colorPaletteRedForeground1 }}>Remove</Button>
                    </div>
                    <Field label="Description" hint="Helps the agent route questions to this source.">
                      <Input value={src.description || ''} onChange={(_, d) => updateSource(src.id, { description: d.value })} placeholder="Finance facts: revenue, margin, bookings by region & quarter." />
                    </Field>
                    {src.type === 'ontology' || src.type === 'graph' ? (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        {src.type === 'graph' ? 'Graphs are queried whole — no node/edge scoping.' : 'Ontologies are queried whole — no subset scoping.'}
                      </Caption1>
                    ) : (
                      <Field label={DA_SCHEMA_LABEL[src.type]}>
                        <Input value={src.tables || ''} onChange={(_, d) => updateSource(src.id, { tables: d.value })} placeholder="dim_date, fact_sales" />
                      </Field>
                    )}
                    <Field label="Source instructions">
                      <Textarea value={src.instructions || ''} rows={4} onChange={(_, d) => updateSource(src.id, { instructions: d.value })} />
                    </Field>
                    {daSupportsExampleQueries(src.type) ? (
                      <Field label="Example question → query pairs (few-shot)">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalSNudge }}>
                          {arr<{ question: string; query: string }>(src.examples).map((ex, i) => (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: tokens.spacingHorizontalSNudge }}>
                              <Input value={ex.question} placeholder="question" onChange={(_, d) => updateSourceExamples(src.id, (arr) => arr.map((e, j) => j === i ? { ...e, question: d.value } : e))} />
                              <Input value={ex.query} placeholder="SQL / KQL / GQL" onChange={(_, d) => updateSourceExamples(src.id, (arr) => arr.map((e, j) => j === i ? { ...e, query: d.value } : e))} />
                              <Button size="small" appearance="subtle" onClick={() => updateSourceExamples(src.id, (arr) => arr.filter((_, j) => j !== i))}>×</Button>
                            </div>
                          ))}
                          <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => addExample(src.id)} style={{ alignSelf: 'flex-start' }}>Example</Button>
                        </div>
                      </Field>
                    ) : (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        {src.type === 'semantic-model'
                          ? 'Semantic models use Power BI “Prep for AI” Verified Answers instead of example queries.'
                          : 'Example queries are not supported for this source.'}
                      </Caption1>
                    )}
                  </div>
                ))}
                {sources.length === 0 && (
                  <MessageBar intent="info"><MessageBarBody><Sparkle20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalSNudge }} />Attach up to five typed sources. Each becomes a grounded tool for the agent. Test chat and Publish both need at least one.</MessageBarBody></MessageBar>
                )}
              </div>
              <SaveBar
                saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
                extraRight={
                  <Button appearance="subtle" disabled={deleting} onClick={deleteAgent}
                    style={{ color: tokens.colorPaletteRedForeground1 }}>
                    {deleting ? 'Deleting…' : 'Delete agent'}
                  </Button>
                }
              />
            </>
          )}

          {tab === 'copilot' && (
            <DataAgentConfigCopilotPanel
              id={id}
              sources={sources}
              ensureSaved={async () => { if (dirty) await save(); }}
              onApply={async (sourceId, suggestion) => {
                // Server already persisted; mirror into local state so Build + Test
                // reflect the applied examples/descriptions immediately, then re-save
                // the exact merged snapshot (idempotent — keeps local + Cosmos identical
                // without a stale-state overwrite).
                const mergedSources = mergeSuggestionIntoSources(
                  arr<DaSource>(state.sources) as unknown as Record<string, unknown>[],
                  sourceId,
                  suggestion,
                ) as unknown as DaSource[];
                const nextState = { ...state, sources: mergedSources };
                setState(() => nextState);
                await save(nextState);
              }}
            />
          )}

          {tab === 'test' && (
            <div className={s.chatShell}>
              <div className={s.chatHead}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                  <Subtitle2>Test chat</Subtitle2>
                  <Badge appearance="tint" color="brand">live · grounded</Badge>
                  <div style={{ flex: 1 }} />
                  {convos.length > 0 && (
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button size="small" appearance="subtle">History ({convos.length})</Button>
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          {convos.slice(0, 25).map((cv) => (
                            <MenuItem key={cv.id} onClick={() => loadConvo(cv.id)}>
                              {cv.title} · {cv.turns} msg · {new Date(cv.updatedAt).toLocaleDateString()}
                            </MenuItem>
                          ))}
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  )}
                  <Button size="small" appearance="subtle" onClick={() => { newChat(); setQuestion(''); }} disabled={asking || (chat.length === 0 && !question)}>+ New thread</Button>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Each turn runs against the live AOAI deployment on the Foundry hub, grounded on the {sources.length} source{sources.length === 1 ? '' : 's'} + instructions in Build.
                </Caption1>
                {sources.length === 0 && (
                  <MessageBar intent="warning"><MessageBarBody>No data sources attached yet — answers will be ungrounded. Add at least one source in the <strong>Build</strong> tab for real grounded responses.</MessageBarBody></MessageBar>
                )}
              </div>

              <div ref={threadRef} className={s.chatThread} aria-live="polite">
                {chat.length === 0 && !asking && (
                  <div style={{ margin: 'auto', textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
                    <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Ask the agent a question to start a thread.</Body1>
                    <Caption1>e.g. “What was total revenue by region last quarter?”</Caption1>
                  </div>
                )}
                {chat.map((m, i) => {
                  const tools = m.tools && m.tools.length ? m.tools : (m.query || m.sourceUsed ? [{ source: m.sourceUsed || 'source', action: 'query', query: m.query } as DaTool] : []);
                  const srcLabel = !m.error
                    ? (tools.length > 1 ? ` · ${tools.length} sources` : m.sourceUsed ? ` · source: ${m.sourceUsed}` : '')
                    : '';
                  return (
                  <div key={i} className={m.role === 'user' ? s.chatRowUser : s.chatRowBot}>
                    <span className={s.chatMeta}>{m.role === 'user' ? 'You' : m.error ? 'Agent · error' : 'Agent'}{srcLabel}{m.model && !m.error ? ` · ${m.model}` : ''}{m.usage?.totalTokens && !m.error ? ` · ${m.usage.totalTokens} tokens` : ''}</span>
                    <div className={m.role === 'user' ? s.bubbleUser : m.error ? s.bubbleErr : s.bubbleBot}>
                      {m.content || (m.error ? 'Unknown error' : '')}
                    </div>
                    {m.role === 'assistant' && !m.error && tools.length > 0 && (
                      <details style={{ marginTop: tokens.spacingVerticalXXS }} open={tools.length > 1}>
                        <summary style={{ cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 }}>
                          🛠 Tools used ({tools.length})
                        </summary>
                        {tools.map((t, ti) => (
                          <div key={ti} style={{ marginTop: tokens.spacingVerticalXS }}>
                            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                              <strong>{t.source}</strong>{t.type ? ` · ${t.type}` : ''} · {t.action}
                              {t.executed && (
                                <Badge appearance="tint" color="success" size="extra-small" style={{ marginLeft: tokens.spacingHorizontalSNudge }}>
                                  ✓ ran · {t.rowCount ?? 0} row{t.rowCount === 1 ? '' : 's'}
                                </Badge>
                              )}
                            </Caption1>
                            {t.query && <pre className={s.chatSource}>{t.query}</pre>}
                            {t.executed && t.columns && t.columns.length > 0 && t.rows && t.rows.length > 0 && (
                              <DataAgentResultViz tool={t} />
                            )}
                            {!t.executed && t.gate && (
                              <Caption1 style={{ color: tokens.colorPaletteYellowForeground1, display: 'block', marginTop: tokens.spacingVerticalXXS }}>
                                ⚠ {t.gate}
                              </Caption1>
                            )}
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                  );
                })}
                {asking && (
                  <div className={s.chatRowBot}>
                    <span className={s.chatMeta}>Agent</span>
                    <div className={s.bubbleBot} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                      <Spinner size="tiny" /> Thinking…
                    </div>
                  </div>
                )}
              </div>

              <div className={s.chatComposer}>
                <Textarea
                  value={question}
                  onChange={(_, d) => setQuestion(d.value)}
                  placeholder="Ask the agent…  (Enter to send · Shift+Enter for a new line)"
                  resize="none"
                  rows={2}
                  textarea={{ style: { maxHeight: 120, overflowY: 'auto' } }}
                  style={{ flex: 1 }}
                  disabled={asking}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (canSend) ask();
                    }
                  }}
                />
                <Button appearance="primary" onClick={ask} disabled={!canSend}>{asking ? 'Sending…' : 'Send'}</Button>
              </div>
            </div>
          )}

          {tab === 'publish' && (
            <>
              <Subtitle2>Publish to Foundry Agent Service</Subtitle2>
              <Caption1>Publishing upserts a prompt-agent (instructions + typed sources as tools) into the Foundry project. Consumers (Foundry agents, Copilot Studio) read the description to decide when to call this agent.</Caption1>
              <Caption1 style={{ marginTop: tokens.spacingVerticalSNudge }}>Description (orchestrators see this)</Caption1>
              <Textarea value={state.description || ''} rows={3} onChange={(_, d) => setState((p) => ({ ...p, description: d.value }))} placeholder="Answers finance questions grounded on the FY warehouse + revenue semantic model." />
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS }}>
                <Button appearance="primary" onClick={publish} disabled={publishing || saving || sources.length === 0}>{publishing ? 'Publishing…' : 'Publish'}</Button>
              </div>
              {state.publishedAt && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalSNudge }}>
                  <Badge appearance="filled" color="success">published</Badge>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{new Date(state.publishedAt).toLocaleString()}</Caption1>
                </div>
              )}
              {publishResult && (
                <MessageBar intent={publishResult.ok ? 'success' : publishResult.deferred ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {publishResult.ok ? 'Published' : publishResult.deferred ? 'Foundry Agent Service not configured' : 'Publish failed'}
                    </MessageBarTitle>
                    {publishResult.ok && (
                      <div style={{ marginTop: tokens.spacingVerticalXS }}>
                        Connect from Foundry / Copilot Studio with this GUID pair (mark both as secrets):
                        <div style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalXS }}>
                          workspace-id (project): <strong>{publishResult.workspaceId}</strong><br />
                          artifact-id (agent): <strong>{publishResult.artifactId}</strong>
                        </div>
                        <Caption1 style={{ marginTop: tokens.spacingVerticalSNudge, display: 'block' }}>
                          Copilot Studio: Agents → + Add → Microsoft Fabric → pick this published agent.
                          Foundry: Management Center → Connected resources → new Microsoft Fabric connection.
                        </Caption1>
                      </div>
                    )}
                    {publishResult.error && <div>{publishResult.error}</div>}
                    {publishResult.hint && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Hint:</em> {publishResult.hint}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* ---- Publish to Microsoft 365 Copilot (Copilot Studio) ---- */}
              <div role="separator" aria-orientation="horizontal" style={{ height: 1, background: tokens.colorNeutralStroke2, margin: `${tokens.spacingVerticalXL} 0` }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Subtitle2>Publish to Microsoft 365 Copilot</Subtitle2>
                <Badge appearance="tint" color="brand">Copilot Studio</Badge>
              </div>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXXS, maxWidth: 720, color: tokens.colorNeutralForeground2 }}>
                Surfaces this data agent as a Copilot Studio agent and enables the Teams + Microsoft 365 Copilot channel,
                so users can discover and chat with it in M365 Copilot. After publishing, a tenant admin approves it in the
                Microsoft 365 admin center (Agents → All agents → Requests).
              </Caption1>
              {!m365EnvLoaded && <Spinner size="tiny" label="Loading Power Platform environments…" labelPosition="after" style={{ marginTop: tokens.spacingVerticalS }} />}
              {m365EnvLoaded && m365Envs.length === 0 && (
                <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>No Power Platform environment available</MessageBarTitle>
                    <div>
                      Microsoft 365 Copilot publishing requires a Dataverse-enabled Power Platform environment with Copilot Studio enabled.
                      Set <code>LOOM_COPILOT_STUDIO_ENVIRONMENT_ID</code> and the Dataverse app-user creds
                      (<code>LOOM_DATAVERSE_CLIENT_ID</code> / <code>LOOM_DATAVERSE_CLIENT_SECRET</code> / <code>LOOM_DATAVERSE_TENANT_ID</code>) on the console app.
                    </div>
                    {m365EnvError && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Detail:</em> {m365EnvError}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}
              {m365EnvLoaded && m365Envs.length > 0 && (
                <>
                  <Field label="Power Platform environment" style={{ marginTop: tokens.spacingVerticalS, maxWidth: 480 }}>
                    <Dropdown
                      value={m365Envs.find((e) => e.id === m365EnvId)?.displayName || ''}
                      selectedOptions={m365EnvId ? [m365EnvId] : []}
                      onOptionSelect={(_, d) => d.optionValue && setM365EnvId(d.optionValue)}
                      placeholder="Select an environment"
                    >
                      {m365Envs.map((e) => <Option key={e.id} value={e.id}>{e.displayName}</Option>)}
                    </Dropdown>
                  </Field>
                  <Switch
                    checked={m365Available}
                    onChange={(_, d) => setM365Available(d.checked)}
                    label="Make agent available in Microsoft 365 Copilot (uncheck for Teams only)"
                    style={{ marginTop: tokens.spacingVerticalXS }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
                    <Button
                      appearance="primary"
                      onClick={publishM365}
                      disabled={m365Publishing || saving || !m365EnvId || sources.length === 0}
                      title={
                        sources.length === 0 ? 'Add at least one data source on the Build tab before publishing.'
                        : !m365EnvId ? 'Select a Power Platform environment first.'
                        : undefined
                      }
                    >
                      {m365Publishing ? 'Publishing to M365 Copilot…' : 'Publish to M365 Copilot'}
                    </Button>
                    {m365Publishing && <Spinner size="tiny" />}
                    {sources.length === 0 && (
                      <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>
                        Add at least one data source on the Build tab before publishing.
                      </Caption1>
                    )}
                  </div>
                </>
              )}
              {state.m365Copilot?.publishedAt && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalSNudge }}>
                  <Badge appearance="filled" color="success">M365 Copilot</Badge>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Published {new Date(state.m365Copilot.publishedAt).toLocaleString()} · agent <code>{state.m365Copilot.agentName}</code>
                  </Caption1>
                </div>
              )}
              {m365Result && (
                <MessageBar intent={m365Result.ok ? 'success' : m365Result.deferred ? 'warning' : 'error'} style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {m365Result.ok ? 'Published to Microsoft 365 Copilot' : m365Result.deferred ? 'Copilot Studio not configured' : 'M365 Copilot publish failed'}
                    </MessageBarTitle>
                    {m365Result.ok && (
                      <div style={{ marginTop: tokens.spacingVerticalXS }}>
                        Copilot Studio agent <strong>{m365Result.agentName}</strong> ({m365Result.agentState || 'published'}) is now on the
                        Teams + Microsoft 365 Copilot channel{m365Result.m365CopilotEnabled ? ' with M365 Copilot enabled' : ' (Teams only)'}.
                      </div>
                    )}
                    {m365Result.error && <div>{m365Result.error}</div>}
                    {m365Result.hint && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Next:</em> {m365Result.hint}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}

          {tab === 'inspect' && (
            <>
              <Subtitle2>Run-steps inspector</Subtitle2>
              <Caption1>Run a question through a PUBLISHED Foundry agent and trace the run steps it executed (tool calls / queries / message creation). Requires the agent to be published and LOOM_FOUNDRY_PROJECT_ENDPOINT configured.</Caption1>
              {inspectGate && (
                <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>Foundry Agent Service not configured</MessageBarTitle>
                    <div>{inspectGate}</div>
                  </MessageBarBody>
                </MessageBar>
              )}
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: tokens.spacingVerticalS }}>
                <Field label="Published agent (name / artifact id)">
                  <Input value={inspectAgent} onChange={(_, d) => setInspectAgent(d.value)} placeholder="from Publish (artifact-id)" style={{ minWidth: 300 }} />
                </Field>
              </div>
              <Textarea value={inspectQuestion} rows={2} onChange={(_, d) => setInspectQuestion(d.value)} placeholder="Ask a question to trace through the agent…" style={{ marginTop: tokens.spacingVerticalS }} />
              <div style={{ marginTop: tokens.spacingVerticalS }}>
                <Button appearance="primary" onClick={runInspect} disabled={inspecting || !inspectAgent.trim() || !inspectQuestion.trim()}>{inspecting ? 'Running…' : 'Run + inspect'}</Button>
              </div>
              {inspectResult && inspectResult.ok && inspectResult.data && (
                <div style={{ marginTop: tokens.spacingVerticalM }}>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge appearance="filled" color={inspectResult.data.status === 'completed' ? 'success' : inspectResult.data.status === 'failed' ? 'danger' : 'warning'}>{inspectResult.data.status}</Badge>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>run {inspectResult.data.runId}</Caption1>
                  </div>
                  {inspectResult.data.lastError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalSNudge }}><MessageBarBody>{inspectResult.data.lastError}</MessageBarBody></MessageBar>}
                  {inspectResult.data.answer && (
                    <div style={{ marginTop: tokens.spacingVerticalS }}><Subtitle2>Answer</Subtitle2><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{inspectResult.data.answer}</div></div>
                  )}
                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Run steps ({inspectResult.data.steps?.length || 0})</Subtitle2>
                  {(inspectResult.data.steps || []).map((st: any, i: number) => (
                    <div key={st.id || i} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalSNudge }}>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                        <Badge appearance="outline">{st.type}</Badge>
                        <Badge appearance="filled" color={st.status === 'completed' ? 'success' : st.status === 'failed' ? 'danger' : 'informative'}>{st.status}</Badge>
                      </div>
                      {(st.toolCalls || []).map((tc: any, j: number) => (
                        <div key={j} style={{ marginTop: tokens.spacingVerticalSNudge, fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, minWidth: 0, overflowWrap: 'anywhere' }}>
                          <div><strong>{tc.type}{tc.name ? ` · ${tc.name}` : ''}</strong></div>
                          {tc.input && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: tokens.colorNeutralForeground3 }}>{tc.input}</div>}
                          {tc.output && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{tc.output}</div>}
                        </div>
                      ))}
                      {st.error && <div style={{ color: tokens.colorPaletteRedForeground1, marginTop: tokens.spacingVerticalXS }}>{st.error}</div>}
                    </div>
                  ))}
                </div>
              )}
              {inspectResult && !inspectResult.ok && !inspectGate && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>{inspectResult.error || 'Run failed'}</MessageBarBody></MessageBar>
              )}
            </>
          )}

          {tab === 'monitor' && <DataAgentMonitoringPanel id={id} />}
        </div>
      </>
    } />
  );
}

// ----- Data Agent → Monitoring (Wave-B merge #6) --------------------------------
// operations-agent's monitoring capability folds into data-agent here, OPTIONALLY:
// a Monitoring tab that creates + lists Azure-native scheduled-query alert rules
// (Microsoft.Insights/scheduledQueryRules + action group) for this agent's data.
// Backend is the EXISTING activator rules route — no new BFF route:
//   GET  /api/items/activator/[id]/rules?workspaceId=...   → MonitorRuleRecord[]
//   POST /api/items/activator/[id]/rules?workspaceId=...    → create one rule
//   POST .../rules?workspaceId=&trigger=<ruleId>            → run the rule's KQL now
// Per no-fabric-dependency.md the default backend is Azure Monitor (no Fabric).
// The route's honest Monitor infra-gate (set LOOM_LOG_ANALYTICS_RESOURCE_ID /
// LOOM_ALERT_RG, grant Monitoring Contributor) is surfaced VERBATIM. The
// workspaceId is read from the page-primed ['item','data-agent',id] React Query
// cache (useItemState doesn't expose it). OperationsAgentEditor is untouched and
// stays registered so already-created operations-agent instances open as before.
const DA_SEVERITY_OPTS: { value: number; label: string }[] = [
  { value: 0, label: '0 — Critical' },
  { value: 1, label: '1 — Error' },
  { value: 2, label: '2 — Warning' },
  { value: 3, label: '3 — Informational' },
  { value: 4, label: '4 — Verbose' },
];
const DA_FREQ_OPTS = ['PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'P1D'];
const DA_WINDOW_OPTS = ['PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'PT24H'];

function DataAgentMonitoringPanel({ id }: { id: string }) {
  const s = useStyles();
  // workspaceId comes from the page-primed item record (the page hydrates
  // ['item','data-agent',id]); read the SAME key so we reuse that cache and the
  // activator rules route gets the required ?workspaceId=.
  const itemQ = useQuery({
    queryKey: ['item', 'data-agent', id],
    queryFn: () => getItem('data-agent', id),
    enabled: !!id && id !== 'new',
  });
  const workspaceId = itemQ.data?.workspaceId || '';

  const [rules, setRules] = useState<MonitorRuleRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ reason?: string; remediation?: string } | null>(null);

  // New-rule form (no JSON — typed fields mirroring the activator rule wizard).
  const [ruleName, setRuleName] = useState('');
  const [query, setQuery] = useState('');
  const [sourceTable, setSourceTable] = useState('');
  const [severity, setSeverity] = useState(2);
  const [evalFreq, setEvalFreq] = useState('PT5M');
  const [winSize, setWinSize] = useState('PT5M');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Trigger-now feedback per rule.
  const [triggerResult, setTriggerResult] = useState<{ ruleId: string; fired: boolean; count: number } | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true); setListErr(null); setGate(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(id)}/rules?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        setRules([]);
        if (j?.gate) setGate(j.gate);
        setListErr(j?.error || `HTTP ${r.status}`);
        return;
      }
      setRules(Array.isArray(j.rules) ? j.rules : []);
    } catch (e: any) {
      setRules([]); setListErr(e?.message || String(e));
    } finally { setLoading(false); }
  }, [id, workspaceId]);

  useEffect(() => { if (workspaceId) loadRules(); }, [workspaceId, loadRules]);

  const createRule = useCallback(async () => {
    if (!ruleName.trim() || !workspaceId) return;
    setCreating(true); setCreateErr(null); setGate(null);
    const body: Record<string, unknown> = {
      name: ruleName.trim(),
      severity, evaluationFrequency: evalFreq, windowSize: winSize,
    };
    if (query.trim()) body.query = query.trim();
    if (sourceTable.trim()) body.sourceTable = sourceTable.trim();
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(id)}/rules?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        if (j?.gate) setGate(j.gate);
        setCreateErr(j?.error || j?.gate?.remediation || `HTTP ${r.status}`);
        return;
      }
      setRuleName(''); setQuery(''); setSourceTable('');
      await loadRules();
    } catch (e: any) {
      setCreateErr(e?.message || String(e));
    } finally { setCreating(false); }
  }, [ruleName, query, sourceTable, severity, evalFreq, winSize, id, workspaceId, loadRules]);

  const triggerNow = useCallback(async (ruleId: string) => {
    if (!workspaceId) return;
    setTriggering(ruleId); setTriggerResult(null); setListErr(null); setGate(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(id)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&trigger=${encodeURIComponent(ruleId)}`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        if (j?.gate) setGate(j.gate);
        setListErr(j?.error || j?.gate?.remediation || `HTTP ${r.status}`);
        return;
      }
      setTriggerResult({ ruleId, fired: !!j.fired, count: typeof j.count === 'number' ? j.count : (Array.isArray(j.rows) ? j.rows.length : 0) });
    } catch (e: any) {
      setListErr(e?.message || String(e));
    } finally { setTriggering(null); }
  }, [id, workspaceId]);

  if (id === 'new') {
    return (
      <MessageBar intent="info">
        <MessageBarBody>Save this data agent first — Monitoring creates Azure Monitor alert rules scoped to this agent, which needs a persisted item.</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.daSection}>
      <div className={s.daSectionHead}>
        <span className={s.daSectionIcon}><Pulse20Regular /></span>
        <Subtitle2>Monitoring</Subtitle2>
        <Badge appearance="tint" color="brand">Azure Monitor</Badge>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadRules} disabled={loading || !workspaceId}>Refresh</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Watch this agent&rsquo;s data with scheduled-query alert rules. Each rule is a real
        <strong> Microsoft.Insights/scheduledQueryRule</strong> (+ action group) that runs your KQL on the Log
        Analytics workspace on a cadence and fires when rows are returned — no Microsoft Fabric required.
      </Caption1>

      {itemQ.isLoading && <Spinner size="tiny" label="Loading agent…" labelPosition="after" />}
      {itemQ.data && !workspaceId && (
        <MessageBar intent="warning"><MessageBarBody>
          Couldn&rsquo;t resolve this agent&rsquo;s workspace. Open the agent from its workspace so Monitoring can scope alert rules to it.
        </MessageBarBody></MessageBar>
      )}

      {/* Honest Azure Monitor infra-gate (NOT a Fabric gate) — verbatim from the route. */}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure Monitor not configured</MessageBarTitle>
            {gate.reason && <div>{gate.reason}</div>}
            {gate.remediation && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>To enable:</em> {gate.remediation}</div>}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* New rule (typed wizard — no freeform JSON). */}
      <div className={s.daAddBar} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Rule name" style={{ minWidth: 200 }}>
            <Input value={ruleName} onChange={(_, d) => setRuleName(d.value)} placeholder="e.g. High error rate" />
          </Field>
          <Field label="Severity">
            <Dropdown
              value={DA_SEVERITY_OPTS.find((o) => o.value === severity)?.label}
              selectedOptions={[String(severity)]}
              onOptionSelect={(_, d) => d.optionValue != null && setSeverity(Number(d.optionValue))}
            >
              {DA_SEVERITY_OPTS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Evaluate every">
            <Dropdown value={evalFreq} selectedOptions={[evalFreq]} onOptionSelect={(_, d) => d.optionValue && setEvalFreq(d.optionValue)}>
              {DA_FREQ_OPTS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Lookback window">
            <Dropdown value={winSize} selectedOptions={[winSize]} onOptionSelect={(_, d) => d.optionValue && setWinSize(d.optionValue)}>
              {DA_WINDOW_OPTS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
        </div>
        <Field label="Alert KQL (Log Analytics)" hint="The rule fires when this query returns one or more rows. Leave blank to alert on any new row in the source table below.">
          <Textarea value={query} rows={3} onChange={(_, d) => setQuery(d.value)} placeholder={'AppEvents\n| where Level == "Error"\n| where TimeGenerated > ago(15m)'} />
        </Field>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Source table (optional)" hint="Used to compose the query when Alert KQL is blank." style={{ minWidth: 240 }}>
            <Input value={sourceTable} onChange={(_, d) => setSourceTable(d.value)} placeholder="AppEvents" />
          </Field>
          <Button appearance="primary" icon={<Add20Regular />} onClick={createRule} disabled={creating || !ruleName.trim() || !workspaceId}>
            {creating ? 'Creating…' : 'Create alert rule'}
          </Button>
        </div>
        {createErr && !gate && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{createErr}</Caption1>}
      </div>

      {/* Rule list. */}
      {loading && <Spinner size="tiny" label="Loading rules…" labelPosition="after" />}
      {!loading && rules.length === 0 && !gate && !listErr && (
        <MessageBar intent="info"><MessageBarBody>
          <Pulse20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalSNudge }} />
          No alert rules yet. Create one above to monitor this agent&rsquo;s data on Azure Monitor.
        </MessageBarBody></MessageBar>
      )}
      {!loading && listErr && !gate && (
        <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>
      )}
      {rules.map((r) => (
        <div key={r.id} className={s.daSrcCard}>
          <div className={s.daSrcHead}>
            <span className={s.daSrcIcon}><Pulse20Regular /></span>
            <strong>{r.name}</strong>
            <Badge appearance="tint" color={r.state === 'Active' ? 'success' : 'warning'}>{r.state}</Badge>
            <Badge appearance="outline">sev {r.severity}</Badge>
            <Badge appearance="outline">{r.evaluationFrequency} / {r.windowSize}</Badge>
            <div style={{ flex: 1 }} />
            <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => triggerNow(r.id)} disabled={triggering === r.id || !workspaceId}>
              {triggering === r.id ? 'Running…' : 'Trigger now'}
            </Button>
          </div>
          {r.query && <pre className={s.chatSource}>{r.query}</pre>}
          {r.note && <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>⚠ {r.note}</Caption1>}
          {triggerResult && triggerResult.ruleId === r.id && (
            <Caption1 style={{ color: triggerResult.fired ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
              {triggerResult.fired
                ? `Would fire — ${triggerResult.count} matching row${triggerResult.count === 1 ? '' : 's'} right now.`
                : 'No matching rows right now — the rule would not fire.'}
            </Caption1>
          )}
        </div>
      ))}
    </div>
  );
}
