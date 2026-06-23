'use client';

/**
 * ResponseBodyViewer — a content-type-aware formatter for an HTTP response body.
 *
 * Used by the API marketplace "Try it" panel and the data-product preview so a
 * raw payload is never dumped as an unreadable single line. It:
 *   - detects the format from the Content-Type (and sniffs the body as a
 *     fallback): JSON, XML/HTML, CSV/TSV, or plain text;
 *   - pretty-prints JSON (2-space) with lightweight, safe syntax highlighting
 *     (keys / strings / numbers / booleans / null colored via Loom tokens);
 *   - indents XML; renders CSV/TSV as a real sortable-feeling table;
 *   - offers a Pretty | Raw toggle, a format badge, and copy (raw + pretty);
 *   - degrades gracefully — an unparseable JSON/XML/CSV falls back to raw text.
 *
 * Pure presentational + Loom-tokenized (web3.0). No network, no freeform input.
 */

import * as React from 'react';
import {
  Badge, Button, Caption1, Tooltip, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { Copy20Regular, Code20Regular, TextAlignLeft20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  code: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '12px',
    lineHeight: '1.55',
    whiteSpace: 'pre',
    overflowX: 'auto',
    maxHeight: '420px',
    overflowY: 'auto',
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    margin: 0,
  },
  wrap: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  // JSON token colors (Loom palette — readable in light + dark).
  jKey: { color: tokens.colorBrandForeground1 },
  jStr: { color: tokens.colorPaletteGreenForeground2 },
  jNum: { color: tokens.colorPaletteBerryForeground2 },
  jBool: { color: tokens.colorPaletteMarigoldForeground2 },
  jNull: { color: tokens.colorNeutralForeground3 },
  tableWrap: {
    overflowX: 'auto', maxHeight: '420px', overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
  },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: '12px' },
  th: {
    textAlign: 'left', padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground3, borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    position: 'sticky', top: 0, fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap',
  },
  td: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, verticalAlign: 'top',
    fontFamily: 'Consolas, monospace',
  },
  empty: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
});

export type BodyFormat = 'json' | 'xml' | 'csv' | 'tsv' | 'text';

/** Classify the payload format from the Content-Type, sniffing the body as a fallback. */
export function detectBodyFormat(body: string, contentType?: string): BodyFormat {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json') || ct.includes('+json')) return 'json';
  if (ct.includes('xml') || ct.includes('html')) return 'xml';
  if (ct.includes('csv')) return 'csv';
  if (ct.includes('tab-separated') || ct.includes('tsv')) return 'tsv';
  // Sniff when the content-type is missing/generic (octet-stream, text/plain).
  const t = (body || '').trim();
  if (!t) return 'text';
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return 'json'; } catch { /* not JSON */ }
  }
  if (t.startsWith('<') && t.endsWith('>')) return 'xml';
  return 'text';
}

/** Pretty-print JSON (2-space). Returns null if the body isn't valid JSON. */
export function tryPrettyJson(body: string): string | null {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return null; }
}

/** Naive but safe XML/HTML indenter — one tag per line, 2-space nesting. */
export function prettyXml(body: string): string {
  const withBreaks = body.replace(/>\s*</g, '>\n<').trim();
  let depth = 0;
  return withBreaks
    .split('\n')
    .map((raw) => {
      const line = raw.trim();
      if (/^<\/[^>]+>/.test(line)) depth = Math.max(0, depth - 1);
      const padded = `${'  '.repeat(depth)}${line}`;
      // Open tag that isn't self-closing and isn't an immediate open+close pair.
      if (/^<[^!?][^>]*[^/]>$/.test(line) && !/^<[^>]+>.*<\/[^>]+>$/.test(line)) depth += 1;
      return padded;
    })
    .join('\n');
}

/** Split a CSV/TSV line respecting simple double-quoted fields. */
function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (c === delim && !inQ) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse CSV/TSV into header + rows. Returns null when it doesn't look tabular. */
export function tryParseTable(body: string, delim: ','| '\t'): { header: string[]; rows: string[][] } | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = splitDelimited(lines[0], delim);
  if (header.length < 2) return null;
  const rows = lines.slice(1, 2001).map((l) => splitDelimited(l, delim));
  // Sanity: most rows should have ~the same column count as the header.
  const consistent = rows.filter((r) => Math.abs(r.length - header.length) <= 1).length;
  if (consistent < rows.length * 0.6) return null;
  return { header, rows };
}

/** Tokenize a pretty-printed JSON string into colored React spans (safe — no HTML injection). */
function highlightJson(pretty: string, s: ReturnType<typeof useStyles>): React.ReactNode[] {
  // Matches strings (incl. keys), numbers, booleans, null. Keys = a string
  // immediately followed by a colon.
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(pretty)) !== null) {
    if (m.index > last) out.push(pretty.slice(last, m.index));
    if (m[1] !== undefined) {
      // string; if followed by a colon it's a key
      if (m[2] !== undefined) {
        out.push(<span key={k++} className={s.jKey}>{m[1]}</span>);
        out.push(m[2]);
      } else {
        out.push(<span key={k++} className={s.jStr}>{m[1]}</span>);
      }
    } else if (m[3] !== undefined) {
      out.push(<span key={k++} className={s.jBool}>{m[3]}</span>);
    } else if (m[4] !== undefined) {
      out.push(<span key={k++} className={s.jNum}>{m[4]}</span>);
    } else {
      out.push(<span key={k++} className={s.jNull}>null</span>);
    }
    last = re.lastIndex;
  }
  if (last < pretty.length) out.push(pretty.slice(last));
  return out;
}

const FORMAT_LABEL: Record<BodyFormat, string> = {
  json: 'JSON', xml: 'XML', csv: 'CSV', tsv: 'TSV', text: 'Text',
};

export function ResponseBodyViewer({
  body, contentType, ariaLabel = 'Response body',
}: {
  body: string;
  contentType?: string;
  ariaLabel?: string;
}) {
  const s = useStyles();
  const fmt = React.useMemo(() => detectBodyFormat(body, contentType), [body, contentType]);
  const [raw, setRaw] = React.useState(false);

  const pretty = React.useMemo(() => {
    if (fmt === 'json') return tryPrettyJson(body);
    if (fmt === 'xml') return prettyXml(body);
    return null;
  }, [fmt, body]);

  const table = React.useMemo(() => {
    if (fmt === 'csv') return tryParseTable(body, ',');
    if (fmt === 'tsv') return tryParseTable(body, '\t');
    return null;
  }, [fmt, body]);

  const canPretty = pretty != null || table != null;
  const copy = (text: string) => { try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ } };

  if (!body) return <div className={mergeClasses(s.code, s.wrap)}><span className={s.empty}>(empty)</span></div>;

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Badge appearance="tint" color="brand">{FORMAT_LABEL[fmt]}</Badge>
        {canPretty && (
          <Tooltip content={raw ? 'Show formatted' : 'Show raw'} relationship="label">
            <Button size="small" appearance="subtle"
              icon={raw ? <Code20Regular /> : <TextAlignLeft20Regular />}
              onClick={() => setRaw((v) => !v)}>
              {raw ? 'Pretty' : 'Raw'}
            </Button>
          </Tooltip>
        )}
        <div className={s.spacer} />
        <Button size="small" appearance="subtle" icon={<Copy20Regular />}
          onClick={() => copy((!raw && pretty) ? pretty : body)}>
          Copy
        </Button>
      </div>

      {!raw && table ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>{table.header.map((h, i) => <th key={i} className={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, ri) => (
                <tr key={ri}>{table.header.map((_, ci) => <td key={ci} className={s.td}>{r[ci] ?? ''}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !raw && fmt === 'json' && pretty ? (
        <pre className={s.code} role="region" aria-label={ariaLabel}>{highlightJson(pretty, s)}</pre>
      ) : !raw && pretty ? (
        <pre className={s.code} role="region" aria-label={ariaLabel}>{pretty}</pre>
      ) : (
        <pre className={mergeClasses(s.code, s.wrap)} role="region" aria-label={ariaLabel}>{body}</pre>
      )}
    </div>
  );
}
