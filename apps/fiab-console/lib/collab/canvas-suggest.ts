/**
 * canvas-suggest — the PURE prompt-builder + response-normalizer for W7, the
 * ambient inline Copilot ghost-node suggestion engine. The ghost-node CHROME
 * already exists in canvas-node-kit (the `aiSuggestion` variant of
 * GhostNextStepCard); this module is the brain the half-built ghost was missing.
 *
 * The BFF route (app/api/items/[type]/[id]/canvas-suggest/route.ts) serializes
 * the CURRENT canvas graph into a {@link CanvasTopology}, calls the unified
 * aoai-chat-client (aoaiChatJson) with the messages this module builds, then
 * normalizes the reply into a {@link CanvasSuggestion} the host materializes on
 * Accept. Kept PURE (no AOAI/DOM import) so the prompt + parsing are unit-tested
 * without a live model.
 */

/** One node in the serialized canvas graph handed to the model. */
export interface CanvasTopologyNode {
  id: string;
  /** The node's wire type (e.g. 'Copy', 'source:eventhub', 'agent') — host-defined. */
  type: string;
  /** Human label shown on the node. */
  label?: string;
  /** Optional 5-category hint (move/transform/control/external/iteration). */
  category?: string;
  /** Optional role hint some canvases use (source/transform/sink/…). */
  role?: string;
}

/** A directed link between two nodes. */
export interface CanvasTopologyEdge {
  source: string;
  target: string;
}

/**
 * One choice the host is willing to insert. The model MUST pick a `type` from
 * this catalog — grounding the suggestion in what the canvas can actually
 * materialize (no hallucinated node types). `title` + `description` teach the
 * model what each does.
 */
export interface CanvasCatalogEntry {
  type: string;
  title: string;
  description?: string;
  category?: string;
}

/** The serialized canvas the host POSTs for a suggestion. */
export interface CanvasTopology {
  /** Owning item slug (e.g. 'eventstream', 'data-pipeline', 'agent-flow'). */
  itemType: string;
  /** What the canvas builds, in plain words (e.g. 'a real-time eventstream'). */
  canvasKind: string;
  nodes: CanvasTopologyNode[];
  edges: CanvasTopologyEdge[];
  /** The types the host can insert. The model picks exactly one. */
  catalog: CanvasCatalogEntry[];
  /** Optional free-text goal the user set (from the item description). */
  goal?: string;
}

/** The structured suggestion the route returns + the ghost node renders. */
export interface CanvasSuggestion {
  /** The chosen catalog `type` to insert (always one of topology.catalog). */
  nodeType: string;
  /** Short imperative label, e.g. 'Add a Filter transform'. */
  label: string;
  /** One-sentence why, grounded in the current graph. */
  reason: string;
  /** Optional shallow config hints the host may pre-fill (name, expression, …). */
  config?: Record<string, unknown>;
}

/** Max nodes/edges serialized into the prompt (keeps the budget bounded). */
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_CATALOG = 40;

/** Render the graph as a compact, model-legible outline. */
function renderTopology(t: CanvasTopology): string {
  const nodes = t.nodes.slice(0, MAX_NODES);
  const edges = t.edges.slice(0, MAX_EDGES);
  const nodeLines = nodes.length
    ? nodes
        .map((n) => `  - ${n.id} :: type=${n.type}${n.label ? ` "${n.label}"` : ''}${n.role ? ` role=${n.role}` : ''}${n.category ? ` (${n.category})` : ''}`)
        .join('\n')
    : '  (canvas is empty)';
  const edgeLines = edges.length
    ? edges.map((e) => `  - ${e.source} -> ${e.target}`).join('\n')
    : '  (no connections yet)';
  return `Nodes:\n${nodeLines}\n\nConnections:\n${edgeLines}`;
}

/** Render the insertable catalog the model must choose from. */
function renderCatalog(t: CanvasTopology): string {
  return t.catalog
    .slice(0, MAX_CATALOG)
    .map((c) => `  - type="${c.type}" — ${c.title}${c.description ? `: ${c.description}` : ''}${c.category ? ` (${c.category})` : ''}`)
    .join('\n');
}

/**
 * Build the persona + grounded user message for a next-step suggestion. The
 * system prompt pins the JSON contract + the "pick from the catalog only" rule;
 * the user message carries the serialized graph + the catalog + any goal.
 */
export function buildSuggestMessages(t: CanvasTopology): { role: 'system' | 'user'; content: string }[] {
  const system =
    `You are the CSA Loom canvas Copilot. Given the CURRENT state of ${t.canvasKind} ` +
    `(a "${t.itemType}" canvas), suggest the single most useful NEXT node to add so the ` +
    `author keeps building toward a complete, working flow. Reason ONLY from the graph and ` +
    `the goal provided — never invent nodes, names or connections that are not present.\n\n` +
    `You MUST pick the "nodeType" from the provided catalog (exact "type" string) — do NOT ` +
    `invent a type outside it. Prefer the step that most naturally continues the trailing ` +
    `node(s): e.g. after a source with no destination, suggest a destination; after a raw ` +
    `copy, suggest a transform/validation; after a model, suggest the next tool/step.\n\n` +
    `Return a STRICT JSON object with these fields:\n` +
    `  "nodeType": string  — the chosen catalog "type" (MUST be one of the catalog entries).\n` +
    `  "label": string     — a 3-6 word imperative, e.g. "Add a Filter transform".\n` +
    `  "reason": string    — ONE sentence on why this is the right next step for THIS graph.\n` +
    `  "config": object    — OPTIONAL shallow hints to pre-fill (e.g. {"name":"...","expression":"..."}); {} if none.\n` +
    `No markdown, no prose outside the JSON object.`;
  const goal = t.goal?.trim() ? `\n\nAuthor's goal: ${t.goal.trim()}` : '';
  const user =
    `${renderTopology(t)}\n\nInsertable next-step catalog (pick exactly one "type"):\n${renderCatalog(t)}${goal}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Normalize the model reply into a {@link CanvasSuggestion}, or null when it is
 * unusable (empty label, or a nodeType not in the catalog — we NEVER surface a
 * suggestion the host can't insert). `catalogTypes` is the set of valid types.
 */
export function normalizeSuggestion(
  raw: Record<string, unknown>,
  catalogTypes: ReadonlySet<string>,
): CanvasSuggestion | null {
  const nodeType = String((raw as any)?.nodeType ?? '').trim();
  const label = String((raw as any)?.label ?? '').trim();
  const reason = String((raw as any)?.reason ?? '').trim();
  if (!nodeType || !label) return null;
  if (!catalogTypes.has(nodeType)) return null;
  const cfg = (raw as any)?.config;
  const config =
    cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? (cfg as Record<string, unknown>) : undefined;
  return {
    nodeType,
    label,
    reason: reason || 'Suggested from the current canvas.',
    ...(config && Object.keys(config).length ? { config } : {}),
  };
}
