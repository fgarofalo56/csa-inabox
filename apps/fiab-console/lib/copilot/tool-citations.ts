/**
 * Tool-provenance → grounding citation mapper (CTS-04).
 *
 * The cross-item build orchestrator grounds answers by calling real tools
 * (Loom's docs RAG index, agentic knowledge-base retrieval, schema/table reads)
 * but never surfaced WHAT grounded an answer — only the separate Help Copilot
 * cited sources. This pure module inspects a tool result for a recognizable
 * provenance shape and maps it into the `Citation[]` shape the transcript
 * already renders (CitationChips), so the agent's answer shows its sources as
 * clickable chips.
 *
 * Pure + defensive: any unrecognized / malformed result yields `[]` (never
 * throws), so a tool that returns no provenance simply contributes no citation.
 */

/**
 * The path prefix that marks SUPERSEDED design history (#3918).
 *
 * The canonical definition is `SUPERSEDED_PATH_PREFIX` / `isSupersededPath` in
 * `lib/azure/loom-docs-corpus.ts`. It is deliberately NOT imported here: this
 * module is on the answer-receipt path, which is reachable from client
 * components, and `loom-docs-corpus` imports `node:fs` / `node:crypto` at module
 * scope. Pulling it in would drag the filesystem into a browser bundle to gain
 * one 14-character string. `path` is a retrievable field on both retrieval
 * backends, so the prefix is the whole contract.
 */
const SUPERSEDED_PATH_PREFIX = 'PRPs/archive/';

function isSupersededPath(p: string): boolean {
  return typeof p === 'string' && p.startsWith(SUPERSEDED_PATH_PREFIX);
}

/** Mirror of the UI `Citation` (lib/components/help-copilot/citations). */
export interface ToolCitation {
  id: string;
  path: string;
  kind: string;
  heading?: string;
  url?: string;
  preview: string;
  /**
   * #3918 — the chunk is SUPERSEDED design history (`PRPs/archive/**`).
   *
   * Structured, so a consumer can style or filter it; the human-visible marker
   * is ALSO folded into `heading` below, because `CitationChips` renders
   * `heading` (chip label + tooltip) and adding a field the renderer does not
   * know about would be a seam wired to nothing — the exact state #3918 was
   * filed about.
   */
  superseded?: boolean;
}

/**
 * The visible marker, kept SHORT on purpose.
 *
 * #3918's predecessor put a 99-char notice into the indexed `content`, which
 * (a) poisoned BM25 and (b) ate 49.5% of every archived citation's 200-char
 * preview. This never enters `content` — it is applied here, at citation
 * assembly, keyed off `path` — and it does not touch the preview budget at all.
 * The chip is `maxWidth: 280px` with an ellipsis, so a long prefix would push
 * the real heading off the chip.
 */
const ARCHIVED_TAG = '[ARCHIVED]';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function clip(v: unknown, n = 200): string {
  return str(v).slice(0, n);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fold the superseded marker into a citation, keyed off its `path`.
 *
 * Exported so the orchestrator's own `Citation` mapper uses the SAME rule and
 * the same wording rather than a second copy that can drift.
 */
export function markSupersededCitation<T extends { path: string; heading?: string; superseded?: boolean }>(c: T): T {
  if (!c.path || !isSupersededPath(c.path)) return c;
  const heading = c.heading && c.heading.trim()
    ? `${ARCHIVED_TAG} ${c.heading}`
    : `${ARCHIVED_TAG} superseded design history`;
  return { ...c, heading, superseded: true };
}

/**
 * Map one `searchDocs`/`loom-docs-index` hit ({ id, kind, path, heading, url,
 * content, score }) into a Citation.
 */
function fromDocHit(h: Record<string, unknown>): ToolCitation | null {
  const path = str(h.path);
  const id = str(h.id) || path;
  if (!id && !path) return null;
  return markSupersededCitation({
    id: id || path,
    path: path || id,
    kind: str(h.kind) || 'docs',
    heading: h.heading ? str(h.heading) : undefined,
    url: h.url ? str(h.url) : undefined,
    preview: clip(h.content ?? h.preview),
  });
}

/**
 * Map one agentic knowledge-base citation ({ id, docKey, source }) into a
 * Citation — the shape `knowledge_base_retrieve` returns.
 */
function fromKnowledgeCitation(c: Record<string, unknown>): ToolCitation | null {
  const docKey = str(c.docKey);
  const source = str(c.source);
  const id = str(c.id) || docKey || source;
  if (!id) return null;
  return markSupersededCitation({
    id,
    path: source || docKey || id,
    kind: 'knowledge',
    url: /^https?:\/\//i.test(source) ? source : undefined,
    preview: clip(c.content ?? c.text ?? ''),
  });
}

/**
 * Extract grounding citations from a single tool result. Recognizes the known
 * Loom provenance shapes; returns [] for anything else.
 */
export function extractCitationsFromToolResult(_toolName: string, result: unknown): ToolCitation[] {
  if (!isRecord(result)) return [];
  const out: ToolCitation[] = [];

  // searchDocs → { hits: DocHit[] }
  if (Array.isArray(result.hits)) {
    for (const h of result.hits) if (isRecord(h)) { const c = fromDocHit(h); if (c) out.push(c); }
  }
  // agentic retrieval → { citations: [{ id, docKey, source }] }
  if (Array.isArray(result.citations)) {
    for (const c of result.citations) if (isRecord(c)) { const m = fromKnowledgeCitation(c); if (m) out.push(m); }
  }
  // generic doc-shaped result arrays some tools return.
  for (const key of ['results', 'sources', 'documents'] as const) {
    const arr = result[key];
    if (Array.isArray(arr)) {
      for (const h of arr) if (isRecord(h) && (h.path || h.url || h.source)) { const c = fromDocHit(h); if (c) out.push(c); }
    }
  }
  return out;
}

/**
 * Fold new citations into an accumulator, de-duplicating by id (first-writer
 * wins). Used across a turn's tool calls before attaching to the final step.
 */
export function mergeCitations(acc: ToolCitation[], next: ToolCitation[]): ToolCitation[] {
  const seen = new Set(acc.map((c) => c.id));
  const merged = [...acc];
  for (const c of next) if (!seen.has(c.id)) { seen.add(c.id); merged.push(c); }
  return merged;
}
