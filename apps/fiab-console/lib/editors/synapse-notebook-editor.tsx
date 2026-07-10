'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Synapse Notebook editor — the heavy-designer surface that brings the Synapse
 * Studio "Develop → Notebooks" experience into Loom 1:1: a multi-cell Spark
 * notebook (code + markdown cells) attached to a Big Data pool, with per-cell
 * Run + Run-all against the real Livy interactive-session API, live output, and
 * Save/Publish back to the workspace notebook artifact.
 *
 * Real backend (per no-vaporware.md):
 *   - List/open/save/delete notebooks → /api/synapse/notebooks[/<name>]
 *     (Synapse dev-plane artifact REST, api-version 2020-12-01)
 *   - Attach picker → /api/items/synapse-spark-pool/list (ARM bigDataPools)
 *   - Run cell → POST /api/synapse/notebooks/<name>/run-cell (Livy create
 *     session + submit statement), poll via GET (Livy get statement)
 *
 * Honest gate: when the workspace routes 503 with code 'not_configured', the
 * full designer still renders behind a Fluent MessageBar naming the exact env
 * var (LOOM_SYNAPSE_WORKSPACE) — no surface is hidden.
 *
 * Parity inventory (Synapse Studio Notebook):
 *   add code/markdown cell ✅ · insert cell between cells ✅ · per-cell language
 *   (pyspark/spark/sql/sparkr/.NET-C#) ✅ · notebook default language ✅ ·
 *   run cell ✅ · run all ✅ · move/duplicate/delete cell ✅ · collapse cell
 *   input ✅ · markdown render ✅ · outline (markdown headings → navigation) ✅ ·
 *   parameters cell (papermill/ADF tag) ✅ · attach Spark pool ✅ · attach
 *   environment (Spark configuration) ✅ · session state + Spark UI link ✅ ·
 *   cell output incl. error traceback ✅ · save (publish artifact + ADLS .ipynb
 *   backup) ✅ · new/open/delete notebook ✅
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Switch, Textarea,
  Tree, TreeItem, TreeItemLayout, Dropdown, Option, ProgressBar, Link,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  Popover, PopoverTrigger, PopoverSurface,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Book20Regular, Add20Regular,
  Save20Regular, TextBulletListTree20Regular,
  CalendarClock20Regular, ArrowUndo20Regular, ArrowRedo20Regular,
  Settings20Regular, ArrowUpload20Regular, ArrowDownload20Regular,
  Code20Regular, Comment20Regular, CommentCheckmark20Regular, Open16Regular,
  ChevronDown16Regular, ChevronRight16Regular, Keyboard20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { loomDocUrl } from '@/lib/learn/content';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import { ScheduleWizard, type ScheduleCreateParams } from '@/lib/components/notebook/schedule-wizard';
import { EmptyState } from '@/lib/components/empty-state';
import { useSharedEditorStyles } from './shared-styles';
// Shared cell / output stack (R4-SYN — one-for-one with the other notebook flavours).
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { RichDisplay } from '@/lib/components/notebook/rich-display';
import { VariablesPane, type VarRow } from '@/lib/components/notebook/variables-pane';
import { DataWranglerPanel } from '@/lib/components/notebook/data-wrangler-panel';
import {
  SessionConfigDialog, toConfigureOptions, normalizeSessionConfig,
  DEFAULT_SESSION_CONFIG, type SessionConfig,
} from '@/lib/components/notebook/session-config-dialog';
import {
  type EditorCell, type CellKind, type CellOutput, type CellComment,
  KIND_LABEL, KIND_MAGIC, LANG_TO_KIND,
  toSharedCell, mergeSharedChange, buildRichFromTable,
  parseRunReference, buildRunPreamble, clampProgress,
  metaToComments, commentsToMeta, SPARK_SNIPPETS,
} from './synapse-notebook-cell-adapter';

/** Shaped AML schedule row returned by /api/notebook/[id]/schedule. */
interface AmlScheduleRow {
  name: string;
  displayName?: string;
  isEnabled: boolean;
  provisioningState?: string;
  frequency?: string;
  interval?: number;
  startTime?: string;
  timeZone?: string;
}

const useLocalStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  cells: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, overflow: 'auto', flex: 1, minHeight: 0, paddingRight: tokens.spacingHorizontalXS },
  cell: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column',
    boxShadow: tokens.shadow4, transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cellActive: { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow16 },
  cellHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackground2, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: `${tokens.borderRadiusLarge} ${tokens.borderRadiusLarge} 0 0`,
  },
  output: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
    padding: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3, maxHeight: '280px', overflow: 'auto',
  },
  outputErr: { color: tokens.colorPaletteRedForeground1, backgroundColor: tokens.colorPaletteRedBackground1 },
  md: {
    padding: tokens.spacingVerticalM, fontSize: tokens.fontSizeBase300, lineHeight: 1.5,
    color: tokens.colorNeutralForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word',
    maxWidth: '100%', minWidth: 0, overflowX: 'auto',
    '& table.md-table': { borderCollapse: 'collapse', width: 'auto', maxWidth: '100%', margin: `${tokens.spacingVerticalS} 0`, fontSize: tokens.fontSizeBase200 },
    '& table.md-table th, & table.md-table td': { border: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`, textAlign: 'left', verticalAlign: 'top' },
    '& table.md-table th': { backgroundColor: tokens.colorNeutralBackground3, fontWeight: tokens.fontWeightSemibold },
    '& table.md-table tr:nth-child(even) td': { backgroundColor: tokens.colorNeutralBackground2 },
    '& pre.md-code': { backgroundColor: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalM, overflowX: 'auto', fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
    '& code': { fontFamily: tokens.fontFamilyMonospace, fontSize: '0.92em' },
    '& blockquote': { margin: `${tokens.spacingVerticalS} 0`, paddingLeft: tokens.spacingHorizontalM, borderLeft: `3px solid ${tokens.colorNeutralStroke1}`, color: tokens.colorNeutralForeground2 },
    '& ul, & ol': { paddingLeft: tokens.spacingHorizontalXL, margin: `${tokens.spacingVerticalXS} 0` },
    '& img': { maxWidth: '100%', borderRadius: tokens.borderRadiusSmall },
    '& a': { color: tokens.colorBrandForegroundLink },
  },
  tag: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100 },
  paramsChip: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    marginBottom: tokens.spacingVerticalXXS,
  },
  collapsedHint: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderTop: `1px dashed ${tokens.colorNeutralStroke2}`, cursor: 'pointer',
    overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%', minWidth: 0,
  },
  outlineHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS} ${tokens.spacingVerticalXS}`, color: tokens.colorNeutralForeground3,
  },
  outlineItem: {
    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`, borderRadius: tokens.borderRadiusMedium, border: 'none', background: 'none',
    color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300,
    overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, boxSizing: 'border-box',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  outlineEmpty: { padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  addBar: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'center', padding: `${tokens.spacingVerticalXS} 0` },
  richOut: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, padding: tokens.spacingVerticalS, maxHeight: '320px', overflow: 'auto' },
  richTable: { width: 'max-content', minWidth: '100%' },
  richImg: { maxWidth: '100%', display: 'block' },
  richHtml: { overflow: 'auto', fontSize: tokens.fontSizeBase300 },
  assistBar: {
    display: 'flex', gap: tokens.spacingHorizontalXS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  assistResult: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
    margin: 0, maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
    maxHeight: '240px', overflow: 'auto',
  },
  scheduleCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  scheduleHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  // Drag-to-reorder drop indicator (R4-SYN-12).
  cellDragOver: {
    outline: `2px dashed ${tokens.colorBrandStroke1}`, outlineOffset: '2px',
    borderRadius: tokens.borderRadiusMedium,
  },
  // Output collapse header (R4-SYN-8) — a slim bar above the cell output.
  outputHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS} 0`,
  },
  // Live Spark progress (R4-SYN-5).
  progressWrap: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  progressRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  // Per-cell comment thread (R4-SYN-9).
  commentBar: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS} ${tokens.spacingVerticalXS}`,
  },
  commentRow: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  commentBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px', overflowWrap: 'anywhere', wordBreak: 'break-word' },
  commentResolved: { opacity: 0.6, textDecoration: 'line-through' },
  commentComposer: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, width: '360px', maxWidth: '100%' },
  shortcutList: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`, alignItems: 'center' },
  kbd: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    padding: `1px ${tokens.spacingHorizontalXS}`, borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap',
  },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

// ── IPYNB ⇄ editor-cell mapping ───────────────────────────────────────────────
// EditorCell / CellKind / CellOutput and the KIND_* maps live in the shared
// ./synapse-notebook-cell-adapter so this editor renders on the shared CodeCell /
// RichDisplay / MarkdownCell stack (imported at the top of the file). The IPYNB
// (de)serialisation + magic round-trip helpers below stay here.

function uid(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Client-side mirror of the server's parseConfigureMagic detection — only the
// "is this a %%configure cell?" check. The server does the authoritative parse
// (and validates the JSON body) when the cell is sent to /execute.
function isConfigureCell(source: string): boolean {
  const first = source.split('\n').find((l) => l.trim() !== '')?.trim().toLowerCase() || '';
  return first.split(/\s+/)[0].startsWith('%%configure');
}

// Synapse magic %%sql / %%spark etc. carry per-cell language in IPYNB source.
function detectKind(metaTags: unknown, source: string): CellKind {
  const head = source.split('\n')[0]?.trim().toLowerCase() || '';
  if (head.startsWith('%%sql')) return 'sql';
  if (head.startsWith('%%spark')) return 'spark';
  if (head.startsWith('%%sparkr') || head.startsWith('%%r')) return 'sparkr';
  if (head.startsWith('%%csharp')) return 'csharp';
  return 'pyspark';
}

function tagsOf(meta: any): string[] {
  return Array.isArray(meta?.tags) ? meta.tags.map((t: unknown) => String(t)) : [];
}

// Synapse persists per-cell language as a leading %%magic in the IPYNB source.
// We strip it for clean editing and re-stamp it on save so language round-trips.
function stripMagic(source: string, kind: CellKind): string {
  if (kind === 'pyspark') return source;
  const lines = source.split('\n');
  const head = lines[0]?.trim().toLowerCase() || '';
  if (head.startsWith('%%')) return lines.slice(1).join('\n');
  return source;
}
function withMagic(source: string, kind: CellKind): string {
  if (kind === 'pyspark') return source;
  const magic = KIND_MAGIC[kind];
  const head = source.split('\n')[0]?.trim().toLowerCase() || '';
  if (head.startsWith(magic.toLowerCase())) return source;
  return `${magic}\n${source}`;
}

function ipynbToCells(props: any): EditorCell[] {
  const raw: any[] = Array.isArray(props?.cells) ? props.cells : [];
  const out: EditorCell[] = raw.map((c) => {
    const src = Array.isArray(c?.source) ? c.source.join('') : (typeof c?.source === 'string' ? c.source : '');
    const isMd = c?.cell_type === 'markdown';
    const outputs: any[] = Array.isArray(c?.outputs) ? c.outputs : [];
    const textOut = outputs
      .map((o) => {
        if (o?.text) return Array.isArray(o.text) ? o.text.join('') : String(o.text);
        const d = o?.data?.['text/plain'];
        return Array.isArray(d) ? d.join('') : (d ? String(d) : '');
      })
      .filter(Boolean).join('\n');
    const tags = tagsOf(c?.metadata);
    const lang: CellKind = isMd ? 'pyspark' : detectKind(c?.metadata?.tags, src);
    return {
      id: uid(),
      type: isMd ? 'markdown' : 'code',
      lang,
      source: isMd ? src : stripMagic(src, lang),
      output: textOut ? { status: 'ok', text: textOut } : undefined,
      isParameters: !isMd && tags.includes('parameters'),
      collapsed: !!(c?.metadata?.jupyter?.source_hidden),
      outputCollapsed: !!(c?.metadata?.jupyter?.outputs_hidden),
      comments: metaToComments(c?.metadata),
    };
  });
  return out.length ? out : [{ id: uid(), type: 'code', lang: 'pyspark', source: '' }];
}

function cellsToIpynb(cells: EditorCell[], pool: string | null, env?: string | null): any {
  return {
    nbformat: 4,
    nbformat_minor: 2,
    bigDataPool: pool ? { referenceName: pool, type: 'BigDataPoolReference' } : undefined,
    metadata: {
      language_info: { name: 'python' },
      kernelspec: { name: 'synapse_pyspark', display_name: 'Synapse PySpark' },
      // Synapse stores the attached Spark configuration ("environment") here.
      ...(env ? { a365ComputeOptions: { id: env, name: env } } : {}),
    },
    cells: cells.map((c) => ({
      cell_type: c.type === 'markdown' ? 'markdown' : 'code',
      metadata: {
        ...(c.type === 'code' ? { tags: c.isParameters ? ['parameters'] : [] } : {}),
        ...((c.collapsed || c.outputCollapsed) ? { jupyter: { ...(c.collapsed ? { source_hidden: true } : {}), ...(c.outputCollapsed ? { outputs_hidden: true } : {}) } } : {}),
        ...(commentsToMeta(c.comments) ? { loomComments: commentsToMeta(c.comments) } : {}),
      },
      source: (c.type === 'code' ? withMagic(c.source, c.lang) : c.source)
        .split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)),
      ...(c.type === 'code' ? { outputs: [], execution_count: null } : {}),
    })),
  };
}

// Markdown rendering uses the shared GFM renderer (tables / fenced code / lists /
// blockquotes / HR) — lib/notebook/render-markdown, imported at the top of the file.

interface SparkPoolLite { name: string; properties?: { nodeSize?: string; sparkVersion?: string } }

export function SynapseNotebookEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // Notebook catalog (workspace artifacts) + the open notebook.
  const [notebooks, setNotebooks] = useState<{ name: string; language?: string; pool?: string }[]>([]);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const [cells, setCells] = useState<EditorCell[]>([{ id: uid(), type: 'code', lang: 'pyspark', source: '' }]);
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Compute attach + Livy session.
  const [pools, setPools] = useState<SparkPoolLite[]>([]);
  const [attachedPool, setAttachedPool] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<number | string | null>(null);
  const [sessionState, setSessionState] = useState<string>('none');

  // Backend (Azure-native Synapse Livy by default; Databricks strictly opt-in
  // via LOOM_NOTEBOOK_BACKEND=databricks) + Databricks cluster attach.
  const [backend, setBackend] = useState<'synapse' | 'databricks'>('synapse');
  const [clusters, setClusters] = useState<{ cluster_id: string; cluster_name?: string; state?: string }[]>([]);
  const [attachedCluster, setAttachedCluster] = useState<string | null>(null);

  // %%configure options applied to the next (re)created session.
  const [sessionConfig, setSessionConfig] = useState<Record<string, unknown> | null>(null);
  // Latest live session, for keepalive + kill-on-unmount (avoids stale closures).
  const liveSessionRef = useRef<{ compute: string; sessionId: number | string } | null>(null);
  // Monotonic Livy execution counter — surfaced as [n] in the shared cell gutter.
  const execCounterRef = useRef(0);

  // Notebook default language (new cells inherit it) + attached environment
  // (Synapse Spark configuration applied to the session).
  const [defaultLang, setDefaultLang] = useState<CellKind>('pyspark');
  const [environments, setEnvironments] = useState<{ name: string; description?: string; sparkVersion?: string }[]>([]);
  const [attachedEnv, setAttachedEnv] = useState<string | null>(null);

  // New-notebook name field.
  const [newName, setNewName] = useState('');

  // Right-side tool drawers — shared with the other notebook flavours.
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [wranglerOpen, setWranglerOpen] = useState(false);

  // ── Session-config dialog (R4-SYN-6) — the dropdown-driven twin of %%configure.
  //    On Apply we store the mapped Livy configure options in `sessionConfig`
  //    (the same field the %%configure magic populates) so the next session is
  //    sized identically; no raw magic required. ─────────────────────────────
  const [sessionCfg, setSessionCfg] = useState<SessionConfig>(DEFAULT_SESSION_CONFIG);
  const [cfgDraft, setCfgDraft] = useState<SessionConfig>(DEFAULT_SESSION_CONFIG);
  const [cfgDialogOpen, setCfgDialogOpen] = useState(false);

  // ── Live Spark progress (R4-SYN-5) — per-cell Livy statement progress (0..100)
  //    while running, plus the resolved Spark UI URL from the session appInfo. ──
  const [progressByCell, setProgressByCell] = useState<Record<string, number>>({});
  const [sparkUiUrl, setSparkUiUrl] = useState<string | null>(null);

  // ── Cell-op undo/redo (R4-SYN-12) — notebook-level history of add/delete/move/
  //    duplicate/convert. Source typing is NOT snapshotted (Monaco owns text
  //    undo). Refs hold the stacks; histVer bumps so the ribbon disabled-state
  //    refreshes. ─────────────────────────────────────────────────────────────
  const cellsRef = useRef<EditorCell[]>(cells);
  useEffect(() => { cellsRef.current = cells; }, [cells]);
  const historyPast = useRef<EditorCell[][]>([]);
  const historyFuture = useRef<EditorCell[][]>([]);
  const [histVer, setHistVer] = useState(0);
  const snapshot = useCallback((): EditorCell[] => cellsRef.current.map((c) => ({ ...c })), []);
  const pushHistory = useCallback(() => {
    historyPast.current.push(snapshot());
    if (historyPast.current.length > 100) historyPast.current.shift();
    historyFuture.current = [];
    setHistVer((v) => v + 1);
  }, [snapshot]);
  const undo = useCallback(() => {
    const prev = historyPast.current.pop();
    if (!prev) return;
    historyFuture.current.push(snapshot());
    setCells(prev); setDirty(true); setHistVer((v) => v + 1);
  }, [snapshot]);
  const redo = useCallback(() => {
    const next = historyFuture.current.pop();
    if (!next) return;
    historyPast.current.push(snapshot());
    setCells(next); setDirty(true); setHistVer((v) => v + 1);
  }, [snapshot]);

  // ── Drag-to-reorder cells (R4-SYN-12) — HTML5 drag handle on each cell. ──────
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // ── Command-mode keyboard shortcuts (R4-SYN-7). `commandMode` is entered with
  //    Esc (from a cell) and drives the A/B/J/K/Shift+D/Enter/M/Y keymap. ───────
  const [commandMode, setCommandMode] = useState(false);
  const cellsContainerRef = useRef<HTMLDivElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // ── IPYNB import (R4-SYN-10) — hidden file input parsed client-side. ─────────
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // ── Notebook scheduling (AML job schedules — recurrence only) ───────────────
  const [scheduleWizardOpen, setScheduleWizardOpen] = useState(false);
  const [schedules, setSchedules] = useState<AmlScheduleRow[]>([]);
  const [schedulesConfigured, setSchedulesConfigured] = useState<boolean | null>(null);
  const [scheduleGateHint, setScheduleGateHint] = useState<string | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const refreshSchedules = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/schedule`);
      const j = await r.json();
      if (j?.configured === false) {
        setSchedulesConfigured(false);
        setScheduleGateHint(j.hint || null);
        setSchedules([]);
      } else if (j?.ok) {
        setSchedulesConfigured(true);
        setScheduleGateHint(null);
        setSchedules(j.schedules || []);
      }
    } catch { /* leave prior state — non-fatal */ }
  }, [id]);
  useEffect(() => { refreshSchedules(); }, [refreshSchedules]);

  const createSchedule = useCallback(async (params: ScheduleCreateParams) => {
    setScheduleBusy(true); setScheduleError(null);
    try {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/schedule`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      const j = await r.json();
      if (j?.configured === false) { setScheduleError(j?.hint || 'Notebook scheduling not configured'); return; }
      if (!j?.ok) { setScheduleError(j?.error || 'Create failed'); return; }
      setScheduleWizardOpen(false);
      setBanner({ intent: 'success', text: `Schedule "${j.schedule?.displayName || j.schedule?.name}" created — every ${j.schedule?.interval} ${String(j.schedule?.frequency || '').toLowerCase()}.` });
      await refreshSchedules();
    } catch (e: any) {
      setScheduleError(e?.message || String(e));
    } finally { setScheduleBusy(false); }
  }, [id, refreshSchedules]);

  const toggleSchedule = useCallback(async (scheduleName: string, isEnabled: boolean) => {
    try {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/schedule`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduleName, isEnabled }),
      });
      const j = await r.json();
      if (j?.ok) await refreshSchedules();
      else setBanner({ intent: 'error', text: j?.error || j?.hint || 'Schedule update failed' });
    } catch (e: any) {
      setBanner({ intent: 'error', text: e?.message || String(e) });
    }
  }, [id, refreshSchedules]);

  // Lightweight client-side schema hint for the per-cell AI assist (F21). The
  // server route grounds primarily on T2 env (bronze/silver/gold) + Synapse
  // serverless databases; this adds the open notebook + attached pool context.
  const clientSchemaContext = useMemo(() => {
    const parts: string[] = [];
    if (openName) parts.push(`Open notebook: ${openName}`);
    if (attachedPool) parts.push(`Attached Spark pool: ${attachedPool}`);
    if (pools.length) parts.push(`Available Spark pools: ${pools.map((p) => p.name).join(', ')}`);
    return parts.join('\n');
  }, [openName, attachedPool, pools]);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await clientFetch('/api/synapse/notebooks');
      const j = await r.json();
      if (r.status === 503 && j?.missing) { setGate({ missing: j.missing }); setNotebooks([]); }
      else if (j?.ok) { setGate(null); setNotebooks(j.notebooks || []); }
      else { setBanner({ intent: 'error', text: j?.error || 'Failed to list notebooks' }); }
    } catch (e: any) {
      setBanner({ intent: 'error', text: e?.message || String(e) });
    } finally { setLoadingList(false); }
  }, []);

  const refreshPools = useCallback(async () => {
    try {
      const r = await clientFetch('/api/items/synapse-spark-pool/list');
      const j = await r.json();
      if (j?.ok) setPools(j.pools || []);
    } catch { /* attach picker shows empty — non-fatal */ }
  }, []);

  // Spark configurations ("environments") — optional notebook attach. Route
  // always returns ok:true with [] when unconfigured, so the picker degrades
  // to "(none)" with no gate.
  const refreshEnvs = useCallback(async () => {
    try {
      const r = await clientFetch('/api/synapse/environments');
      const j = await r.json();
      if (j?.ok) setEnvironments(j.environments || []);
    } catch { /* non-fatal — environment attach is optional */ }
  }, []);

  useEffect(() => { refreshList(); refreshPools(); refreshEnvs(); }, [refreshList, refreshPools, refreshEnvs]);

  // Detect the active notebook compute backend (Synapse Livy default; Databricks
  // strictly opt-in). When Databricks is selected, load its all-purpose clusters
  // for the attach picker instead of Spark pools.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/session?probe=1`);
        const j = await r.json();
        if (cancelled || !j?.ok) return;
        const b: 'synapse' | 'databricks' = j.backend === 'databricks' ? 'databricks' : 'synapse';
        setBackend(b);
        if (b === 'databricks') {
          const cr = await clientFetch('/api/admin/scaling/databricks-cluster');
          const cj = await cr.json();
          if (!cancelled && cj?.ok) setClusters(cj.clusters || []);
        }
      } catch { /* stay on synapse default */ }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Keepalive — reset the session idle clock every 4 minutes while a notebook is
  // open so the warm session survives between cell runs.
  useEffect(() => {
    if (sessionId == null) return;
    const compute = backend === 'databricks' ? attachedCluster : attachedPool;
    if (!compute) return;
    const param = backend === 'databricks'
      ? `cluster=${encodeURIComponent(compute)}&sessionId=${encodeURIComponent(String(sessionId))}`
      : `pool=${encodeURIComponent(compute)}&sessionId=${encodeURIComponent(String(sessionId))}`;
    const timer = setInterval(() => {
      clientFetch(`/api/notebook/${encodeURIComponent(id)}/session?${param}`).catch(() => {});
    }, 4 * 60 * 1000);
    return () => clearInterval(timer);
  }, [sessionId, backend, attachedPool, attachedCluster, id]);

  // Kill the live session on unmount so we don't leak Spark drivers / contexts.
  useEffect(() => {
    return () => {
      const ref = liveSessionRef.current;
      if (!ref) return;
      const param = backend === 'databricks'
        ? `cluster=${encodeURIComponent(ref.compute)}&sessionId=${encodeURIComponent(String(ref.sessionId))}`
        : `pool=${encodeURIComponent(ref.compute)}&sessionId=${encodeURIComponent(String(ref.sessionId))}`;
      clientFetch(`/api/notebook/${encodeURIComponent(id)}/session?${param}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, backend]);

  // ---- Hydrate from the installed item's bundle cells ----
  // A bundle-installed synapse-notebook has its NotebookContent cells stamped
  // into Cosmos (state.cells, or state.content.cells when only the
  // NotebookContent shape was written). The live Synapse workspace list on the
  // left doesn't surface those, so on mount we open the item populated with
  // every markdown + code cell instead of a single empty cell — the bundle
  // content is no longer stranded. /api/items/synapse-notebook/[id] returns the
  // stamped cells in the IPYNB shape ipynbToCells() already parses. Once the
  // user opens a real workspace notebook on the left, openNotebook() takes over.
  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    (async () => {
      try {
        // Resolve the owning workspace, then pull the Cosmos-backed cells.
        const lookup = await clientFetch(`/api/cosmos-items/synapse-notebook/${encodeURIComponent(id)}`);
        if (!lookup.ok) return;
        const item = await lookup.json();
        if (cancelled || !item?.workspaceId) return;
        const r = await clientFetch(`/api/items/synapse-notebook/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(item.workspaceId)}`);
        const j = await r.json();
        if (cancelled || !j?.ok) return;
        const props = j.notebook?.properties || {};
        if (!Array.isArray(props.cells) || props.cells.length === 0) return;
        setOpenName(j.notebook?.name || item.displayName || 'notebook');
        setCells(ipynbToCells(props));
        setAttachedPool(props?.bigDataPool?.referenceName ?? null);
        setAttachedEnv((props?.metadata?.a365ComputeOptions?.name as string) ?? null);
        setSessionId(null); setSessionState('none'); setDirty(false);
        setBanner({ intent: 'info', text: 'Loaded notebook cells from the installed app bundle. Open a workspace notebook on the left to edit the published copy.' });
      } catch { /* fall back to the empty starter cell */ }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const openNotebook = useCallback(async (name: string) => {
    setBanner(null);
    try {
      const r = await clientFetch(`/api/synapse/notebooks/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || `Failed to open ${name}` }); return; }
      const props = j.notebook?.properties || {};
      setOpenName(name);
      setCells(ipynbToCells(props));
      setAttachedPool(props?.bigDataPool?.referenceName ?? null);
      setAttachedEnv((props?.metadata?.a365ComputeOptions?.name as string) ?? null);
      setSessionId(null); setSessionState('none'); setDirty(false);
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
  }, []);

  const createNotebook = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBanner(null);
    try {
      const r = await clientFetch('/api/synapse/notebooks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || 'Create failed' }); return; }
      setNewName('');
      await refreshList();
      await openNotebook(name);
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
  }, [newName, refreshList, openNotebook]);

  const save = useCallback(async () => {
    if (!openName) { setBanner({ intent: 'info', text: 'Open or create a notebook first.' }); return; }
    setSaving(true); setBanner(null);
    try {
      const r = await clientFetch(`/api/synapse/notebooks/${encodeURIComponent(openName)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ properties: cellsToIpynb(cells, attachedPool, attachedEnv) }),
      });
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || 'Save failed' }); }
      else {
        setDirty(false);
        const backup = j.adlsBackup;
        const note = backup?.ok
          ? ` .ipynb backed up to ADLS (${backup.path}).`
          : backup?.skipped ? '' : ' (ADLS backup skipped — see logs.)';
        setBanner({ intent: 'success', text: `Published "${openName}" to the workspace.${note}` });
        refreshList();
      }
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  }, [openName, cells, attachedPool, attachedEnv, refreshList]);

  const deleteOpen = useCallback(async () => {
    if (!openName) return;
    try {
      const r = await clientFetch(`/api/synapse/notebooks/${encodeURIComponent(openName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || 'Delete failed' }); return; }
      setOpenName(null); setCells([{ id: uid(), type: 'code', lang: 'pyspark', source: '' }]); setDirty(false);
      refreshList();
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
  }, [openName, refreshList]);

  // ── IPYNB export (R4-SYN-10) — download the open notebook as a standard .ipynb.
  //    Client-side Blob; the same shape cellsToIpynb publishes to the workspace. ─
  const exportIpynb = useCallback(() => {
    if (typeof window === 'undefined') return;
    const doc = cellsToIpynb(cells, attachedPool, attachedEnv);
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(openName || 'notebook').replace(/[^\w.-]+/g, '_')}.ipynb`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setBanner({ intent: 'success', text: `Exported ${a.download}.` });
  }, [cells, attachedPool, attachedEnv, openName]);

  // ── IPYNB import (R4-SYN-10) — read a standard .ipynb into the editor cells.
  //    Parsed client-side with the same ipynbToCells the workspace-open path
  //    uses; the imported notebook is unsaved until the user clicks Save. ───────
  const importIpynb = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!Array.isArray(json?.cells)) {
        setBanner({ intent: 'error', text: `${file.name} is not a valid notebook (no cells array).` });
        return;
      }
      pushHistory();
      const imported = ipynbToCells(json);
      setCells(imported);
      setAttachedPool(json?.bigDataPool?.referenceName ?? attachedPool);
      setDirty(true);
      setBanner({
        intent: 'info',
        text: openName
          ? `Imported ${imported.length} cell${imported.length === 1 ? '' : 's'} from ${file.name} into "${openName}". Click Save to publish.`
          : `Imported ${imported.length} cell${imported.length === 1 ? '' : 's'} from ${file.name}. Create or open a notebook, then Save to publish.`,
      });
    } catch (e: any) {
      setBanner({ intent: 'error', text: `Import failed: ${e?.message || String(e)}` });
    }
  }, [openName, attachedPool, pushHistory]);

  // ── Session-config dialog apply (R4-SYN-6) — map the dropdown config to Livy
  //    configure options (== %%configure) and reset the session so the next run
  //    starts sized. ────────────────────────────────────────────────────────
  const applySessionConfig = useCallback(() => {
    setSessionCfg(cfgDraft);
    setSessionConfig(toConfigureOptions(cfgDraft) as unknown as Record<string, unknown>);
    setSessionId(null); setSessionState('none'); liveSessionRef.current = null;
    setCfgDialogOpen(false);
    setBanner({ intent: 'info', text: `Session configured — ${cfgDraft.numExecutors} executor(s) · ${cfgDraft.executorMemoryGb} GB · ${cfgDraft.timeoutMinutes} min idle. The next Run starts a session with these settings.` });
  }, [cfgDraft]);

  // ── Cell ops ───────────────────────────────────────────────────────────────
  const patchCell = useCallback((cid: string, patch: Partial<EditorCell>) => {
    setCells((cs) => cs.map((c) => (c.id === cid ? { ...c, ...patch } : c)));
    setDirty(true);
  }, []);
  // Insert a new cell. `pos` controls placement relative to `anchor`:
  //   'end'    → bottom of the notebook
  //   'after'  → directly below `anchor` (used by the between-cell adders)
  //   'before' → directly above `anchor` (used by the top adder)
  const addCell = useCallback((type: 'code' | 'markdown', anchor?: string, pos: 'end' | 'after' | 'before' = 'end') => {
    pushHistory();
    const nc: EditorCell = { id: uid(), type, lang: type === 'code' ? defaultLang : 'pyspark', source: type === 'markdown' ? '# New markdown cell' : '' };
    setCells((cs) => {
      if (!anchor || pos === 'end') return [...cs, nc];
      const i = cs.findIndex((c) => c.id === anchor);
      if (i < 0) return [...cs, nc];
      const at = pos === 'before' ? i : i + 1;
      return [...cs.slice(0, at), nc, ...cs.slice(at)];
    });
    setActiveCell(nc.id); setDirty(true);
  }, [defaultLang, pushHistory]);
  const duplicateCell = useCallback((cid: string) => {
    pushHistory();
    setCells((cs) => {
      const i = cs.findIndex((c) => c.id === cid);
      if (i < 0) return cs;
      const src = cs[i];
      // Clone without output / running state and without the parameters tag
      // (only one parameters cell is allowed) — Synapse "Copy cell" semantics.
      const copy: EditorCell = { ...src, id: uid(), output: undefined, running: false, isParameters: false };
      return [...cs.slice(0, i + 1), copy, ...cs.slice(i + 1)];
    });
    setDirty(true);
  }, [pushHistory]);
  // Synapse allows exactly one parameters cell — toggling one on clears any other.
  const toggleParameters = useCallback((cid: string) => {
    pushHistory();
    setCells((cs) => cs.map((c) => {
      if (c.id === cid) return { ...c, isParameters: !c.isParameters };
      return c.isParameters ? { ...c, isParameters: false } : c;
    }));
    setDirty(true);
  }, [pushHistory]);
  const deleteCell = useCallback((cid: string) => {
    pushHistory();
    setCells((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== cid)));
    setDirty(true);
  }, [pushHistory]);
  const moveCell = useCallback((cid: string, dir: -1 | 1) => {
    pushHistory();
    setCells((cs) => {
      const i = cs.findIndex((c) => c.id === cid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cs.length) return cs;
      const next = [...cs]; [next[i], next[j]] = [next[j], next[i]]; return next;
    });
    setDirty(true);
  }, [pushHistory]);
  // Drag-to-reorder: move the dragged cell to the drop target's index (R4-SYN-12).
  const moveCellToIndex = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    pushHistory();
    setCells((cs) => {
      if (from >= cs.length || to >= cs.length) return cs;
      const next = [...cs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDirty(true);
  }, [pushHistory]);

  // ── Cell comments (R4-SYN-9) — add / resolve a persisted per-cell comment. ──
  const addComment = useCallback((cid: string, text: string) => {
    const body = text.trim();
    if (!body) return;
    const comment: CellComment = {
      id: `cm-${uid()}`, author: 'You', text: body, at: new Date().toISOString(),
    };
    setCells((cs) => cs.map((c) => (c.id === cid ? { ...c, comments: [...(c.comments || []), comment] } : c)));
    setDirty(true);
  }, []);
  const toggleCommentResolved = useCallback((cid: string, commentId: string) => {
    setCells((cs) => cs.map((c) => (c.id === cid
      ? { ...c, comments: (c.comments || []).map((m) => (m.id === commentId ? { ...m, resolved: !m.resolved } : m)) }
      : c)));
    setDirty(true);
  }, []);

  // ── Independent output collapse (R4-SYN-8). ─────────────────────────────────
  const toggleOutputCollapsed = useCallback((cid: string) => {
    setCells((cs) => cs.map((c) => (c.id === cid ? { ...c, outputCollapsed: !c.outputCollapsed } : c)));
  }, []);

  // ── Snippet insert (R4-SYN-11) — splice a ready-made Spark cell below active. ─
  const insertSnippet = useCallback((snippetId: string) => {
    const snip = SPARK_SNIPPETS.find((x) => x.id === snippetId);
    if (!snip) return;
    pushHistory();
    const nc: EditorCell = { id: uid(), type: 'code', lang: snip.lang, source: snip.source };
    setCells((cs) => {
      const i = activeCell ? cs.findIndex((c) => c.id === activeCell) : -1;
      if (i < 0) return [...cs, nc];
      return [...cs.slice(0, i + 1), nc, ...cs.slice(i + 1)];
    });
    setActiveCell(nc.id); setDirty(true);
  }, [activeCell, pushHistory]);

  // ── Outline — markdown headings (# / ## / ###) → click-to-scroll navigation,
  //    mirroring Synapse Studio's notebook Outline pane. ────────────────────────
  const outline = useMemo(() => {
    const items: { id: string; level: number; text: string }[] = [];
    for (const c of cells) {
      if (c.type !== 'markdown') continue;
      for (const line of c.source.split('\n')) {
        const m = line.match(/^(#{1,3})\s+(.+)$/);
        if (m) { items.push({ id: c.id, level: m[1].length, text: m[2].trim() }); break; }
      }
    }
    return items;
  }, [cells]);

  // ── Run a cell against the attached compute via Livy (create session →
  //    submit → poll). Reuses the warm session across cells (notebook
  //    semantics). Databricks uses the execution-context analog under the same
  //    /api/notebook/[id]/{session,execute} routes. ──────────────────────────
  const computeParam = useCallback((sess: number | string, stmt?: number | string) => {
    const compute = backend === 'databricks' ? attachedCluster : attachedPool;
    const key = backend === 'databricks' ? 'cluster' : 'pool';
    let qs = `${key}=${encodeURIComponent(String(compute))}&sessionId=${encodeURIComponent(String(sess))}`;
    if (stmt != null) qs += `&stmtId=${encodeURIComponent(String(stmt))}`;
    return qs;
  }, [backend, attachedCluster, attachedPool]);

  const applyOutput = useCallback((cid: string, out: any) => {
    execCounterRef.current += 1;
    const executionCount = execCounterRef.current;
    if (!out) { patchCell(cid, { running: false, executionCount, output: { status: 'ok', text: '(no output)' } }); return; }
    if (out.status === 'error') {
      patchCell(cid, { running: false, executionCount, output: { status: 'error', ename: out.ename, evalue: out.evalue, traceback: out.traceback, text: out.evalue } });
      return;
    }
    patchCell(cid, {
      running: false,
      executionCount,
      output: {
        status: 'ok',
        text: out.textPlain || (out.textHtml || out.tableRows || out.imageBase64 ? '' : '(no output)'),
        html: out.textHtml || undefined,
        tableColumns: out.tableColumns || undefined,
        tableRows: out.tableRows || undefined,
        imageBase64: out.imageBase64 || undefined,
      },
    });
  }, [patchCell]);

  // Clear a cell's live-progress entry (R4-SYN-5) once the statement settles.
  const clearProgress = useCallback((cid: string) => {
    setProgressByCell((p) => { if (!(cid in p)) return p; const n = { ...p }; delete n[cid]; return n; });
  }, []);

  const pollStatement = useCallback(async (sess: number | string, stmt: number | string, cid: string) => {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/execute?${computeParam(sess, stmt)}`);
      const j = await r.json();
      if (!j?.ok) { clearProgress(cid); patchCell(cid, { running: false, output: { status: 'error', text: j?.error || 'poll failed' } }); return; }
      // R4-SYN-5 — surface the real Livy statement progress (0..1) as a live bar.
      // Livy exposes fractional progress, not stage/task counts, so we show the
      // honest percentage + the Spark UI drill-down (never fabricated counts).
      if (typeof j.progress === 'number') {
        setProgressByCell((p) => ({ ...p, [cid]: clampProgress(j.progress) }));
      }
      const st = String(j.state);
      if (st === 'available') { clearProgress(cid); applyOutput(cid, j.output); return; }
      if (st === 'error' || st === 'cancelled') {
        clearProgress(cid);
        if (j.output) applyOutput(cid, j.output);
        else patchCell(cid, { running: false, output: { status: 'error', text: `statement ${st}` } });
        return;
      }
    }
    clearProgress(cid);
    patchCell(cid, { running: false, output: { status: 'error', text: 'timed out polling statement' } });
  }, [id, computeParam, patchCell, applyOutput, clearProgress]);

  const runCell = useCallback(async (cid: string): Promise<void> => {
    const cell = cells.find((c) => c.id === cid);
    if (!cell || cell.type !== 'code') return;
    const compute = backend === 'databricks' ? attachedCluster : attachedPool;
    if (!compute) {
      setBanner({ intent: 'info', text: backend === 'databricks' ? 'Attach a Databricks cluster before running.' : 'Attach a Spark pool before running.' });
      return;
    }

    // %%configure interception — store the compute options for the next session
    // (re)create; the session must be restarted for them to take effect.
    if (isConfigureCell(cell.source)) {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/execute`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pool: attachedPool, cluster: attachedCluster, sessionId: sessionId ?? undefined, code: cell.source, kind: cell.lang }),
      });
      const j = await r.json();
      if (!j?.ok) { patchCell(cid, { running: false, output: { status: 'error', text: j?.error || '%%configure invalid' } }); return; }
      setSessionConfig(j.configureOptions || {});
      setSessionId(null); setSessionState('none'); liveSessionRef.current = null;
      patchCell(cid, { running: false, output: { status: 'ok', text: '%%configure applied. The session was reset; the next run starts a session with these settings.' } });
      setBanner({ intent: 'info', text: '%%configure stored. The next Run starts a fresh session with the new compute settings.' });
      return;
    }

    patchCell(cid, { running: true, output: { status: 'running', text: 'Submitting…' } });
    try {
      // R4-SYN-4 — %run reference: resolve the referenced published notebook's
      // PySpark definitions into a preamble and run THAT in the warm session, so
      // its functions/vars become available (Synapse %run semantics). Enforces
      // published-only (the workspace GET) + non-recursive (buildRunPreamble).
      let codeToRun = cell.source;
      const runRef = parseRunReference(cell.source);
      if (runRef) {
        patchCell(cid, { running: true, output: { status: 'running', text: `Resolving %run ${runRef}…` } });
        try {
          const rr = await clientFetch(`/api/synapse/notebooks/${encodeURIComponent(runRef)}`);
          const rj = await rr.json();
          if (!rj?.ok) {
            throw new Error(`Referenced notebook "${runRef}" not found — Synapse %run resolves PUBLISHED workspace notebooks only.`);
          }
          const refCells = ipynbToCells(rj.notebook?.properties || {});
          codeToRun = buildRunPreamble(refCells, runRef);
        } catch (e: any) {
          clearProgress(cid);
          patchCell(cid, { running: false, output: { status: 'error', text: e?.message || String(e) } });
          return;
        }
      }

      // 1. Ensure a live, idle session (create or reuse). Poll to idle.
      let sess = sessionId;
      for (let attempt = 0; attempt < 90; attempt++) {
        const sr = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/session`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pool: attachedPool, cluster: attachedCluster,
            kind: cell.lang,
            existingSessionId: backend === 'synapse' && typeof sess === 'number' ? sess : undefined,
            existingContextId: backend === 'databricks' && typeof sess === 'string' ? sess : undefined,
            configureOptions: backend === 'synapse' && sessionConfig ? sessionConfig : undefined,
          }),
        });
        const sj = await sr.json();
        if (!sj?.ok) { patchCell(cid, { running: false, output: { status: 'error', text: sj?.error || 'session failed' } }); return; }
        sess = sj.sessionId; setSessionId(sj.sessionId);
        // R4-SYN-5 — resolve the real Spark UI URL from the session app info for
        // the running-cell drill-down link (no fabricated URL).
        if (sj.appInfo?.sparkUiUrl) setSparkUiUrl(sj.appInfo.sparkUiUrl);
        if (sj.state !== 'idle') {
          setSessionState(sj.state || 'starting');
          // Poll the session GET until idle.
          await new Promise((r2) => setTimeout(r2, 3000));
          const gr = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/session?${computeParam(sess!)}`);
          const gj = await gr.json();
          if (gj?.ok) { setSessionState(gj.state); sess = gj.sessionId ?? sess; if (gj.appInfo?.sparkUiUrl) setSparkUiUrl(gj.appInfo.sparkUiUrl); }
          if (gj?.state === 'idle') break;
          continue;
        }
        break;
      }
      if (sess == null) { patchCell(cid, { running: false, output: { status: 'error', text: 'Spark session did not become ready in time' } }); return; }

      setSessionState('busy');
      liveSessionRef.current = { compute, sessionId: sess };

      // 2. Submit the statement (codeToRun carries the %run preamble when set).
      const er = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/execute`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pool: attachedPool, cluster: attachedCluster, sessionId: sess, code: codeToRun, kind: cell.lang }),
      });
      const ej = await er.json();
      if (!ej?.ok) {
        if (ej?.sessionDead) { setSessionId(null); setSessionState('none'); liveSessionRef.current = null; }
        patchCell(cid, { running: false, output: { status: 'error', text: ej?.error || 'run failed' } });
        return;
      }
      if (ej.configureApplied) { setSessionConfig(ej.configureOptions || {}); patchCell(cid, { running: false, output: { status: 'ok', text: '%%configure applied.' } }); return; }
      if (ej.sessionWarming || ej.stmtId == null) {
        // Session warmed between the POSTs above and this one — retry once.
        setSessionState(ej.state || 'starting');
        await new Promise((r3) => setTimeout(r3, 3000));
        return runCell(cid);
      }

      // 3. Poll the statement to completion.
      await pollStatement(sess, ej.stmtId, cid);
      setSessionState('idle');
    } catch (e: any) {
      clearProgress(cid);
      patchCell(cid, { running: false, output: { status: 'error', text: e?.message || String(e) } });
    }
  }, [cells, backend, attachedPool, attachedCluster, sessionId, sessionConfig, id, computeParam, patchCell, pollStatement, clearProgress]);

  const runAll = useCallback(async () => {
    for (const c of cells) {
      if (c.type === 'code' && c.source.trim()) {
        // eslint-disable-next-line no-await-in-loop
        await runCell(c.id);
      }
    }
  }, [cells, runCell]);

  // Convert a cell between code ⇄ markdown (shared CodeCell / MarkdownCell action).
  const convertCell = useCallback((cid: string, type: 'code' | 'markdown') => {
    pushHistory();
    patchCell(cid, { type, output: undefined, running: false, ...(type === 'markdown' ? { isParameters: false } : {}) });
  }, [patchCell, pushHistory]);

  // Insert a generated code cell below the active cell (Data Wrangler export-to-cell).
  const insertWranglerCell = useCallback((source: string) => {
    pushHistory();
    const nc: EditorCell = { id: uid(), type: 'code', lang: 'pyspark', source };
    setCells((cs) => {
      const i = activeCell ? cs.findIndex((c) => c.id === activeCell) : -1;
      if (i < 0) return [...cs, nc];
      return [...cs.slice(0, i + 1), nc, ...cs.slice(i + 1)];
    });
    setActiveCell(nc.id);
    setDirty(true);
    setWranglerOpen(false);
    setBanner({ intent: 'info', text: 'Inserted Data Wrangler code cell — review and Run to apply on your full DataFrame.' });
  }, [activeCell, pushHistory]);

  // ── Command-mode keyboard shortcuts (R4-SYN-7) — the Synapse Studio modal
  //    keymap. Esc leaves the editor into command mode; A/B insert, J/K select,
  //    Shift+D deletes, Enter edits, M/Y convert, and Ctrl/⌘+Z / Shift+Z drive
  //    cell-op undo/redo. Refs keep the listener stable while reading live state.
  const activeCellRef = useRef<string | null>(activeCell);
  useEffect(() => { activeCellRef.current = activeCell; }, [activeCell]);
  const focusCellEditor = useCallback((cid: string) => {
    const el = document.getElementById(`cell-${cid}`);
    const ta = el?.querySelector('.monaco-editor textarea, textarea') as HTMLTextAreaElement | null;
    if (ta) { ta.focus(); return true; }
    return false;
  }, []);
  useEffect(() => {
    if (gate) return; // no cells surface while the workspace is gated
    const inEditable = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      if (node.isContentEditable) return true;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return !!node.closest?.('.monaco-editor');
    };
    const onKey = (e: KeyboardEvent) => {
      // Cell-op undo/redo works anywhere the user isn't typing text.
      const editing = inEditable(document.activeElement);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z') && !editing) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y') && !editing) { e.preventDefault(); redo(); return; }

      if (e.key === 'Escape') {
        // Leave the editor into command mode (focus the cells container).
        (document.activeElement as HTMLElement | null)?.blur?.();
        setCommandMode(true);
        cellsContainerRef.current?.focus?.();
        return;
      }
      if (editing || !commandMode) return; // command keys only in command mode
      const active = activeCellRef.current;
      const list = cellsRef.current;
      const idx = active ? list.findIndex((c) => c.id === active) : -1;
      switch (e.key) {
        case 'a': case 'A':
          e.preventDefault(); addCell('code', active || undefined, 'before'); break;
        case 'b': case 'B':
          e.preventDefault(); addCell('code', active || undefined, 'after'); break;
        case 'j': case 'ArrowDown': {
          e.preventDefault();
          const next = idx < 0 ? list[0] : list[Math.min(list.length - 1, idx + 1)];
          if (next) { setActiveCell(next.id); document.getElementById(`cell-${next.id}`)?.scrollIntoView({ block: 'nearest' }); }
          break;
        }
        case 'k': case 'ArrowUp': {
          e.preventDefault();
          const prev = idx < 0 ? list[0] : list[Math.max(0, idx - 1)];
          if (prev) { setActiveCell(prev.id); document.getElementById(`cell-${prev.id}`)?.scrollIntoView({ block: 'nearest' }); }
          break;
        }
        case 'D':
          if (e.shiftKey && active) { e.preventDefault(); deleteCell(active); }
          break;
        case 'm': case 'M':
          if (active) { e.preventDefault(); convertCell(active, 'markdown'); }
          break;
        case 'y': case 'Y':
          if (active) { e.preventDefault(); convertCell(active, 'code'); }
          break;
        case 'Enter':
          if (active) { e.preventDefault(); setCommandMode(false); focusCellEditor(active); }
          break;
        default: break;
      }
    };
    // Typing into a cell editor leaves command mode so the badge never lingers.
    const onFocusIn = (e: FocusEvent) => { if (inEditable(e.target)) setCommandMode(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('focusin', onFocusIn);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('focusin', onFocusIn); };
  }, [gate, commandMode, addCell, deleteCell, convertCell, undo, redo, focusCellEditor]);

  // ── Variable explorer (R4-SYN-2) — inspect the live Livy/Databricks Python
  //    session for user variables (Name / Type / Length / Value). Reuses the
  //    warm session + the same session/execute run path as cells; Python-only,
  //    exactly like Synapse Studio / Fabric. No mock — a real globals() snapshot. ──
  const inspectVariables = useCallback(async (): Promise<VarRow[]> => {
    const compute = backend === 'databricks' ? attachedCluster : attachedPool;
    if (!compute) {
      throw new Error(backend === 'databricks'
        ? 'Attach a Databricks cluster before inspecting variables.'
        : 'Attach a Spark pool before inspecting variables.');
    }
    const INSPECT_SOURCE = [
      'import json as __loom_j__',
      '__loom_v__ = []',
      "__loom_skip__ = ('In','Out','exit','quit','get_ipython','spark','sc','sqlContext','spark_session')",
      'for __loom_k__ in list(globals().keys()):',
      "    if __loom_k__.startswith('_') or __loom_k__ in __loom_skip__:",
      '        continue',
      '    __loom_val__ = globals()[__loom_k__]',
      "    if type(__loom_val__).__name__ in ('module','function','type','builtin_function_or_method'):",
      '        continue',
      '    try:',
      "        __loom_l__ = len(__loom_val__) if hasattr(__loom_val__, '__len__') else None",
      '    except Exception:',
      '        __loom_l__ = None',
      '    try:',
      '        __loom_r__ = repr(__loom_val__)[:300]',
      '    except Exception:',
      "        __loom_r__ = '<unrepresentable>'",
      "    __loom_v__.append({'n': __loom_k__, 't': type(__loom_val__).__name__, 'l': __loom_l__, 'r': __loom_r__})",
      "print('__LOOM_VARS__:' + __loom_j__.dumps(__loom_v__))",
      'del __loom_j__, __loom_v__, __loom_skip__',
    ].join('\n');

    // 1. Ensure a live, idle session (reuse the warm one across cells).
    let sess = sessionId;
    for (let attempt = 0; attempt < 90; attempt++) {
      const sr = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pool: attachedPool, cluster: attachedCluster, kind: 'pyspark',
          existingSessionId: backend === 'synapse' && typeof sess === 'number' ? sess : undefined,
          existingContextId: backend === 'databricks' && typeof sess === 'string' ? sess : undefined,
          configureOptions: backend === 'synapse' && sessionConfig ? sessionConfig : undefined,
        }),
      });
      const sj = await sr.json();
      if (!sj?.ok) throw new Error(sj?.error || 'Spark session failed to start.');
      sess = sj.sessionId; setSessionId(sj.sessionId);
      if (sj.state !== 'idle') {
        setSessionState(sj.state || 'starting');
        await new Promise((r) => setTimeout(r, 3000));
        const gr = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/session?${computeParam(sess!)}`);
        const gj = await gr.json();
        if (gj?.ok) { setSessionState(gj.state); sess = gj.sessionId ?? sess; }
        if (gj?.state === 'idle') break;
        continue;
      }
      break;
    }
    if (sess == null) throw new Error('Spark session did not become ready in time.');
    setSessionState('busy'); liveSessionRef.current = { compute, sessionId: sess };

    // 2. Submit the introspection statement.
    const er = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pool: attachedPool, cluster: attachedCluster, sessionId: sess, code: INSPECT_SOURCE, kind: 'pyspark' }),
    });
    const ej = await er.json();
    if (!ej?.ok) {
      if (ej?.sessionDead) { setSessionId(null); setSessionState('none'); liveSessionRef.current = null; }
      throw new Error(ej?.error || 'Variable inspection failed to dispatch.');
    }
    if (ej.stmtId == null) throw new Error('The kernel did not accept the inspection statement — try again once the session is warm.');

    // 3. Poll to completion + parse the __LOOM_VARS__ line.
    let text = '';
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(id)}/execute?${computeParam(sess, ej.stmtId)}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || 'Polling the inspection statement failed.');
      const st = String(j.state);
      if (st === 'available') {
        setSessionState('idle');
        if (j.output?.status === 'error') throw new Error(`${j.output.ename || 'Error'}: ${j.output.evalue || 'kernel raised an error'}`);
        text = j.output?.textPlain || '';
        break;
      }
      if (st === 'error' || st === 'cancelled') { setSessionState('idle'); throw new Error(`Inspection statement ${st}.`); }
    }

    const markerIdx = text.lastIndexOf('__LOOM_VARS__:');
    if (markerIdx < 0) return [];
    const jsonStr = text.slice(markerIdx + '__LOOM_VARS__:'.length).split('\n')[0].trim();
    let raw: Array<{ n: string; t: string; l: number | null; r: string }>;
    try { raw = JSON.parse(jsonStr); } catch { throw new Error('Could not parse the kernel variable snapshot.'); }
    return raw.map((x) => ({ name: x.n, type: x.t, len: x.l, repr: x.r }));
  }, [backend, attachedCluster, attachedPool, sessionId, sessionConfig, id, computeParam]);

  const attachedCompute = backend === 'databricks' ? attachedCluster : attachedPool;
  const cellRuntime: 'databricks' | 'synapse-spark' = backend === 'databricks' ? 'databricks' : 'synapse-spark';

  const canUndo = historyPast.current.length > 0;
  const canRedo = historyFuture.current.length > 0;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: 'Run all', onClick: openName && attachedCompute ? runAll : undefined, disabled: !openName || !attachedCompute, title: !attachedCompute ? (backend === 'databricks' ? 'Attach a Databricks cluster first' : 'Attach a Spark pool first') : undefined },
      ]},
      { label: 'Edit', actions: [
        { label: 'Undo', icon: <ArrowUndo20Regular />, onClick: canUndo ? undo : undefined, disabled: !canUndo, title: 'Undo the last cell operation (Ctrl+Z)' },
        { label: 'Redo', icon: <ArrowRedo20Regular />, onClick: canRedo ? redo : undefined, disabled: !canRedo, title: 'Redo the last undone cell operation (Ctrl+Shift+Z)' },
      ]},
      { label: 'Cells', actions: [
        { label: 'Add code', onClick: () => addCell('code', activeCell || undefined, 'after') },
        { label: 'Add markdown', onClick: () => addCell('markdown', activeCell || undefined, 'after') },
        { label: 'Duplicate', onClick: activeCell ? () => duplicateCell(activeCell) : undefined, disabled: !activeCell },
        { label: 'Parameters cell', onClick: activeCell ? () => toggleParameters(activeCell) : undefined, disabled: !activeCell, title: 'Mark the active code cell as the papermill/ADF parameters cell' },
        {
          label: 'Snippets', icon: <Code20Regular />,
          title: 'Insert a ready-made Spark snippet below the active cell',
          dropdownItems: SPARK_SNIPPETS.map((sn) => ({ label: sn.label, onClick: () => insertSnippet(sn.id) })),
        },
      ]},
      { label: 'Notebook', actions: [
        { label: saving ? 'Saving…' : 'Save', icon: <Save20Regular />, onClick: openName && !saving ? save : undefined, disabled: !openName || saving },
        { label: 'Import', icon: <ArrowUpload20Regular />, onClick: () => importInputRef.current?.click(), title: 'Import a standard .ipynb into the editor' },
        { label: 'Export', icon: <ArrowDownload20Regular />, onClick: exportIpynb, title: 'Download the current notebook as a standard .ipynb' },
        { label: 'Delete', onClick: openName ? deleteOpen : undefined, disabled: !openName },
        { label: 'Refresh', onClick: refreshList },
      ]},
      { label: 'Session', actions: [
        { label: 'Configure session', icon: <Settings20Regular />, onClick: () => { setCfgDraft(sessionCfg); setCfgDialogOpen(true); }, title: 'Size the Spark session (executors / memory / idle timeout) — the dropdown twin of %%configure' },
      ]},
      { label: 'Scheduling', actions: [
        { label: 'Schedule', icon: <CalendarClock20Regular />, onClick: openName ? () => setScheduleWizardOpen(true) : undefined, disabled: !openName, title: !openName ? 'Open a notebook first' : 'Create a recurrence schedule (Azure ML job schedule)' },
      ]},
      { label: 'Tools', actions: [
        { label: 'Variables', onClick: () => setVariablesOpen(true), title: 'Variable explorer — inspect the live Python session (Name / Type / Length / Value)' },
        { label: 'Data Wrangler', onClick: () => setWranglerOpen(true), title: 'Visual data-prep — build cleaning steps and export pandas / PySpark code into a cell' },
        { label: 'Shortcuts', icon: <Keyboard20Regular />, onClick: () => setShortcutsOpen(true), title: 'Show the command-mode keyboard shortcuts' },
      ]},
    ]},
  ], [openName, attachedCompute, backend, runAll, addCell, activeCell, duplicateCell, toggleParameters, saving, save, deleteOpen, refreshList, canUndo, canRedo, undo, redo, insertSnippet, exportIpynb, sessionCfg]);

  return (
    <ItemEditorChrome splitKeyPrefix={item.slug}
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          {gate ? (
            <Caption1>Workspace not configured.</Caption1>
          ) : (
            <>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalS }}>
                <Input
                  size="small" placeholder="new notebook name" value={newName}
                  onChange={(_, d) => setNewName(d.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createNotebook(); }}
                  aria-label="New notebook name"
                />
                <Button size="small" icon={<Add20Regular />} onClick={createNotebook} disabled={!newName.trim()} aria-label="Create notebook" />
              </div>
              <Tree aria-label="Workspace notebooks" defaultOpenItems={['nb']}>
                <TreeItem itemType="branch" value="nb">
                  <TreeItemLayout iconBefore={<Book20Regular />}>
                    Notebooks ({notebooks.length})
                  </TreeItemLayout>
                  <Tree>
                    {loadingList && (
                      <TreeItem itemType="leaf" value="loading"><TreeItemLayout><Spinner size="tiny" /></TreeItemLayout></TreeItem>
                    )}
                    {!loadingList && notebooks.length === 0 && (
                      <TreeItem itemType="leaf" value="empty"><TreeItemLayout>No notebooks yet</TreeItemLayout></TreeItem>
                    )}
                    {notebooks.map((n) => (
                      <TreeItem key={n.name} itemType="leaf" value={`n-${n.name}`} onClick={() => openNotebook(n.name)}>
                        <TreeItemLayout iconBefore={<Book20Regular />}>
                          {n.name} {openName === n.name && '·'}
                          {n.pool && <Caption1> · {n.pool}</Caption1>}
                        </TreeItemLayout>
                      </TreeItem>
                    ))}
                  </Tree>
                </TreeItem>
              </Tree>

              {/* Outline — markdown headings → click-to-scroll, like Synapse Studio. */}
              <div className={s.outlineHead}>
                <TextBulletListTree20Regular />
                <Caption1>Outline</Caption1>
              </div>
              <div role="navigation" aria-label="Outline">
                {outline.length === 0 ? (
                  <div className={s.outlineEmpty}>No headings yet — add a markdown cell with a # heading.</div>
                ) : (
                  outline.map((o, idx) => (
                    <button
                      key={`${o.id}-${idx}`}
                      type="button"
                      className={s.outlineItem}
                      style={{ paddingLeft: 4 + (o.level - 1) * 14 }}
                      onClick={() => {
                        setActiveCell(o.id);
                        document.getElementById(`cell-${o.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                    >
                      {o.text}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      }
      main={
        <div className={s.pad}>
          {/* SC-6 — teaching banner: real Synapse Spark Livy backend + session model. */}
          <TeachingBanner
            surfaceKey="synapse-notebook"
            title="Cells run as real Spark statements over Synapse Livy"
            message="Each Run submits to a live Synapse Spark session (a warm pool keeps startup fast); the run path publishes the notebook via the Synapse Artifact Publisher role and executes against your workspace — never a mock. The status line tracks the session state, and Copilot can draft or explain a cell inline. Azure-native — no Microsoft Fabric required."
            learnMoreHref={loomDocUrl('fiab/parity/synapse-notebook')}
          />
          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Synapse workspace not configured</MessageBarTitle>
                Set <strong>{gate.missing}</strong> on the console container app to the Synapse
                workspace name. The notebook designer and Spark Livy run path light up once it is set
                and the Loom UAMI holds the <strong>Synapse Artifact Publisher</strong> role on the
                workspace. Bicep: <code>platform/fiab/bicep/modules/synapse/*.bicep</code>.
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={refreshList}>Re-check</Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {banner && (
            <MessageBar intent={banner.intent}>
              <MessageBarBody>{banner.text}</MessageBarBody>
              <MessageBarActions><Button size="small" onClick={() => setBanner(null)}>Dismiss</Button></MessageBarActions>
            </MessageBar>
          )}

          {/* Hidden file input for IPYNB import (R4-SYN-10). */}
          <input
            ref={importInputRef}
            type="file"
            accept=".ipynb,application/json"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importIpynb(f); }}
            aria-hidden="true"
          />

          {!gate && (
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">Notebook</Badge>
              <Body1>{openName || 'no notebook open'}</Body1>
              {dirty && <Badge appearance="outline" color="warning" size="small">unsaved</Badge>}
              {commandMode && <Badge appearance="tint" color="informative" size="small" title="Command mode — A/B insert · J/K select · Shift+D delete · Enter edits. Click a cell editor to leave.">command mode</Badge>}
              {backend === 'databricks' && <Badge appearance="tint" color="important">Backend: Databricks</Badge>}
              {sessionConfig && Object.keys(sessionConfig).length > 0 && <Badge appearance="outline" color="brand" size="small">%%configure pending</Badge>}
              {sparkUiUrl && (sessionState === 'busy' || sessionState === 'idle') && (
                <Link href={sparkUiUrl} target="_blank" rel="noreferrer" title="Open the Spark application UI (jobs / stages)">
                  <Caption1><Open16Regular style={{ verticalAlign: 'middle' }} /> Spark UI</Caption1>
                </Link>
              )}
              <div className={s.spacer} />
              <Caption1>Language:</Caption1>
              <Dropdown
                size="small"
                value={KIND_LABEL[defaultLang]}
                selectedOptions={[defaultLang]}
                onOptionSelect={(_, d) => { if (d.optionValue) { setDefaultLang(d.optionValue as CellKind); setDirty(true); } }}
                aria-label="Default cell language"
                style={{ minWidth: 150 }}
              >
                {(Object.keys(KIND_LABEL) as CellKind[]).map((k) => (
                  <Option key={k} value={k} text={KIND_LABEL[k]}>{KIND_LABEL[k]}</Option>
                ))}
              </Dropdown>
              <Caption1>Attach:</Caption1>
              {backend === 'databricks' ? (
                <Dropdown
                  size="small"
                  placeholder="Databricks cluster"
                  value={attachedCluster || ''}
                  selectedOptions={attachedCluster ? [attachedCluster] : []}
                  onOptionSelect={(_, d) => { setAttachedCluster(d.optionValue || null); setSessionId(null); setSessionState('none'); liveSessionRef.current = null; }}
                  aria-label="Attach Databricks cluster"
                  style={{ minWidth: 200 }}
                >
                  {clusters.length === 0 && <Option value="" disabled>no clusters in workspace</Option>}
                  {clusters.map((c) => (
                    <Option key={c.cluster_id} value={c.cluster_id} text={c.cluster_name || c.cluster_id}>
                      {c.cluster_name || c.cluster_id} {c.state ? `· ${c.state}` : ''}
                    </Option>
                  ))}
                </Dropdown>
              ) : (
                <>
                  <Dropdown
                    size="small"
                    placeholder="Spark pool"
                    value={attachedPool || ''}
                    selectedOptions={attachedPool ? [attachedPool] : []}
                    onOptionSelect={(_, d) => { setAttachedPool(d.optionValue || null); setSessionId(null); setSessionState('none'); liveSessionRef.current = null; setDirty(true); }}
                    aria-label="Attach Spark pool"
                    style={{ minWidth: 180 }}
                  >
                    {pools.length === 0 && <Option value="" disabled>no Spark pools in workspace</Option>}
                    {pools.map((p) => (
                      <Option key={p.name} value={p.name} text={p.name}>
                        {p.name} {p.properties?.nodeSize ? `· ${p.properties.nodeSize}` : ''}
                      </Option>
                    ))}
                  </Dropdown>
                  <Dropdown
                    size="small"
                    placeholder="Environment"
                    value={attachedEnv || ''}
                    selectedOptions={attachedEnv ? [attachedEnv] : ['']}
                    onOptionSelect={(_, d) => { setAttachedEnv(d.optionValue || null); setDirty(true); }}
                    aria-label="Attach environment (Spark configuration)"
                    title="Spark configuration applied to the session"
                    style={{ minWidth: 160 }}
                  >
                    <Option value="" text="(no environment)">(no environment)</Option>
                    {environments.map((e) => (
                      <Option key={e.name} value={e.name} text={e.name}>
                        {e.name}{e.sparkVersion ? ` · Spark ${e.sparkVersion}` : ''}
                      </Option>
                    ))}
                  </Dropdown>
                </>
              )}
              <Badge appearance="outline" color={sessionState === 'idle' ? 'success' : sessionState === 'busy' || sessionState === 'starting' ? 'warning' : 'informative'}>
                session: {sessionId != null ? `${sessionId} (${sessionState})` : 'none'}
              </Badge>
              <Button appearance="primary" icon={<Save20Regular />} disabled={!openName || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}

          {!gate && (
            <div className={s.cells} ref={cellsContainerRef} tabIndex={-1}>
              <CellAdder
                onAddCode={() => addCell('code', cells[0]?.id, 'before')}
                onAddMarkdown={() => addCell('markdown', cells[0]?.id, 'before')}
              />
              {cells.map((c, i) => (
                <div
                  key={c.id}
                  id={`cell-${c.id}`}
                  onDragOver={(e) => { if (dragIndexRef.current != null) { e.preventDefault(); setDragOverId(c.id); } }}
                  onDrop={(e) => { e.preventDefault(); const from = dragIndexRef.current; if (from != null) moveCellToIndex(from, i); dragIndexRef.current = null; setDragOverId(null); }}
                  className={dragOverId === c.id ? s.cellDragOver : undefined}
                >
                  {c.type === 'markdown' ? (
                    <MarkdownCell
                      cell={toSharedCell(c)}
                      active={activeCell === c.id}
                      onFocus={() => setActiveCell(c.id)}
                      onChange={(next) => patchCell(c.id, mergeSharedChange(c, next))}
                      onDelete={() => deleteCell(c.id)}
                      onMoveUp={() => moveCell(c.id, -1)}
                      onMoveDown={() => moveCell(c.id, 1)}
                      onDuplicate={() => duplicateCell(c.id)}
                      onConvertToCode={() => convertCell(c.id, 'code')}
                      canMoveUp={i > 0}
                      canMoveDown={i < cells.length - 1}
                      dragHandleProps={{
                        draggable: true,
                        onDragStart: () => { dragIndexRef.current = i; },
                        onDragEnd: () => { dragIndexRef.current = null; setDragOverId(null); },
                      }}
                    />
                  ) : (
                    <>
                      {c.isParameters && (
                        <div className={s.paramsChip}>
                          <Badge appearance="filled" color="brand" size="small">parameters cell</Badge>
                          <Caption1 className={s.tag}>values can be overridden when the notebook runs from a pipeline (papermill/ADF)</Caption1>
                        </div>
                      )}
                      <CodeCell
                        cell={toSharedCell(c)}
                        active={activeCell === c.id}
                        onFocus={() => setActiveCell(c.id)}
                        onChange={(next) => patchCell(c.id, mergeSharedChange(c, next))}
                        onRun={attachedCompute ? () => runCell(c.id) : undefined}
                        onDelete={() => deleteCell(c.id)}
                        onMoveUp={() => moveCell(c.id, -1)}
                        onMoveDown={() => moveCell(c.id, 1)}
                        onDuplicate={() => duplicateCell(c.id)}
                        onConvertToMarkdown={() => convertCell(c.id, 'markdown')}
                        canMoveUp={i > 0}
                        canMoveDown={i < cells.length - 1}
                        dragHandleProps={{
                          draggable: true,
                          onDragStart: () => { dragIndexRef.current = i; },
                          onDragEnd: () => { dragIndexRef.current = null; setDragOverId(null); },
                        }}
                        notebookId={id}
                        runtime={cellRuntime}
                        priorCells={cells.slice(0, i).filter((pc) => pc.type === 'code').slice(-3).map((pc) => pc.source)}
                        schemaContext={clientSchemaContext}
                        onInsertBelow={(newCell) => {
                          const nc: EditorCell = {
                            id: newCell.id || uid(),
                            type: newCell.type === 'markdown' ? 'markdown' : 'code',
                            lang: newCell.type === 'markdown' ? 'pyspark' : (LANG_TO_KIND[newCell.lang || 'pyspark'] || 'pyspark'),
                            source: newCell.source,
                          };
                          setCells((cs) => {
                            const idx = cs.findIndex((x) => x.id === c.id);
                            if (idx < 0) return [...cs, nc];
                            return [...cs.slice(0, idx + 1), nc, ...cs.slice(idx + 1)];
                          });
                          setActiveCell(nc.id); setDirty(true);
                        }}
                      />
                      {/* Output header — independent output collapse (R4-SYN-8). */}
                      {!c.collapsed && c.output && (
                        <div className={s.outputHeader}>
                          <Button
                            size="small" appearance="subtle"
                            icon={c.outputCollapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
                            onClick={() => toggleOutputCollapsed(c.id)}
                          >
                            {c.outputCollapsed ? 'Show output' : 'Output'}
                          </Button>
                        </div>
                      )}
                      {!c.collapsed && !c.outputCollapsed && (
                        <SynapseCellOutput out={c.output} cellId={c.id} notebookId={id} progress={progressByCell[c.id]} sparkUiUrl={sparkUiUrl} />
                      )}
                    </>
                  )}
                  {/* Per-cell comment thread (R4-SYN-9) — persists with the notebook. */}
                  <CellCommentBar
                    comments={c.comments}
                    onAdd={(text) => addComment(c.id, text)}
                    onToggleResolve={(cmid) => toggleCommentResolved(c.id, cmid)}
                  />
                  <CellAdder
                    onAddCode={() => addCell('code', c.id, 'after')}
                    onAddMarkdown={() => addCell('markdown', c.id, 'after')}
                  />
                </div>
              ))}
            </div>
          )}

          {/* ── Notebook schedules (AML job schedules) ───────────────────────── */}
          {!gate && schedulesConfigured === false && scheduleGateHint && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Notebook scheduling not configured</MessageBarTitle>
                {scheduleGateHint} Bicep: <code>platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep</code>.
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={refreshSchedules}>Re-check</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {!gate && schedulesConfigured && (
            <div className={s.scheduleCard}>
              <div className={s.scheduleHead}>
                <CalendarClock20Regular />
                <Subtitle2>Schedules ({schedules.length})</Subtitle2>
                <div className={s.spacer} />
                <Button size="small" appearance="subtle" onClick={refreshSchedules}>Refresh</Button>
              </div>
              {schedules.length === 0 ? (
                <EmptyState
                  icon={<CalendarClock20Regular />}
                  title="No schedules yet"
                  body="Run this notebook on a recurrence with an Azure ML job schedule. Click Schedule in the ribbon to create one."
                  primaryAction={openName ? { label: 'Create schedule', onClick: () => setScheduleWizardOpen(true) } : undefined}
                />
              ) : (
                <Table size="extra-small" aria-label="Notebook schedules">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Recurrence</TableHeaderCell>
                      <TableHeaderCell>Start</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {schedules.map((sc) => (
                      <TableRow key={sc.name}>
                        <TableCell>{sc.displayName || sc.name}</TableCell>
                        <TableCell>Every {sc.interval ?? 1} {String(sc.frequency || '').toLowerCase()}</TableCell>
                        <TableCell>{sc.startTime ? new Date(sc.startTime).toLocaleString() : '—'}</TableCell>
                        <TableCell>
                          <Switch
                            label={sc.isEnabled ? 'Enabled' : 'Disabled'}
                            checked={sc.isEnabled}
                            onChange={(_, d) => toggleSchedule(sc.name, d.checked)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}

          <ScheduleWizard
            open={scheduleWizardOpen}
            onClose={() => { setScheduleWizardOpen(false); setScheduleError(null); }}
            onCreate={createSchedule}
            busy={scheduleBusy}
            error={scheduleError}
          />

          {/* Variable explorer (R4-SYN-2) — inspects the live Livy/Databricks
              session via the same session/execute path as cell runs. Python-only. */}
          <VariablesPane
            open={variablesOpen}
            onOpenChange={setVariablesOpen}
            onInspect={inspectVariables}
            defaultLang={defaultLang}
          />

          {/* Data Wrangler (R4-SYN-3) — visual data-prep over a real pandas host;
              exports pandas / PySpark code into a notebook cell. */}
          <DataWranglerPanel
            open={wranglerOpen}
            onOpenChange={setWranglerOpen}
            onInsertCell={(source) => insertWranglerCell(source)}
            dfVar="df"
            itemType={item.slug}
            itemId={id}
          />

          {/* Configure session dialog (R4-SYN-6) — dropdown twin of %%configure. */}
          <SessionConfigDialog
            open={cfgDialogOpen}
            config={cfgDraft}
            onConfigChange={setCfgDraft}
            onApply={applySessionConfig}
            onClose={() => setCfgDialogOpen(false)}
          />

          {/* Command-mode keyboard shortcuts reference (R4-SYN-7). */}
          <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} styles={s} />
        </div>
      }
    />
  );
}

// ── Command-mode shortcut reference (R4-SYN-7) — mirrors Synapse Studio's
//    "Use shortcut keys" table so the modal keymap is discoverable. ──
function ShortcutsDialog({ open, onClose, styles }: { open: boolean; onClose: () => void; styles: ReturnType<typeof useStyles> }) {
  const rows: [string, string][] = [
    ['Esc', 'Enter command mode (leave the cell editor)'],
    ['Enter', 'Edit the selected cell'],
    ['A', 'Insert a code cell above'],
    ['B', 'Insert a code cell below'],
    ['J / ↓', 'Select the next cell'],
    ['K / ↑', 'Select the previous cell'],
    ['Shift + D', 'Delete the selected cell'],
    ['M', 'Convert the selected cell to markdown'],
    ['Y', 'Convert the selected cell to code'],
    ['Ctrl / ⌘ + Z', 'Undo the last cell operation'],
    ['Ctrl / ⌘ + Shift + Z', 'Redo the last cell operation'],
  ];
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Keyboard shortcuts (command mode)</DialogTitle>
          <DialogContent>
            <div className={styles.shortcutList}>
              {rows.map(([k, desc]) => (
                <Fragment key={k}>
                  <span className={styles.kbd}>{k}</span>
                  <Caption1>{desc}</Caption1>
                </Fragment>
              ))}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Per-cell comment thread (R4-SYN-9) — self-contained composer + list. The
//    comment persists with the notebook definition (IPYNB metadata); real-time
//    multi-user presence (F6) is NOT provided and is honestly disclosed. ──
function CellCommentBar({
  comments, onAdd, onToggleResolve,
}: {
  comments?: CellComment[];
  onAdd: (text: string) => void;
  onToggleResolve: (commentId: string) => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const count = comments?.length || 0;
  const openCount = comments?.filter((c) => !c.resolved).length || 0;
  const submit = () => { const t = draft.trim(); if (!t) return; onAdd(t); setDraft(''); };
  return (
    <div className={s.commentBar}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
        <Popover open={open} onOpenChange={(_, d) => setOpen(d.open)} positioning="below-start" trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <Button
              size="small" appearance="subtle"
              icon={openCount > 0 ? <Comment20Regular /> : <CommentCheckmark20Regular />}
              title="Add or view a comment on this cell (persists with the notebook)"
            >
              {count > 0 ? `Comments (${count})` : 'Comment'}
            </Button>
          </PopoverTrigger>
          <PopoverSurface>
            <div className={s.commentComposer}>
              <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Add a comment</Caption1>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Comments persist with the notebook. Live multi-user presence / co-authoring
                is not available on this Azure-native backend.
              </Caption1>
              <Textarea
                value={draft}
                onChange={(_, d) => setDraft(d.value)}
                placeholder="Leave a note on this cell…"
                resize="vertical"
                aria-label="Cell comment"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacingHorizontalS }}>
                <Button size="small" appearance="subtle" onClick={() => { setDraft(''); setOpen(false); }}>Cancel</Button>
                <Button size="small" appearance="primary" disabled={!draft.trim()} onClick={() => { submit(); setOpen(false); }}>Comment</Button>
              </div>
            </div>
          </PopoverSurface>
        </Popover>
      </div>
      {comments && comments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
          {comments.map((c) => (
            <div key={c.id} className={s.commentRow}>
              <div className={s.commentBody}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  {c.author} · {new Date(c.at).toLocaleString()}
                </Caption1>
                <Body1 className={c.resolved ? s.commentResolved : undefined}>{c.text}</Body1>
              </div>
              <Button
                size="small" appearance="subtle"
                onClick={() => onToggleResolve(c.id)}
                title={c.resolved ? 'Reopen comment' : 'Resolve comment'}
              >
                {c.resolved ? 'Reopen' : 'Resolve'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Cell output (R4-SYN-1) — success output rendered on the shared stack:
//    a display(df) table becomes the RichDisplay grid + chart builder; html /
//    image / text keep their existing rich rendering. Errors are rendered by
//    the shared CodeCell (traceback + Fix with Copilot), so this skips them. ──
function SynapseCellOutput({ out, cellId, notebookId, progress, sparkUiUrl }: { out?: CellOutput; cellId: string; notebookId: string; progress?: number; sparkUiUrl?: string | null }) {
  const s = useStyles();
  if (!out) return null;
  if (out.status === 'running') {
    // R4-SYN-5 — live Spark progress: Livy exposes a fractional statement
    // progress (0..1), not stage/task counts, so we surface the honest
    // percentage + the Spark UI drill-down (never fabricated counts).
    const pct = typeof progress === 'number' ? progress : undefined;
    return (
      <div className={s.progressWrap}>
        <div className={s.progressRow}>
          <Spinner size="tiny" label={pct != null ? `Running… ${pct}%` : (out.text || 'Running…')} labelPosition="after" />
          {sparkUiUrl && (
            <Link href={sparkUiUrl} target="_blank" rel="noreferrer" title="Open the Spark application UI (jobs / stages)">
              <Caption1><Open16Regular style={{ verticalAlign: 'middle' }} /> Spark UI</Caption1>
            </Link>
          )}
        </div>
        <ProgressBar value={pct != null ? pct / 100 : undefined} shape="rounded" thickness="large" aria-label="Spark statement progress" />
      </div>
    );
  }
  if (out.status === 'error') return null; // CodeCell owns the error surface.
  const rich = buildRichFromTable(out.tableColumns, out.tableRows);
  const hasAny = !!(out.text || rich || out.html || out.imageBase64);
  return (
    <>
      {out.text && <div className={s.output}>{out.text}</div>}
      {rich && (
        <div className={s.richOut}>
          <RichDisplay payload={rich} cellId={cellId} notebookId={notebookId} workspaceId="" computeId="" />
        </div>
      )}
      {out.html && !rich && (
        <div className={s.richOut}>
          {/* Synapse display(df) emits an HTML table here. eslint-disable-next-line react/no-danger */}
          <div className={s.richHtml} dangerouslySetInnerHTML={{ __html: out.html }} />
        </div>
      )}
      {out.imageBase64 && (
        <div className={s.richOut}>
          <img className={s.richImg} src={`data:image/png;base64,${out.imageBase64}`} alt="cell output" />
        </div>
      )}
      {!hasAny && <div className={s.output}>(no output)</div>}
    </>
  );
}

