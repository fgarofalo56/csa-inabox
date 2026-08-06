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
 * `"<title> › <H2> › <H3>"` — the FULL heading ancestry of a chunk.
 *
 * ── Why the innermost heading alone was not enough (#2979 follow-up) ─────────
 *
 * `breadcrumbHeading` labels a chunk with its document title and its innermost
 * heading. In a `docs/fiab/parity/*.md` — which by `.claude/rules/ui-parity.md`
 * describes TWO products — the innermost heading is frequently an H3 whose
 * product allegiance is stated only by its H2 ancestor. `data-agent.md` is the
 * measured case:
 *
 *     # data-agent — parity with Microsoft Fabric Data Agent
 *     ## Real feature inventory (every capability, grounded in Learn)   <- FABRIC
 *     ### A. Data sources (left "explorer" rail)                        <- chunk
 *     ...
 *     ## Loom coverage (built ✅ / honest-gate ⚠️ / MISSING ❌)          <- LOOM
 *
 * A chunk of `### A. Data sources` was labelled `data-agent — parity … › A. Data
 * sources`, which says NOTHING about which product it describes. Both the answer
 * prompt (`docs-grounding.renderDocExcerpts`) and the judge
 * (`evaluator-core.renderJudgeExcerpt`) render that label and were therefore
 * asked to distinguish two products while holding evidence stripped of the only
 * thing that distinguishes them. `evaluator-core.classifyExcerptProvenance`
 * classified such chunks `'unlabelled'` and told the judge to treat them as
 * possibly-either — for a surface whose ENTIRE gold document is that one parity
 * file.
 *
 * Measured consequence (run 31064239486): `data-agent` retrieved its gold
 * document on 90% of questions and still scored `productFidelityAvg` **1.889**
 * of 5 — a pass rate of 0.10 against a 0.40 floor, while `groundingAvg` was a
 * healthy 4.33. The answers WERE grounded; they were grounded in Fabric's
 * inventory and reported as CSA Loom's capabilities, which is exactly the
 * inversion `productFidelity` exists to catch.
 *
 * Carrying the ancestry costs nothing at retrieval time (the ancestor text is
 * already indexed on the H2's own chunks) and gives every downstream consumer —
 * answer prompt, judge, and the deterministic provenance classifier — the label
 * the document actually carries.
 */
export function ancestryHeading(
  title: string | undefined,
  ancestors: readonly string[],
): string | undefined {
  const parts: string[] = [];
  for (const a of [title, ...ancestors]) {
    const t = (a || '').trim();
    if (!t) continue;
    // Skip a repeat of the previous segment (an H1 identical to the title, or a
    // heading repeated at two levels) so the breadcrumb never says the same
    // thing twice.
    if (parts.length > 0 && parts[parts.length - 1] === t) continue;
    parts.push(t);
  }
  if (parts.length === 0) return undefined;
  return parts.join(BREADCRUMB_SEP);
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
 * boundaries. Every chunk is labelled with its FULL heading ancestry —
 * `title › H2 › H3` — where the title is the document's first H1 (or, for a
 * document that never uses one, its first heading of any level). See
 * {@link ancestryHeading} for why the innermost heading alone was not enough.
 */
export function chunkMarkdown(text: string, max: number = MAX_CHUNK): MarkdownChunk[] {
  const lines = text.split(/\r?\n/);
  const title = documentTitle(lines);
  const blocks: MarkdownChunk[] = [];
  /** Open heading ancestors by level: [H1, H2, H3]. */
  const stack: (string | undefined)[] = [undefined, undefined, undefined];
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
      const level = m[1].length; // 1..3
      const text_ = m[2].trim();
      stack[level - 1] = text_;
      // Opening a heading closes every deeper one — an H2 after an H3 must not
      // keep that H3 as an ancestor.
      for (let d = level; d < stack.length; d++) stack[d] = undefined;
      curHeading = ancestryHeading(title, stack.filter((s): s is string => !!s));
    } else {
      buf.push(line);
    }
  }
  flush();

  const out: MarkdownChunk[] = [];
  for (const b of blocks) {
    // Content before the first heading has no ancestry — label it with the title.
    const heading = b.heading ?? (title || undefined);
    if (b.content.length <= max) { out.push({ heading, content: b.content }); continue; }
    for (const piece of splitOnLines(b.content, max)) out.push({ heading, content: piece });
  }
  return out;
}
