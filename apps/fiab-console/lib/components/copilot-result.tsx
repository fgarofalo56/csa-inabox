'use client';

/**
 * CopilotResult — typed tool-result renderer for the Copilot surfaces.
 *
 * Replaces the old raw-JSON dump (`JSON.stringify(result, null, 2)` in a <pre>)
 * with a surface chosen by the result's kind:
 *
 *   table           → LoomDataTable  (Fluent DataGrid: sortable + filterable + resizable)
 *   chart           → KqlChart       (existing SVG chart; toggle to table)
 *   code            → MonacoTextarea read-only + Copy + "Insert into editor"
 *   summary         → rendered markdown (lightweight, no new npm dep)
 *   proposed_change → change-set receipt (field / before / after) + Open link
 *   error           → Fluent error MessageBar
 *   unknown         → collapsible raw view (only reached for untaggable output)
 *
 * No new dependencies: everything renders with @fluentui/react-components,
 * the self-hosted Monaco wrapper, and the in-repo KqlChart. All data is the
 * REAL output the Azure-native tool handlers produced — no mocks.
 */

import * as React from 'react';
import { useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Copy20Regular, ArrowDownload20Regular, Table20Regular, DataBarVertical20Regular,
  Code20Regular, DocumentText20Regular, Open16Regular, Checkmark16Regular,
} from '@fluentui/react-icons';
import { KqlChart } from '@/lib/components/monitor/kql-chart';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';
import {
  type TypedResult, type TableResult, type ChartResult, type CodeResult,
  type SummaryResult, type ProposedChangeResult, type ErrorResult,
} from '@/lib/components/copilot-result-tagger';

const useStyles = makeStyles({
  card: {
    marginTop: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  headTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  spacer: { flex: 1 },
  body: { padding: tokens.spacingHorizontalM },
  tableScroll: { maxHeight: 340, overflowY: 'auto' },
  // markdown
  md: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground1, fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase300,
  },
  mdH: { fontWeight: tokens.fontWeightSemibold, marginTop: tokens.spacingVerticalXS },
  mdPre: {
    fontFamily: 'var(--loom-font-mono, ui-monospace, Menlo, monospace)', whiteSpace: 'pre-wrap',
    backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalS, fontSize: tokens.fontSizeBase200, margin: 0, overflowX: 'auto',
  },
  mdList: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '2px' },
  // change set
  changeTable: { borderCollapse: 'collapse', width: '100%', fontSize: tokens.fontSizeBase200 },
  changeTh: { textAlign: 'left', padding: '4px 12px 4px 0', color: tokens.colorNeutralForeground3, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  changeTd: { padding: '4px 12px 4px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, verticalAlign: 'top', wordBreak: 'break-word' },
  rawDetails: { fontSize: tokens.fontSizeBase200 },
  rawPre: { whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', fontSize: tokens.fontSizeBase200, margin: 0, fontFamily: 'var(--loom-font-mono, ui-monospace, Menlo, monospace)' },
});

// ---------------------------------------------------------------------------
// Clipboard with IL5-hardened-browser fallback (clipboard API may be blocked).
// ---------------------------------------------------------------------------
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to execCommand */ }
  try {
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    }
  } catch { /* ignore */ }
  return false;
}

function CopyButton({ getText, label = 'Copy' }: { getText: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="small"
      appearance="subtle"
      icon={done ? <Checkmark16Regular /> : <Copy20Regular />}
      onClick={async () => {
        if (await copyText(getText())) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      aria-label={label}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

function fmtCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function TableRenderer({ result }: { result: TableResult }) {
  const s = useStyles();
  const { columns, rows } = result;
  const total = result.rowCount ?? rows.length;

  const objectRows = useMemo(
    () => rows.map((r, i) => {
      const o: Record<string, unknown> = { __i: i };
      columns.forEach((c, ci) => { o[c] = r[ci]; });
      return o;
    }),
    [columns, rows],
  );

  const gridColumns: LoomColumn<Record<string, unknown>>[] = useMemo(
    () => columns.map((c) => ({
      key: c,
      label: c,
      sortable: true,
      filterable: true,
      getValue: (row) => {
        const v = row[c];
        return typeof v === 'number' ? v : fmtCell(v);
      },
      render: (row) => fmtCell(row[c]),
    })),
    [columns],
  );

  return (
    <div className={s.card}>
      <div className={s.head}>
        <Table20Regular aria-hidden style={{ color: tokens.colorBrandForeground1 }} />
        <span className={s.headTitle}>{result.source ?? 'Query result'}</span>
        <Badge appearance="tint" size="small" color="success">{total} row{total === 1 ? '' : 's'}</Badge>
        {result.truncated && <Badge appearance="tint" size="small" color="warning">Truncated</Badge>}
        {result.executionMs != null && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{result.executionMs}ms</Caption1>}
        <span className={s.spacer} />
        <CopyButton getText={() => toCsv(columns, rows)} label="Copy CSV" />
      </div>
      <div className={s.tableScroll}>
        {columns.length === 0 || rows.length === 0 ? (
          <div style={{ padding: tokens.spacingHorizontalM }}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Query returned no rows.</Caption1>
          </div>
        ) : (
          <LoomDataTable
            columns={gridColumns}
            rows={objectRows}
            getRowId={(r) => String(r.__i)}
            ariaLabel={result.source ?? 'Query result'}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart (toggle to table)
// ---------------------------------------------------------------------------
function ChartRenderer({ result }: { result: ChartResult }) {
  const s = useStyles();
  const [asTableView, setAsTableView] = useState(false);
  return (
    <div className={s.card}>
      <div className={s.head}>
        <DataBarVertical20Regular aria-hidden style={{ color: tokens.colorBrandForeground1 }} />
        <span className={s.headTitle}>{result.title ?? result.source ?? 'Chart'}</span>
        <span className={s.spacer} />
        <Button
          size="small"
          appearance="subtle"
          icon={asTableView ? <DataBarVertical20Regular /> : <Table20Regular />}
          onClick={() => setAsTableView((v) => !v)}
          aria-label={asTableView ? 'Show chart' : 'Show table'}
        >
          {asTableView ? 'Chart' : 'Table'}
        </Button>
      </div>
      <div className={s.body}>
        {asTableView ? (
          <TableRenderer result={{ kind: 'table', columns: result.columns, rows: result.rows, source: result.source }} />
        ) : (
          <KqlChart type={result.chartType} columns={result.columns} rows={result.rows} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code (read-only Monaco + Copy + Insert into editor)
// ---------------------------------------------------------------------------
const MONACO_LANGS: ReadonlySet<string> = new Set<MonacoLanguage>([
  'python', 'pyspark', 'spark', 'scala', 'sql', 'tsql', 'sparksql', 'r', 'sparkr',
  'csharp', 'kql', 'kusto', 'xml', 'json', 'graphql', 'javascript', 'typescript',
  'yaml', 'markdown', 'plaintext',
]);
function toMonacoLang(lang: string): MonacoLanguage {
  const l = lang.toLowerCase();
  if (MONACO_LANGS.has(l)) return l as MonacoLanguage;
  if (l === 'py') return 'python';
  if (l === 'ts') return 'typescript';
  if (l === 'js') return 'javascript';
  if (l === 'shell' || l === 'bash' || l === 'sh') return 'plaintext';
  return 'plaintext';
}

/** Broadcast the code so any open editor that opted in can inject it. */
export function dispatchInsertCode(code: string, language: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('loom:insert-code', { detail: { code, language } }));
}

function CodeRenderer({ result }: { result: CodeResult }) {
  const s = useStyles();
  const [inserted, setInserted] = useState(false);
  const lines = result.code.split('\n').length;
  const height = Math.min(Math.max(lines * 19 + 16, 80), 400);

  return (
    <div className={s.card}>
      <div className={s.head}>
        <Code20Regular aria-hidden style={{ color: tokens.colorBrandForeground1 }} />
        <span className={s.headTitle}>{result.filename ?? result.language}</span>
        <Badge appearance="tint" size="small" color="informative">{result.language}</Badge>
        <span className={s.spacer} />
        <CopyButton getText={() => result.code} />
        <Button
          size="small"
          appearance="subtle"
          icon={inserted ? <Checkmark16Regular /> : <ArrowDownload20Regular />}
          onClick={async () => {
            // Broadcast for any open code editor that listens, AND copy to the
            // clipboard so the action has a guaranteed observable effect even
            // when no editor is focused (no-vaporware: the control always does
            // something the user can act on).
            dispatchInsertCode(result.code, result.language);
            await copyText(result.code);
            setInserted(true);
            setTimeout(() => setInserted(false), 1500);
          }}
          aria-label="Insert into editor"
          title="Sends the code to an open code editor that accepts inserts, and copies it to the clipboard."
        >
          {inserted ? 'Sent' : 'Insert into editor'}
        </Button>
      </div>
      {result.description && (
        <Caption1 style={{ display: 'block', padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM} 0`, color: tokens.colorNeutralForeground3 }}>
          {result.description}
        </Caption1>
      )}
      <div className={s.body}>
        <MonacoTextarea
          value={result.code}
          onChange={() => { /* read-only */ }}
          language={toMonacoLang(result.language)}
          readOnly
          height={height}
          ariaLabel={`${result.language} code`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary — lightweight markdown (no react-markdown dependency)
// ---------------------------------------------------------------------------
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  // Split on **bold**, `code`, and *italic* while preserving the delimiters.
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(
      <code key={key} style={{ fontFamily: 'var(--loom-font-mono, ui-monospace, Menlo, monospace)', backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall, padding: '1px 4px', fontSize: tokens.fontSizeBase200 }}>{tok.slice(1, -1)}</code>,
    );
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function SummaryRenderer({ result }: { result: SummaryResult }) {
  const s = useStyles();
  const blocks = useMemo(() => {
    const md = result.markdown ?? '';
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const nodes: React.ReactNode[] = [];
    let i = 0;
    let listBuf: { ordered: boolean; items: string[] } | null = null;
    const flushList = () => {
      if (!listBuf) return;
      const Tag = listBuf.ordered ? 'ol' : 'ul';
      nodes.push(
        React.createElement(
          Tag,
          { key: `list-${nodes.length}`, className: s.mdList },
          listBuf.items.map((it, k) => <li key={k}>{renderInline(it, `li-${nodes.length}-${k}`)}</li>),
        ),
      );
      listBuf = null;
    };
    while (i < lines.length) {
      const line = lines[i];
      // fenced code block
      if (/^```/.test(line.trim())) {
        flushList();
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        i++; // closing fence
        nodes.push(<pre key={`pre-${nodes.length}`} className={s.mdPre}>{buf.join('\n')}</pre>);
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushList();
        const level = heading[1].length;
        const size = level <= 1 ? tokens.fontSizeBase500 : level === 2 ? tokens.fontSizeBase400 : tokens.fontSizeBase300;
        nodes.push(
          <div key={`h-${nodes.length}`} className={s.mdH} style={{ fontSize: size }}>
            {renderInline(heading[2], `h-${nodes.length}`)}
          </div>,
        );
        i++; continue;
      }
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        const isOrdered = !!ordered;
        if (!listBuf || listBuf.ordered !== isOrdered) { flushList(); listBuf = { ordered: isOrdered, items: [] }; }
        listBuf.items.push((bullet ? bullet[1] : ordered![1]));
        i++; continue;
      }
      if (line.trim() === '') { flushList(); i++; continue; }
      flushList();
      nodes.push(<div key={`p-${nodes.length}`}>{renderInline(line, `p-${nodes.length}`)}</div>);
      i++;
    }
    flushList();
    return nodes;
  }, [result.markdown, s]);

  return (
    <div className={s.card}>
      <div className={s.head}>
        <DocumentText20Regular aria-hidden style={{ color: tokens.colorBrandForeground1 }} />
        <span className={s.headTitle}>{result.title ?? 'Summary'}</span>
      </div>
      <div className={s.body}>
        <div className={s.md}>{blocks}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposed change — a change-set receipt
// ---------------------------------------------------------------------------
function ProposedChangeRenderer({ result }: { result: ProposedChangeResult }) {
  const s = useStyles();
  const openHref = result.targetId ? `/items/${encodeURIComponent(result.targetType)}/${encodeURIComponent(result.targetId)}` : null;
  return (
    <div className={s.card}>
      <div className={s.head}>
        <Checkmark16Regular aria-hidden style={{ color: tokens.colorPaletteGreenForeground1 }} />
        <span className={s.headTitle}>{result.displayName ?? result.targetType}</span>
        <Badge appearance="tint" size="small" color="brand">{result.targetType}</Badge>
        <span className={s.spacer} />
        {openHref && (
          <Button as="a" href={openHref} size="small" appearance="subtle" icon={<Open16Regular />}>
            Open
          </Button>
        )}
      </div>
      <div className={s.body}>
        {result.description && (
          <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
            {result.description}
          </Caption1>
        )}
        <table className={s.changeTable}>
          <thead>
            <tr>
              <th className={s.changeTh}>Field</th>
              <th className={s.changeTh}>Before</th>
              <th className={s.changeTh}>After</th>
            </tr>
          </thead>
          <tbody>
            {result.changes.map((c, i) => (
              <tr key={i}>
                <td className={s.changeTd}><strong>{c.field}</strong></td>
                <td className={s.changeTd}>{c.before == null ? '—' : fmtCell(c.before)}</td>
                <td className={s.changeTd}>{fmtCell(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error + Unknown
// ---------------------------------------------------------------------------
function ErrorRenderer({ result }: { result: ErrorResult }) {
  return (
    <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}>
      <MessageBarBody>
        {result.code && <MessageBarTitle>{result.code}</MessageBarTitle>}
        <span style={{ whiteSpace: 'pre-wrap' }}>{result.message}</span>
      </MessageBarBody>
    </MessageBar>
  );
}

function UnknownRenderer({ raw }: { raw: unknown }) {
  const s = useStyles();
  let text: string;
  try { text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2); }
  catch { text = String(raw); }
  return (
    <details className={s.rawDetails} style={{ marginTop: tokens.spacingVerticalS }}>
      <summary style={{ cursor: 'pointer', color: tokens.colorNeutralForeground3 }}>Result detail</summary>
      <pre className={s.rawPre}>{text}</pre>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export function CopilotResult({ result }: { result: TypedResult; toolName?: string }) {
  switch (result.kind) {
    case 'table': return <TableRenderer result={result} />;
    case 'chart': return <ChartRenderer result={result} />;
    case 'code': return <CodeRenderer result={result} />;
    case 'summary': return <SummaryRenderer result={result} />;
    case 'proposed_change': return <ProposedChangeRenderer result={result} />;
    case 'error': return <ErrorRenderer result={result} />;
    default: return <UnknownRenderer raw={(result as { raw?: unknown }).raw} />;
  }
}

export default CopilotResult;
