'use client';

/**
 * ReportDesigner — the Loom-native interactive REPORT DESIGNER.
 *
 * Power BI report-authoring parity, Azure-native (no-fabric-dependency.md).
 *
 * This file is the SHELL. Implementation is split into sibling modules
 * under lib/editors/report-designer/:
 *   types.ts              — all TypeScript types + constants
 *   constants.tsx         — VISUALS gallery, GALLERY_CATS, chart sets
 *   helpers.tsx           — pure helper fns (uid, fieldKey, dataTypeGlyph, etc.)
 *   styles.ts             — makeStyles block (useStyles + type Styles)
 *   pane-section.tsx      — <PaneSection> collapsible header
 *   visual-body.tsx       — <VisualBody>, <TooltipPageContent>
 *   well-editor.tsx       — <WellEditor> field-well editor
 *   rename-page-item.tsx  — <RenamePageItem> inline rename control
 *   page-format-panel.tsx — <PageFormatPanel> no-selection format surface
 *   arrange-bar.tsx       — <ArrangeBar> multi-select arrange toolbar
 *   pages-panel.tsx       — <PagesPanel> left-rail pages list
 *   use-report-mutations.tsx — all IO + mutation + ribbon callbacks (hook)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge, Button, Caption1, Dropdown, Option, Divider, Input, Field, Radio, RadioGroup,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader, MenuDivider,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Spinner, Subtitle2, Text, Tooltip,
  Tree, TreeItem, TreeItemLayout, TabList, Tab,
  tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Save20Regular, ArrowSync20Regular,
  Edit20Regular, DataBarVerticalRegular, Table20Regular,
  Filter20Regular, Dismiss16Regular, Sparkle20Regular,
  Database20Regular, CloudArrowUp20Regular, ColorRegular,
  Options20Regular, DataTrending20Regular, Eye20Regular, EyeOff20Regular,
  Layer20Regular, LockClosed20Regular, LockOpen20Regular,
  PositionToFront20Regular, PositionToBack20Regular,
  ArrowExpand20Regular,
  Bookmark20Regular, BookmarkMultiple20Regular,
  ArrowExit20Regular,
  DataBarVertical20Regular,
  MathFormula16Regular,
  Settings20Regular, EyeOff16Regular,
  ArrowRight20Regular, DocumentMultiple20Regular,
} from '@fluentui/react-icons';
import type { CSSProperties, ReactElement } from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { useBiBackend } from '@/lib/components/platform-config';
import { ItemEditorChrome } from './item-editor-chrome';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { ReportPowerBiCopilot } from '@/lib/components/report/report-powerbi-copilot';
import { DataSourcePicker } from './report/data-source-picker';
import { LoomItemSourcePicker } from './report/loom-item-source-picker';
import { FormatPane } from './report/format-pane';
import {
  FiltersPane, fieldOptions, type FilterPaneFormat,
} from './report/filters-pane';
import { AnalyticsPane, seriesNamesFromRows } from './report/analytics-pane';
import {
  InteractionsEditor, resolveInteraction, type VisualSelection,
} from './report/interactions';
import { type ReportDataSource, isBound, describeSource } from './report/report-data-source';
import { FreeFormCanvas } from './report/free-form-canvas';
import { type AbsRect } from './report/use-canvas-layout';
import {
  type CanvasElement,
  ElementsGallery, ElementProperties,
  renderElement, renderElementChrome,
} from './report/canvas-elements';
import {
  BookmarksPane, type ReportBookmark, type BookmarkScope, type BookmarkApply,
} from './report/bookmarks-pane';
import { SelectionPane } from './report/selection-pane';
import { themeChartProps, applyThemeCssVars, type ReportTheme } from './report/themes';
import { ThemesPane } from './report/themes-pane';
import {
  usePersonalize, PersonalizeBanner, PersonalizePopover,
  type DVisual as PersonalizeVisual,
} from './report/personalize';
import { ExportMenu } from './report/export-report';
import { VisualExportDataDialog, type ExportVisualShape } from './report/visual-export-data';
import { SensitivityLabelDialog } from './report/sensitivity-label';
import { EndorsementDialog, type Endorsement } from './report/endorsement';
import { DeployToPipelineDialog } from './report/deploy-to-pipeline';
import { usePerfRecorder, PerformanceAnalyzer } from './report/performance-analyzer';
import { useReportSettings, ReportSettingsDialog } from './report/report-settings';
import { SyncSlicersPane, syncedPeerPages, type SyncGroup } from './report/sync-slicers';
import { WhatIfPane, type WhatIfParam, type FieldParameter } from './report/what-if-pane';
import type { ReportFilterInput } from '@/lib/azure/wells-to-sql';
import { AskAffordance } from '@/lib/components/ask/AskAffordance';
import type { ReportFilter } from './report/filters-pane';

// ── Extracted sub-modules ─────────────────────────────────────────────────────
import { useStyles } from './report-designer/styles';
import {
  pageDims,
  type DPage, type DVisual, type WellFieldRef, type VisualType, type FFNode,
  type VisualState, type FieldTable, type RightTab,
} from './report-designer/types';
import { GALLERY_CATS, VISUALS, CHART_TYPES } from './report-designer/constants';
import { wellsFor, fieldKey, fieldLabel, dataTypeGlyph, applyAlpha, wellResultAlias } from './report-designer/helpers';
import { PaneSection } from './report-designer/pane-section';
import { VisualBody, TooltipPageContent } from './report-designer/visual-body';
import { WellEditor } from './report-designer/well-editor';
import { PageFormatPanel } from './report-designer/page-format-panel';
import { ArrangeBar } from './report-designer/arrange-bar';
import { PagesPanel } from './report-designer/pages-panel';
import { useReportMutations, type HistSnap } from './report-designer/use-report-mutations';

// ── Component ─────────────────────────────────────────────────────────────────

export function ReportDesigner({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const router = useRouter();
  const isNew = id === 'new';

  // ── state ──────────────────────────────────────────────────────────────────
  const [pages, setPages] = useState<DPage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selectedVisual, setSelectedVisual] = useState<string | null>(null);
  const [selectedVisualIds, setSelectedVisualIds] = useState<Set<string>>(new Set());
  const [snapGrid, setSnapGrid] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [selection, setSelection] = useState<VisualSelection | null>(null);
  const [drill, setDrill] = useState<{ fromPage: number; toPage: number; filters: ReportFilter[]; label: string } | null>(null);
  const [bookmarks, setBookmarks] = useState<ReportBookmark[]>([]);
  const [syncGroups, setSyncGroups] = useState<SyncGroup[]>([]);
  const [whatIfs, setWhatIfs] = useState<WhatIfParam[]>([]);
  const [fieldParams, setFieldParams] = useState<FieldParameter[]>([]);
  const [drillByVisual, setDrillByVisual] = useState<Record<string, { level: number; path: { table?: string; column?: string; value: string }[]; expandAll?: boolean }>>({});
  const [tooltipHover, setTooltipHover] = useState<{ visualId: string; pageIndex: number; field: WellFieldRef; value: string; x: number; y: number } | null>(null);
  const pointerVpRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => { pointerVpRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', onMove, true);
    return () => window.removeEventListener('mousemove', onMove, true);
  }, []);
  const drillByVisualRef = useRef(drillByVisual);
  drillByVisualRef.current = drillByVisual;
  const whatIfsRef = useRef(whatIfs);
  whatIfsRef.current = whatIfs;
  const [rightTab, setRightTab] = useState<RightTab>('build');
  const [reportName, setReportName] = useState('');
  const [theme, setTheme] = useState<ReportTheme | undefined>(undefined);
  const [themesOpen, setThemesOpen] = useState(false);
  const themeChart = useMemo(() => themeChartProps(theme), [theme]);
  const themeVars = useMemo(() => applyThemeCssVars(theme), [theme]);
  const personalize = usePersonalize(id, '');
  const personalizeActiveRef = useRef(false);
  personalizeActiveRef.current = personalize.active;
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dataSource, setDataSource] = useState<ReportDataSource | null>(null);
  const [dsOpen, setDsOpen] = useState(false);
  const [dsSaving, setDsSaving] = useState(false);
  const [dsNote, setDsNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [reportFilters, setReportFilters] = useState<ReportFilter[]>([]);
  const [filterPaneFormat, setFilterPaneFormat] = useState<FilterPaneFormat | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [sensitivityOpen, setSensitivityOpen] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endorsementOpen, setEndorsementOpen] = useState(false);
  const [exportVisual, setExportVisual] = useState<DVisual | null>(null);
  const [sensitivityLabelName, setSensitivityLabelName] = useState<string>('');
  const [endorsement, setEndorsement] = useState<Endorsement | null>(null);
  const perf = usePerfRecorder();
  const reportSettings = useReportSettings();
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
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createWsId, setCreateWsId] = useState('');
  const [reportWorkspaceId, setReportWorkspaceId] = useState('');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[] | null>(null);
  const [wsErr, setWsErr] = useState<string | null>(null);
  const [visualRows, setVisualRows] = useState<Record<string, VisualState>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<{ past: HistSnap[]; future: HistSnap[] }>({ past: [], future: [] });
  const prevSnapRef = useRef<HistSnap | null>(null);
  const restoringRef = useRef(false);
  const [, setHistTick] = useState(0);

  const { powerBiEnabled: pbiPublishEnabled } = useBiBackend();

  // U1 (G3, FLAG0) — default-ON kill-switch; OFF = pre-U1 fixed canvas, no roll.
  const g3CanvasResize = useRuntimeFlag('u1-report-designer-g3');

  // ── derived (computed before the hook so they feed the ribbon config) ──────
  const page = pages[activePage];
  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  const selected = useMemo(
    () => (page?.visuals || []).find((v) => v.id === selectedVisual) || null,
    [page, selectedVisual],
  );
  const selectedElement = useMemo(
    () => (page?.elements || []).find((e) => e.id === selectedVisual) || null,
    [page, selectedVisual],
  );
  const effectiveVisuals = useMemo<DVisual[]>(
    () => (personalize.active
      ? (page?.visuals || []).map((v) =>
          (personalize.applyOverride as unknown as (x: DVisual) => DVisual)(v))
      : (page?.visuals || [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page?.visuals, personalize.active, personalize.map, personalize.applyOverride],
  );

  // Clear cross-filter selection on page navigation.
  useEffect(() => { setSelection(null); }, [activePage]);

  // ── all IO + mutation + ribbon callbacks ───────────────────────────────────
  const {
    loadDetail, loadFields, runVisual,
    undo, redo,
    mutatePage, mutateVisual, addVisual, removeVisual,
    unionNodes, scatterLayouts,
    mutateElement, addElement, removeElement, removeNodes, reorderZStepUnion,
    addToWell, removeFromWell, setAgg,
    queryAdHoc,
    toggleMultiSelect, arrangeTargets, setVisualFlag, matchSize, reorderZ,
    alignSelection, distributeSelection,
    applyLayoutMoves, onCanvasSelect, onCanvasMarquee,
    groupVisuals, ungroupVisuals, selectGroup,
    drillSeedFor, navigateDrillthrough, exitDrillthrough,
    buildCaptureSource, captureBookmark, applyBookmark, changeBookmarks,
    onOpenUrl, onNavigatePage, resolveToken, onElementAction, elemCtx,
    addPage, renamePage, deletePage, duplicatePage, toggleHidePage,
    applyCopilotVisual, addCopilotPage,
    buildDefinitionBody, save, createNewReport, applyDataSource, doPublish,
    rowsByVisual, getPrintHtml, onExportPrint, onExportPng, onServerExport,
    narrativePageRows, aiWiring, scriptWiring, ribbon,
  } = useReportMutations({
    id, isNew, router,
    pages, activePage, selectedVisual, selectedVisualIds,
    reportFilters, bookmarks, syncGroups, whatIfs, fieldParams,
    drillByVisual, selection, drill, dataSource,
    filterPaneFormat, theme, page, reportName,
    workspaces, createOpen, createName, createWsId, publishTarget,
    endorsement, sensitivityLabelName, visualRows, effectiveVisuals,
    dirty, saveBusy, snapGrid, showGrid, tables, canUndo, canRedo,
    personalize, perf, reportSettings,
    historyRef, prevSnapRef, restoringRef, drillByVisualRef, whatIfsRef,
    personalizeActiveRef, gridRef,
    setPages, setActivePage, setSelectedVisual, setSelectedVisualIds,
    setReportFilters, setBookmarks, setSyncGroups, setWhatIfs, setFieldParams,
    setDrillByVisual, setTooltipHover, setSelection, setDrill,
    setDataSource, setDsOpen, setDsSaving, setDsNote,
    setFilterPaneFormat, setTheme, setReportName, setReportWorkspaceId,
    setSensitivityLabelName, setEndorsement, setVisualRows, setDirty,
    setSaveBusy, setSaveMsg, setWorkspaces, setWsErr,
    setCreateOpen, setCreateBusy, setCreateErr, setCreateName, setCreateWsId,
    setPublishBusy, setPublishMsg, setPublishOpen, setPublishTarget, setExportMsg,
    setTables, setFieldsErr, setFieldsLoading, setLoading, setLoadErr,
    setSnapGrid, setShowGrid, setRightTab,
    setSensitivityOpen, setEndorsementOpen, setPipelineOpen, setSettingsOpen, setThemesOpen,
    setHistTick,
  });

  // ── free-form canvas helpers ───────────────────────────────────────────────
  // U1 (G3) — ON: user-resizable canvas height via the shared
  // ResizableCanvasRegion (drag grip + keyboard, persisted per surface;
  // 560 = initial px, the primitive's documented band). OFF: identity wrapper.
  const wrapCanvasRegion = (enabled: boolean) => (canvas: ReactElement): ReactElement =>
    (enabled ? (
      <ResizableCanvasRegion storageKey="report-designer-canvas" defaultPx={560}
        ariaLabel="Resize the report canvas height. Use Arrow Up and Arrow Down keys.">
        {canvas}
      </ResizableCanvasRegion>
    ) : canvas);
  const pageDimsActive = pageDims(page);
  const ffVisuals: Array<DVisual & { layout: AbsRect }> = effectiveVisuals.map((v, i) => ({
    ...v,
    layout: v.layout ?? { x: 24 + (i % 6) * 24, y: 24 + (i % 6) * 24, w: 480, h: 320, z: i },
  }));
  const elementsActive = page?.elements || [];
  const canvasNodes: FFNode[] = [
    ...ffVisuals.map((v) => ({ ...v })),
    ...elementsActive.map((e) => ({
      id: e.id, layout: e.layout, locked: e.locked, hidden: e.hidden, groupId: e.groupId, __el: e,
    })),
  ];
  const nodeCount = (page?.visuals.length || 0) + elementsActive.length;
  const canvasBg: CSSProperties = {
    ...(themeVars || {}),
    ...(page?.background?.color
      ? { backgroundColor: applyAlpha(page.background.color, page.background.transparency) }
      : {}),
  };

  // ── drill helpers ──────────────────────────────────────────────────────────
  const isDrillable = (v: DVisual): boolean =>
    (CHART_TYPES.has(v.type) || v.type === 'matrix') && (v.wells.category?.length || 0) > 1;
  const drillStateOf = (v: DVisual) =>
    drillByVisual[v.id] || { level: 0, path: [] as { table?: string; column?: string; value: string }[], expandAll: false };
  const drillDownVisual = (v: DVisual, category: string) => {
    if (!isDrillable(v)) return;
    setDrillByVisual((prev) => {
      const cats = v.wells.category || [];
      const cur = prev[v.id] || { level: 0, path: [], expandAll: false };
      if (cur.level >= cats.length - 1) return prev;
      const f = cats[cur.level];
      const step = { table: f?.table, column: f?.column, value: category };
      return { ...prev, [v.id]: { level: cur.level + 1, path: [...cur.path, step], expandAll: cur.expandAll } };
    });
  };
  const drillUpVisual = (v: DVisual) => setDrillByVisual((prev) => {
    const cur = prev[v.id];
    if (!cur || cur.level <= 0) { const n = { ...prev }; delete n[v.id]; return n; }
    return { ...prev, [v.id]: { level: cur.level - 1, path: cur.path.slice(0, -1), expandAll: cur.expandAll } };
  });
  const toggleExpandAll = (v: DVisual) => setDrillByVisual((prev) => {
    const cur = prev[v.id] || { level: 0, path: [], expandAll: false };
    return { ...prev, [v.id]: { ...cur, expandAll: !cur.expandAll } };
  });

  // ── tooltip-page hover resolver ───────────────────────────────────────────
  const resolveTooltipPage = (v: DVisual): { pageIndex: number; field: WellFieldRef } | null => {
    const cat = v.wells.category?.[0];
    if (!cat || (!cat.column && !cat.measure)) return null;
    for (let i = 0; i < pages.length; i++) {
      const tp = pages[i];
      if (!tp.tooltipPage?.enabled || !tp.tooltipPage.boundField) continue;
      const bf = tp.tooltipPage.boundField;
      const sameCol = bf.column && cat.column && bf.column.toLowerCase() === cat.column.toLowerCase();
      const sameMeasure = bf.measure && cat.measure && bf.measure.toLowerCase() === cat.measure.toLowerCase();
      if (sameCol || sameMeasure) return { pageIndex: i, field: bf };
    }
    return null;
  };

  // ── visual chrome renderer ────────────────────────────────────────────────
  const renderVisualChrome = (v: DVisual): ReactElement => {
    const fmt = v.format;
    const showTitle = fmt?.showTitle !== false;
    const titleText = (fmt?.titleText && fmt.titleText.trim()) || v.title || '(untitled)';
    const locked = !!v.locked;
    const drillable = isDrillable(v);
    const dstate = drillStateOf(v);
    const drillTargets = (selection && selection.sourceId === v.id)
      ? pages.map((tp, ti) => ({ tp, ti, seed: drillSeedFor(tp, selection) }))
          .filter((x) => x.ti !== activePage && x.seed && x.seed.length)
      : [];
    return (
      <>
        {drillable && (
          <span data-ff-nodrag className="ff-chrome-actions"
            style={{ display: 'inline-flex', gap: tokens.spacingHorizontalXXS, alignItems: 'center' }}>
            <Tooltip content="Drill up" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowExit20Regular />}
                disabled={dstate.level <= 0} aria-label="drill up"
                onClick={(e) => { e.stopPropagation(); drillUpVisual(v); }} />
            </Tooltip>
            <Tooltip content={dstate.expandAll ? 'Collapse one level' : 'Expand all down one level'} relationship="label">
              <Button size="small" appearance={dstate.expandAll ? 'primary' : 'subtle'}
                icon={<ArrowExpand20Regular />} aria-label="expand all down"
                onClick={(e) => { e.stopPropagation(); toggleExpandAll(v); }} />
            </Tooltip>
            {dstate.level > 0 && (
              <Badge appearance="tint" size="small" color="brand" data-ff-nodrag>L{dstate.level + 1}</Badge>
            )}
          </span>
        )}
        <Badge appearance="tint" size="small" data-ff-nodrag>
          {VISUALS.find((x) => x.type === v.type)?.label || v.type}
        </Badge>
        {v.groupId && (
          <Tooltip content="Select group" relationship="label">
            <Badge appearance="outline" size="small" color="brand" data-ff-nodrag
              style={{ cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); selectGroup(v.groupId as string); }}>
              Group
            </Badge>
          </Tooltip>
        )}
        {v.hidden && <Badge appearance="tint" size="small" color="warning" data-ff-nodrag>Hidden</Badge>}
        {showTitle
          ? <Text className={styles.vcardTitle} weight="semibold">{titleText}</Text>
          : <div className={styles.spacer} />}
        {drillTargets.length > 0 && (
          <span data-ff-nodrag className="ff-chrome-actions">
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Tooltip content="Drill through" relationship="label">
                  <Button size="small" appearance="subtle" icon={<ArrowExpand20Regular />}
                    aria-label="drill through" onClick={(e) => e.stopPropagation()} />
                </Tooltip>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuGroupHeader>Drill through to</MenuGroupHeader>
                  {drillTargets.map(({ tp, ti, seed }) => (
                    <MenuItem key={tp.id}
                      onClick={(e) => { e.stopPropagation(); navigateDrillthrough(ti, seed as ReportFilter[], tp.name); }}>
                      {tp.name}
                    </MenuItem>
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
          <span data-ff-nodrag className="ff-chrome-actions"
            style={{ display: 'inline-flex', gap: tokens.spacingHorizontalXXS }}>
            <Tooltip content={locked ? 'Unlock' : 'Lock'} relationship="label">
              <Button size="small" appearance="subtle"
                icon={locked ? <LockClosed20Regular /> : <LockOpen20Regular />}
                onClick={(e) => { e.stopPropagation(); setVisualFlag([v.id], { locked: !locked }); }} />
            </Tooltip>
            <Tooltip content={v.hidden ? 'Show' : 'Hide'} relationship="label">
              <Button size="small" appearance="subtle"
                icon={v.hidden ? <EyeOff20Regular /> : <Eye20Regular />}
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

  // ── visual body renderer ──────────────────────────────────────────────────
  const renderVisualBody = (v: DVisual): ReactElement => {
    const drillFilters = drill && drill.toPage === activePage ? drill.filters : [];
    const merged = [...reportFilters, ...drillFilters, ...(page?.filters || []), ...(v.filters || [])];
    const interactionMode = selection && selection.sourceId !== v.id && page
      ? resolveInteraction(
          { visuals: page.visuals, interactions: page.interactions },
          selection.sourceId, v.id)
      : 'none';
    return (
      <VisualBody visual={v} state={visualRows[v.id]} styles={styles} filters={merged}
        selection={selection} interactionMode={interactionMode}
        themeChart={themeChart} ai={aiWiring} script={scriptWiring} reportId={id}
        onExportData={reportSettings.settings.allowExport === false ? undefined : () => setExportVisual(v)}
        onSelect={(sel) => setSelection(sel)}
        onPageFilter={(f, removeId) => {
          mutatePage((p) => ({
            ...p,
            filters: [...(p.filters || []).filter((x) => x.id !== removeId), ...(f ? [f] : [])],
          }));
          const slcField = v.wells.category?.[0];
          if (slcField && (slcField.column || slcField.measure) && page) {
            const peers = syncedPeerPages(syncGroups, fieldKey(slcField), page.id);
            if (peers.length) {
              setPages((prev) => prev.map((pg) => (peers.includes(pg.id)
                ? { ...pg, filters: [...(pg.filters || []).filter((x) => x.id !== removeId), ...(f ? [{ ...f }] : [])] }
                : pg)));
              setDirty(true);
            }
          }
        }}
        onSlicerStyle={(s) => mutateVisual(v.id, (vv) => ({
          ...vv, config: { ...(vv.config || {}), slicerStyle: s },
        }))}
        onPointSelect={isDrillable(v) ? (cat) => drillDownVisual(v, cat) : undefined}
        onPointHover={(cat, coords) => {
          const tp = resolveTooltipPage(v);
          if (!tp) { if (tooltipHover && tooltipHover.visualId === v.id) setTooltipHover(null); return; }
          const px = pointerVpRef.current.x || coords.x;
          const py = pointerVpRef.current.y || coords.y;
          setTooltipHover({
            visualId: v.id, pageIndex: tp.pageIndex, field: tp.field, value: cat, x: px, y: py,
          });
        }} />
    );
  };

  // ── panels ────────────────────────────────────────────────────────────────
  const bound = isBound(dataSource);

  const leftPanel = (
    <PagesPanel
      styles={styles}
      pages={pages}
      activePage={activePage}
      onSelectPage={(i) => { setActivePage(i); setSelectedVisual(null); }}
      onAddPage={addPage}
      onRenamePage={renamePage}
      onDuplicatePage={duplicatePage}
      onHidePage={toggleHidePage}
      onDeletePage={deletePage}
    />
  );

  const main = (
    <div className={styles.canvasWrap}>
      <div className={styles.toolbar}>
        <Badge appearance="filled" color="brand">Report · Loom-native · {describeSource(dataSource)}</Badge>
        {reportName && <Subtitle2>{reportName}{page ? ` — ${page.name}` : ''}</Subtitle2>}
        <div className={styles.spacer} />
        {dirty && <Badge appearance="tint" color="warning">Unsaved</Badge>}
        <ExportMenu
          reportId={id}
          pbiEnabled={pbiPublishEnabled}
          currentPageName={page?.name}
          disabled={isNew || !page || page.visuals.length === 0}
          onServerExport={onServerExport}
          onPrint={onExportPrint}
          onPng={onExportPng}
        />
        <Button appearance="primary" icon={<Save20Regular />}
          disabled={saveBusy || (!isNew && !dirty)} onClick={save}>
          {isNew ? 'Create report' : (saveBusy ? 'Saving…' : 'Save')}
        </Button>
      </div>

      {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
      {saveMsg && (
        <MessageBar intent={saveMsg.ok ? 'success' : 'error'}>
          <MessageBarBody>{saveMsg.text}</MessageBarBody>
        </MessageBar>
      )}
      {dsNote && (
        <MessageBar intent={dsNote.ok ? 'success' : 'warning'}>
          <MessageBarBody>{dsNote.text}</MessageBarBody>
        </MessageBar>
      )}
      {exportMsg && (
        <MessageBar intent={exportMsg.ok ? 'success' : 'warning'}>
          <MessageBarBody>{exportMsg.text}</MessageBarBody>
        </MessageBar>
      )}
      {personalize.active && (
        <PersonalizeBanner count={personalize.count}
          onResetAll={personalize.resetAll} onExit={() => personalize.setActive(false)} />
      )}
      {!bound && !loading && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Choose a data source</MessageBarTitle>
            This report isn&apos;t bound to data yet. Click <strong>Data source</strong> to bind a
            Loom <strong>semantic model</strong> (Azure-native — Synapse / lakehouse, no Power BI or
            Fabric required), build from a SQL query, or bind an Azure Analysis Services tabular model.
            You can lay out pages and visuals now; they render once a source is bound.
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="primary" icon={<Database20Regular />}
              onClick={() => setDsOpen(true)}>Data source</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading report…" />}

      {drill && drill.toPage === activePage && (
        <div className={styles.backBar}>
          <Button size="small" appearance="primary" icon={<ArrowExit20Regular />}
            onClick={exitDrillthrough}>Back</Button>
          <Caption1>
            Drilled through{drill.label ? ` to ${drill.label}` : ''} — this page is filtered.
          </Caption1>
        </div>
      )}

      {!loading && !personalize.active && page && nodeCount > 0 && arrangeTargets().length > 0 && (
        <ArrangeBar
          styles={styles}
          targets={arrangeTargets()}
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
        <div className={styles.guidedEmpty} role="region" aria-label="Design your first visual">
          <Subtitle2>Design your first visual</Subtitle2>
          <div className={styles.guidedSteps}>
            <button type="button" className={styles.guidedStep} onClick={() => setDsOpen(true)}
              aria-label="Step 1 — add data">
              <span className={styles.guidedStepIcon} aria-hidden><Database20Regular /></span>
              <span className={styles.guidedStepHead}>
                <span className={styles.guidedStepNum} aria-hidden>1</span>
                <Text weight="semibold">Add data</Text>
              </span>
              <Caption1 className={styles.muted}>
                {bound ? `Bound — ${describeSource(dataSource)}` : 'Bind a semantic model, SQL query, or AAS model.'}
              </Caption1>
            </button>
            <span className={styles.guidedArrow} aria-hidden><ArrowRight20Regular /></span>
            <button type="button" className={styles.guidedStep} onClick={() => setRightTab('build')}
              aria-label="Step 2 — pick a visual">
              <span className={styles.guidedStepIcon} aria-hidden><DataBarVertical20Regular /></span>
              <span className={styles.guidedStepHead}>
                <span className={styles.guidedStepNum} aria-hidden>2</span>
                <Text weight="semibold">Pick a visual</Text>
              </span>
              <Caption1 className={styles.muted}>
                Choose from 25+ chart, table, map, and AI visuals in the Build pane.
              </Caption1>
            </button>
            <span className={styles.guidedArrow} aria-hidden><ArrowRight20Regular /></span>
            <button type="button" className={styles.guidedStep} onClick={() => setRightTab('build')}
              aria-label="Step 3 — drag fields">
              <span className={styles.guidedStepIcon} aria-hidden><Table20Regular /></span>
              <span className={styles.guidedStepHead}>
                <span className={styles.guidedStepNum} aria-hidden>3</span>
                <Text weight="semibold">Drag fields</Text>
              </span>
              <Caption1 className={styles.muted}>
                Drop model fields into the wells — every visual renders live.
              </Caption1>
            </button>
          </div>
          <Caption1 className={styles.guidedBody}>
            Insert text boxes, shapes, images, buttons, and navigators from the Elements gallery.
          </Caption1>
        </div>
      )}

      {/* U1 (G3): flag ON = resizable canvas height (loom.canvasHeight.
          report-designer-canvas); the absolute page tolerates variable height —
          FreeFormCanvas fit-zoom rescales off its viewport ResizeObserver
          (free-form-canvas-variable-height.test.tsx). OFF = pre-U1 layout. */}
      {!loading && page && nodeCount > 0 && wrapCanvasRegion(g3CanvasResize)(
        <div ref={gridRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <FreeFormCanvas<FFNode>
            fitParent={g3CanvasResize}
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
            onDelete={removeNodes}
            onZStep={reorderZStepUnion}
            dragBody={(n) => !!(n as { __el?: unknown }).__el}
            renderChrome={(n) =>
              ((n as { __el?: CanvasElement }).__el
                ? renderElementChrome((n as { __el: CanvasElement }).__el, elemCtx)
                : renderVisualChrome(n as unknown as DVisual))
            }
            renderVisual={(n) =>
              ((n as { __el?: CanvasElement }).__el
                ? renderElement((n as { __el: CanvasElement }).__el, elemCtx)
                : renderVisualBody(n as unknown as DVisual))
            }
            frameStyle={(n) => {
              if ((n as { __el?: unknown }).__el) return {};
              const v = n as unknown as DVisual;
              const s: CSSProperties = {};
              if (v.format?.background?.color)
                s.backgroundColor = applyAlpha(v.format.background.color, v.format.background.transparency);
              if (v.format?.border?.show) {
                s.border = `1px solid ${v.format.border.color || tokens.colorNeutralStroke1}`;
                if (v.format.border.radius != null) s.borderRadius = v.format.border.radius;
              }
              if (v.format?.shadow?.show) s.boxShadow = tokens.shadow16;
              return s;
            }}
          />
        </div>
      )}

      {!loading && pages.length > 0 && (
        <div className={styles.pageTabStrip} role="tablist" aria-label="Report pages">
          {pages.map((p, i) => (
            <button key={p.id} type="button" role="tab" aria-selected={i === activePage}
              className={mergeClasses(styles.pageTab, i === activePage && styles.pageTabActive)}
              onClick={() => { setActivePage(i); setSelectedVisual(null); }}>
              {p.hidden && <EyeOff16Regular aria-hidden />}
              <Caption1 className={styles.pageTabName}>{p.name}</Caption1>
            </button>
          ))}
          <Tooltip content="New page" relationship="label">
            <Button size="small" appearance="subtle" icon={<Add20Regular />}
              onClick={addPage} aria-label="New page" />
          </Tooltip>
        </div>
      )}

      {tooltipHover && (() => {
        const tp = pages[tooltipHover.pageIndex];
        if (!tp) return null;
        const f = tooltipHover.field;
        const seed: ReportFilterInput = {
          table: f.table, column: f.column, measure: f.measure, op: 'eq', value: tooltipHover.value,
        };
        const CW = 320, CH = 360, GAP = 16, PAD = 8;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        let left = tooltipHover.x + GAP;
        if (left + CW + PAD > vw) left = tooltipHover.x - CW - GAP;
        left = Math.max(PAD, Math.min(left, vw - CW - PAD));
        let top = tooltipHover.y + GAP;
        if (top + CH + PAD > vh) top = tooltipHover.y - CH - GAP;
        top = Math.max(PAD, Math.min(top, vh - CH - PAD));
        return (
          <div role="tooltip" style={{
            position: 'fixed', left, top, width: CW, maxHeight: CH, overflow: 'auto',
            zIndex: 1000, pointerEvents: 'auto',
            background: tokens.colorNeutralBackground1,
            border: `1px solid ${tokens.colorNeutralStroke1}`,
            borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow28,
            padding: tokens.spacingVerticalM,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXS }}>
              <Badge appearance="tint" color="brand" size="small">Tooltip</Badge>
              <Caption1 style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tp.name} · {f.measure || f.column} = {tooltipHover.value}
              </Caption1>
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
                aria-label="close tooltip" onClick={() => setTooltipHover(null)} />
            </div>
            <TooltipPageContent visuals={tp.visuals} seed={seed} queryAdHoc={queryAdHoc}
              styles={styles} themeChart={themeChart} reportId={id} />
          </div>
        );
      })()}
    </div>
  );

  // ── right panel ───────────────────────────────────────────────────────────
  const sizes = [
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
        <Tab value="syncSlicers" icon={<Filter20Regular />}>Sync slicers</Tab>
        <Tab value="whatIf" icon={<DataTrending20Regular />}>What-if</Tab>
        <Tab value="performance" icon={<Settings20Regular />}>Performance</Tab>
        <Tab value="copilot" icon={<Sparkle20Regular />}>Copilot</Tab>
        <Tab value="ask" icon={<Sparkle20Regular />}>Ask</Tab>
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
            visuals: p.visuals.map((v) =>
              (zById[v.id] !== undefined
                ? { ...v, z: zById[v.id], layout: v.layout ? { ...v.layout, z: zById[v.id] } : v.layout }
                : v)),
          }))}
          onGroup={(ids) => groupVisuals(ids)}
          onUngroup={(gid) => {
            const ids = (pages[activePage]?.visuals || [])
              .filter((v) => v.groupId === gid).map((v) => v.id);
            ungroupVisuals(ids);
          }}
        />
      )}
      {rightTab === 'syncSlicers' && (
        <SyncSlicersPane
          pages={pages.map((p) => ({ id: p.id, name: p.name }))}
          fields={(() => {
            const seen = new Map<string, { key: string; label: string; pageIds: string[] }>();
            pages.forEach((p) => p.visuals.forEach((v) => {
              if (v.type !== 'slicer') return;
              const f = v.wells.category?.[0];
              if (!f || (!f.column && !f.measure)) return;
              const k = fieldKey(f);
              const ex = seen.get(k);
              if (ex) { if (!ex.pageIds.includes(p.id)) ex.pageIds.push(p.id); }
              else seen.set(k, { key: k, label: fieldLabel(f), pageIds: [p.id] });
            }));
            return [...seen.values()];
          })()}
          groups={syncGroups}
          onChange={(g) => { setSyncGroups(g); setDirty(true); }}
        />
      )}
      {rightTab === 'whatIf' && (
        <WhatIfPane
          whatIfs={whatIfs}
          fieldParams={fieldParams}
          fields={fieldOptions(tables)}
          aggregateAliases={Array.from(new Set(
            (page?.visuals || []).flatMap((v) => (v.wells.values || []).map(wellResultAlias)),
          ))}
          onChangeWhatIfs={(l) => { setWhatIfs(l); setDirty(true); }}
          onChangeFieldParams={(l) => { setFieldParams(l); setDirty(true); }}
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
      {rightTab === 'ask' && (
        <div style={{ padding: tokens.spacingHorizontalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
          <AskAffordance
            surfaceKind="report"
            itemId={id}
            itemType="report"
            context={{ tables: tables.map((t) => t.name) }}
            alwaysOpen
          />
        </div>
      )}
      {rightTab === 'format' && (
        selected ? (
          <FormatPane
            visualType={selected.type}
            format={selected.format}
            condFields={fieldOptions(tables)}
            valueColumns={Object.keys(visualRows[selected.id]?.rows?.[0] ?? {})}
            onChange={(f) => mutateVisual(selected.id, (v) => ({ ...v, format: f }))}
          />
        ) : (
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
          filterPaneFormat={filterPaneFormat}
          onFilterPaneFormat={(next) => { setFilterPaneFormat(next); setDirty(true); }}
          drillthroughFilters={drill && drill.toPage === activePage ? drill.filters : null}
          onClearDrillthrough={(fid) => setDrill((d) => (
            d && d.toPage === activePage ? { ...d, filters: d.filters.filter((f) => f.id !== fid) } : d
          ))}
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
      {rightTab === 'performance' && (
        <PerformanceAnalyzer perf={perf}
          onRefreshVisuals={() => effectiveVisuals.forEach(
            (v) => runVisual(v, [...reportFilters, ...(page?.filters || [])]))} />
      )}
      {rightTab === 'build' && (
        <>
          <PaneSection styles={styles} icon={<DataBarVertical20Regular />} label="Visualizations">
            {GALLERY_CATS.map((cat) => {
              const tiles = VISUALS.filter((vt) => vt.group !== 'ai' && vt.cat === cat.key);
              if (tiles.length === 0) return null;
              return (
                <div key={cat.key} className={styles.galleryCat}>
                  <div className={styles.galleryCatHead}>
                    <span className={styles.galleryCatDot}
                      style={{ backgroundColor: cat.accent }} aria-hidden />
                    <Caption1 className={styles.galleryCatLabel}>{cat.label}</Caption1>
                  </div>
                  <div className={styles.gallery} role="group" aria-label={cat.label}>
                    {tiles.map((vt) => {
                      const seed = (vt as { seed?: { language: string } }).seed;
                      const active = selected?.type === vt.type
                        && (!seed || ((selected?.config?.language as string) || 'python') === seed.language);
                      const key = seed ? `${vt.type}:${seed.language}` : vt.type;
                      return (
                        <Tooltip key={key}
                          content={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`}
                          relationship="label">
                          <button type="button"
                            aria-label={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`}
                            aria-pressed={active}
                            className={mergeClasses(styles.galleryBtn, active && styles.galleryBtnActive)}
                            onClick={() => (selected
                              ? mutateVisual(selected.id, (v) => ({
                                  ...v, type: vt.type,
                                  ...(seed ? { config: { ...(v.config || {}), language: seed.language as 'python' | 'r', script: (v.config?.script as string) ?? '' } } : {}),
                                }))
                              : addVisual(vt.type, seed as { language: 'python' | 'r' } | undefined))}>
                            <span
                              className={mergeClasses(styles.galleryIcon, active && styles.galleryIconActive)}
                              style={active ? undefined : { color: cat.accent }}
                              aria-hidden>{vt.icon}</span>
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </PaneSection>

          <PaneSection styles={styles} icon={<Sparkle20Regular />} label="AI visuals">
            <div className={styles.gallery}>
              {VISUALS.filter((vt) => vt.group === 'ai').map((vt) => (
                <Tooltip key={vt.type}
                  content={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`}
                  relationship="label">
                  <button type="button"
                    aria-label={selected ? `Change to ${vt.label}` : `Add a ${vt.label}`}
                    aria-pressed={selected?.type === vt.type}
                    className={mergeClasses(styles.galleryBtn, selected?.type === vt.type && styles.galleryBtnActive)}
                    onClick={() => (selected
                      ? mutateVisual(selected.id, (v) => ({ ...v, type: vt.type }))
                      : addVisual(vt.type))}>
                    <span
                      className={mergeClasses(styles.galleryIcon, selected?.type === vt.type && styles.galleryIconActive)}
                      aria-hidden>{vt.icon}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          </PaneSection>

          <PaneSection styles={styles} icon={<Add20Regular />} label="Elements">
            <ElementsGallery onInsert={addElement} />
          </PaneSection>

          {!selected && !selectedElement && (
            <Caption1 className={styles.muted}>
              Select a visual on the canvas, or click above to add one, then assign fields.
              Add text boxes, shapes, images, buttons, and navigators from Elements.
            </Caption1>
          )}

          {selectedElement && (
            <ElementProperties
              element={selectedElement}
              ctx={elemCtx}
              tables={tables}
              pages={pages.map((p, i) => ({ id: p.id, name: p.name, index: i, hidden: !!p.hidden }))}
              bookmarks={bookmarks}
              reportId={id}
              resolveToken={resolveToken}
              onChange={(next: CanvasElement | ((e: CanvasElement) => CanvasElement)) =>
                mutateElement(selectedElement.id,
                  (e) => (typeof next === 'function' ? (next as (x: CanvasElement) => CanvasElement)(e) : next))}
              onRemove={() => removeElement(selectedElement.id)}
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
                    const active = selected.layout
                      ? Math.abs(selected.layout.w - targetW) <= 4
                      : (selected as { w?: number }).w === s.w;
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
                <WellEditor key={w.name} visual={selected} well={w.name} label={w.label}
                  tables={tables} styles={styles}
                  onAdd={(well, f) => addToWell(selected.id, well, f)}
                  onRemove={(well, fuid) => removeFromWell(selected.id, well, fuid)}
                  onAgg={(well, fuid, agg) => setAgg(selected.id, well, fuid, agg)}
                  onDrop={(well, f) => addToWell(selected.id, well, f)} />
              ))}
            </>
          )}

          <div className={styles.wellHead}>
            <span className={styles.paneSectionIcon} aria-hidden><Table20Regular /></span>
            <Subtitle2>Fields</Subtitle2>
            <div className={styles.spacer} />
            <Tooltip content="Reload model fields" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />}
                onClick={loadFields} />
            </Tooltip>
          </div>
          <Divider />
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
                        <TreeItemLayout iconBefore={
                          <span className={styles.tokenTypeMeasure} style={{ display: 'inline-flex' }}>
                            <MathFormula16Regular />
                          </span>}>
                          <span className={styles.chip} draggable
                            onDragStart={(e) =>
                              e.dataTransfer.setData('application/json',
                                JSON.stringify({ measure: m.name }))}>
                            {m.name}
                          </span>
                        </TreeItemLayout>
                      </TreeItem>
                    ))}
                    {t.columns.map((c) => (
                      <TreeItem key={`c:${c.name}`} itemType="leaf" value={`c:${t.name}.${c.name}`}>
                        <TreeItemLayout iconBefore={
                          <span className={styles.tokenType} style={{ display: 'inline-flex' }}>
                            {dataTypeGlyph(c.dataType)}
                          </span>}>
                          <span className={styles.chip} draggable
                            onDragStart={(e) =>
                              e.dataTransfer.setData('application/json',
                                JSON.stringify({ table: t.name, column: c.name }))}>
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
            <Caption1 className={styles.muted}>
              No model fields. Bind a data source (ribbon → Data source) to populate the Fields tree.
            </Caption1>
          )}
        </>
      )}
    </div>
  );

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <>
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} dirty={dirty}
        splitKeyPrefix="report-designer" collabPresence
        leftPanel={leftPanel} main={main} rightPanel={rightPanel} rightPanelLabel="Build" />

      <DataSourcePicker
        open={dsOpen}
        reportId={id}
        workspaceId={reportWorkspaceId}
        value={dataSource}
        onChange={applyDataSource}
        onDismiss={() => setDsOpen(false)}
        saving={dsSaving}
      />

      {/* Create-report dialog (isNew flow) */}
      <Dialog open={createOpen} onOpenChange={(_e, d) => { if (!createBusy) setCreateOpen(d.open); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Create report</DialogTitle>
            <DialogContent>
              <div className={styles.section}>
                <Caption1 className={styles.muted}>
                  Saves this report so its full Save / Publish / data-source actions run against a real item.
                  Your current pages, visuals, filters{isBound(dataSource) ? ', and data source' : ''} are carried over.
                </Caption1>
                {wsErr && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Workspaces not reachable</MessageBarTitle>{wsErr}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {workspaces !== null && workspaces.length === 0 && !wsErr && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>No workspaces yet</MessageBarTitle>
                      Create a workspace first, then return to create this report.
                    </MessageBarBody>
                  </MessageBar>
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
                <div className={styles.section}>
                  <Subtitle2>Data source (optional)</Subtitle2>
                  <Caption1 className={styles.muted}>
                    Wire a Loom item as this report&apos;s source now — or set it later from the Data source panel.
                    {isBound(dataSource) ? ` Current: ${describeSource(dataSource)}.` : ''}
                  </Caption1>
                  <LoomItemSourcePicker
                    purpose="report"
                    workspaceId={createWsId}
                    onResolved={(res) => { setDataSource(res.dataSource ?? null); setDirty(true); }}
                    onCleared={() => setDataSource(null)}
                  />
                </div>
                {createErr && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Create failed</MessageBarTitle>{createErr}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={createBusy}
                onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance="primary" icon={createBusy ? <Spinner size="tiny" /> : <Save20Regular />}
                disabled={createBusy || !createWsId} onClick={createNewReport}>
                {createBusy ? 'Creating…' : 'Create report'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Publish dialog */}
      <Dialog open={publishOpen} onOpenChange={(_e, d) => setPublishOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Publish report</DialogTitle>
            <DialogContent>
              <div className={styles.section}>
                <Caption1 className={styles.muted}>
                  Publish a snapshot so colleagues can view it. The default is the Azure-native
                  Organization gallery — no Power BI or Fabric required.
                </Caption1>
                <Field label="Target">
                  <RadioGroup value={publishTarget}
                    onChange={(_e, d) => setPublishTarget(d.value as 'org' | 'powerbi')}>
                    <Radio value="org" label="Organization gallery (Azure-native, default)" />
                    <Radio value="powerbi" disabled={!pbiPublishEnabled}
                      label={pbiPublishEnabled
                        ? 'Power BI workspace (opt-in)'
                        : 'Power BI workspace — enable Power BI backend in Admin → Runtime configuration'} />
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
              <Button appearance="primary"
                icon={publishBusy ? <Spinner size="tiny" /> : <CloudArrowUp20Regular />}
                disabled={publishBusy} onClick={doPublish}>
                {publishBusy ? 'Publishing…' : 'Publish'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Themes dialog */}
      <Dialog open={themesOpen} onOpenChange={(_e, d) => setThemesOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Report theme</DialogTitle>
            <DialogContent>
              <ThemesPane theme={theme ?? null}
                onChange={(t) => { setTheme(t ?? undefined); setDirty(true); }} />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setThemesOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <SensitivityLabelDialog open={sensitivityOpen} onClose={() => setSensitivityOpen(false)}
        reportId={id} appliedName={sensitivityLabelName}
        onApplied={(n) => setSensitivityLabelName(n)} />
      <EndorsementDialog open={endorsementOpen} onClose={() => setEndorsementOpen(false)}
        reportId={id} value={endorsement} onChange={(e) => setEndorsement(e)} />
      <DeployToPipelineDialog open={pipelineOpen} onClose={() => setPipelineOpen(false)} reportId={id} />
      <ReportSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)}
        settings={reportSettings.settings} onChange={reportSettings.setSettings} reportId={id} />
      {exportVisual && (
        <VisualExportDataDialog
          reportId={id}
          visual={exportVisual as unknown as ExportVisualShape}
          filters={[...reportFilters, ...(page?.filters || [])]}
          dataSource={dataSource}
          onClose={() => setExportVisual(null)} />
      )}
    </>
  );
}
