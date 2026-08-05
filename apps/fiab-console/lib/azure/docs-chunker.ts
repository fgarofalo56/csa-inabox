/**
 * docs-chunker — how a markdown source file becomes RAG chunks.
 *
 * Extracted from `loom-docs-index.ts` (#2929) so that it is (a) unit-testable
 * without dragging in the Azure SDK / Cosmos / Next runtime that module needs,
 * and (b) importable by the offline retrieval harness
 * (`scripts/csa-loom/measure-retrieval.mjs`), which until now carried a hand-
 * maintained PORT of this function. A port that drifts from its subject makes
 * the harness agree with itself while both disagree with production, so the
 * harness now imports THIS module and the port is gone.
 *
 * ── Why this file exists at all (measured, #2929) ────────────────────────────
 *
 * The previous chunker had two defects that cost retrieval hits outright. Both
 * were measured on the two gold documents whose surfaces missed their floors,
 * `docs/fiab/parity/lakehouse.md` and `docs/fiab/parity/kql-database.md`:
 *
 * D1 — OVERSIZED SECTIONS WERE SLICED AT A BLIND CHARACTER OFFSET.
 *      `content.slice(i, i + MAX_CHUNK)` every 1500 characters, with no regard
 *      for lines, words, or markdown table rows. Splits therefore landed
 *      mid-word, and the bisected term stopped existing for BOTH retrieval
 *      backends (AI Search's `standard.lucene` analyzer and the BM25 ranker
 *      tokenize on word boundaries alike). Real casualties in those two files:
 *
 *        "retention"              -> "etention"       (kql-database chunk 4)
 *        "lakehouse"              -> "house"          (lakehouse chunk 2)
 *        "LOOM_SYNAPSE_WORKSPACE" -> "ACE"            (lakehouse chunk 4)
 *        "shortcut-engines.ts"    -> "ngines.ts"      (lakehouse chunk 8)
 *
 *      `kql-database` eval row 8 asks "How do I see database policies like
 *      retention and caching?" — the chunk that holds that exact material is
 *      the one whose "retention" the splitter had eaten.
 *
 * D2 — CONTINUATION CHUNKS LOST THEIR DOCUMENT IDENTITY.
 *      The ranker indexes `heading + content` only (`path` is not part of the
 *      BM25 body). Every sub-chunk inherited the bare section heading — and in
 *      `docs/fiab/parity/**` those headings are `Loom coverage`, `Backend per
 *      control`, `Verification`: shared verbatim by ~hundreds of sibling files.
 *      Combined with D1 eating the topic word out of the prose, 4 of the 24
 *      chunks of the two gold documents contained NO occurrence of their own
 *      document's key term, making them unreachable for any on-topic query.
 *      `docs/fiab/copilot-quality-triage.md` §2.5 had already measured the
 *      crowding ("28 files with lakehouse in the filename"); this is the
 *      mechanism by which the crowd wins.
 *
 * The fixes are, respectively: pack whole LINES up to the budget (and split a
 * single over-long line on a WORD boundary), and label every chunk with a
 * `title › section` breadcrumb so document identity survives into each one.
 */

/**
 * Maximum characters of `content` in one chunk.
 *
 * Also caps the repo-source summaries in `loom-docs-index.ts` so the
 * chunk-size invariant holds across every corpus kind.
 */
export const MAX_CHUNK = 1500;

/** Separator between the document title and the section heading. */
export const BREADCRUMB_SEP = ' › ';

/** One chunk of a markdown source file. */
export interface MarkdownChunk {
  /**
   * Display + retrieval label. `"<document title> › <section heading>"` when
   * the two differ, otherwise whichever exists. Indexed by the BM25 ranker
   * (which tokenizes `heading + content`) and a searchable field on the AI
   * Search index, so this is what carries document identity into a chunk whose
   * prose does not happen to repeat the topic word.
   */
  heading?: string;
  /** Chunk body. Never longer than `MAX_CHUNK`. */
  content: string;
}

/**
 * Split one over-long LINE on word boundaries.
 *
 * Only reached for a line that on its own exceeds `max` — in practice a wide
 * markdown table row or a long prose paragraph written as a single line. A
 * single token longer than `max` (a giant URL, a base64 blob) still has to be
 * hard-sliced; nothing can preserve it, but it is the rare case rather than
 * the default one.
 */
function splitLongLine(line: string, max: number): string[] {
  const out: string[] = [];
  // Keep the separators so re-joined text preserves its original spacing.
  const parts = line.split(/(\s+)/);
  let buf = '';
  for (const part of parts) {
    if (buf.length + part.length > max) {
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = '';
      if (part.length > max) {
        for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
        continue;
      }
    }
    buf += part;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

/**
 * Split an over-budget section into chunks along LINE boundaries.
 *
 * Greedily packs whole lines until the next one would not fit. This keeps
 * markdown table rows, list items and code lines intact, so no query term is
 * ever bisected by the act of chunking (D1).
 */
function splitOnLines(content: string, max: number): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    const s = buf.join('\n').trim();
    if (s.length > 0) out.push(s);
    buf = [];
    len = 0;
  };
  for (const line of content.split('\n')) {
    if (line.length > max) {
      flush();
      for (const piece of splitLongLine(line, max)) out.push(piece);
      continue;
    }
    // +1 for the '\n' that will re-join this line to the ones before it.
    if (len + (buf.length === 0 ? line.length : line.length + 1) > max) flush();
    len += buf.length === 0 ? line.length : line.length + 1;
    buf.push(line);
  }
  flush();
  return out;
}

/** `"<title> › <section>"`, collapsing the case where they are the same. */
export function breadcrumbHeading(title?: string, heading?: string): string | undefined {
  if (title && heading && title !== heading) return `${title}${BREADCRUMB_SEP}${heading}`;
  return heading ?? title ?? undefined;
}

/**
 * The document's title: its first H1, or — for a document that never uses one
 * — its first heading of any level.
 *
 * Resolved in a PRE-PASS over the whole document rather than while walking it,
 * so every chunk of one file carries the same title even when an H1 appears
 * after an H2. Walking-order resolution would label the chunks before that H1
 * differently from the ones after it.
 */
export function documentTitle(lines: readonly string[]): string | undefined {
  let firstHeading: string | undefined;
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (text.length === 0) continue;
    if (m[1].length === 1) return text;
    if (firstHeading === undefined) firstHeading = text;
  }
  return firstHeading;
}

/**
 * Chunk a markdown document for the retrieval corpus.
 *
 * Sections break on H1-H3. A section over `MAX_CHUNK` is split along line
 * boundaries. Every chunk is labelled with a `title › section` breadcrumb,
 * where the title is the document's first H1 (or, for a document that never
 * uses one, its first heading of any level).
 */
export function chunkMarkdown(text: string, max: number = MAX_CHUNK): MarkdownChunk[] {
  const lines = text.split(/\r?\n/);
  const title = documentTitle(lines);
  const blocks: MarkdownChunk[] = [];
  let curHeading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    const content = buf.join('\n').trim();
    if (content.length > 0) blocks.push({ heading: curHeading, content });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      flush();
      curHeading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  const out: MarkdownChunk[] = [];
  for (const b of blocks) {
    const heading = breadcrumbHeading(title, b.heading);
    if (b.content.length <= max) { out.push({ heading, content: b.content }); continue; }
    for (const piece of splitOnLines(b.content, max)) out.push({ heading, content: piece });
  }
  return out;
}
