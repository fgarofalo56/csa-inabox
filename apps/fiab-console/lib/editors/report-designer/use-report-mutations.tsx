'use client';

// use-report-mutations.tsx — All IO, mutation, and ribbon callbacks extracted from
// ReportDesigner. The shell wires state in → callbacks + derived-values out.

import {
  useCallback, useEffect, useMemo,
  type Dispatch, type SetStateAction, type MutableRefObject, type RefObject,
} from 'react';
import {
  Save20Regular, ArrowSync20Regular, ArrowUndo20Regular, ArrowRedo20Regular,
  Database20Regular, CloudArrowUp20Regular, Shield20Regular, Ribbon20Regular,
  Branch20Regular, Add20Regular, ColorRegular, GridDots20Regular, Grid20Regular,
  Settings20Regular, Edit20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { RibbonTab } from '@/lib/components/ribbon';

import {
  pageDims,
  type DPage, type DVisual, type WellName, type WellField, type Wells,
  type CanvasType, type VisualState, type FieldTable, type AiVisualWiring,
  type RightTab, type Agg, type WellFieldRef, type VisualType,
} from './types';
import { uid, fieldKey, parseFieldRef, queryVisual, wireWells, hasBinding } from './helpers';
import { COMPACT_TYPES, VISUALS, AI_SELF_QUERY, AI_TYPES } from './constants';

import {
  reFilters, wireFilters, parseFilterPaneFormat, wireFilterPaneFormat,
  type ReportFilter, type FilterPaneFormat,
} from '../report/filters-pane';
import { parseInteractions, wireInteractions, type VisualSelection } from '../report/interactions';
import { parseAnalytics } from '../report/analytics-pane';
import {
  parseElements, wireElements, newElement, tokenToSpec,
  type CanvasElement, type ElementKind, type FieldToken, type ButtonAction,
} from '../report/canvas-elements';
import {
  parseBookmarks, wireBookmarks,
  captureBookmark as captureBookmarkState,
  applyBookmark as bookmarkToPatch,
  newBookmark,
  type ReportBookmark, type BookmarkScope, type BookmarkApply, type BookmarkCaptureSource,
} from '../report/bookmarks-pane';
import {
  migrateFlowToAbsolute, absAlign, absDistribute,
  reorderZ as absReorderZ, reorderZStep as absReorderZStep, defaultElementLayout,
  type AbsRect, type AlignEdge, type DistributeAxis,
} from '../report/use-canvas-layout';
import { parseSyncGroups, wireSyncGroups, type SyncGroup } from '../report/sync-slicers';
import {
  parseWhatIfParams, wireWhatIfParams, parseFieldParameters, wireFieldParameters,
  whatIfBindings, activeField, type WhatIfParam, type FieldParameter,
} from '../report/what-if-pane';
import {
  type ReportDataSource, isBound, describeSource, parseDataSource, fromLegacyState,
} from '../report/report-data-source';
import { sanitizeTheme, type ReportTheme } from '../report/themes';
import { slicerFilterId, type SlicerStyle } from '../report/slicer-visual';
import {
  buildReportPrintHtml, printReport, pngOfElement, downloadBlobObject, slugify,
  type ExportFormat, type ExportScope, type PrintPage,
} from '../report/export-report';
import type { CopilotVisualSpec, CopilotWellField } from '@/lib/components/report/report-powerbi-copilot';
import type { ReportFilterInput } from '@/lib/azure/wells-to-sql';
import type { SmartNarrativeVisualRows } from '../report/ai-visuals/smart-narrative';
import type { Endorsement } from '../report/endorsement';
import type { ReportVisualFormat } from '../report/format-pane';
import type { ReportSettingsHandle } from '../report/report-settings';

// ── Local type aliases ────────────────────────────────────────────────────────

type DrillContext = { fromPage: number; toPage: number; filters: ReportFilter[]; label: string };
type DrillByVisualEntry = { level: number; path: { table?: string; column?: string; value: string }[]; expandAll?: boolean };
type TooltipHoverEntry = { visualId: string; pageIndex: number; field: WellFieldRef; value: string; x: number; y: number };
export type HistSnap = { pages: DPage[]; reportFilters: ReportFilter[]; bookmarks: ReportBookmark[] };

interface PerfHandle {
  recording: boolean;
  record: (id: string, data: { title: string; serverMs: number; rowCount: number; clientMs: number; sql?: string }) => void;
}
interface PersonalizeHandle {
  active: boolean;
  toggleActive: () => void;
}

export interface UseReportMutationsConfig {
  id: string;
  isNew: boolean;
  router: { push: (url: string) => void };
  // state values
  pages: DPage[];
  activePage: number;
  selectedVisual: string | null;
  selectedVisualIds: Set<string>;
  reportFilters: ReportFilter[];
  bookmarks: ReportBookmark[];
  syncGroups: SyncGroup[];
  whatIfs: WhatIfParam[];
  fieldParams: FieldParameter[];
  drillByVisual: Record<string, DrillByVisualEntry>;
  selection: VisualSelection | null;
  drill: DrillContext | null;
  dataSource: ReportDataSource | null;
  filterPaneFormat: FilterPaneFormat | null;
  theme: ReportTheme | undefined;
  page: DPage | undefined;
  reportName: string;
  workspaces: { id: string; name: string }[] | null;
  createOpen: boolean;
  createName: string;
  createWsId: string;
  publishTarget: 'org' | 'powerbi';
  endorsement: Endorsement | null;
  sensitivityLabelName: string;
  visualRows: Record<string, VisualState>;
  effectiveVisuals: DVisual[];
  dirty: boolean;
  saveBusy: boolean;
  snapGrid: boolean;
  showGrid: boolean;
  tables: FieldTable[];
  canUndo: boolean;
  canRedo: boolean;
  personalize: PersonalizeHandle;
  perf: PerfHandle;
  reportSettings: ReportSettingsHandle;
  // refs
  historyRef: MutableRefObject<{ past: HistSnap[]; future: HistSnap[] }>;
  prevSnapRef: MutableRefObject<HistSnap | null>;
  restoringRef: MutableRefObject<boolean>;
  drillByVisualRef: MutableRefObject<Record<string, DrillByVisualEntry>>;
  whatIfsRef: MutableRefObject<WhatIfParam[]>;
  personalizeActiveRef: MutableRefObject<boolean>;
  gridRef: RefObject<HTMLDivElement | null>;
  // setters
  setPages: Dispatch<SetStateAction<DPage[]>>;
  setActivePage: Dispatch<SetStateAction<number>>;
  setSelectedVisual: Dispatch<SetStateAction<string | null>>;
  setSelectedVisualIds: Dispatch<SetStateAction<Set<string>>>;
  setReportFilters: Dispatch<SetStateAction<ReportFilter[]>>;
  setBookmarks: Dispatch<SetStateAction<ReportBookmark[]>>;
  setSyncGroups: Dispatch<SetStateAction<SyncGroup[]>>;
  setWhatIfs: Dispatch<SetStateAction<WhatIfParam[]>>;
  setFieldParams: Dispatch<SetStateAction<FieldParameter[]>>;
  setDrillByVisual: Dispatch<SetStateAction<Record<string, DrillByVisualEntry>>>;
  setTooltipHover: Dispatch<SetStateAction<TooltipHoverEntry | null>>;
  setSelection: Dispatch<SetStateAction<VisualSelection | null>>;
  setDrill: Dispatch<SetStateAction<DrillContext | null>>;
  setDataSource: Dispatch<SetStateAction<ReportDataSource | null>>;
  setDsOpen: Dispatch<SetStateAction<boolean>>;
  setDsSaving: Dispatch<SetStateAction<boolean>>;
  setDsNote: Dispatch<SetStateAction<{ ok: boolean; text: string } | null>>;
  setFilterPaneFormat: Dispatch<SetStateAction<FilterPaneFormat | null>>;
  setTheme: Dispatch<SetStateAction<ReportTheme | undefined>>;
  setReportName: Dispatch<SetStateAction<string>>;
  setReportWorkspaceId: Dispatch<SetStateAction<string>>;
  setSensitivityLabelName: Dispatch<SetStateAction<string>>;
  setEndorsement: Dispatch<SetStateAction<Endorsement | null>>;
  setVisualRows: Dispatch<SetStateAction<Record<string, VisualState>>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setSaveBusy: Dispatch<SetStateAction<boolean>>;
  setSaveMsg: Dispatch<SetStateAction<{ ok: boolean; text: string } | null>>;
  setWorkspaces: Dispatch<SetStateAction<{ id: string; name: string }[] | null>>;
  setWsErr: Dispatch<SetStateAction<string | null>>;
  setCreateOpen: Dispatch<SetStateAction<boolean>>;
  setCreateBusy: Dispatch<SetStateAction<boolean>>;
  setCreateErr: Dispatch<SetStateAction<string | null>>;
  setCreateName: Dispatch<SetStateAction<string>>;
  setCreateWsId: Dispatch<SetStateAction<string>>;
  setPublishBusy: Dispatch<SetStateAction<boolean>>;
  setPublishMsg: Dispatch<SetStateAction<{ ok: boolean; text: string } | null>>;
  setPublishOpen: Dispatch<SetStateAction<boolean>>;
  setPublishTarget: Dispatch<SetStateAction<'org' | 'powerbi'>>;
  setExportMsg: Dispatch<SetStateAction<{ ok: boolean; text: string } | null>>;
  setTables: Dispatch<SetStateAction<FieldTable[]>>;
  setFieldsErr: Dispatch<SetStateAction<string | null>>;
  setFieldsLoading: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setLoadErr: Dispatch<SetStateAction<string | null>>;
  setSnapGrid: Dispatch<SetStateAction<boolean>>;
  setShowGrid: Dispatch<SetStateAction<boolean>>;
  setRightTab: Dispatch<SetStateAction<RightTab>>;
  setSensitivityOpen: Dispatch<SetStateAction<boolean>>;
  setEndorsementOpen: Dispatch<SetStateAction<boolean>>;
  setPipelineOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setThemesOpen: Dispatch<SetStateAction<boolean>>;
  setHistTick: Dispatch<SetStateAction<number>>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useReportMutations({
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
}: UseReportMutationsConfig) {

  // ── load definition ──────────────────────────────────────────────────────
  const loadDetail = useCallback(async () => {
    if (id === 'new') {
      setPages([{ id: uid('p'), name: 'Page 1', visuals: [] }]);
      setActivePage(0); setReportName(''); setDataSource(null); setReportFilters([]);
      setBookmarks([]); setDrill(null); setSelectedVisualIds(new Set()); setFilterPaneFormat(null);
      setTheme(undefined);
      setSensitivityLabelName(''); setEndorsement(null); reportSettings.setSettings({});
      historyRef.current = { past: [], future: [] }; prevSnapRef.current = null; restoringRef.current = false;
      setDirty(false); setLoadErr(null); setLoading(false);
      return;
    }
    setLoading(true); setLoadErr(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      if (j.workspaceId && j.workspaceId !== '_loom') setReportWorkspaceId(j.workspaceId);
      setReportName(j.report?.name || '');

      let ds: ReportDataSource | null = null;
      try {
        const dr = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/data-source`);
        if (dr.ok) { const dj = await dr.json(); if (dj?.ok) ds = parseDataSource(dj.dataSource); }
      } catch { /* fall through to legacy */ }
      if (!ds) ds = fromLegacyState({ aasServer: j.aasServer ?? undefined, aasDatabase: j.aasDatabase ?? undefined });
      setDataSource(ds);
      setReportFilters(reFilters(j.reportFilters));
      setBookmarks(parseBookmarks(j.bookmarks));
      setTheme(sanitizeTheme(j.theme));
      { const fpf = parseFilterPaneFormat(j.filterPaneFormat); setFilterPaneFormat(Object.keys(fpf).length ? fpf : null); }
      setSyncGroups(parseSyncGroups(j.syncSlicers));
      setWhatIfs(parseWhatIfParams(j.whatIfParams));
      setFieldParams(parseFieldParameters(j.fieldParameters));
      setSensitivityLabelName(typeof j.sensitivityLabel === 'string' ? j.sensitivityLabel : '');
      setEndorsement(j.endorsement === 'Promoted' || j.endorsement === 'Certified' ? j.endorsement : null);
      reportSettings.setSettings(j.settings && typeof j.settings === 'object' ? j.settings : {});
      setDrillByVisual({}); setTooltipHover(null);
      setDrill(null); setSelectedVisualIds(new Set());
      historyRef.current = { past: [], future: [] }; prevSnapRef.current = null; restoringRef.current = false;

      const dpages: DPage[] = (j.pages || []).map((p: any, pi: number): DPage => {
        const pc = p.config || {};
        return {
          id: uid('p'),
          name: p.displayName || p.name || `Page ${pi + 1}`,
          filters: reFilters(p.filters),
          hidden: !!pc.hidden,
          interactions: parseInteractions(pc.interactions),
          canvasType: typeof pc.type === 'string' ? (pc.type as CanvasType) : undefined,
          background: pc.background && typeof pc.background === 'object' ? pc.background : undefined,
          size: pc.size && typeof pc.size === 'object' ? pc.size : undefined,
          drillthrough: pc.drillthrough && Array.isArray(pc.drillthrough.fields)
            ? { fields: (pc.drillthrough.fields as any[]).map((f) => ({ table: f?.table, column: f?.column, measure: f?.measure })).filter((f: any) => f.column || f.measure) }
            : undefined,
          tooltipPage: pc.tooltipPage && typeof pc.tooltipPage === 'object'
            ? { enabled: !!pc.tooltipPage.enabled, boundField: pc.tooltipPage.boundField || undefined }
            : undefined,
          elements: parseElements(p.elements),
          visuals: (p.visuals || []).map((v: any): DVisual => {
            const cfgWells = v.config?.wells;
            const reUid = (a: any): WellField[] => (Array.isArray(a) ? a : []).map((f: any) => ({ uid: uid('f'), ...f }));
            let wells: Wells;
            if (cfgWells) {
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
              const parsed = parseFieldRef(v.field);
              const into: WellName = parsed?.measure ? 'values' : 'category';
              wells = { category: [], values: [], legend: [] };
              if (parsed) wells[into] = [parsed.measure ? parsed : { ...parsed, aggregation: undefined }];
            }
            const lay = v.config?.layout;
            const isAbs = lay && (lay.unit === 'px' || Number(lay.w) > 12 || Number(lay.h) > 24);
            return {
              id: uid('v'),
              type: (v.type as VisualType) || 'table',
              title: v.title || '',
              wells,
              w: Math.min(12, Math.max(1, Number(v.config?.layout?.w) || 6)),
              h: Math.max(1, Number(v.config?.layout?.h) || 4),
              layout: isAbs
                ? { x: Math.max(0, Number(lay.x) || 0), y: Math.max(0, Number(lay.y) || 0), w: Math.max(1, Number(lay.w) || 200), h: Math.max(1, Number(lay.h) || 160), z: Number.isFinite(Number(lay.z)) ? Number(lay.z) : undefined }
                : undefined,
              format: (v.config?.format as ReportVisualFormat | undefined) || undefined,
              analytics: parseAnalytics(v.config?.analytics),
              filters: reFilters(v.config?.filters),
              hidden: v.config?.hidden === true || v.config?.layout?.hidden === true,
              locked: v.config?.locked === true || v.config?.layout?.locked === true,
              z: Number.isFinite(Number(v.config?.layout?.z)) ? Number(v.config.layout.z) : undefined,
              groupId: typeof v.config?.groupId === 'string' ? v.config.groupId : undefined,
              config: ((v.type as VisualType) === 'scriptVisual')
                ? { language: v.config?.language === 'r' ? 'r' : 'python', script: typeof v.config?.script === 'string' ? v.config.script : '' }
                : ((v.type as VisualType) === 'slicer' && typeof v.config?.slicerStyle === 'string')
                  ? { slicerStyle: v.config.slicerStyle as SlicerStyle }
                  : undefined,
            };
          }),
        };
      });
      const migrated = dpages.map((p) => {
        if (!p.visuals.length || p.visuals.every((v) => v.layout)) return p;
        const dims = pageDims(p);
        const need = p.visuals.filter((v) => !v.layout);
        const haveBottom = p.visuals.filter((v) => v.layout).reduce((m, v) => Math.max(m, (v.layout!.y + v.layout!.h)), 0);
        const offset = haveBottom ? haveBottom + 16 : 0;
        const placed = new Map(migrateFlowToAbsolute(need, dims).map((v) => [v.id, { ...v.layout, y: v.layout.y + offset }]));
        return { ...p, visuals: p.visuals.map((v) => (v.layout ? v : { ...v, layout: placed.get(v.id) })) };
      });
      setPages(migrated.length ? migrated : [{ id: uid('p'), name: 'Page 1', visuals: [] }]);
      setActivePage(0);
      setDirty(false);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── load fields ──────────────────────────────────────────────────────────
  const loadFields = useCallback(async () => {
    if (id === 'new') { setTables([]); setFieldsErr(null); setFieldsLoading(false); return; }
    setFieldsLoading(true); setFieldsErr(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/fields`);
      const j = await r.json();
      if (j.ok) { setTables(j.tables || []); }
      else { setTables([]); setFieldsErr(j.error || `HTTP ${r.status}`); }
    } catch (e: any) { setTables([]); setFieldsErr(e?.message || String(e)); }
    finally { setFieldsLoading(false); }
  }, [id]);

  useEffect(() => { loadDetail(); loadFields(); }, [loadDetail, loadFields]);

  // ── history recording ────────────────────────────────────────────────────
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
  }, [pages, reportFilters, bookmarks]); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    h.future.push({ pages, reportFilters, bookmarks });
    const prev = h.past.pop() as HistSnap;
    restoringRef.current = true;
    setPages(prev.pages); setReportFilters(prev.reportFilters); setBookmarks(prev.bookmarks);
    setDirty(true); setSelection(null); setHistTick((t) => t + 1);
  }, [pages, reportFilters, bookmarks]); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    h.past.push({ pages, reportFilters, bookmarks });
    const next = h.future.pop() as HistSnap;
    restoringRef.current = true;
    setPages(next.pages); setReportFilters(next.reportFilters); setBookmarks(next.bookmarks);
    setDirty(true); setSelection(null); setHistTick((t) => t + 1);
  }, [pages, reportFilters, bookmarks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo.
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

  // ── live render ──────────────────────────────────────────────────────────
  const runVisual = useCallback(async (v: DVisual, scopeFilters: ReportFilter[] = []) => {
    if (AI_SELF_QUERY.has(v.type)) return;
    if (!hasBinding(v)) return;
    const applicable = [...scopeFilters, ...(v.filters || [])];
    setVisualRows((p) => ({ ...p, [v.id]: { rows: p[v.id]?.rows || [], loading: true, err: null } }));
    const __t0 = performance.now();
    try {
      const dr = drillByVisualRef.current[v.id];
      const wif = whatIfBindings(whatIfsRef.current);
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          visual: queryVisual(v), filters: wireFilters(applicable), dataSource,
          ...(dr ? { drill: dr } : {}),
          ...(wif.length ? { whatIf: wif } : {}),
        }),
      });
      const j = await r.json();
      if (j.ok) {
        setVisualRows((p) => ({ ...p, [v.id]: { rows: j.rows || [], loading: false, err: null } }));
        if (perf.recording) perf.record(v.id, { title: v.title, serverMs: j.elapsedMs, rowCount: j.rowCount ?? (j.rows || []).length, clientMs: performance.now() - __t0, sql: j.sql || j.daxQuery });
      } else {
        setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: j.error || `HTTP ${r.status}` } }));
      }
    } catch (e: any) {
      setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: e?.message || String(e) } }));
    }
  }, [id, dataSource]); // eslint-disable-line react-hooks/exhaustive-deps

  const bound = isBound(dataSource);

  const bindingSig = (v: DVisual) => `${v.type}|${JSON.stringify(queryVisual(v).wells)}|${JSON.stringify(v.filters || [])}`;
  useEffect(() => {
    if (!bound || !page) return;
    const drillScope = drill && drill.toPage === activePage ? drill.filters : [];
    const scope = [...reportFilters, ...drillScope, ...(page.filters || [])];
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
  }, [bound, activePage, effectiveVisuals.map(bindingSig).join('~'), JSON.stringify(reportFilters), JSON.stringify(page?.filters || []), JSON.stringify(drill?.toPage === activePage ? drill?.filters : []), JSON.stringify(drillByVisual), JSON.stringify(whatIfs)]);

  useEffect(() => {
    const sec = reportSettings.settings.refreshIntervalSec as number || 0;
    if (!bound || sec <= 0) return;
    const handle = setInterval(() => {
      const scope = [...reportFilters, ...(page?.filters || [])];
      effectiveVisuals.forEach((v) => {
        if (AI_SELF_QUERY.has(v.type) || !hasBinding(v)) return;
        runVisual(v, scope);
      });
    }, sec * 1000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportSettings.settings.refreshIntervalSec, bound, activePage, effectiveVisuals.map(bindingSig).join('~'), JSON.stringify(reportFilters), JSON.stringify(page?.filters || [])]);

  // ── mutation helpers ─────────────────────────────────────────────────────
  const mutatePage = useCallback((fn: (p: DPage) => DPage) => {
    if (personalizeActiveRef.current) return;
    setPages((prev) => prev.map((p, i) => (i === activePage ? fn(p) : p)));
    setDirty(true);
  }, [activePage]); // eslint-disable-line react-hooks/exhaustive-deps

  const fieldParamSig = fieldParams.map((fp) => `${fp.id}:${fp.activeIndex ?? 0}`).join('~');
  useEffect(() => {
    if (personalizeActiveRef.current || fieldParams.length === 0) return;
    const keyOf = (f?: { table?: string; column?: string; measure?: string }) =>
      f ? `${f.table || ''}.${f.column || ''}|${f.measure || ''}` : '';
    setPages((prev) => {
      let changed = false;
      const next = prev.map((pg) => ({
        ...pg,
        visuals: pg.visuals.map((v) => {
          const cat0 = v.wells.category?.[0];
          if (!cat0) return v;
          const cur = keyOf(cat0);
          for (const fp of fieldParams) {
            const candidateKeys = fp.fields.map(keyOf);
            if (!candidateKeys.includes(cur)) continue;
            const af = activeField(fp);
            if (!af || keyOf(af) === cur) return v;
            changed = true;
            return { ...v, wells: { ...v.wells, category: [{ ...cat0, table: af.table, column: af.column, measure: af.measure }, ...(v.wells.category || []).slice(1)] } };
          }
          return v;
        }),
      }));
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldParamSig]);

  const mutateVisual = useCallback((vid: string, fn: (v: DVisual) => DVisual) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.map((v) => (v.id === vid ? fn(v) : v)) }));
  }, [mutatePage]);

  const addVisual = useCallback((type: VisualType, seed?: { language: 'python' | 'r' }) => {
    const isKpi = COMPACT_TYPES.has(type);
    mutatePage((p) => {
      const dims = pageDims(p);
      const w = isKpi ? 280 : 480; const h = isKpi ? 200 : 320;
      const n = p.visuals.length;
      const x = Math.min(dims.width - w, 40 + (n % 6) * 28);
      const y = Math.min(dims.height - h, 40 + (n % 6) * 28);
      const z = p.visuals.reduce((m, vv) => Math.max(m, (vv.layout?.z ?? -1)), -1) + 1;
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
  }, [mutatePage]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeVisual = useCallback((vid: string) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.filter((v) => v.id !== vid) }));
    if (selectedVisual === vid) setSelectedVisual(null);
  }, [mutatePage, selectedVisual]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── canvas-element mutators ──────────────────────────────────────────────
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

  const mutateElement = useCallback((eid: string, fn: (e: CanvasElement) => CanvasElement) => {
    mutatePage((p) => ({ ...p, elements: (p.elements || []).map((e) => (e.id === eid ? fn(e) : e)) }));
  }, [mutatePage]);

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
  }, [mutatePage, unionNodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeElement = useCallback((eid: string) => {
    mutatePage((p) => ({ ...p, elements: (p.elements || []).filter((e) => e.id !== eid) }));
    if (selectedVisual === eid) setSelectedVisual(null);
  }, [mutatePage, selectedVisual]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [mutatePage, selectedVisual]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── wells ────────────────────────────────────────────────────────────────
  const addToWell = useCallback((vid: string, well: WellName, f: WellField) => {
    mutateVisual(vid, (v) => {
      const cur = v.wells[well] || [];
      if (cur.some((x) => fieldKey(x) === fieldKey(f))) return v;
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

  // ── ad-hoc query ─────────────────────────────────────────────────────────
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
    const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visual, filters: adHocFilters ?? [], dataSource }),
    });
    const j = await r.json().catch(() => ({} as Record<string, unknown>));
    if (!r.ok || !j?.ok) throw new Error((j?.error as string) || `HTTP ${r.status}`);
    return (j.rows || []) as Array<Record<string, unknown>>;
  }, [id, dataSource]);

  // ── multi-select + Arrange ────────────────────────────────────────────────
  const toggleMultiSelect = useCallback((vid: string) => {
    setSelectedVisualIds((prev) => {
      const next = new Set(prev);
      if (next.has(vid)) next.delete(vid); else next.add(vid);
      return next;
    });
    setSelectedVisual(vid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const arrangeTargets = useCallback((): string[] => {
    if (selectedVisualIds.size > 0) return [...selectedVisualIds];
    return selectedVisual ? [selectedVisual] : [];
  }, [selectedVisualIds, selectedVisual]);

  const setVisualFlag = useCallback((ids: string[], patch: Partial<Pick<DVisual, 'hidden' | 'locked'>>) => {
    const set = new Set(ids);
    mutatePage((p) => {
      const np: DPage = { ...p, visuals: p.visuals.map((v) => (set.has(v.id) ? { ...v, ...patch } : v)) };
      if (p.elements && p.elements.length) np.elements = p.elements.map((e) => (set.has(e.id) ? { ...e, ...patch } : e));
      return np;
    });
  }, [mutatePage]);

  const matchSize = useCallback((ids: string[], dim: 'w' | 'h') => {
    if (ids.length < 2) return;
    mutatePage((p) => {
      const union = unionNodes(p);
      const first = union.find((n) => n.id === ids[0]);
      if (!first) return p;
      const set = new Set(ids);
      const val = first.layout[dim];
      const byId = new Map<string, AbsRect>(union.filter((n) => set.has(n.id)).map((n) => [n.id, { ...n.layout, [dim]: val }]));
      return scatterLayouts(p, byId);
    });
  }, [mutatePage, unionNodes, scatterLayouts]);

  const reorderZ = useCallback((ids: string[], dir: 'front' | 'back') => {
    if (!ids.length) return;
    const set = new Set(ids);
    mutatePage((p) => {
      const union = unionNodes(p);
      if (!union.length) return p;
      const next = absReorderZ(union, set, dir);
      const byId = new Map(next.map((n) => [n.id, n.layout]));
      return scatterLayouts(p, byId);
    });
  }, [mutatePage, unionNodes, scatterLayouts]);

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

  // ── canvas handlers ───────────────────────────────────────────────────────
  const applyLayoutMoves = useCallback((moves: Array<{ id: string; layout: AbsRect }>) => {
    if (!moves.length) return;
    const byId = new Map(moves.map((m) => [m.id, m.layout]));
    mutatePage((p) => {
      const np: DPage = { ...p, visuals: p.visuals.map((v) => (byId.has(v.id) ? { ...v, layout: { ...v.layout, ...byId.get(v.id)! } } : v)) };
      if (p.elements && p.elements.length) {
        np.elements = p.elements.map((e) => (byId.has(e.id) ? { ...e, layout: { ...e.layout, ...byId.get(e.id)! } } : e));
      }
      return np;
    });
  }, [mutatePage]);

  const onCanvasSelect = useCallback((vid: string | null, additive: boolean) => {
    if (vid == null) { setSelectedVisual(null); setSelectedVisualIds(new Set()); return; }
    if (additive) { toggleMultiSelect(vid); return; }
    setSelectedVisual(vid); setSelectedVisualIds(new Set());
  }, [toggleMultiSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCanvasMarquee = useCallback((ids: string[], additive: boolean) => {
    setSelectedVisualIds((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (const x of ids) next.add(x);
      return next;
    });
    if (ids[0]) setSelectedVisual(ids[0]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── grouping ──────────────────────────────────────────────────────────────
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

  const selectGroup = useCallback((gid: string) => {
    const p = pages[activePage];
    const members = [
      ...(p?.visuals || []).filter((v) => v.groupId === gid).map((v) => v.id),
      ...(p?.elements || []).filter((e) => e.groupId === gid).map((e) => e.id),
    ];
    setSelectedVisualIds(new Set(members));
    if (members[0]) setSelectedVisual(members[0]);
  }, [pages, activePage]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── drillthrough ──────────────────────────────────────────────────────────
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
  }, [activePage]); // eslint-disable-line react-hooks/exhaustive-deps

  const exitDrillthrough = useCallback(() => {
    setDrill((d) => { if (d) setActivePage(d.fromPage); return null; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── bookmarks ─────────────────────────────────────────────────────────────
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
  }, [buildCaptureSource]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeBookmarks = useCallback((next: ReportBookmark[]) => {
    setBookmarks(next);
    setDirty(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── element context ───────────────────────────────────────────────────────
  const onOpenUrl = useCallback((url: string) => {
    if (!url) return;
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
  }, []);

  const onNavigatePage = useCallback((target: number | string) => {
    if (typeof target === 'number') { setActivePage(Math.max(0, Math.min(pages.length - 1, target))); return; }
    const idx = pages.findIndex((p) => p.id === target);
    if (idx >= 0) setActivePage(idx);
  }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveToken = useCallback(async (token: FieldToken): Promise<unknown> => {
    const drillScope = drill && drill.toPage === activePage ? drill.filters : [];
    const scope = wireFilters([...reportFilters, ...drillScope, ...(page?.filters || [])]) as unknown as ReportFilterInput[];
    const rows = await queryAdHoc(tokenToSpec(token), scope);
    const row = rows[0];
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[keys.length - 1]] : null;
  }, [queryAdHoc, reportFilters, drill, activePage, page?.filters]);

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
  }, [bookmarks, applyBookmark, pages, selection, exitDrillthrough, drillSeedFor, navigateDrillthrough, onNavigatePage, onOpenUrl]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── page mutations ────────────────────────────────────────────────────────
  const addPage = useCallback(() => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const renamePage = useCallback((pid: string, name: string) => {
    setPages((prev) => prev.map((p) => (p.id === pid ? { ...p, name } : p)));
    setDirty(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const deletePage = useCallback((pid: string) => {
    setPages((prev) => {
      const next = prev.filter((p) => p.id !== pid);
      const safe = next.length ? next : [{ id: uid('p'), name: 'Page 1', visuals: [] }];
      setActivePage((ap) => Math.max(0, Math.min(ap, safe.length - 1)));
      return safe;
    });
    setDirty(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const duplicatePage = useCallback((pid: string) => {
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
        interactions: undefined,
        filters: (src.filters || []).map((f) => ({ ...f, id: uid('flt') })),
        visuals: src.visuals.map((v) => ({ ...v, id: uid('v'), wells: cloneWells(v.wells), filters: (v.filters || []).map((f) => ({ ...f, id: uid('flt') })) })),
        elements: src.elements ? src.elements.map((e): CanvasElement => ({ ...e, id: uid('el') })) : undefined,
      };
      const next = [...prev.slice(0, idx + 1), dup, ...prev.slice(idx + 1)];
      setActivePage(idx + 1);
      return next;
    });
    setSelectedVisual(null);
    setDirty(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleHidePage = useCallback((pid: string) => {
    setPages((prev) => prev.map((p) => (p.id === pid ? { ...p, hidden: !p.hidden } : p)));
    setDirty(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Copilot actions ───────────────────────────────────────────────────────
  const applyCopilotVisual = useCallback((spec: CopilotVisualSpec) => {
    const reUid = (a?: Array<{ table?: string; column?: string; measure?: string; aggregation?: Agg }>): WellField[] =>
      (a || []).map((f) => ({ uid: uid('f'), ...f }));
    const v: DVisual = {
      id: uid('v'),
      type: spec.type,
      title: spec.title || VISUALS.find((x) => x.type === spec.type)?.label || spec.type,
      wells: { category: reUid(spec.wells?.category), values: reUid(spec.wells?.values), legend: reUid(spec.wells?.legend) },
      w: spec.w && spec.w >= 2 ? Math.min(12, spec.w) : (spec.type === 'card' ? 3 : 6),
      h: spec.h && spec.h >= 1 ? spec.h : 4,
    };
    mutatePage((p) => {
      const dims = pageDims(p);
      const isKpi = COMPACT_TYPES.has(spec.type);
      const w = isKpi ? 280 : 480; const h = isKpi ? 200 : 320;
      const n = p.visuals.length;
      const z = p.visuals.reduce((m, vv) => Math.max(m, (vv.layout?.z ?? -1)), -1) + 1;
      const vv: DVisual = { ...v, layout: { x: Math.max(0, Math.min(dims.width - w, 40 + (n % 6) * 28)), y: Math.max(0, Math.min(dims.height - h, 40 + (n % 6) * 28)), w, h, z } };
      setSelectedVisual(vv.id);
      return { ...p, visuals: [...p.visuals, vv] };
    });
  }, [mutatePage]); // eslint-disable-line react-hooks/exhaustive-deps

  const addCopilotPage = useCallback((name?: string) => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: (name || '').trim() || `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── save ──────────────────────────────────────────────────────────────────
  const buildDefinitionBody = useCallback(() => ({
    pages: pages.map((p) => ({
      name: p.name,
      filters: wireFilters(p.filters || []),
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
        visualType: v.type, title: v.title,
        wells: wireWells(v.wells),
        layout: v.layout
          ? { x: Math.round(v.layout.x), y: Math.round(v.layout.y), w: Math.round(v.layout.w), h: Math.round(v.layout.h), z: v.layout.z ?? vi, unit: 'px' }
          : { x: 0, y: 0, w: v.w, h: v.h, z: v.z ?? vi },
        format: v.format, analytics: v.analytics,
        filters: wireFilters(v.filters || []),
        ...(v.hidden ? { hidden: true } : {}),
        ...(v.locked ? { locked: true } : {}),
        ...(v.groupId ? { groupId: v.groupId } : {}),
        ...(v.config?.language ? { language: v.config.language } : {}),
        ...(v.config?.script ? { script: v.config.script } : {}),
        ...(v.config?.slicerStyle ? { slicerStyle: v.config.slicerStyle } : {}),
      })),
      elements: wireElements(p.elements) ?? [],
    })),
    reportFilters: wireFilters(reportFilters),
    bookmarks: wireBookmarks(bookmarks) ?? [],
    filterPaneFormat: wireFilterPaneFormat(filterPaneFormat),
    theme: theme ?? undefined,
    syncSlicers: wireSyncGroups(syncGroups),
    fieldParameters: wireFieldParameters(fieldParams),
    whatIfParams: wireWhatIfParams(whatIfs),
    settings: reportSettings.settings,
    dataSource,
  }), [pages, reportFilters, bookmarks, filterPaneFormat, theme, syncGroups, fieldParams, whatIfs, dataSource, reportSettings.settings]);

  const save = useCallback(async () => {
    if (isNew) {
      setCreateErr(null);
      setCreateName((prev) => prev || reportName.trim() || 'Untitled report');
      setCreateOpen(true);
      return;
    }
    setSaveBusy(true); setSaveMsg(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDefinitionBody()),
      });
      const j = await r.json();
      if (j.ok) { setDirty(false); setSaveMsg({ ok: true, text: `Saved ${j.pageCount} page(s), ${j.visualCount} visual(s).` }); }
      else setSaveMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [isNew, id, reportName, buildDefinitionBody]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!createOpen || workspaces !== null) return;
    (async () => {
      try {
        const r = await clientFetch('/api/loom/workspaces');
        const j = await r.json();
        if (j.ok) {
          const list = (j.workspaces || []) as { id: string; name: string }[];
          setWorkspaces(list);
          setCreateWsId((prev) => prev || list[0]?.id || '');
        } else { setWorkspaces([]); setWsErr(j.error || `HTTP ${r.status}`); }
      } catch (e: any) { setWorkspaces([]); setWsErr(e?.message || String(e)); }
    })();
  }, [createOpen, workspaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const createNewReport = useCallback(async () => {
    const name = createName.trim() || reportName.trim() || 'Untitled report';
    if (!createWsId) { setCreateErr('Select a workspace for the new report.'); return; }
    setCreateBusy(true); setCreateErr(null);
    try {
      const cr = await clientFetch('/api/cosmos-items/report', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: createWsId, displayName: name }),
      });
      const cj = await cr.json().catch(() => ({} as any));
      if (!cr.ok || !cj?.ok || !cj.item?.id) throw new Error(cj?.error || `Could not create the report (HTTP ${cr.status}).`);
      const newId: string = cj.item.id;
      const dr = await clientFetch(`/api/items/report/${encodeURIComponent(newId)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDefinitionBody()),
      });
      const dj = await dr.json().catch(() => ({} as any));
      if (!dr.ok || !dj?.ok) throw new Error(dj?.error || `Saving the report layout failed (HTTP ${dr.status}).`);
      if (isBound(dataSource) && dataSource) {
        await clientFetch(`/api/items/report/${encodeURIComponent(newId)}/data-source`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataSource }),
        }).catch(() => { /* swallow */ });
      }
      setDirty(false);
      router.push(`/items/report/${encodeURIComponent(newId)}`);
    } catch (e: any) {
      setCreateErr(e?.message || String(e)); setCreateBusy(false);
    }
  }, [createName, reportName, createWsId, buildDefinitionBody, dataSource, router]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── data source ───────────────────────────────────────────────────────────
  const applyDataSource = useCallback(async (ds: ReportDataSource) => {
    if (id === 'new') {
      setDataSource(ds); setDsOpen(false); setDirty(true);
      setDsNote({ ok: true, text: `Data source set (${describeSource(ds)}). Save the report to persist it.` });
      return;
    }
    setDsSaving(true); setDsNote(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/data-source`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataSource: ds }),
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
  }, [id, loadFields]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── publish ───────────────────────────────────────────────────────────────
  const doPublish = useCallback(async () => {
    setPublishBusy(true); setPublishMsg(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: publishTarget }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setPublishMsg({ ok: true, text: j.message || (publishTarget === 'powerbi' ? 'Published to the Power BI workspace.' : 'Published to the Organization gallery (/org-reports).') });
      } else {
        setPublishMsg({ ok: false, text: j?.error || `Publishing requires the report publish route / target to be configured (HTTP ${r.status}).` });
      }
    } catch (e: any) { setPublishMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setPublishBusy(false); }
  }, [id, publishTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── export ────────────────────────────────────────────────────────────────
  const rowsByVisual = useMemo(() => {
    const m: Record<string, Array<Record<string, unknown>>> = {};
    for (const k of Object.keys(visualRows)) m[k] = visualRows[k].rows;
    return m;
  }, [visualRows]);

  const getPrintHtml = useCallback((scope: ExportScope) => buildReportPrintHtml(
    pages as PrintPage[], rowsByVisual, theme ?? null, scope, page?.id, reportName || 'Report',
  ), [pages, rowsByVisual, theme, page?.id, reportName]);

  const onExportPrint = useCallback((scope: ExportScope) => {
    printReport(scope, getPrintHtml).catch(() => { /* print blocked */ });
  }, [getPrintHtml]);

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
  }, [reportName, page?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const onServerExport = useCallback(async (format: ExportFormat, scope: ExportScope) => {
    setExportMsg(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/export`, {
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
          text: (j?.error as string) || `High-fidelity ${format} export needs the Loom report renderer (set LOOM_REPORT_RENDERER) — use Print / Save as PDF for a no-setup file. (HTTP ${r.status})`,
        });
      }
    } catch (e: any) { setExportMsg({ ok: false, text: e?.message || String(e) }); }
  }, [id, reportName]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── AI wiring ─────────────────────────────────────────────────────────────
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

  const scriptWiring = useMemo(() => ({
    onChange: (vid: string, patch: { script?: string; language?: 'python' | 'r' }) =>
      mutateVisual(vid, (v) => ({ ...v, config: { ...(v.config || {}), ...patch } })),
  }), [mutateVisual]);

  // ── ribbon ────────────────────────────────────────────────────────────────
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
      { label: 'Governance', actions: [
        { label: sensitivityLabelName ? `Sensitivity: ${sensitivityLabelName}` : 'Sensitivity', icon: <Shield20Regular />, onClick: () => setSensitivityOpen(true), disabled: isNew, title: 'Apply a Microsoft Information Protection sensitivity label' },
        { label: endorsement ? `Endorsement: ${endorsement}` : 'Endorse', icon: <Ribbon20Regular />, onClick: () => setEndorsementOpen(true), disabled: isNew, title: 'Promote or certify this report' },
      ]},
      { label: 'Lifecycle', actions: [
        { label: 'Pipeline', icon: <Branch20Regular />, onClick: () => setPipelineOpen(true), disabled: isNew, title: 'Add to / deploy through a deployment pipeline' },
      ]},
      { label: 'Insert', actions: [
        { label: 'New page', icon: <Add20Regular />, onClick: addPage, title: 'add a report page' },
      ]},
    ]},
    { id: 'view', label: 'View', groups: [
      { label: 'Theme', actions: [
        { label: 'Themes', icon: <ColorRegular />, onClick: () => setThemesOpen(true), title: 'Restyle every visual — palette, font, background (Loom + custom themes)' },
      ]},
      { label: 'Page layout', actions: [
        { label: 'Snap to grid', icon: <GridDots20Regular />, onClick: () => setSnapGrid((s) => !s), appearance: snapGrid ? 'primary' : undefined, title: 'Snap visuals to the grid when moving or resizing (Power BI "Snap objects to grid")' },
        { label: 'Gridlines', icon: <Grid20Regular />, onClick: () => setShowGrid((s) => !s), appearance: showGrid ? 'primary' : undefined, title: 'Show alignment gridlines on the canvas' },
      ]},
      { label: 'Settings', actions: [ { label: 'Settings', icon: <Settings20Regular />, onClick: () => setSettingsOpen(true), title: 'Report settings — auto-refresh, persistent filters, export + header toggles, cross-report drillthrough' } ]},
      { label: 'Reading', actions: [
        { label: personalize.active ? 'Personalizing' : 'Personalize', icon: <Edit20Regular />, onClick: () => personalize.toggleActive(), appearance: personalize.active ? 'primary' : undefined, title: 'Change visual types / fields for your own view — temporary, per-user, not saved' },
      ]},
    ]},
  ], [save, saveBusy, dirty, loadDetail, loadFields, dataSource, id, isNew, undo, redo, canUndo, canRedo, personalize.active, personalize.toggleActive, snapGrid, showGrid, sensitivityLabelName, endorsement, addPage]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    loadDetail, loadFields, runVisual,
    undo, redo,
    mutatePage, mutateVisual, addVisual, removeVisual,
    unionNodes, scatterLayouts,
    mutateElement, addElement, removeElement, removeNodes, reorderZStepUnion,
    addToWell, removeFromWell, setAgg,
    queryAdHoc,
    toggleMultiSelect, arrangeTargets, setVisualFlag, matchSize, reorderZ, alignSelection, distributeSelection,
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
  };
}
