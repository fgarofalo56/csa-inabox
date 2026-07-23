'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Input, MessageBar, MessageBarBody, Popover,
  PopoverSurface, PopoverTrigger, Select, Spinner, Tooltip, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Play16Regular, Delete16Regular, ChevronUp16Regular, ChevronDown16Regular,
  ChevronRight16Regular, LockClosed16Regular, LockClosed16Filled, Copy16Regular,
  ArrowMaximize16Regular, ArrowMinimize16Regular,
  Stop16Filled, ArrowSwap16Regular, ReOrderDotsVertical16Regular,
  Lightbulb16Regular, Sparkle16Regular, Sparkle16Filled,
} from '@fluentui/react-icons';
import type { NotebookCell, NotebookCellLang, NotebookCellOutput } from '@/lib/types/notebook-cell';
import { LOOM_DISPLAY_MIME } from '@/lib/types/notebook-cell';
import type { LoomDisplayPayload } from '@/lib/types/notebook-cell';
import { parseCopilotCommand, copilotResultCell } from '@/lib/components/notebook/copilot-commands';
import { inCellResultAction } from '@/lib/copilot/notebook-tools';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';
import { registerInlineCompletion, type InlineCompletionContext } from '@/lib/components/editor/inline-completion';
import { registerClusterIntelliSense, type ClusterIntelliSenseContext } from '@/lib/components/editor/cluster-intellisense';
import { type ClusterRuntime, RUNTIME_LABEL } from '@/lib/components/editor/cluster-runtime';
import { useInlineCompleteToggle } from '@/lib/components/editor/use-inline-complete-toggle';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { CopilotPane } from './copilot-pane';
import { RichDisplay } from '@/lib/components/notebook/rich-display';

// ── U3 — per-cell resizable height ─────────────────────────────────────────
// Each code cell's Monaco editor gets a per-cell sizingKey so the shared
// ResizableCanvasRegion grip can persist a user-chosen height PER CELL under
// `loom.canvasHeight.monaco.notebook.<cellId>`. Explosion guard: a key is only
// written on the user's FIRST real resize gesture (auto-until-first-drag), and
// the notebook editor prunes a cell's key when the cell is deleted.

/** Monaco `sizingKey` for one notebook cell (U3 spec keying). */
export function notebookCellSizingKey(cellId: string): string {
  return `notebook.${cellId}`;
}

/**
 * Drop a deleted cell's persisted height so per-cell keys never accumulate
 * beyond the cells that still exist (call from the editor's delete path).
 */
export function pruneCellHeightKey(cellId: string): void {
  try {
    window.localStorage.removeItem(`loom.canvasHeight.monaco.${notebookCellSizingKey(cellId)}`);
  } catch {
    /* storage unavailable — nothing persisted to prune */
  }
}

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    // Fabric cell anatomy — a colored left accent rail marks the cell type
    // (brand blue = code); the rail brightens with the active state.
    borderLeft: `3px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    // Secondary cell actions (convert / lock / duplicate / maximize / move /
    // delete / AI toggle) are hover-only, matching the Fabric notebook's
    // hover toolbar. :focus-within keeps them keyboard-reachable.
    '& .nb-cell-actions': { opacity: 0, transitionProperty: 'opacity', transitionDuration: tokens.durationFaster },
    ':hover .nb-cell-actions': { opacity: 1 },
    ':focus-within .nb-cell-actions': { opacity: 1 },
  },
  shellActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    '& .nb-cell-actions': { opacity: 1 },
  },
  shellMaximized: {
    position: 'fixed',
    top: '64px',
    right: '16px',
    bottom: '16px',
    left: '16px',
    zIndex: 1000,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    zIndex: 999,
  },
  header: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS,
    padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px 4px 0 0',
  },
  spacer: { flex: 1 },
  dragHandle: {
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'grab',
    color: tokens.colorNeutralForeground3,
    padding: '2px',
    ':active': { cursor: 'grabbing' },
  },
  editor: {
    width: '100%',
    minHeight: '80px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '13px', padding: tokens.spacingHorizontalS,
    border: 'none',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
    outline: 'none',
  },
  editorLocked: {
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    cursor: 'not-allowed',
  },
  editorMaximized: {
    flex: 1,
    minHeight: 0,
    resize: 'none',
  },
  outputBox: {
    padding: tokens.spacingHorizontalS,
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    maxWidth: '100%',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    maxHeight: '240px',
    overflow: 'auto',
    // Pure-CSS scroll fade (background-attachment trick): a soft shadow appears
    // at the top/bottom edge only while more output is scrolled out of view —
    // honest affordance, theme-correct, no overlay elements.
    backgroundColor: tokens.colorNeutralBackground2,
    backgroundImage: `linear-gradient(${tokens.colorNeutralBackground2} 30%, transparent), linear-gradient(transparent, ${tokens.colorNeutralBackground2} 70%), linear-gradient(${tokens.colorNeutralShadowAmbient}, transparent), linear-gradient(transparent, ${tokens.colorNeutralShadowAmbient})`,
    backgroundPosition: 'top, bottom, top, bottom',
    backgroundRepeat: 'no-repeat',
    backgroundSize: '100% 24px, 100% 24px, 100% 8px, 100% 8px',
    backgroundAttachment: 'local, local, scroll, scroll',
  },
  outputBoxMaximized: {
    maxHeight: '40%',
  },
  outputError: {
    color: tokens.colorPaletteRedForeground1,
  },
  // Rich (non-text) output shapes — R3 #5. Images + sandboxed HTML render
  // above/instead of the plain-text fallback.
  richOutput: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    maxHeight: '480px', overflow: 'auto', maxWidth: '100%',
  },
  richOutputMaximized: { maxHeight: '60%' },
  // Matplotlib / plot figures are authored on a WHITE canvas and are often
  // transparent-background — keep a stable light backing in BOTH themes so they
  // stay legible on dark mode (a token would flip to dark and hide the plot).
  outputImageWrap: {
    display: 'inline-block', alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    maxWidth: '100%',
  },
  outputImage: { maxWidth: '100%', height: 'auto', display: 'block' },
  // text/html (e.g. pandas _repr_html_) rendered in a scripts-disabled sandboxed
  // iframe (no sanitizer dep in-repo) so untrusted output HTML can never run JS
  // or touch the parent DOM. White backing for default table styling.
  outputHtmlFrame: {
    width: '100%', minHeight: '80px', height: '300px', maxWidth: '100%',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: '#ffffff',
  },
  outputStdout: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
    color: tokens.colorNeutralForeground2, margin: 0, maxWidth: '100%',
  },
  outputJson: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, maxWidth: '100%',
  },
  viewToggle: { alignSelf: 'flex-start' },
  badgeCount: {
    fontFamily: 'Consolas, monospace',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    minWidth: '32px',
    textAlign: 'right',
  },
  // Per-cell execution duration ("✓ 2.4 s"), Fabric cell status parity.
  durationText: {
    fontFamily: 'Consolas, monospace',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  hoverActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
});

/** "842 ms" / "2.4 s" / "1 m 12 s" — per-cell run duration. */
export function formatCellDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m} m ${sec} s`;
}

const LANG_OPTIONS: { value: NotebookCellLang; label: string }[] = [
  { value: 'pyspark', label: 'PySpark (Python)' },
  { value: 'spark', label: 'Spark (Scala)' },
  { value: 'sparksql', label: 'Spark SQL' },
  { value: 'sparkr', label: 'SparkR (R)' },
  { value: 'python', label: 'Python' },
  { value: 'tsql', label: 'T-SQL' },
  { value: 'csharp', label: '.NET Spark (C#)' },
];

/**
 * Pure, client-safe detection of a leading Synapse language magic on the first
 * non-empty line (mirrors synapse-livy-client.parseMagicKind, re-implemented
 * here so this 'use client' component never bundles the Azure SDK). Returns the
 * resolved routing kind, or null when there's no magic.
 */
const MAGIC_ROUTING: Record<string, 'pyspark' | 'spark' | 'sql' | 'sparkr'> = {
  '%%pyspark': 'pyspark', '%%python': 'pyspark',
  '%%spark': 'spark', '%%scala': 'spark',
  '%%sql': 'sql', '%%sparksql': 'sql',
  '%%sparkr': 'sparkr', '%%r': 'sparkr',
};
function detectCellMagic(source: string): 'pyspark' | 'spark' | 'sql' | 'sparkr' | null {
  const line = source.split('\n').find(l => l.trim() !== '');
  if (!line) return null;
  const token = line.trim().toLowerCase().split(/\s+/)[0];
  return MAGIC_ROUTING[token] ?? null;
}

// ---- Rich cell-output rendering (R3 #5) ----------------------------------
// Livy statement output.data is a MIME map. Render the RICHEST shape (image >
// html > json) rather than dumping base64 / an object repr as text, and keep
// stdout (print) alongside a figure/HTML so "print + df repr" cells show both.
const IMAGE_MIMES: Array<[string, string]> = [
  ['image/png', 'image/png'], ['image/jpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'], ['image/webp', 'image/webp'],
];

function toImageSrc(mime: string, val: string): string {
  return val.startsWith('data:') ? val : `data:${mime};base64,${val}`;
}
function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** Extract renderable parts from a cell output's MIME map. `hasRich` is true
 *  when there is a non-plain-text shape (image / html / json) worth rendering
 *  richly instead of the plain-text fallback. */
export function outputRichParts(output: NotebookCellOutput) {
  const data = (output.data && typeof output.data === 'object') ? output.data as Record<string, unknown> : {};
  const images: Array<{ mime: string; src: string }> = [];
  for (const [key, mime] of IMAGE_MIMES) {
    const v = data[key];
    if (typeof v === 'string' && v) images.push({ mime, src: toImageSrc(mime, v) });
  }
  const svg = typeof data['image/svg+xml'] === 'string' ? data['image/svg+xml'] as string : undefined;
  // SVG renders through <img> (image context disables any embedded scripting),
  // encoded inline so no base64 round-trip is needed.
  if (svg) images.push({ mime: 'image/svg+xml', src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` });
  const html = typeof data['text/html'] === 'string' ? data['text/html'] as string : undefined;
  const jsonRaw = data['application/json'];
  const jsonVal = (jsonRaw !== undefined && jsonRaw !== null && jsonRaw !== LOOM_DISPLAY_MIME) ? jsonRaw : undefined;
  const text = (typeof output.textPlain === 'string' && output.textPlain)
    ? output.textPlain
    : (typeof data['text/plain'] === 'string' ? data['text/plain'] as string : undefined);
  const hasRich = images.length > 0 || !!html || jsonVal !== undefined;
  return { images, html, jsonVal, text, hasRich };
}

function RichCellOutput({ output, maximized }: { output: NotebookCellOutput; maximized?: boolean }) {
  const s = useStyles();
  const [viewText, setViewText] = useState(false);
  const { images, html, jsonVal, text } = outputRichParts(output);
  const hasVisual = images.length > 0 || !!html;
  const canToggleText = !!text && hasVisual;
  return (
    <div className={mergeClasses(s.richOutput, maximized && s.richOutputMaximized)}>
      {canToggleText && (
        <Button
          size="small" appearance="subtle" className={s.viewToggle}
          onClick={(e) => { e.stopPropagation(); setViewText((v) => !v); }}
        >
          {viewText ? 'View rich output' : 'View as text'}
        </Button>
      )}
      {viewText && text ? (
        <pre className={s.outputStdout}>{text}</pre>
      ) : (
        <>
          {/* stdout above the figure/HTML so a "print + df repr" cell shows both */}
          {text && hasVisual && <pre className={s.outputStdout}>{text}</pre>}
          {images.map((img, i) => (
            <span key={i} className={s.outputImageWrap}>
              <img src={img.src} alt="Cell output" className={s.outputImage} />
            </span>
          ))}
          {html && (
            // Scripts-disabled sandboxed iframe (no in-repo HTML sanitizer): the
            // output HTML can never run JS or reach the parent DOM.
            <iframe title="Cell HTML output" sandbox="" className={s.outputHtmlFrame} srcDoc={html} />
          )}
          {jsonVal !== undefined && !hasVisual && (
            <pre className={s.outputJson}>{safeJson(jsonVal)}</pre>
          )}
        </>
      )}
    </div>
  );
}

export interface CodeCellProps {
  cell: NotebookCell;
  active?: boolean;
  onFocus?: () => void;
  onChange: (next: NotebookCell) => void;
  onRun?: (cell: NotebookCell) => Promise<void>;
  onStop?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate?: () => void;
  onConvertToMarkdown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** Native HTML5 drag handle wiring supplied by the editor for reorder. */
  dragHandleProps?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
  /** Threaded so the rich display() surface can fire full-dataset Spark aggregations. */
  workspaceId?: string;
  computeId?: string;
  /**
   * WebSocket path for the Pylance/pylsp bridge (e.g. `/api/notebook/<id>/lsp`),
   * or null when the bridge is not enabled in this deployment. When set and the
   * cell is a Python flavour, Monaco gets real pyright/pylsp completions + hover.
   */
  lspWsUrl?: string | null;
  /** Sources of up to 3 preceding cells (oldest first) for ghost-text grounding. */
  priorCells?: string[];
  /** Lakehouse / notebook schema hint forwarded to inline completion. */
  schemaContext?: string;
  /** Notebook item id — when present (with onInsertBelow) the in-cell Copilot
   *  button is shown. Absent in the legacy scratchpad pane, where it stays hidden.
   *  Also threaded so the rich display() surface can fire full-dataset Spark aggregations. */
  notebookId?: string;
  /** Parent splices the Copilot-generated cell directly below this one. */
  onInsertBelow?: (cell: NotebookCell) => void;
  /**
   * Runtime derived from the attached compute (Databricks / Synapse Spark /
   * Azure ML). Drives cluster-aware IntelliSense (dbutils vs mssparkutils vs
   * azure.ai.ml) and the runtime grounding fed to the in-cell Copilot. Defaults
   * to 'synapse-spark' (the historically-validated Livy path) when absent.
   */
  runtime?: ClusterRuntime;
}

/** Map a notebook cell language to the Monaco language id (mirror of monaco-textarea.mapLanguage). */
function toMonacoLang(lang: NotebookCellLang | undefined): string {
  switch (lang) {
    case 'pyspark':
    case 'python': return 'python';
    case 'spark': return 'scala';
    case 'sparksql':
    case 'tsql': return 'sql';
    case 'sparkr': return 'r';
    case 'csharp': return 'csharp';
    default: return 'python';
  }
}

const PY_LANGS = new Set<NotebookCellLang>(['python', 'pyspark']);

/**
 * In-cell Copilot (Fabric-parity): a per-cell Copilot button opens a prompt
 * popover with slash commands; the result is inserted as a new cell below.
 * Slash parsing + result-cell construction live in ./copilot-commands.
 */
export function CodeCell({ cell, active, onFocus, onChange, onRun, onStop, onDelete, onMoveUp, onMoveDown, onDuplicate, onConvertToMarkdown, canMoveUp, canMoveDown, dragHandleProps, notebookId, workspaceId, computeId, lspWsUrl, priorCells, schemaContext, onInsertBelow, runtime = 'synapse-spark' }: CodeCellProps) {
  const s = useStyles();
  const [running, setRunning] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // U3 kill-switch (FLAG0): OFF reverts cells to the pre-U3 auto-height-only
  // editor on the next load; saved per-cell heights are simply ignored.
  const cellResizeOn = useRuntimeFlag('u3-notebook-cell-resize');
  const [completionEnabled, toggleCompletion] = useInlineCompleteToggle();
  const [copilotOpen, setCopilotOpen] = useState(false);

  // In-cell Copilot popover state (distinct from the full CopilotPane above).
  const [inCellOpen, setInCellOpen] = useState(false);
  const [copilotDraft, setCopilotDraft] = useState('');
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);
  const [copilotHint, setCopilotHint] = useState<string | null>(null);
  // Approval-diff: the AOAI-proposed cell source for a code-MODIFYING command
  // (/fix, /comments, /optimize, free-form refactor). Reviewed before it applies
  // in place — parity with the Fabric in-cell Copilot "review & accept" flow.
  const [proposedCode, setProposedCode] = useState<string | null>(null);
  const copilotEnabled = !!notebookId && !!onInsertBelow;

  const locked = !!cell.locked;

  // 'off' = no bridge / non-Python; 'connecting'|'ready'|'error' track the LSP.
  const [lspState, setLspState] = useState<'off' | 'connecting' | 'ready' | 'error'>('off');
  const lspDisposeRef = useRef<null | (() => void)>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const lang = (cell.lang || 'pyspark') as NotebookCellLang;
  const lspEligible = !!lspWsUrl && PY_LANGS.has(lang);
  // Bumped when Monaco mounts so the attach effect re-runs (refs don't trigger effects).
  const [editorReady, setEditorReady] = useState(0);

  const detachLsp = useCallback(() => {
    lspDisposeRef.current?.();
    lspDisposeRef.current = null;
  }, []);

  // Attach / re-attach the pylsp language client whenever the cell becomes an
  // eligible (Python + bridge-available) cell with a mounted Monaco editor, and
  // tear it down otherwise. Keyed on lspEligible + lspWsUrl so switching a cell
  // to Python after mount, or the bridge appearing, both attach correctly.
  useEffect(() => {
    if (!lspEligible || !editorRef.current || !monacoRef.current || typeof window === 'undefined') {
      detachLsp();
      setLspState('off');
      return;
    }
    detachLsp();
    setLspState('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.host}${lspWsUrl}`;
    let cancelled = false;
    // @ts-ignore — plain-JS LSP client, excluded from the TS program.
    import('@/lib/lsp/notebook-lsp-client.mjs')
      .then((mod) => {
        if (cancelled) return;
        const dispose = mod.attachPylsp({
          editor: editorRef.current, monaco: monacoRef.current, wsUrl, language: 'python',
          fileUri: `inmemory://loom/cell-${cell.id}.py`,
        });
        lspDisposeRef.current = dispose;
        dispose.onStatus?.((st: { state: string }) => {
          if (cancelled) return;
          setLspState(st.state === 'ready' ? 'ready' : st.state === 'error' || st.state === 'disconnected' ? 'error' : 'connecting');
        });
      })
      .catch(() => { if (!cancelled) setLspState('error'); });
    return () => { cancelled = true; detachLsp(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lspEligible, lspWsUrl, cell.id, editorReady, detachLsp]);

  // Live context for the inline-completion provider (read on each invocation).
  const ctxRef = useRef<InlineCompletionContext>({
    enabled: completionEnabled, locked, lang: cell.lang || 'pyspark',
    priorCells: priorCells || [], schemaContext, runtime,
  });
  useEffect(() => {
    ctxRef.current = {
      enabled: completionEnabled, locked, lang: cell.lang || 'pyspark',
      priorCells: priorCells || [], schemaContext, runtime,
    };
  }, [completionEnabled, locked, cell.lang, priorCells, schemaContext, runtime]);

  // Live context for the cluster-aware (runtime-specific) completion provider.
  // Read on each keystroke so flipping the runtime/lang takes effect instantly.
  const clusterCtxRef = useRef<ClusterIntelliSenseContext>({
    runtime, monacoLanguage: toMonacoLang(cell.lang),
  });
  useEffect(() => {
    clusterCtxRef.current = { runtime, monacoLanguage: toMonacoLang(cell.lang) };
  }, [runtime, cell.lang]);

  const disposeRef = useRef<{ dispose(): void } | null>(null);
  const clusterDisposeRef = useRef<{ dispose(): void } | null>(null);
  // Unified Monaco onReady: capture editor/monaco for the LSP attach effect AND
  // register the inline-completion + cluster-aware completion providers.
  const handleEditorReady = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorReady((n) => n + 1);
    disposeRef.current?.dispose();
    disposeRef.current = registerInlineCompletion(editor, monaco, () => ctxRef.current);
    clusterDisposeRef.current?.dispose();
    clusterDisposeRef.current = registerClusterIntelliSense(editor, monaco, () => clusterCtxRef.current);
  }, []);
  useEffect(() => () => { disposeRef.current?.dispose(); clusterDisposeRef.current?.dispose(); }, []);

  // Re-register the cluster provider when the cell's Monaco language changes
  // (e.g. PySpark → Scala), since the provider is keyed by Monaco language id.
  // Switching runtime alone needs no re-register (the getter reads it live).
  const monacoLangKey = toMonacoLang(cell.lang);
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    clusterDisposeRef.current?.dispose();
    clusterDisposeRef.current = registerClusterIntelliSense(
      editorRef.current, monacoRef.current, () => clusterCtxRef.current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoLangKey, editorReady]);

  // ESC dismisses the maximized state.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const handleRun = useCallback(async () => {
    if (!onRun) return;
    setRunning(true);
    try { await onRun(cell); }
    finally { setRunning(false); }
  }, [cell, onRun]);

  const handleCopilot = useCallback(async () => {
    if (!onInsertBelow || !notebookId) return;
    const { mode, prompt } = parseCopilotCommand(copilotDraft);
    setCopilotError(null);
    setCopilotHint(null);
    setProposedCode(null);

    if (mode === 'generate' && !prompt) {
      setCopilotError('Add a description after /generate, or type a free-text prompt.');
      return;
    }
    // explain / fix / comments / optimize all operate on the current cell source.
    if (mode !== 'generate' && !cell.source.trim()) {
      setCopilotError(`/${mode} requires cell source code.`);
      return;
    }

    setCopilotBusy(true);
    try {
      const errorText = mode === 'fix'
        ? [cell.output?.ename, cell.output?.evalue, ...(cell.output?.traceback ?? [])].filter(Boolean).join('\n')
        : '';
      const res = await clientFetch(`/api/notebook/${encodeURIComponent(notebookId)}/assist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode, lang: cell.lang || 'pyspark', source: cell.source, prompt, errorText,
          // workspaceId lets the route pull the REAL last error from the live
          // Livy session for /fix when the cell has no cached error output.
          workspaceId: workspaceId || '',
          // Runtime so the Copilot targets the correct cluster's syntax/APIs
          // (Databricks dbutils/display vs Synapse mssparkutils vs Azure ML SDK).
          runtime,
        }),
      });
      const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!j.ok) {
        if (j.code === 'no_aoai') setCopilotHint(j.hint || j.error || 'AOAI not configured.');
        else setCopilotError(j.error || `HTTP ${res.status}`);
        return;
      }
      if (inCellResultAction(mode, prompt) === 'propose-edit') {
        // Code-modifying result → review in the approval-diff, apply in place on Accept.
        setProposedCode(j.result);
        return;
      }
      // insert-below: /explain prose (markdown) or a free-form new code cell.
      const newCell: NotebookCell = copilotResultCell(mode, cell.lang || 'pyspark', j.result);
      onInsertBelow(newCell);
      setInCellOpen(false);
      setCopilotDraft('');
    } catch (e: any) {
      setCopilotError(e?.message || String(e));
    } finally {
      setCopilotBusy(false);
    }
  }, [notebookId, cell, copilotDraft, onInsertBelow, workspaceId, runtime]);

  const setLang = (lang: NotebookCellLang) => onChange({ ...cell, lang });
  const setSource = (source: string) => onChange({ ...cell, source });
  const toggleLock = () => onChange({ ...cell, locked: !cell.locked });
  const toggleCollapsed = () => onChange({ ...cell, collapsed: !cell.collapsed });

  const exec = cell.executionCount ? `[${cell.executionCount}]` : '[ ]';
  const collapsed = !!cell.collapsed;
  const lineCount = cell.source ? cell.source.split('\n').length : 0;
  const magic = detectCellMagic(cell.source);

  const shell = (
    <div
      className={mergeClasses(
        s.shell,
        active && s.shellActive,
        maximized && s.shellMaximized,
      )}
      onClick={onFocus}
    >
      <div className={s.header}>
        {dragHandleProps && (
          <span
            className={s.dragHandle}
            draggable={dragHandleProps.draggable}
            onDragStart={dragHandleProps.onDragStart}
            onDragEnd={dragHandleProps.onDragEnd}
            onClick={(e) => e.stopPropagation()}
            role="button"
            aria-label="Drag to reorder cell"
            title="Drag to reorder"
          >
            <ReOrderDotsVertical16Regular />
          </span>
        )}
        <Button
          size="small"
          appearance="subtle"
          icon={collapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
          onClick={(e) => { e.stopPropagation(); toggleCollapsed(); }}
          aria-label={collapsed ? 'Expand cell' : 'Collapse cell'}
          title={collapsed ? 'Expand cell' : 'Collapse cell'}
        />
        <Caption1 className={s.badgeCount}>{exec}</Caption1>
        {typeof cell.output?.durationMs === 'number' && cell.output.status !== 'pending' && (
          <Caption1
            className={s.durationText}
            title={cell.output.executedAtUtc ? `Last run ${new Date(cell.output.executedAtUtc).toLocaleString()}` : 'Last run duration'}
          >
            {cell.output.status === 'ok' ? '✓' : '✗'} {formatCellDuration(cell.output.durationMs)}
          </Caption1>
        )}
        {running ? (
          <Button size="small" appearance="subtle" icon={<Stop16Filled />} disabled={!onStop} onClick={(e) => { e.stopPropagation(); onStop?.(); }}>
            Stop
          </Button>
        ) : (
          <Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={!onRun || locked} onClick={(e) => { e.stopPropagation(); handleRun(); }}>
            Run cell
          </Button>
        )}
        <Select size="small" value={cell.lang || 'pyspark'} onChange={(_, d) => setLang(d.value as NotebookCellLang)} onClick={(e) => e.stopPropagation()} disabled={locked}>
          {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {magic && (
          <Badge appearance="tint" color="brand" size="small" title={`%%${magic} routes this cell to the Spark backend`}>
            %%{magic} → Spark
          </Badge>
        )}
        <Badge
          appearance="outline"
          size="small"
          color={runtime === 'databricks' ? 'important' : runtime === 'azure-ml' ? 'success' : 'brand'}
          title={`IntelliSense + Copilot tuned for ${RUNTIME_LABEL[runtime]} (switches with the attached compute)`}
        >
          {RUNTIME_LABEL[runtime]}
        </Badge>
        {collapsed && <Badge appearance="outline" size="small">{lineCount} line{lineCount === 1 ? '' : 's'} hidden</Badge>}
        {locked && <Badge appearance="outline" color="warning" size="small">locked</Badge>}
        {lspEligible && (
          <Tooltip
            content={
              lspState === 'ready' ? 'Pylance IntelliSense connected — real pyright completions & hover'
              : lspState === 'connecting' ? 'Connecting to the Python language server…'
              : lspState === 'error' ? 'Language server unavailable — Monaco built-in completions only'
              : 'IntelliSense'
            }
            relationship="label"
          >
            <Badge
              appearance="outline"
              size="small"
              color={lspState === 'ready' ? 'success' : lspState === 'error' ? 'danger' : 'informative'}
              icon={<Lightbulb16Regular />}
            >
              {lspState === 'ready' ? 'Pylance' : lspState === 'connecting' ? 'Pylance…' : 'IntelliSense'}
            </Badge>
          </Tooltip>
        )}
        {copilotEnabled && (
          <Popover
            open={inCellOpen}
            onOpenChange={(_, d) => { if (!copilotBusy) { setInCellOpen(d.open); if (!d.open) { setProposedCode(null); setCopilotError(null); } } }}
            positioning="below-start"
            trapFocus
          >
            <PopoverTrigger disableButtonEnhancement>
              <Button
                size="small"
                appearance="subtle"
                icon={<Sparkle16Regular style={{ color: tokens.colorBrandForeground1 }} />}
                onClick={(e) => { e.stopPropagation(); setInCellOpen(o => !o); }}
                aria-label="In-cell Copilot"
                title="In-cell Copilot"
              >
                Copilot
              </Button>
            </PopoverTrigger>
            <PopoverSurface
              onClick={(e) => e.stopPropagation()}
              style={{ padding: tokens.spacingVerticalM, width: 380, display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}>
                <Sparkle16Regular style={{ color: tokens.colorBrandForeground1 }} />
                <Caption1 style={{ fontWeight: 600 }}>In-cell Copilot</Caption1>
              </div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                /explain · /fix · /comments · /optimize · /generate &lt;description&gt; · or a free-form prompt
              </Caption1>
              <Input
                value={copilotDraft}
                onChange={(_, d) => setCopilotDraft(d.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !copilotBusy && proposedCode === null) { e.preventDefault(); handleCopilot(); } }}
                placeholder="e.g. /explain"
                disabled={copilotBusy || proposedCode !== null}
                contentBefore={copilotBusy ? <Spinner size="tiny" /> : undefined}
                style={{ width: '100%' }}
                aria-label="Copilot prompt"
                autoFocus
              />
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button size="small" appearance="subtle" disabled={copilotBusy || proposedCode !== null}
                  onClick={() => setCopilotDraft('/explain')}>/explain</Button>
                <Button size="small" appearance="subtle" disabled={copilotBusy || proposedCode !== null}
                  onClick={() => setCopilotDraft('/fix')}>/fix</Button>
                <Button size="small" appearance="subtle" disabled={copilotBusy || proposedCode !== null}
                  onClick={() => setCopilotDraft('/comments')}>/comments</Button>
                <Button size="small" appearance="subtle" disabled={copilotBusy || proposedCode !== null}
                  onClick={() => setCopilotDraft('/optimize')}>/optimize</Button>
                <Button size="small" appearance="subtle" disabled={copilotBusy || proposedCode !== null}
                  onClick={() => setCopilotDraft('/generate ')}>/generate</Button>
                <div style={{ flex: 1 }} />
                <Button size="small" appearance="primary"
                  disabled={copilotBusy || !copilotDraft.trim() || proposedCode !== null}
                  onClick={handleCopilot}>
                  {copilotBusy ? 'Working…' : 'Run'}
                </Button>
              </div>
              {proposedCode !== null && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS }}>
                  <Caption1 style={{ fontWeight: 600, color: tokens.colorBrandForeground1 }}>
                    Proposed change — review before applying:
                  </Caption1>
                  <pre style={{
                    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, margin: tokens.spacingVerticalNone, maxHeight: 240,
                    overflow: 'auto', padding: tokens.spacingVerticalS, borderRadius: 4, whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%',
                    backgroundColor: tokens.colorNeutralBackground3,
                    border: `1px solid ${tokens.colorNeutralStroke2}`,
                  }}>
                    {proposedCode}
                  </pre>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                    <Button size="small" appearance="primary"
                      onClick={() => {
                        onChange({ ...cell, source: proposedCode, output: undefined, executionCount: undefined });
                        setProposedCode(null);
                        setInCellOpen(false);
                        setCopilotDraft('');
                      }}>
                      Accept
                    </Button>
                    <Button size="small" appearance="subtle"
                      onClick={() => { setProposedCode(null); setCopilotDraft(''); }}>
                      Reject
                    </Button>
                  </div>
                </div>
              )}
              {copilotHint && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    AOAI not configured — {copilotHint} Deploy the AI Foundry project
                    (platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true).
                  </MessageBarBody>
                </MessageBar>
              )}
              {copilotError && (
                <MessageBar intent="error">
                  <MessageBarBody>{copilotError}</MessageBarBody>
                </MessageBar>
              )}
            </PopoverSurface>
          </Popover>
        )}
        <div className={s.spacer} />
        {/* Secondary actions — hover-only (`.nb-cell-actions` reveals on shell
            hover / focus-within / active), Fabric hover-toolbar density. */}
        <span className={mergeClasses(s.hoverActions, 'nb-cell-actions')}>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowSwap16Regular />}
            disabled={!onConvertToMarkdown}
            onClick={(e) => { e.stopPropagation(); onConvertToMarkdown?.(); }}
            aria-label="Convert to markdown cell"
            title="Convert to markdown cell"
          />
          <Button
            size="small"
            appearance={completionEnabled ? 'primary' : 'subtle'}
            icon={completionEnabled ? <Sparkle16Filled /> : <Sparkle16Regular />}
            onClick={(e) => { e.stopPropagation(); toggleCompletion(); }}
            aria-label={completionEnabled ? 'Disable AI inline completion' : 'Enable AI inline completion'}
            title={completionEnabled ? 'AI inline completion: on — pause typing for a ghost suggestion, Tab to accept' : 'AI inline completion: off'}
          />
          <Button
            size="small"
            appearance={locked ? 'primary' : 'subtle'}
            icon={locked ? <LockClosed16Filled /> : <LockClosed16Regular />}
            onClick={(e) => { e.stopPropagation(); toggleLock(); }}
            aria-label={locked ? 'Unlock cell' : 'Lock cell'}
            title={locked ? 'Unlock cell' : 'Lock cell'}
          />
          <Button size="small" appearance="subtle" icon={<Copy16Regular />} disabled={!onDuplicate} onClick={(e) => { e.stopPropagation(); onDuplicate?.(); }} aria-label="Duplicate cell" title="Duplicate cell" />
          <Button
            size="small"
            appearance="subtle"
            icon={maximized ? <ArrowMinimize16Regular /> : <ArrowMaximize16Regular />}
            onClick={(e) => { e.stopPropagation(); setMaximized(m => !m); }}
            aria-label={maximized ? 'Restore cell' : 'Maximize cell'}
            title={maximized ? 'Restore cell (Esc)' : 'Maximize cell'}
          />
          <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={!canMoveUp} onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }} aria-label="Move cell up" title="Move cell up" />
          <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={!canMoveDown} onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }} aria-label="Move cell down" title="Move cell down" />
          <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={(e) => { e.stopPropagation(); onDelete?.(); }} aria-label="Delete cell" title="Delete cell" />
        </span>
      </div>
      {!collapsed && (
        maximized ? (
          <MonacoTextarea
            value={cell.source}
            onChange={setSource}
            language={(cell.lang || 'pyspark') as MonacoLanguage}
            readOnly={locked}
            height={'calc(100% - 200px)'}
            minHeight={80}
            ariaLabel={`Code cell ${cell.id}`}
            className={mergeClasses(locked && s.editorLocked)}
            onReady={handleEditorReady}
          />
        ) : (
          // Auto-fit: the editor grows to its content height (min 120px, up to
          // 720px then scrolls) so the cell shows everything by default without
          // the user dragging. Maximize is still available for large edits.
          // U3: with the runtime flag ON, a per-cell sizingKey adds the shared
          // resize grip — auto-fit until the user's first drag, then THAT
          // cell's chosen height persists (siblings unaffected).
          <MonacoTextarea
            value={cell.source}
            onChange={setSource}
            language={(cell.lang || 'pyspark') as MonacoLanguage}
            readOnly={locked}
            autoHeight
            minHeight={120}
            maxHeight={720}
            sizingKey={cellResizeOn ? notebookCellSizingKey(cell.id) : undefined}
            ariaLabel={`Code cell ${cell.id}`}
            className={mergeClasses(locked && s.editorLocked)}
            onReady={handleEditorReady}
          />
        )
      )}
      {/* R4-NB-6 — collapse the OUTPUT independently of the cell input. */}
      {!collapsed && cell.output && (
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}` }}>
          <Button
            size="small"
            appearance="transparent"
            icon={cell.outputCollapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
            onClick={(e) => { e.stopPropagation(); onChange({ ...cell, outputCollapsed: !cell.outputCollapsed }); }}
            aria-label={cell.outputCollapsed ? 'Show output' : 'Hide output'}
          >
            Output{cell.outputCollapsed ? ' (hidden)' : ''}
          </Button>
        </div>
      )}
      {!collapsed && cell.output && !cell.outputCollapsed && (() => {
        // Rich display(): prefer the structured payload; fall back to the raw
        // MIME if it slipped through in output.data. Render the interactive grid
        // + charts instead of the plain text table when present.
        const richFromField = cell.output.richDisplay;
        const richFromData = (cell.output.data as Record<string, unknown> | undefined)?.[LOOM_DISPLAY_MIME] as LoomDisplayPayload | undefined;
        const rich = richFromField || (richFromData && Array.isArray(richFromData.columns) ? richFromData : undefined);
        if (cell.output.status !== 'error' && rich) {
          return (
            <div style={{ padding: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
              <RichDisplay payload={rich} cellId={cell.id} notebookId={notebookId || ''} workspaceId={workspaceId || ''} computeId={computeId || ''} />
            </div>
          );
        }
        // Rich output SHAPES (R3 #5): matplotlib image/png, text/html, JSON, and
        // "print + df repr" multi-output cells — render the richest shape instead
        // of a base64 dump / escaped-HTML text. Errors keep the plain-text box.
        if (cell.output.status !== 'error' && outputRichParts(cell.output).hasRich) {
          return <RichCellOutput output={cell.output} maximized={maximized} />;
        }
        return (
          <>
          <div className={mergeClasses(
            s.outputBox,
            maximized && s.outputBoxMaximized,
            cell.output.status === 'error' && s.outputError,
          )}>
            {cell.output.status === 'error' && (
              <Badge appearance="filled" color="danger" size="small" style={{ marginBottom: tokens.spacingVerticalXS }}>
                {cell.output.ename || 'Error'}
              </Badge>
            )}
            {cell.output.status === 'error' ? (
              <>
                {cell.output.evalue}
                {cell.output.traceback && '\n' + (Array.isArray(cell.output.traceback) ? cell.output.traceback.join('\n') : cell.output.traceback)}
              </>
            ) : (
              cell.output.textPlain || JSON.stringify(cell.output.data, null, 2)
            )}
          </div>
          {cell.output.status === 'error' && !locked && (
            <>
              <Button
                size="small"
                appearance="outline"
                icon={<Sparkle16Regular />}
                style={{ margin: '4px 8px 8px', alignSelf: 'flex-start' }}
                onClick={(e) => { e.stopPropagation(); setCopilotOpen(true); }}
              >
                Fix with Copilot
              </Button>
              <CopilotPane
                open={copilotOpen}
                cell={cell}
                output={cell.output}
                onAccept={(proposedCode) => {
                  onChange({ ...cell, source: proposedCode, output: undefined, executionCount: undefined });
                  setCopilotOpen(false);
                }}
                onClose={() => setCopilotOpen(false)}
              />
            </>
          )}
          </>
        );
      })()}
    </div>
  );

  if (maximized) {
    return (
      <>
        <div className={s.backdrop} onClick={() => setMaximized(false)} aria-hidden="true" />
        {shell}
      </>
    );
  }
  return shell;
}
