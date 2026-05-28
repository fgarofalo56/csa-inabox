'use client';

/**
 * MonacoTextarea — Fabric-parity code editor surface.
 *
 * Drop-in replacement for `<textarea>` across CSA Loom editors. Provides
 * syntax colorization, IntelliSense, error squigglies and per-language tokens
 * matching the v2 fabric-parity-loop contract.
 *
 * Languages supported here map to Monaco's built-ins:
 *   python / pyspark      -> python
 *   spark (Scala)         -> scala (via 'scala' built-in)
 *   sparksql / tsql / sql -> sql
 *   sparkr / r            -> r
 *   kql                   -> kusto (registered below; full schema via
 *                            @kusto/monaco-kusto in a follow-up PR)
 *   xml                   -> xml (used by APIM policies)
 *   json                  -> json (used by ADF / Synapse pipeline JSON tab)
 *   graphql               -> graphql
 *   javascript            -> javascript
 *   typescript            -> typescript
 *
 * Per the no-vaporware rule, this is the front+middle+back-end edit
 * surface — the actual SDK is loaded dynamically client-side so SSR works.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef } from 'react';
import { tokens } from '@fluentui/react-components';
import type { OnMount, OnChange } from '@monaco-editor/react';

// Self-host the Monaco AMD loader from /monaco/vs (copied at build time by
// scripts/copy-monaco-assets.mjs). The default @monaco-editor/react config
// fetches loader.js from cdn.jsdelivr.net which is blocked by our CSP
// (`script-src 'self' 'unsafe-inline'`) and breaks every code editor in
// the app. This must be configured before the first MonacoEditor mount.
if (typeof window !== 'undefined') {
  // Lazy import so loader.config doesn't trip on SSR.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loader } = require('@monaco-editor/react');
  // ABSOLUTE origin (not root-relative). Monaco's language workers run in a
  // blob: worker context whose base origin is `null`, so a root-relative
  // path like `/monaco/vs/...` fails inside importScripts() with
  // "The URL '/monaco/vs/language/json/jsonWorker.js' is invalid".
  // Anchoring to window.location.origin makes the importScripts URL
  // absolute so the worker bootstrap resolves correctly.
  const vsBase = `${window.location.origin}/monaco/vs`;
  loader.config({ paths: { vs: vsBase } });
  // Belt-and-suspenders: some Monaco builds read MonacoEnvironment.getWorkerUrl
  // instead of the AMD path. Return a same-origin loader-shim worker that
  // importScripts the absolute workerMain, avoiding the blob-origin issue.
  (window as any).MonacoEnvironment = {
    getWorkerUrl() {
      const shim = `self.MonacoEnvironment={baseUrl:'${window.location.origin}/monaco/'};importScripts('${vsBase}/base/worker/workerMain.js');`;
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(shim)}`;
    },
  };
}

const MonacoEditor = dynamic(
  () => import('@monaco-editor/react').then(m => m.default),
  { ssr: false, loading: () => null },
);

export type MonacoLanguage =
  | 'python'
  | 'pyspark'
  | 'spark'         // Scala
  | 'scala'
  | 'sql'
  | 'tsql'
  | 'sparksql'
  | 'r'
  | 'sparkr'
  | 'kql'
  | 'kusto'
  | 'xml'
  | 'json'
  | 'graphql'
  | 'javascript'
  | 'typescript'
  | 'plaintext';

export interface MonacoTextareaProps {
  value: string;
  onChange: (next: string) => void;
  language?: MonacoLanguage;
  readOnly?: boolean;
  height?: number | string;
  minHeight?: number;
  className?: string;
  ariaLabel?: string;
  /** Show minimap. Default off for narrow cells. */
  minimap?: boolean;
  /** Word wrap. Default on. */
  wordWrap?: boolean;
}

function mapLanguage(lang?: MonacoLanguage): string {
  switch (lang) {
    case 'pyspark':
    case 'python': return 'python';
    case 'spark':
    case 'scala': return 'scala';
    case 'sparksql':
    case 'tsql':
    case 'sql': return 'sql';
    case 'sparkr':
    case 'r': return 'r';
    case 'kql':
    case 'kusto': return 'kusto';
    case 'xml': return 'xml';
    case 'json': return 'json';
    case 'graphql': return 'graphql';
    case 'javascript': return 'javascript';
    case 'typescript': return 'typescript';
    default: return 'plaintext';
  }
}

let kustoRegistered = false;
function registerKustoLanguageOnce(monaco: any) {
  if (kustoRegistered) return;
  if (monaco.languages.getLanguages().some((l: any) => l.id === 'kusto')) {
    kustoRegistered = true;
    return;
  }
  monaco.languages.register({ id: 'kusto', extensions: ['.kql', '.csl'] });
  monaco.languages.setMonarchTokensProvider('kusto', {
    defaultToken: '',
    ignoreCase: true,
    keywords: [
      'and', 'or', 'not', 'in', 'has', 'contains', 'startswith', 'endswith',
      'matches', 'between', 'true', 'false', 'null', 'by', 'on', 'asc', 'desc',
      'kind', 'where', 'project', 'extend', 'summarize', 'count', 'distinct',
      'top', 'sort', 'order', 'limit', 'take', 'join', 'union', 'evaluate',
      'render', 'datatable', 'let', 'materialize', 'mv-expand', 'parse',
      'print', 'search', 'range', 'reduce', 'sample', 'serialize',
    ],
    operators: ['=', '==', '!=', '<', '>', '<=', '>=', '=~', '!~', '+', '-', '*', '/', '%', '|'],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/'[^']*'/, 'string'],
        [/"[^"]*"/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[a-zA-Z_][\w]*/, {
          cases: { '@keywords': 'keyword', '@default': 'identifier' },
        }],
        [/[|=<>!+\-*/%]+/, 'operator'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('kusto', {
    comments: { lineComment: '//' },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
    ],
  });
  kustoRegistered = true;
}

let darkThemeDefined = false;
function defineLoomThemeOnce(monaco: any) {
  if (darkThemeDefined) return;
  monaco.editor.defineTheme('loom-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '569CD6' },
      { token: 'identifier', foreground: 'D4D4D4' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'operator', foreground: 'D4D4D4' },
    ],
    colors: {
      'editor.background': '#1B1A19',
      'editor.foreground': '#D4D4D4',
      'editorLineNumber.foreground': '#858585',
      'editor.selectionBackground': '#264F78',
      'editor.inactiveSelectionBackground': '#3A3D41',
      'editorIndentGuide.background': '#404040',
      'editor.lineHighlightBackground': '#2A2D2E',
    },
  });
  monaco.editor.defineTheme('loom-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '0000FF' },
      { token: 'string', foreground: 'A31515' },
      { token: 'number', foreground: '098658' },
      { token: 'comment', foreground: '008000', fontStyle: 'italic' },
    ],
    colors: {},
  });
  darkThemeDefined = true;
}

function detectTheme(): 'loom-dark' | 'loom-light' {
  if (typeof window === 'undefined') return 'loom-light';
  const isDark = document.documentElement.classList.contains('dark') ||
    window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return isDark ? 'loom-dark' : 'loom-light';
}

export function MonacoTextarea({
  value,
  onChange,
  language = 'plaintext',
  readOnly = false,
  height = 240,
  minHeight,
  className,
  ariaLabel,
  minimap = false,
  wordWrap = true,
}: MonacoTextareaProps) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const monacoLang = mapLanguage(language);

  const onMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    defineLoomThemeOnce(monaco);
    if (monacoLang === 'kusto') registerKustoLanguageOnce(monaco);
    monaco.editor.setTheme(detectTheme());
  }, [monacoLang]);

  // Watch for dark/light class flips on <html> and resync the theme.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (monacoRef.current) monacoRef.current.editor.setTheme(detectTheme());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const handleChange: OnChange = useCallback((v) => {
    onChange(v ?? '');
  }, [onChange]);

  return (
    <div
      className={className}
      role="textbox"
      aria-label={ariaLabel}
      aria-readonly={readOnly}
      style={{
        height,
        minHeight,
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: 4,
        overflow: 'hidden',
        backgroundColor: tokens.colorNeutralBackground3,
      }}
    >
      <MonacoEditor
        value={value}
        language={monacoLang}
        onMount={onMount}
        onChange={handleChange}
        height="100%"
        options={{
          readOnly,
          minimap: { enabled: minimap },
          wordWrap: wordWrap ? 'on' : 'off',
          fontFamily: 'Consolas, "Cascadia Code", monospace',
          fontSize: 13,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'line',
          renderWhitespace: 'selection',
          tabSize: 2,
          insertSpaces: true,
          automaticLayout: true,
          suggestOnTriggerCharacters: true,
          quickSuggestions: { other: true, comments: false, strings: false },
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}

export default MonacoTextarea;
