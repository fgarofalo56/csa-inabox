/**
 * Shared Markdown → HTML renderer for ALL Loom notebook surfaces (regular
 * notebook MarkdownCell, Databricks notebook cells, Synapse notebook editor).
 *
 * The previous per-surface renderers only handled headings / bold / italic /
 * inline-code / links / bullet lists — so GFM **tables**, fenced code blocks,
 * ordered lists, blockquotes, and horizontal rules silently fell through as raw
 * text ("parts of it render, but not all"). This one renderer fixes that in one
 * place so every notebook type renders Markdown the same, correct way.
 *
 * Security: the source is HTML-escaped FIRST (& < > "), so no author markup can
 * inject elements; only the formatting we synthesize below is HTML. (Consumers
 * still set it via dangerouslySetInnerHTML; escaping-first keeps that safe for
 * user-authored notebook content.) No external dependency — a focused,
 * dependency-free GFM subset rather than pulling in react-markdown/remark.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline spans: bold, italic, strikethrough, inline code, images, links. */
function inline(s: string): string {
  let out = s;
  // inline code first so * / _ inside code aren't treated as emphasis
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
  // images ![alt](url)  — before links
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt, url) => `<img src="${url}" alt="${alt}" style="max-width:100%" />`);
  // links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, t, url) => `<a href="${url}" target="_blank" rel="noreferrer">${t}</a>`);
  // bold (** or __), then italic (* or _), then strikethrough (~~)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return out;
}

/** A GFM table block: a header row, a |---|:--:|---| separator, then body rows. */
function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
    || /^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+$/.test(line);
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  // split on unescaped pipes; trim each cell (GFM ignores surrounding spaces)
  return l.split(/\s*(?<!\\)\|\s*/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function alignOf(spec: string): string {
  const t = spec.trim();
  const l = t.startsWith(':'), r = t.endsWith(':');
  if (l && r) return ' style="text-align:center"';
  if (r) return ' style="text-align:right"';
  if (l) return ' style="text-align:left"';
  return '';
}

/** Render escaped Markdown source (already HTML-escaped) to an HTML string. */
function renderEscaped(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;

  const closeListIfOpen = (stack: string[]) => { while (stack.length) out.push(`</${stack.pop()}>`); };
  const listStack: string[] = []; // 'ul' | 'ol'

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block ```lang ... ```
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      closeListIfOpen(listStack);
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(`<pre class="md-code"><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    // GFM table: current line has pipes AND the next line is a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeListIfOpen(listStack);
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      const thead = '<thead><tr>' + header.map((h, c) => `<th${aligns[c] || ''}>${inline(h)}</th>`).join('') + '</tr></thead>';
      const tbody = '<tbody>' + bodyRows.map((r) =>
        '<tr>' + header.map((_h, c) => `<td${aligns[c] || ''}>${inline(r[c] ?? '')}</td>`).join('') + '</tr>'
      ).join('') + '</tbody>';
      out.push(`<table class="md-table">${thead}${tbody}</table>`);
      continue;
    }

    // horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeListIfOpen(listStack);
      out.push('<hr/>');
      i++;
      continue;
    }

    // heading # .. ######
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      closeListIfOpen(listStack);
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // blockquote (consume consecutive > lines). NOTE: the source is already
    // HTML-escaped, so a leading '>' is now '&gt;' — match that, not a literal >.
    if (/^\s*&gt;\s?/.test(line)) {
      closeListIfOpen(listStack);
      const quote: string[] = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++; }
      out.push(`<blockquote>${inline(quote.join('<br/>'))}</blockquote>`);
      continue;
    }

    // ordered list item
    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ol) {
      if (listStack[listStack.length - 1] !== 'ol') { closeListIfOpen(listStack); out.push('<ol>'); listStack.push('ol'); }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }
    // unordered list item
    const ul = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (ul) {
      if (listStack[listStack.length - 1] !== 'ul') { closeListIfOpen(listStack); out.push('<ul>'); listStack.push('ul'); }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }

    // blank line — close any open list + paragraph break
    if (line.trim() === '') {
      closeListIfOpen(listStack);
      i++;
      continue;
    }

    // paragraph: gather consecutive non-structural lines (soft breaks → <br/>)
    closeListIfOpen(listStack);
    const para: string[] = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*&gt;\s?/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) { para.push(lines[i]); i++; }
    out.push(`<p>${inline(para.join('<br/>'))}</p>`);
  }
  closeListIfOpen(listStack);
  return out.join('\n');
}

/**
 * Render Markdown source to a safe HTML string (GFM subset: headings, bold,
 * italic, strikethrough, inline + fenced code, links, images, ordered +
 * unordered lists, blockquotes, horizontal rules, and TABLES).
 */
export function renderMarkdown(src: string): string {
  return renderEscaped(escapeHtml(src ?? ''));
}
