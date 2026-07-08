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

/** Mirror of the UI `Citation` (lib/components/help-copilot/citations). */
export interface ToolCitation {
  id: string;
  path: string;
  kind: string;
  heading?: string;
  url?: string;
  preview: string;
}

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
 * Map one `searchDocs`/`loom-docs-index` hit ({ id, kind, path, heading, url,
 * content, score }) into a Citation.
 */
function fromDocHit(h: Record<string, unknown>): ToolCitation | null {
  const path = str(h.path);
  const id = str(h.id) || path;
  if (!id && !path) return null;
  return {
    id: id || path,
    path: path || id,
    kind: str(h.kind) || 'docs',
    heading: h.heading ? str(h.heading) : undefined,
    url: h.url ? str(h.url) : undefined,
    preview: clip(h.content ?? h.preview),
  };
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
  return {
    id,
    path: source || docKey || id,
    kind: 'knowledge',
    url: /^https?:\/\//i.test(source) ? source : undefined,
    preview: clip(c.content ?? c.text ?? ''),
  };
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
