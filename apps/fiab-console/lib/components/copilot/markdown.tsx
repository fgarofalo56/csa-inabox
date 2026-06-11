'use client';

/**
 * CopilotMarkdown — shared assistant-message renderer for the Loom Copilot
 * console transcript.
 *
 * Renders prose markdown (headings, bold/italic, inline code, links, bullet +
 * numbered lists, blockquotes, tables) and delegates fenced code blocks
 * (```lang … ```) to the real Monaco surface (read-only, syntax-highlighted)
 * with a Copy button — so a model answer that includes T-SQL / KQL / Python
 * shows colourised code, not a flat `<pre>` dump.
 *
 * No new npm dependency is added (the repo intentionally ships no
 * react-markdown / shiki): the inline renderer is a hardened version of the
 * notebook markdown-cell escaper, and code blocks reuse the in-repo
 * MonacoTextarea editor that every other Loom code surface uses.
 */

import { useMemo, useState } from 'react';
import { Button, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { Copy16Regular, Checkmark16Regular } from '@fluentui/react-icons';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  prose: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: tokens.colorNeutralForeground1,
    wordBreak: 'break-word',
    '& h1': { fontSize: tokens.fontSizeBase500, margin: `${tokens.spacingVerticalM} 0 ${tokens.spacingVerticalXS}` },
    '& h2': { fontSize: tokens.fontSizeBase400, margin: `${tokens.spacingVerticalM} 0 ${tokens.spacingVerticalXS}` },
    '& h3': { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalXXS}` },
    '& p': { margin: `${tokens.spacingVerticalXS} 0` },
    '& ul, & ol': { margin: `${tokens.spacingVerticalXS} 0`, paddingLeft: tokens.spacingHorizontalXL },
    '& li': { margin: '2px 0' },
    '& a': { color: tokens.colorBrandForeground1 },
    '& code': {
      fontFamily: 'var(--loom-font-mono, ui-monospace, Menlo, Consolas, monospace)',
      fontSize: tokens.fontSizeBase200,
      backgroundColor: tokens.colorNeutralBackground3,
      padding: '1px 5px',
      borderRadius: tokens.borderRadiusSmall,
    },
    '& blockquote': {
      margin: `${tokens.spacingVerticalXS} 0`,
      paddingLeft: tokens.spacingHorizontalM,
      borderLeft: `3px solid ${tokens.colorNeutralStroke2}`,
      color: tokens.colorNeutralForeground2,
    },
    '& table': { borderCollapse: 'collapse', margin: `${tokens.spacingVerticalS} 0`, fontSize: tokens.fontSizeBase200 },
    '& th, & td': { border: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px 8px', textAlign: 'left' },
    '& th': { backgroundColor: tokens.colorNeutralBackground2, fontWeight: tokens.fontWeightSemibold },
  },
  codeBlock: {
    position: 'relative',
    margin: `${tokens.spacingVerticalS} 0`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  codeBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `2px 4px 2px ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
});

const LANG_MAP: Record<string, MonacoLanguage> = {
  py: 'python', python: 'python', pyspark: 'pyspark',
  sql: 'sql', tsql: 'tsql', sparksql: 'sparksql',
  kql: 'kql', kusto: 'kusto',
  scala: 'scala', spark: 'spark',
  r: 'r', csharp: 'csharp', cs: 'csharp',
  xml: 'xml', json: 'json', yaml: 'yaml', yml: 'yaml',
  graphql: 'graphql', js: 'javascript', javascript: 'javascript',
  ts: 'typescript', typescript: 'typescript', dax: 'dax', md: 'markdown',
};

function mapFence(lang: string | undefined): MonacoLanguage {
  if (!lang) return 'plaintext';
  return LANG_MAP[lang.toLowerCase().trim()] ?? 'plaintext';
}

/** Escape + render a single prose (non-code) markdown segment to HTML. */
function renderProse(src: string): string {
  let html = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Tables (GitHub pipe tables) — header row, separator, body rows.
  html = html.replace(
    /(^\|.+\|[ \t]*\n\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|[ \t]*\n(?:\|.*\|[ \t]*\n?)*)/gm,
    (block) => {
      const rows = block.trim().split('\n');
      const header = rows[0];
      const body = rows.slice(2);
      const cells = (row: string) =>
        row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const th = cells(header).map((c) => `<th>${c}</th>`).join('');
      const trs = body
        .map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('');
      return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
    },
  );

  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  // Numbered lists
  html = html.replace(/^(?:\d+\. .+(?:\n|$))+/gm, (block) => {
    const lis = block.split('\n').filter(Boolean)
      .map((l) => '<li>' + l.replace(/^\d+\. /, '') + '</li>').join('');
    return '<ol>' + lis + '</ol>';
  });
  // Bullet lists
  html = html.replace(/^(?:[-*] .+(?:\n|$))+/gm, (block) => {
    const lis = block.split('\n').filter(Boolean)
      .map((l) => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('');
    return '<ul>' + lis + '</ul>';
  });
  // Paragraph breaks (leave block-level elements untouched)
  html = html.split(/\n\n+/)
    .map((p) => /<\/(h\d|ul|ol|pre|table|blockquote)>/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br/>') + '</p>')
    .join('');
  return html;
}

interface Segment {
  type: 'prose' | 'code';
  content: string;
  lang?: string;
}

/** Split markdown into prose + fenced-code segments. */
function splitSegments(src: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(src)) !== null) {
    if (m.index > last) segments.push({ type: 'prose', content: src.slice(last, m.index) });
    segments.push({ type: 'code', content: m[2].replace(/\n$/, ''), lang: m[1].trim() || undefined });
    last = fence.lastIndex;
  }
  if (last < src.length) segments.push({ type: 'prose', content: src.slice(last) });
  return segments;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  const language = mapFence(lang);
  const lineCount = code.split('\n').length;
  const height = Math.min(Math.max(lineCount * 19 + 16, 56), 420);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className={s.codeBlock}>
      <div className={s.codeBar}>
        <span>{lang || 'text'}</span>
        <Tooltip content={copied ? 'Copied' : 'Copy code'} relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
            onClick={copy}
            aria-label="Copy code"
          />
        </Tooltip>
      </div>
      <MonacoTextarea
        value={code}
        onChange={() => { /* read-only */ }}
        language={language}
        readOnly
        height={height}
        lineNumbers={false}
        ariaLabel={`${lang || 'code'} block`}
      />
    </div>
  );
}

export function CopilotMarkdown({ source }: { source: string }) {
  const s = useStyles();
  const segments = useMemo(() => splitSegments(source || ''), [source]);
  return (
    <div>
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} code={seg.content} lang={seg.lang} />
        ) : (
          <div
            key={i}
            className={s.prose}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderProse(seg.content) }}
          />
        ),
      )}
    </div>
  );
}
