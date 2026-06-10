'use client';

/**
 * CopilotDiff — approval gate for any Copilot-proposed code/query/transform
 * change. Renders a REAL Monaco DiffEditor (before | after, side-by-side,
 * read-only) inside a Fluent Dialog with **Keep** and **Undo**.
 *
 * Contract (per the approval-diff task + no-vaporware):
 *  - The editor is mutated ONLY when the user clicks **Keep** — never on open,
 *    never on stream. The parent owns the mutation: `onKeep(change)` is where
 *    the actual editor write happens (via the apply-change bridge registry for
 *    orchestrator-driven changes, or a direct callback for the notebook pane).
 *  - **Undo** (button), the dialog dismiss (X), Escape, or clicking the
 *    backdrop all discard the change and leave the editor byte-for-byte
 *    unchanged via `onUndo()`.
 *  - a11y: the DiffEditor is labelled; a visually-hidden live region announces
 *    the before/after line counts; Keep is the primary, focused default action.
 *
 * Self-hosted Monaco: this mirrors monaco-textarea.tsx's AMD-loader + worker
 * shim so the DiffEditor loads from /monaco/vs (same-origin, CSP-safe) in every
 * cloud (Commercial / GCC / GCC-High / IL5) with no external CDN.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Badge, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Checkmark20Regular, ArrowUndo20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';

// Self-host the Monaco AMD loader from /monaco/vs (copied at build time by
// scripts/copy-monaco-assets.mjs). Identical to monaco-textarea.tsx — the
// default @monaco-editor/react config fetches loader.js from a CDN blocked by
// our CSP. loader.config is idempotent, so calling it here as well as in
// monaco-textarea is safe.
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@monaco-editor/react');
  const vsBase = `${window.location.origin}/monaco/vs`;
  // Optional-chained: in unit tests `@monaco-editor/react` is stubbed without a
  // `loader`, so guard the config call rather than crash on module load.
  mod?.loader?.config?.({ paths: { vs: vsBase } });
  if (!(window as any).MonacoEnvironment) {
    (window as any).MonacoEnvironment = {
      getWorkerUrl() {
        const shim = `self.MonacoEnvironment={baseUrl:'${window.location.origin}/monaco/'};importScripts('${vsBase}/base/worker/workerMain.js');`;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(shim)}`;
      },
    };
  }
}

const DiffEditor = dynamic(
  () => import('@monaco-editor/react').then((m) => m.DiffEditor),
  { ssr: false, loading: () => null },
);

/**
 * A proposed change emitted by a tool. `target` is a deterministic editor-bridge
 * key (e.g. "notebook-cell:<id>"); `lang` is an optional Monaco language hint.
 */
export interface ProposedChange {
  target: string;
  before: string;
  after: string;
  lang?: string;
  callId?: string;
  /** Optional human label for the change (tool rationale / summary). */
  summary?: string;
}

export interface CopilotDiffProps {
  /** The change to review, or null when the modal is closed. */
  change: ProposedChange | null;
  /** Invoked when the user clicks Keep. The parent performs the real mutation. */
  onKeep: (change: ProposedChange) => void;
  /** Invoked on Undo / dismiss / Escape — the change is discarded. */
  onUndo: () => void;
}

/** Map a tool-supplied language hint onto a Monaco language id. */
function mapLanguage(lang?: string): string {
  switch ((lang || '').toLowerCase()) {
    case 'pyspark':
    case 'python': return 'python';
    case 'spark':
    case 'scala': return 'scala';
    case 'sparksql':
    case 'tsql':
    case 'sql': return 'sql';
    case 'sparkr':
    case 'r': return 'r';
    case 'csharp': return 'csharp';
    case 'kql':
    case 'kusto': return 'kusto';
    case 'xml': return 'xml';
    case 'json': return 'json';
    case 'yaml': return 'yaml';
    case 'graphql': return 'graphql';
    case 'javascript': return 'javascript';
    case 'typescript': return 'typescript';
    case 'markdown': return 'markdown';
    default: return 'plaintext';
  }
}

let loomThemeDefined = false;
function defineLoomThemeOnce(monaco: any) {
  if (loomThemeDefined) return;
  monaco.editor.defineTheme('loom-dark', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
    ],
    colors: { 'editor.background': '#1B1A19', 'editor.foreground': '#D4D4D4' },
  });
  monaco.editor.defineTheme('loom-light', {
    base: 'vs', inherit: true,
    rules: [
      { token: 'keyword', foreground: '0000FF' },
      { token: 'string', foreground: 'A31515' },
      { token: 'number', foreground: '098658' },
      { token: 'comment', foreground: '008000', fontStyle: 'italic' },
    ],
    colors: {},
  });
  loomThemeDefined = true;
}

function detectTheme(): 'loom-dark' | 'loom-light' {
  if (typeof window === 'undefined') return 'loom-light';
  const isDark = document.documentElement.classList.contains('dark') ||
    window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return isDark ? 'loom-dark' : 'loom-light';
}

const useStyles = makeStyles({
  surface: { maxWidth: '920px', width: '90vw' },
  diffWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  meta: {
    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
    marginBottom: '8px',
  },
  target: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
  },
  srOnly: {
    position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px',
    overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
  },
});

export function CopilotDiff({ change, onKeep, onUndo }: CopilotDiffProps) {
  const s = useStyles();
  const monacoRef = useRef<any>(null);

  // Keep Monaco theme in sync with the app's dark/light class.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (monacoRef.current) monacoRef.current.editor.setTheme(detectTheme());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const beforeLines = useMemo(() => (change ? change.before.split('\n').length : 0), [change]);
  const afterLines = useMemo(() => (change ? change.after.split('\n').length : 0), [change]);

  const height = useMemo(() => {
    const lines = Math.max(beforeLines, afterLines);
    return Math.max(200, Math.min(520, lines * 19 + 40));
  }, [beforeLines, afterLines]);

  const handleKeep = useCallback(() => {
    if (!change) return;
    onKeep(change);
  }, [change, onKeep]);

  const onMount = useCallback((_editor: any, monaco: any) => {
    monacoRef.current = monaco;
    defineLoomThemeOnce(monaco);
    monaco.editor.setTheme(detectTheme());
  }, []);

  const open = change !== null;
  const language = mapLanguage(change?.lang);

  return (
    <Dialog
      open={open}
      modalType="modal"
      // Dismiss (X / backdrop / Escape) discards the change.
      onOpenChange={(_, d) => { if (!d.open) onUndo(); }}
    >
      <DialogSurface className={s.surface} aria-label="Review proposed change">
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Sparkle20Regular style={{ color: tokens.colorBrandForeground1 }} />
              Review proposed change
            </span>
          </DialogTitle>
          <DialogContent>
            {change && (
              <>
                <div className={s.meta}>
                  <span className={s.target}>{change.target}</span>
                  <Badge appearance="outline" color="brand" size="small">
                    {language}
                  </Badge>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {beforeLines} → {afterLines} lines
                  </Caption1>
                </div>
                {change.summary && (
                  <Caption1 style={{ display: 'block', marginBottom: 8 }}>
                    {change.summary}
                  </Caption1>
                )}
                {/* Visually-hidden live region for screen readers. */}
                <div className={s.srOnly} role="status" aria-live="polite">
                  Proposed change to {change.target}. Before: {beforeLines} lines.
                  After: {afterLines} lines. Press Keep to apply, Undo to discard.
                </div>
                <div
                  className={s.diffWrap}
                  style={{ height }}
                  role="group"
                  aria-label={`Diff of ${change.target}: before and after`}
                >
                  <DiffEditor
                    original={change.before}
                    modified={change.after}
                    language={language}
                    height="100%"
                    onMount={onMount}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      fontSize: 13,
                      fontFamily: 'Consolas, "Cascadia Code", monospace',
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      renderOverviewRuler: false,
                    }}
                  />
                </div>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              icon={<ArrowUndo20Regular />}
              onClick={onUndo}
            >
              Undo
            </Button>
            <Button
              appearance="primary"
              icon={<Checkmark20Regular />}
              onClick={handleKeep}
            >
              Keep
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default CopilotDiff;
