'use client';

/**
 * DaxSnippet — a zero-dependency, read-only DAX / SQL snippet renderer with
 * lightweight syntax hints (ux-fabric-a W1). Fabric's semantic-model measure
 * list renders DAX with colorized functions / refs / strings; mirror that for
 * Loom's measure lists WITHOUT mounting a Monaco instance per row (the
 * authoring surfaces keep the real Monaco DAX editor — this is display-only).
 *
 * Pure client tokenizer (regex alternation, single pass): comments, strings,
 * 'Table'[Column] / [Measure] refs, numbers, function calls (ident followed by
 * an open paren), and a small keyword set. Everything else stays neutral.
 * Colors are the theme-aware --loom-accent-* pairs (light+dark in globals.css)
 * + Fluent neutrals — token-only per web3-ui.md.
 */

import type { ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    margin: 0,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
    minWidth: 0,
  },
  fn: { color: 'var(--loom-accent-blue)' },
  kw: { color: 'var(--loom-accent-violet)', fontWeight: tokens.fontWeightSemibold },
  str: { color: 'var(--loom-accent-orange)' },
  num: { color: 'var(--loom-accent-teal)' },
  ref: { color: 'var(--loom-accent-amber)' },
  cmt: { color: tokens.colorNeutralForeground4, fontStyle: 'italic' },
});

/** DAX statement keywords + a few shared SQL ones (hints, not a grammar). */
const KEYWORDS = new Set([
  'VAR', 'RETURN', 'EVALUATE', 'DEFINE', 'MEASURE', 'COLUMN', 'TABLE',
  'ORDER', 'BY', 'ASC', 'DESC', 'TRUE', 'FALSE', 'IN', 'NOT', 'AND', 'OR',
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'JOIN', 'ON', 'AS', 'WITH',
]);

// One alternation, ordered: comment | string | bracket-ref | quoted-table ref
// | number | identifier (function-call vs keyword vs plain decided after).
const TOKEN_RE =
  /(\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"]|"")*")|(\[[^\]\n]*\])|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_.]*)/g;

export function DaxSnippet({ expression, ariaLabel }: { expression: string; ariaLabel?: string }) {
  const s = useStyles();
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const src = expression ?? '';
  for (const m of src.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(src.slice(last, idx));
    const [full, cmt, str, bref, qref, num, ident] = m;
    if (cmt) out.push(<span key={k++} className={s.cmt}>{cmt}</span>);
    else if (str) out.push(<span key={k++} className={s.str}>{str}</span>);
    else if (bref || qref) out.push(<span key={k++} className={s.ref}>{bref || qref}</span>);
    else if (num) out.push(<span key={k++} className={s.num}>{num}</span>);
    else if (ident) {
      // Function call when the next non-space char is "(" — else keyword/plain.
      const rest = src.slice(idx + full.length);
      if (/^\s*\(/.test(rest)) out.push(<span key={k++} className={s.fn}>{ident}</span>);
      else if (KEYWORDS.has(ident.toUpperCase())) out.push(<span key={k++} className={s.kw}>{ident}</span>);
      else out.push(full);
    } else out.push(full);
    last = idx + full.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return <pre className={s.root} aria-label={ariaLabel}>{out}</pre>;
}

export default DaxSnippet;
