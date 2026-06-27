'use client';

/**
 * PowerQueryHost — Power Query Online-parity authoring surface for Dataflow
 * Gen2 on the Azure-native backend (no Fabric required), REUSED unchanged by the
 * report builder's "Transform Data" host (Wave 4).
 *
 * Mirrors the real Power Query Online / ADF "Power Query" editor layout:
 *   - Ribbon (Home / Transform / Add column / View) — each transform button
 *     appends a real M step chaining off the previous applied step (via the pure
 *     `appendStep`, never raw-typed M — no-freeform-config). The View tab adds
 *     data-profiling, a query diagram, View-native-query, and Manage parameters.
 *   - Formula bar — edit the selected applied step's M expression inline.
 *   - Queries pane (left) — add / select / rename / delete named queries.
 *   - Applied Steps pane (right) — the let-block steps of the active query;
 *     select / rename / delete + a right-click (and kebab) menu with
 *     rename / insert-after / move-up / move-down / delete / delete-until-end.
 *   - Center — data preview (honest-gated), OR the column profile, OR the query
 *     diagram, depending on the View toggles.
 *
 * WAVE 4 (additive — every new prop is optional and defaults to today's behavior,
 * so the dataflow editor mount in `dataflow-gen2-editor.tsx` is byte-unchanged):
 *   - `schema?`            — source columns handed to the structured transform
 *                            dialogs + the query diagram.
 *   - `onProfile?`         — self-fetching profiler for the View → Data profiling
 *                            pane (real aggregate SQL via the report/dataflow
 *                            /profile route). Absent ⇒ honest gate.
 *   - `onViewNativeQuery?` — resolves the folded native query (report
 *                            /native-query). Absent ⇒ the host folds locally
 *                            (`foldAppliedStepsToSql`) over a symbolic source so
 *                            View-native-query still shows the REAL folded SQL
 *                            (and the honest not-foldable gate), never a stub.
 *   - `onManageParameters?`— open a host-external Manage Parameters experience;
 *                            absent ⇒ the host mounts the shared dialog itself.
 *   - `hasTransformDialog?`/`renderTransformDialog?` — the seam the shared
 *                            `pq-transform-dialogs` module plugs into so a ribbon
 *                            button (or Insert-step-after) opens a structured,
 *                            column-aware dialog that emits a refined
 *                            `RibbonTransform` applied through `appendStep` — the
 *                            SAME path the bare ribbon button uses. Absent ⇒ the
 *                            ribbon appends the default step directly (unchanged).
 *
 * The M script stays the single source of truth: every edit recomputes the M and
 * emits it via onChange, so what you see is exactly what Save persists and Run
 * compiles into an ADF WranglingDataFlow (dataflow) / the report DirectQuery fold
 * + Import materialization read at /query.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Subtitle2, Caption1, Body1, Body1Strong, Button, Input, Tab, TabList,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle, Badge,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  ToggleButton, Spinner,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, Table16Regular, ChevronRight16Regular,
  TableSettings20Regular, NumberSymbolSquare20Regular,
  MoreHorizontal16Regular, Edit16Regular, ArrowUp16Regular, ArrowDown16Regular,
  Code20Regular, DataHistogram20Regular, Flowchart20Regular, Options20Regular,
} from '@fluentui/react-icons';
import {
  parseSharedQueries, parseLetBody, buildLetBody, setQueryBody,
  appendStep, renameIdentifier, foldAppliedStepsToSql,
  RIBBON_TRANSFORMS, type RibbonTransform,
} from './m-script';
import type { SqlDialect } from '@/lib/azure/wells-to-sql';
import { DataProfiling, type ProfileResponse } from './data-profiling';
import { ManageParametersDialog } from './manage-parameters';
import {
  CanvasNode, CATEGORY_ACCENT, CATEGORY_ICON, accentTint, accentGradient,
} from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';
// Shared Web-5.0 drag-to-resize canvas-height primitive (pointer + keyboard +
// ARIA + per-surface localStorage persistence all live in the primitive). This
// surface only declares its bounds/storage key; the diagram + steps region
// height becomes user-controlled while canvas behaviour stays unchanged.
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';

/**
 * Power Query is a data-wrangling surface → it belongs to the kit's `transform`
 * category. Reuse the SAME accent (violet) + section glyph the mapping-data-flow
 * transform nodes use, so this frame reads as the same product as the canvas.
 */
const PQ_ACCENT = CATEGORY_ACCENT.transform;
const PQ_GLYPH = CATEGORY_ICON.transform;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flex: 1, minHeight: 0 },
  // Shared elevated-card chrome for every panel (ribbon / formula bar / panes / center).
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow8 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  ribbon: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
  },
  ribbonRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
  formulaBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
  },
  // Accent-tinted "fx" chip, mirroring the kit's iconChip.
  fxChip: {
    flexShrink: 0,
    width: '28px', height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontStyle: 'italic', fontWeight: tokens.fontWeightBold,
    background: accentGradient(PQ_ACCENT), color: PQ_ACCENT,
    border: `1px solid ${accentTint(PQ_ACCENT, 24)}`,
  },
  // The definite height is now supplied by the wrapping <ResizableCanvasRegion>
  // (user-resizable, persisted); the body just fills it (height:100% claims the
  // region's resolved height; minHeight:0 lets the panes scroll instead of
  // forcing overflow). Was a fixed minHeight:320 flex:1 region.
  body: { display: 'flex', gap: tokens.spacingHorizontalM, height: '100%', minHeight: 0 },
  pane: {
    width: '244px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS, overflow: 'auto',
  },
  center: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // Scroll host for the View modes (profile cards / diagram) so they fill the
  // center without pushing the header off-screen.
  viewBody: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  paneHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalXS },
  paneTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  // Accent-tinted section glyph chip on pane / center headers (matches palette + node headers).
  headerIcon: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    background: accentTint(PQ_ACCENT, 14), color: PQ_ACCENT,
  },
  listItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  listItemActive: {
    backgroundColor: accentTint(PQ_ACCENT, 12),
    boxShadow: `inset 3px 0 0 0 ${PQ_ACCENT}`,
  },
  listIcon: { flexShrink: 0, color: PQ_ACCENT, display: 'inline-flex', alignItems: 'center' },
  itemText: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  fillInput: { flex: 1 },
  hint: { marginTop: 'auto', color: tokens.colorNeutralForeground3 },
  mPreviewLabel: { color: tokens.colorNeutralForeground3 },
  mPreview: {
    margin: 0,
    padding: tokens.spacingHorizontalM,
    overflow: 'auto',
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
  },
  // ── View-mode chrome ───────────────────────────────────────────────────────
  diagram: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap', overflow: 'auto', padding: tokens.spacingVerticalS, minHeight: 0,
  },
  diagramArrow: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
  loadingRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3,
  },
  nqMeta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalXS },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** Ribbon tabs — the 3 transform tabs plus the additive View tab. */
type HostTab = RibbonTransform['tab'] | 'view';
const HOST_TABS: Array<{ id: HostTab; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'transform', label: 'Transform' },
  { id: 'addColumn', label: 'Add column' },
  { id: 'view', label: 'View' },
];

/** A source column handed to the structured transform dialogs + the diagram. */
export interface TransformColumn {
  name: string;
  dataType?: string;
}

/** Result of resolving the active query's folded native query (View → native query). */
export type NativeQueryResult =
  | { ok: true; dialect?: SqlDialect; sql: string; foldable?: boolean }
  | { ok: false; code?: 'not-foldable' | 'unbound'; error: string; unfoldableStep?: string };

/** Request handed to the shared transform-dialog renderer (the seam). */
export interface TransformDialogRequest {
  /** The ribbon transform the user picked (default step name / expr / foldable). */
  transform: RibbonTransform;
  /** The active query's column schema, so the dialog can offer real columns. */
  columns: TransformColumn[];
  /** Emit the refined transform; the host applies it via appendStep (the same
   *  path the ribbon button uses) at the requested position. */
  onEmit: (spec: RibbonTransform) => void;
  /** Dismiss without applying. */
  onCancel: () => void;
}

// ── Pure, position-aware applied-step edits (mirror appendStep at a position) ──

/**
 * Insert a ribbon transform as a new applied step AFTER `idx`, rewiring the
 * immediate successor to chain off the inserted step (Power Query "Insert step
 * after"). Pure; M let-bindings resolve by name so the rebuilt let stays valid.
 */
function insertStepAfter(body: string, idx: number, t: RibbonTransform): string {
  const { steps, result } = parseLetBody(body);
  if (idx < 0 || idx >= steps.length) return appendStep(body, t);
  const prevName = steps[idx].name;
  let name = t.stepName;
  let n = 1;
  const existing = new Set(steps.map((st) => st.name));
  while (existing.has(name)) { n += 1; name = `${t.stepName} ${n}`; }
  const inserted = { name, expr: t.expr(prevName) };
  const next = [...steps];
  next.splice(idx + 1, 0, inserted);
  // The step that originally chained off `idx` now chains off the inserted step.
  const succIdx = idx + 2;
  if (succIdx < next.length) {
    next[succIdx] = { ...next[succIdx], expr: renameIdentifier(next[succIdx].expr, prevName, name) };
  }
  return buildLetBody(next, result);
}

/** Drop every applied step AFTER `idx`; the step at `idx` becomes the result. */
function truncateStepsAfter(body: string, idx: number): string {
  const { steps } = parseLetBody(body);
  if (idx < 0 || idx >= steps.length - 1) return body;
  const kept = steps.slice(0, idx + 1);
  return buildLetBody(kept, kept[kept.length - 1].name);
}

/**
 * Swap two adjacent applied-step bindings and rebuild the let (Power Query
 * "Move up/down"). M let bindings resolve by name, so reordering stays valid and
 * `foldAppliedStepsToSql` (which walks bindings positionally) reflects the new
 * order.
 */
function moveStep(body: string, idx: number, dir: -1 | 1): string {
  const { steps, result } = parseLetBody(body);
  const j = idx + dir;
  if (idx < 0 || j < 0 || idx >= steps.length || j >= steps.length) return body;
  const next = [...steps];
  const tmp = next[idx];
  next[idx] = next[j];
  next[j] = tmp;
  return buildLetBody(next, result);
}

export interface PowerQueryHostProps {
  /** The Power Query M script (single source of truth). */
  mScript: string;
  /** Emit the next M script on any edit. */
  onChange: (nextM: string) => void;
  readOnly?: boolean;
  /** Notified whenever the active query changes (so a docked Copilot pane can
   *  target the same query the user is editing). Fires on mount + selection. */
  onActiveQueryChange?: (name: string) => void;

  // ── Wave 4 — all optional; absent ⇒ today's dataflow-editor behavior ────────
  /** Source columns for the active query — feed the structured transform dialogs
   *  + the query diagram. */
  schema?: TransformColumn[];
  /** Self-fetching profiler for the View → Data profiling pane (POST report
   *  /profile or dataflow /profile). Absent ⇒ the pane shows an honest gate. */
  onProfile?: () => Promise<ProfileResponse>;
  /** Resolve the folded native query for the active query (report /native-query).
   *  Absent ⇒ the host folds locally for a real preview (never a stub). */
  onViewNativeQuery?: (queryName: string) => Promise<NativeQueryResult>;
  /** Open a host-external Manage Parameters experience. Absent ⇒ the host mounts
   *  the shared ManageParametersDialog itself. */
  onManageParameters?: () => void;
  /** Does this ribbon transform key have a richer structured dialog? Paired with
   *  `renderTransformDialog`. Absent ⇒ ribbon buttons append the default step
   *  directly (unchanged). */
  hasTransformDialog?: (key: string) => boolean;
  /** Render the structured, column-aware dialog for a ribbon transform — the seam
   *  the shared pq-transform-dialogs module plugs into. The dialog emits a refined
   *  `RibbonTransform` the host applies through `appendStep`. */
  renderTransformDialog?: (req: TransformDialogRequest) => ReactNode;
}

export function PowerQueryHost({
  mScript, onChange, readOnly = false, onActiveQueryChange,
  schema, onProfile, onViewNativeQuery, onManageParameters,
  hasTransformDialog, renderTransformDialog,
}: PowerQueryHostProps) {
  const s = useStyles();
  const queries = useMemo(() => parseSharedQueries(mScript), [mScript]);
  const [activeQuery, setActiveQuery] = useState<string>(queries[0]?.name || '');
  const [activeStepIdx, setActiveStepIdx] = useState<number>(0);
  const [ribbonTab, setRibbonTab] = useState<HostTab>('home');
  const [renaming, setRenaming] = useState<{ kind: 'query' | 'step'; value: string } | null>(null);
  // View-mode for the center panel + per-step action menu + dialogs.
  const [viewMode, setViewMode] = useState<'preview' | 'profile' | 'diagram'>('preview');
  const [stepMenuIdx, setStepMenuIdx] = useState<number | null>(null);
  const [pendingTransform, setPendingTransform] = useState<{ t: RibbonTransform; idx: number | null } | null>(null);
  const [nq, setNq] = useState<{ open: boolean; loading: boolean; result?: NativeQueryResult }>({ open: false, loading: false });
  const [paramsOpen, setParamsOpen] = useState(false);

  const current = queries.find((q) => q.name === activeQuery) || queries[0];
  const parsed = useMemo(() => (current ? parseLetBody(current.body) : { steps: [], result: '' }), [current]);

  // Report the resolved active query name up to a docked Copilot pane.
  const currentName = current?.name || '';
  useEffect(() => { onActiveQueryChange?.(currentName); }, [currentName, onActiveQueryChange]);

  const steps = parsed.steps;
  const safeStepIdx = Math.min(activeStepIdx, Math.max(0, steps.length - 1));
  const activeStep = steps[safeStepIdx];

  // Columns offered to the structured transform dialogs (empty list when the
  // host wasn't given a schema — the dialog still renders, the user types names).
  const columns = useMemo<TransformColumn[]>(() => schema ?? [], [schema]);

  const emitQueryBody = useCallback((queryName: string, body: string) => {
    onChange(setQueryBody(mScript, queryName, body));
  }, [mScript, onChange]);

  // ---- Queries ----
  const addQuery = useCallback(() => {
    if (readOnly) return;
    const existing = new Set(queries.map((q) => q.name));
    let n = queries.length + 1;
    let name = `Query${n}`;
    while (existing.has(name)) { n += 1; name = `Query${n}`; }
    const body = 'let\n    Source = #table({"col1","col2"}, {{"hello","world"}})\nin\n    Source';
    let next = mScript;
    if (!/^\s*section\s/m.test(next)) next = `section Section1;\n${next}`;
    onChange(`${next.replace(/\s*$/, '')}\nshared ${name} = ${body};\n`);
    setActiveQuery(name);
    setActiveStepIdx(0);
  }, [readOnly, queries, mScript, onChange]);

  const deleteQuery = useCallback((name: string) => {
    if (readOnly) return;
    const remaining = queries.filter((q) => q.name !== name);
    const rebuilt = `section Section1;\n\n${remaining.map((q) => `shared ${q.name} = ${q.body};`).join('\n\n')}\n`;
    onChange(rebuilt);
    if (activeQuery === name) { setActiveQuery(remaining[0]?.name || ''); setActiveStepIdx(0); }
  }, [readOnly, queries, onChange, activeQuery]);

  const commitRenameQuery = useCallback((oldName: string, newName: string) => {
    const trimmed = newName.trim();
    setRenaming(null);
    if (readOnly || !trimmed || trimmed === oldName) return;
    if (queries.some((q) => q.name === trimmed)) return;
    // Rename the declaration + every cross-query reference.
    const renamed = renameIdentifier(mScript, oldName, trimmed)
      .replace(new RegExp(`shared\\s+#?"?${oldName}"?\\s*=`), `shared ${trimmed} =`);
    onChange(renamed);
    setActiveQuery(trimmed);
  }, [readOnly, queries, mScript, onChange]);

  // ---- Steps ----
  const updateStepExpr = useCallback((idx: number, expr: string) => {
    if (readOnly || !current) return;
    const nextSteps = steps.map((st, i) => (i === idx ? { ...st, expr } : st));
    emitQueryBody(current.name, buildLetBody(nextSteps, parsed.result));
  }, [readOnly, current, steps, parsed.result, emitQueryBody]);

  const deleteStep = useCallback((idx: number) => {
    if (readOnly || !current || steps.length <= 1 || idx <= 0) return;
    const nextSteps = steps.filter((_, i) => i !== idx);
    const result = parsed.result === steps[idx].name ? nextSteps[nextSteps.length - 1].name : parsed.result;
    emitQueryBody(current.name, buildLetBody(nextSteps, result));
    setActiveStepIdx(Math.max(0, idx - 1));
  }, [readOnly, current, steps, parsed.result, emitQueryBody]);

  const commitRenameStep = useCallback((oldName: string, newName: string) => {
    const trimmed = newName.trim();
    setRenaming(null);
    if (readOnly || !current || !trimmed || trimmed === oldName) return;
    if (steps.some((st) => st.name === trimmed)) return;
    // Rename within this query body only (steps are query-scoped).
    const newBody = renameIdentifier(current.body, oldName, trimmed);
    emitQueryBody(current.name, newBody);
  }, [readOnly, current, steps, emitQueryBody]);

  const moveStepBy = useCallback((idx: number, dir: -1 | 1) => {
    if (readOnly || !current) return;
    emitQueryBody(current.name, moveStep(current.body, idx, dir));
    setActiveStepIdx(Math.min(Math.max(0, idx + dir), Math.max(0, steps.length - 1)));
    setStepMenuIdx(null);
  }, [readOnly, current, steps.length, emitQueryBody]);

  const truncateAfter = useCallback((idx: number) => {
    if (readOnly || !current) return;
    emitQueryBody(current.name, truncateStepsAfter(current.body, idx));
    setActiveStepIdx(idx);
    setStepMenuIdx(null);
  }, [readOnly, current, emitQueryBody]);

  // ---- Transforms (ribbon button + insert-after share this path) ----
  /** Apply a (possibly dialog-refined) transform spec at the requested position. */
  const commitTransform = useCallback((spec: RibbonTransform, idx: number | null) => {
    if (readOnly || !current) return;
    if (idx == null) {
      const newBody = appendStep(current.body, spec);
      emitQueryBody(current.name, newBody);
      setActiveStepIdx(Math.max(0, parseLetBody(newBody).steps.length - 1));
    } else {
      emitQueryBody(current.name, insertStepAfter(current.body, idx, spec));
      setActiveStepIdx(idx + 1);
    }
    setPendingTransform(null);
    setStepMenuIdx(null);
  }, [readOnly, current, emitQueryBody]);

  /** Pick a transform: open its structured dialog when one is wired, else apply. */
  const requestTransform = useCallback((t: RibbonTransform, idx: number | null = null) => {
    if (readOnly || !current) return;
    if (renderTransformDialog && hasTransformDialog?.(t.key)) {
      setPendingTransform({ t, idx });
      setStepMenuIdx(null);
    } else {
      commitTransform(t, idx);
    }
  }, [readOnly, current, renderTransformDialog, hasTransformDialog, commitTransform]);

  // ---- View → native query (real fold; route-backed when onViewNativeQuery) ----
  const openNativeQuery = useCallback(async () => {
    if (!current) return;
    setNq({ open: true, loading: true });
    try {
      let result: NativeQueryResult;
      if (onViewNativeQuery) {
        result = await onViewNativeQuery(current.name);
      } else {
        // Local fold over a symbolic source — the report /query route substitutes
        // the bound relation for [source]. REAL fold logic + honest gate (never a
        // fabricated query): surfaces the first non-foldable step by name.
        const folded = foldAppliedStepsToSql('SELECT * FROM [source]', current.body);
        result = folded.ok
          ? { ok: true, sql: folded.sql, foldable: true }
          : { ok: false, code: 'not-foldable', unfoldableStep: folded.unfoldableStep,
              error: `Step '${folded.unfoldableStep}' can't fold to a native query — switch this query to Import.` };
      }
      setNq({ open: true, loading: false, result });
    } catch (e: any) {
      setNq({ open: true, loading: false, result: { ok: false, error: e?.message || String(e) } });
    }
  }, [current, onViewNativeQuery]);

  const openManageParameters = useCallback(() => {
    if (onManageParameters) onManageParameters();
    else setParamsOpen(true);
  }, [onManageParameters]);

  const ribbonButtons = RIBBON_TRANSFORMS.filter((t) => t.tab === ribbonTab);

  if (queries.length === 0) {
    return (
      <div className={s.root}>
        <EmptyState
          icon={PQ_GLYPH}
          title="No queries yet"
          body="This dataflow has no Power Query declarations the visual editor can read. Add one to start shaping data with the ribbon, or author raw M on the Script (M) tab."
          primaryAction={readOnly
            ? undefined
            : { label: 'Add query', appearance: 'primary', onClick: addQuery }}
        />
      </div>
    );
  }

  const centerTitle = viewMode === 'profile' ? 'Column profile'
    : viewMode === 'diagram' ? 'Query diagram'
      : 'Data preview';

  return (
    <div className={s.root}>
      {/* Ribbon */}
      <div className={mergeClasses(s.card, s.ribbon)}>
        <TabList selectedValue={ribbonTab} onTabSelect={(_, d) => setRibbonTab(d.value as HostTab)} size="small">
          {HOST_TABS.map((t) => <Tab key={t.id} value={t.id}>{t.label}</Tab>)}
        </TabList>
        <div className={s.ribbonRow}>
          {ribbonTab === 'view' ? (
            <>
              <ToggleButton
                size="small" appearance="subtle" icon={<DataHistogram20Regular />}
                checked={viewMode === 'profile'}
                onClick={() => setViewMode((v) => (v === 'profile' ? 'preview' : 'profile'))}
              >
                Data profiling
              </ToggleButton>
              <ToggleButton
                size="small" appearance="subtle" icon={<Flowchart20Regular />}
                checked={viewMode === 'diagram'}
                onClick={() => setViewMode((v) => (v === 'diagram' ? 'preview' : 'diagram'))}
              >
                Query diagram
              </ToggleButton>
              <Tooltip content="Show the folded native (SQL) query" relationship="label">
                <Button size="small" appearance="subtle" icon={<Code20Regular />} disabled={!current} onClick={openNativeQuery}>
                  View native query
                </Button>
              </Tooltip>
              <Button size="small" appearance="subtle" icon={<Options20Regular />} onClick={openManageParameters}>
                Manage parameters
              </Button>
            </>
          ) : (
            ribbonButtons.map((t) => (
              <Tooltip key={t.key} content={`Append: ${t.label}`} relationship="label">
                <Button size="small" appearance="subtle" disabled={readOnly || !current} onClick={() => requestTransform(t)}>
                  {t.label}
                </Button>
              </Tooltip>
            ))
          )}
        </div>
      </div>

      {/* Formula bar */}
      <div className={mergeClasses(s.card, s.formulaBar)}>
        <span className={s.fxChip} aria-hidden="true">fx</span>
        <Input
          appearance="filled-lighter"
          className={s.fillInput}
          value={activeStep?.expr || ''}
          placeholder={activeStep ? '' : 'Select an applied step'}
          disabled={readOnly || !activeStep}
          onChange={(_, d) => updateStepExpr(safeStepIdx, d.value)}
          aria-label="Step formula (M)"
        />
      </div>

      {/* The Power Query diagram + steps area is a bounded canvas region whose
          height the user can drag (or keyboard-resize) and which persists per
          surface. Bounds: minPx 300 (floor for the 3-pane layout) up to ~80vh,
          default 420 — matching the prior fixed minHeight:320 + flex so first
          paint is visually unchanged. Canvas behaviour/contents are untouched. */}
      <ResizableCanvasRegion
        storageKey="power-query-gen2"
        defaultPx={420}
        minPx={300}
        ariaLabel="Resize Power Query canvas height"
      >
      <div className={s.body}>
        {/* Queries pane */}
        <div className={mergeClasses(s.card, s.pane)} role="navigation" aria-label="Queries">
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>
              <span className={s.headerIcon} aria-hidden="true"><TableSettings20Regular /></span>
              <Subtitle2>Queries</Subtitle2>
            </span>
            <Tooltip content="New query" relationship="label">
              <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={addQuery} disabled={readOnly} aria-label="New query" />
            </Tooltip>
          </div>
          {queries.map((q) => (
            <div
              key={q.name}
              className={mergeClasses(s.listItem, q.name === activeQuery && s.listItemActive)}
              onClick={() => { setActiveQuery(q.name); setActiveStepIdx(0); }}
              onDoubleClick={() => setRenaming({ kind: 'query', value: q.name })}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') { setActiveQuery(q.name); setActiveStepIdx(0); } }}
            >
              <span className={s.listIcon} aria-hidden="true"><Table16Regular /></span>
              {renaming?.kind === 'query' && q.name === activeQuery ? (
                <Input
                  size="small" className={s.fillInput} defaultValue={q.name} autoFocus
                  onBlur={(e) => commitRenameQuery(q.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRenameQuery(q.name, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }}
                  aria-label="Rename query"
                />
              ) : (
                <span className={s.itemText}>{q.name === activeQuery ? <Body1Strong>{q.name}</Body1Strong> : q.name}</span>
              )}
              {q.name === activeQuery && queries.length > 1 && (
                <Tooltip content="Delete query" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={readOnly}
                    onClick={(e) => { e.stopPropagation(); deleteQuery(q.name); }} aria-label="Delete query" />
                </Tooltip>
              )}
            </div>
          ))}
          <Caption1 className={s.hint}>
            Double-click a query to rename.
          </Caption1>
        </div>

        {/* Center — data preview (honest-gated) / column profile / query diagram */}
        <div className={mergeClasses(s.card, s.center)}>
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>
              <span className={s.headerIcon} aria-hidden="true"><Table16Regular /></span>
              <Body1Strong>{centerTitle} — {current?.name}</Body1Strong>
            </span>
            <Badge appearance="tint" color="informative">{steps.length} step{steps.length === 1 ? '' : 's'}</Badge>
          </div>

          {viewMode === 'profile' ? (
            <div className={s.viewBody}>
              {onProfile ? (
                <DataProfiling onProfile={onProfile} />
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Data profiling needs a profile backend</MessageBarTitle>
                    Column profiling runs real aggregate SQL (COUNT / COUNT DISTINCT / null %,
                    min/max, value distribution) on the bound source via Synapse. It is wired
                    when this query is opened in the report Transform editor; this mount has no{' '}
                    <code>onProfile</code> backend.
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          ) : viewMode === 'diagram' ? (
            <div className={mergeClasses(s.viewBody, s.diagram)} role="list" aria-label="Query step diagram">
              {steps.map((st, i) => (
                <Fragment key={`${st.name}-d-${i}`}>
                  {i > 0 && <ChevronRight16Regular className={s.diagramArrow} aria-hidden="true" />}
                  <CanvasNode
                    width={176}
                    title={st.name}
                    visual={{ icon: PQ_GLYPH, category: 'transform', accent: PQ_ACCENT }}
                    typeLabel={i === 0 ? 'Source' : 'Applied step'}
                    selected={i === safeStepIdx}
                    description={i === 0 && columns.length ? `${columns.length} column${columns.length === 1 ? '' : 's'}` : undefined}
                    rootProps={{
                      role: 'listitem', tabIndex: 0,
                      'aria-label': `Step ${st.name}`,
                      style: { cursor: 'pointer' },
                      onClick: () => setActiveStepIdx(i),
                      onKeyDown: (e) => { if (e.key === 'Enter') setActiveStepIdx(i); },
                    }}
                  />
                </Fragment>
              ))}
            </div>
          ) : (
            <>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Live preview runs on ADF Spark</MessageBarTitle>
                  ADF has no inline Power Query evaluation endpoint, so Loom does not fabricate
                  sample rows. Set an Output destination, then <strong>Save &amp; Run</strong> to
                  execute this mashup on ADF and write real rows. Opt into Fabric
                  (<code>LOOM_DATAFLOW_BACKEND=fabric</code> + a bound workspace) for inline preview.
                </MessageBarBody>
              </MessageBar>
              <Body1 className={s.mPreviewLabel}>
                Applied step expression (M):
              </Body1>
              <pre className={s.mPreview}>
                {activeStep ? `${activeStep.name} =\n    ${activeStep.expr}` : '— select an applied step —'}
              </pre>
            </>
          )}
        </div>

        {/* Applied steps pane */}
        <div className={mergeClasses(s.card, s.pane)} role="navigation" aria-label="Applied steps">
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>
              <span className={s.headerIcon} aria-hidden="true"><NumberSymbolSquare20Regular /></span>
              <Subtitle2>Applied steps</Subtitle2>
            </span>
          </div>
          {steps.map((st, i) => (
            <div
              key={`${st.name}-${i}`}
              className={mergeClasses(s.listItem, i === safeStepIdx && s.listItemActive)}
              onClick={() => setActiveStepIdx(i)}
              onDoubleClick={() => setRenaming({ kind: 'step', value: st.name })}
              onContextMenu={(e) => { if (readOnly) return; e.preventDefault(); setActiveStepIdx(i); setStepMenuIdx(i); }}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setActiveStepIdx(i); }}
            >
              <span className={s.listIcon} aria-hidden="true"><ChevronRight16Regular /></span>
              {renaming?.kind === 'step' && i === safeStepIdx ? (
                <Input
                  size="small" className={s.fillInput} defaultValue={st.name} autoFocus
                  onBlur={(e) => commitRenameStep(st.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRenameStep(st.name, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }}
                  aria-label="Rename step"
                />
              ) : (
                <span className={s.itemText}>{st.name}</span>
              )}
              {i === safeStepIdx && (
                <Menu
                  open={stepMenuIdx === i}
                  onOpenChange={(_, d) => setStepMenuIdx(d.open ? i : null)}
                  positioning="below-end"
                >
                  <MenuTrigger disableButtonEnhancement>
                    <Button
                      size="small" appearance="subtle" icon={<MoreHorizontal16Regular />}
                      disabled={readOnly} aria-label="Step actions"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </MenuTrigger>
                  <MenuPopover>
                    <MenuList>
                      <MenuItem icon={<Edit16Regular />} onClick={() => setRenaming({ kind: 'step', value: st.name })}>
                        Rename
                      </MenuItem>
                      <Menu>
                        <MenuTrigger disableButtonEnhancement>
                          <MenuItem icon={<Add16Regular />}>Insert step after</MenuItem>
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            {HOST_TABS.filter((tb) => tb.id !== 'view').map((tb, gi) => (
                              <Fragment key={tb.id}>
                                {gi > 0 && <MenuDivider />}
                                {RIBBON_TRANSFORMS.filter((t) => t.tab === tb.id).map((t) => (
                                  <MenuItem key={t.key} onClick={() => requestTransform(t, i)}>{t.label}</MenuItem>
                                ))}
                              </Fragment>
                            ))}
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                      <MenuDivider />
                      <MenuItem icon={<ArrowUp16Regular />} disabled={i <= 1} onClick={() => moveStepBy(i, -1)}>
                        Move up
                      </MenuItem>
                      <MenuItem icon={<ArrowDown16Regular />} disabled={i === 0 || i >= steps.length - 1} onClick={() => moveStepBy(i, 1)}>
                        Move down
                      </MenuItem>
                      <MenuDivider />
                      <MenuItem icon={<Delete16Regular />} disabled={i === 0 || steps.length <= 1} onClick={() => deleteStep(i)}>
                        Delete step
                      </MenuItem>
                      <MenuItem icon={<Delete16Regular />} disabled={i >= steps.length - 1} onClick={() => truncateAfter(i)}>
                        Delete steps until end
                      </MenuItem>
                    </MenuList>
                  </MenuPopover>
                </Menu>
              )}
            </div>
          ))}
          <Caption1 className={s.hint}>
            Right-click (or use the ⋯ menu) for rename, insert, move, and delete.
          </Caption1>
        </div>
      </div>
      </ResizableCanvasRegion>

      {/* Structured transform dialog — the shared pq-transform-dialogs module plugs
          in via renderTransformDialog; emits a refined RibbonTransform applied
          through appendStep (same path as the ribbon button). */}
      {pendingTransform && renderTransformDialog?.({
        transform: pendingTransform.t,
        columns,
        onEmit: (spec) => commitTransform(spec, pendingTransform.idx),
        onCancel: () => setPendingTransform(null),
      })}

      {/* View → native query — REAL folded SQL (route-backed or local fold) / honest gate. */}
      <Dialog open={nq.open} onOpenChange={(_, d) => setNq((p) => ({ ...p, open: d.open }))}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Native query — {current?.name}</DialogTitle>
            <DialogContent>
              {nq.loading ? (
                <div className={s.loadingRow}>
                  <Spinner size="tiny" /> <Caption1>Compiling native query…</Caption1>
                </div>
              ) : nq.result?.ok ? (
                <>
                  <div className={s.nqMeta}>
                    <Badge appearance="tint" color="brand">{nq.result.dialect || 'tsql'}</Badge>
                    {!onViewNativeQuery && (
                      <Caption1 className={s.muted}>
                        Preview — the report DirectQuery <code>/query</code> route substitutes the
                        bound source for <code>[source]</code> and runs this on Synapse / the connector dialect.
                      </Caption1>
                    )}
                  </div>
                  <pre className={s.mPreview}>{nq.result.sql}</pre>
                </>
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>
                      {nq.result?.code === 'unbound' ? 'No bound source' : 'Step can’t fold to SQL'}
                    </MessageBarTitle>
                    {nq.result?.error || 'Unable to compile a native query.'}
                  </MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setNq((p) => ({ ...p, open: false }))}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Manage parameters — host-owned when no external handler is supplied. */}
      {!onManageParameters && (
        <ManageParametersDialog
          open={paramsOpen}
          onOpenChange={setParamsOpen}
          mScript={mScript}
          onChange={onChange}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
