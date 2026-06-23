'use client';

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
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { LOOM_DISPLAY_MIME } from '@/lib/types/notebook-cell';
import type { LoomDisplayPayload } from '@/lib/types/notebook-cell';
import { parseCopilotCommand, copilotResultCell } from '@/lib/components/notebook/copilot-commands';
import { inCellResultAction } from '@/lib/copilot/notebook-tools';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';
import { registerInlineCompletion, type InlineCompletionContext } from '@/lib/components/editor/inline-completion';
import { registerClusterIntelliSense, type ClusterIntelliSenseContext } from '@/lib/components/editor/cluster-intellisense';
import { type ClusterRuntime, RUNTIME_LABEL } from '@/lib/components/editor/cluster-runtime';
import { useInlineCompleteToggle } from '@/lib/components/editor/use-inline-complete-toggle';
import { CopilotPane } from './copilot-pane';
import { RichDisplay } from '@/lib/components/notebook/rich-display';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  shellActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
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
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
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
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    maxHeight: '240px',
    overflow: 'auto',
  },
  outputBoxMaximized: {
    maxHeight: '40%',
  },
  outputError: {
    color: tokens.colorPaletteRedForeground1,
  },
  badgeCount: {
    fontFamily: 'Consolas, monospace',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    minWidth: '32px',
    textAlign: 'right',
  },
});

const LANG_OPTIONS: { value: NotebookCellLang; label: string }[] = [
  { value: 'pyspark', label: 'PySpark (Python)' },
  { value: 'spark', label: 'Spark (Scala)' },
  { value: 'sparksql', label: 'Spark SQL' },
  { value: 'sparkr', label: 'SparkR (R)' },
  { value: 'python', label: 'Python' },
  { value: 'tsql', label: 'T-SQL' },
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
      const res = await fetch(`/api/notebook/${encodeURIComponent(notebookId)}/assist`, {
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
              style={{ padding: 12, width: 380, display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Caption1 style={{ fontWeight: 600, color: tokens.colorBrandForeground1 }}>
                    Proposed change — review before applying:
                  </Caption1>
                  <pre style={{
                    fontFamily: 'Consolas, monospace', fontSize: 12, margin: 0, maxHeight: 240,
                    overflow: 'auto', padding: 8, borderRadius: 4, whiteSpace: 'pre-wrap',
                    backgroundColor: tokens.colorNeutralBackground3,
                    border: `1px solid ${tokens.colorNeutralStroke2}`,
                  }}>
                    {proposedCode}
                  </pre>
                  <div style={{ display: 'flex', gap: 8 }}>
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
        <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={!canMoveUp} onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }} aria-label="Move cell up" />
        <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={!canMoveDown} onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }} aria-label="Move cell down" />
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={(e) => { e.stopPropagation(); onDelete?.(); }} aria-label="Delete cell" />
      </div>
      {!collapsed && (
        <MonacoTextarea
          value={cell.source}
          onChange={setSource}
          language={(cell.lang || 'pyspark') as MonacoLanguage}
          readOnly={locked}
          height={maximized ? 'calc(100% - 200px)' : 160}
          minHeight={80}
          ariaLabel={`Code cell ${cell.id}`}
          className={mergeClasses(locked && s.editorLocked)}
          onReady={handleEditorReady}
        />
      )}
      {!collapsed && cell.output && (() => {
        // Rich display(): prefer the structured payload; fall back to the raw
        // MIME if it slipped through in output.data. Render the interactive grid
        // + charts instead of the plain text table when present.
        const richFromField = cell.output.richDisplay;
        const richFromData = (cell.output.data as Record<string, unknown> | undefined)?.[LOOM_DISPLAY_MIME] as LoomDisplayPayload | undefined;
        const rich = richFromField || (richFromData && Array.isArray(richFromData.columns) ? richFromData : undefined);
        if (cell.output.status !== 'error' && rich) {
          return (
            <div style={{ padding: 8, borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
              <RichDisplay payload={rich} cellId={cell.id} notebookId={notebookId || ''} workspaceId={workspaceId || ''} computeId={computeId || ''} />
            </div>
          );
        }
        return (
          <>
          <div className={mergeClasses(
            s.outputBox,
            maximized && s.outputBoxMaximized,
            cell.output.status === 'error' && s.outputError,
          )}>
            {cell.output.status === 'error' && (
              <Badge appearance="filled" color="danger" size="small" style={{ marginBottom: 4 }}>
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
