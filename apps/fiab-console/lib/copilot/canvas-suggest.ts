/**
 * canvas-suggest — the PURE logic behind POST /api/canvas/suggest-next (W7).
 *
 * Isolated from the route so it is unit-testable with no Next/Azure imports:
 *   • sanitizeSuggestInput — validate + bound the client-supplied graph
 *   • buildSuggestPrompt   — the grounded system+user prompt
 *   • clampSuggestions     — constrain model output to the palette allowlist
 *   • isCanvasSuggestEnabled — the default-ON / opt-out admin kill-switch
 *
 * Security: suggestion keys are matched against the palette allowlist with a
 * Set (never an object-as-map), so no attacker-controlled key can reach the
 * editor or pollute a prototype. Labels/reasons are coerced to strings and
 * length-capped before they enter a prompt or the response.
 */

/** A node the caller can legally add — its key is one of the surface's palette keys. */
export interface CanvasSuggestion {
  /** Palette key to insert on Accept (∈ the caller's paletteKeys). */
  key: string;
  /** Short human label, e.g. 'Copy data'. */
  label: string;
  /** One-line rationale grounded in the current graph. */
  reason: string;
}

/** A single canvas node in the grounding payload. */
export interface SuggestNode {
  id: string;
  type?: string;
  label?: string;
}

/** A single directed edge in the grounding payload. */
export interface SuggestEdge {
  source: string;
  target: string;
}

/** Validated, bounded suggestion input. */
export interface SuggestInput {
  itemType: string;
  nodes: SuggestNode[];
  edges: SuggestEdge[];
  paletteKeys: string[];
}

// Bounds — keep the prompt small + the request cheap regardless of graph size.
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_PALETTE = 100;
const MAX_STR = 120;
const MAX_ITEM_TYPE = 64;

/** Coerce to a trimmed, length-capped string (empty when not a usable string). */
function str(v: unknown, cap = MAX_STR): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, cap);
}

/**
 * The default-ON / opt-out kill-switch. Suggestions are ENABLED unless an admin
 * sets LOOM_CANVAS_AI_SUGGEST to an explicit falsy value on the Container App
 * (0 / false / off / no — case-insensitive). Any other value (incl. unset)
 * leaves the feature on.
 */
export function isCanvasSuggestEnabled(): boolean {
  const v = (process.env.LOOM_CANVAS_AI_SUGGEST || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Validate + bound the client-supplied graph. Returns null when the required
 * fields (itemType, a non-empty palette allowlist) are missing.
 */
export function sanitizeSuggestInput(raw: {
  itemType?: unknown;
  nodes?: unknown;
  edges?: unknown;
  paletteKeys?: unknown;
}): SuggestInput | null {
  const itemType = str(raw.itemType, MAX_ITEM_TYPE);
  if (!itemType) return null;

  const paletteKeys = Array.isArray(raw.paletteKeys)
    ? Array.from(new Set(raw.paletteKeys.map((k) => str(k)).filter(Boolean))).slice(0, MAX_PALETTE)
    : [];
  if (paletteKeys.length === 0) return null;

  const nodes: SuggestNode[] = Array.isArray(raw.nodes)
    ? raw.nodes
        .map((n) => {
          const o = (n ?? {}) as Record<string, unknown>;
          const id = str(o.id);
          if (!id) return null;
          const node: SuggestNode = { id };
          const t = str(o.type);
          if (t) node.type = t;
          const label = str(o.label);
          if (label) node.label = label;
          return node;
        })
        .filter((n): n is SuggestNode => n !== null)
        .slice(0, MAX_NODES)
    : [];

  const validIds = new Set(nodes.map((n) => n.id));
  const edges: SuggestEdge[] = Array.isArray(raw.edges)
    ? raw.edges
        .map((e) => {
          const o = (e ?? {}) as Record<string, unknown>;
          const source = str(o.source);
          const target = str(o.target);
          if (!source || !target || !validIds.has(source) || !validIds.has(target)) return null;
          return { source, target };
        })
        .filter((e): e is SuggestEdge => e !== null)
        .slice(0, MAX_EDGES)
    : [];

  return { itemType, nodes, edges, paletteKeys };
}

/**
 * Build the grounded system + user prompt. The model must pick from the palette
 * allowlist and return STRICT JSON — no free-form node kinds.
 */
export function buildSuggestPrompt(input: SuggestInput): { system: string; user: string } {
  const system =
    'You are the CSA Loom canvas copilot. You look at the CURRENT node graph a user is building ' +
    `on a visual "${input.itemType}" designer and suggest the single best NEXT node to add. ` +
    'You MUST choose the node kind from the provided PALETTE allowlist — never invent a kind. ' +
    'Ground your suggestion in the actual nodes and their connections: pick the node that most ' +
    'naturally continues the flow (e.g. a transform after a source, a sink after a transform). ' +
    'Return STRICT JSON {"suggestions":[{"key":string,"label":string,"reason":string}]} with 1-3 ' +
    'suggestions, best first. "key" MUST be one of the palette keys verbatim. "label" is a short ' +
    'human title (≤40 chars). "reason" is ONE concise sentence (≤140 chars) grounded in the graph. ' +
    'Return {"suggestions":[]} only if truly nothing sensible can follow.';

  const nodeLines = input.nodes
    .map((n) => `  - ${n.id}${n.type ? ` [${n.type}]` : ''}${n.label ? `: ${n.label}` : ''}`)
    .join('\n');
  const edgeLines = input.edges.length
    ? input.edges.map((e) => `  - ${e.source} -> ${e.target}`).join('\n')
    : '  (none)';

  const user =
    `Palette (allowed node keys): ${input.paletteKeys.join(', ')}\n\n` +
    `Current nodes:\n${nodeLines || '  (none)'}\n\n` +
    `Current edges:\n${edgeLines}\n\n` +
    'Suggest the best next node to add.';

  return { system, user };
}

/**
 * Constrain the model's suggestions to the palette allowlist, de-dupe by key,
 * coerce/cap strings, drop empties, and keep at most the top 3. Uses a Set for
 * the allowlist check so no attacker-controlled key can reach the caller.
 */
export function clampSuggestions(raw: unknown, paletteKeys: string[]): CanvasSuggestion[] {
  const allow = new Set(paletteKeys);
  const seen = new Set<string>();
  const out: CanvasSuggestion[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const key = str(o.key);
    if (!key || !allow.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: str(o.label, 40) || key,
      reason: str(o.reason, 140),
    });
    if (out.length >= 3) break;
  }
  return out;
}
