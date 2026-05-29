/**
 * flow.dag.yaml model + (de)serializer for the Prompt Flow visual builder.
 *
 * Azure AI Foundry / Azure ML prompt flow stores a flow as a `flow.dag.yaml`
 * file with three top-level sections:
 *
 *   inputs:          # the flow's typed inputs
 *     url:
 *       type: string
 *       default: https://www.bing.com
 *   outputs:         # the flow's typed outputs (each references a node output)
 *     category:
 *       type: string
 *       reference: ${classify.output}
 *   nodes:           # the DAG — list of tool nodes (llm | python | prompt)
 *     - name: summarize
 *       type: llm
 *       source: { type: code, path: summarize.jinja2 }
 *       inputs: { text: ${fetch_text.output}, max_tokens: 256 }
 *       connection: aoai-conn
 *       api: chat
 *       provider: AzureOpenAI
 *       module: promptflow.tools.aoai
 *
 * Edges are NOT stored explicitly — they're derived from `${...}` references
 * in node inputs (`${nodeName.output}` / `${nodeName.output.field}`) and flow
 * output references. The canvas reconstructs the DAG from those references,
 * exactly like the Foundry/AML "Graph" view does.
 *
 * No external YAML dependency is available in this app, so this module ships a
 * small, deterministic YAML serializer + parser scoped to the flow.dag.yaml
 * shape (maps, lists of maps, scalars, multi-line block scalars for code).
 * The contract tests assert round-trip stability.
 */

export type FlowNodeType = 'llm' | 'python' | 'prompt';

export interface FlowInput {
  name: string;
  type: string;               // string | int | bool | double | list | object
  default?: unknown;
}

export interface FlowOutput {
  name: string;
  type: string;
  reference: string;          // ${node.output} or ${node.output.field}
}

export interface FlowNode {
  name: string;
  type: FlowNodeType;
  /** Jinja2 template (llm/prompt) or python code (python). Stored inline. */
  source?: { type: 'code' | 'package'; path?: string; code?: string; tool?: string };
  /** Node inputs — values may be literals or ${...} references. */
  inputs: Record<string, unknown>;
  // LLM-specific
  connection?: string;        // Foundry connection name
  api?: string;               // chat | completion
  deploymentName?: string;
  provider?: string;          // AzureOpenAI
  module?: string;
}

export interface FlowDag {
  inputs: FlowInput[];
  outputs: FlowOutput[];
  nodes: FlowNode[];
  /** Any unmodeled top-level keys (environment, node_variants, …) preserved. */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Graph derivation — turn the DAG into nodes + edges for the canvas.
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;                 // node name, or '__inputs__' / '__outputs__'
  kind: FlowNodeType | 'inputs' | 'outputs';
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

const REF_RE = /\$\{([a-zA-Z_][\w]*)\.output(?:\.[\w]+)?\}/g;
const INPUT_REF_RE = /\$\{(?:inputs?|flow)\.[\w]+\}/;

/** Extract referenced node names from any value (string / object / array). */
export function referencedNodes(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      let m: RegExpExecArray | null;
      REF_RE.lastIndex = 0;
      while ((m = REF_RE.exec(v))) found.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}

/** True when any value references the flow inputs (${inputs.x} / ${flow.x}). */
export function referencesFlowInputs(value: unknown): boolean {
  if (typeof value === 'string') return INPUT_REF_RE.test(value);
  if (Array.isArray(value)) return value.some(referencesFlowInputs);
  if (value && typeof value === 'object') return Object.values(value as any).some(referencesFlowInputs);
  return false;
}

export const INPUTS_NODE = '__inputs__';
export const OUTPUTS_NODE = '__outputs__';

/** Build the visual graph (nodes + edges) from a flow DAG. */
export function flowToGraph(dag: FlowDag): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: INPUTS_NODE, kind: 'inputs', label: 'Inputs' },
  ];
  for (const n of dag.nodes) nodes.push({ id: n.name, kind: n.type, label: n.name });
  nodes.push({ id: OUTPUTS_NODE, kind: 'outputs', label: 'Outputs' });

  const nodeNames = new Set(dag.nodes.map((n) => n.name));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string) => {
    const k = `${from}->${to}`;
    if (from !== to && !seen.has(k)) { seen.add(k); edges.push({ from, to }); }
  };

  // node -> node edges (and inputs -> node) from each node's input references.
  for (const n of dag.nodes) {
    const refs = referencedNodes(n.inputs);
    for (const r of refs) {
      if (nodeNames.has(r)) addEdge(r, n.name);
    }
    if (referencesFlowInputs(n.inputs)) addEdge(INPUTS_NODE, n.name);
  }

  // node -> outputs from each flow-output reference.
  for (const o of dag.outputs) {
    for (const r of referencedNodes(o.reference)) {
      if (nodeNames.has(r)) addEdge(r, OUTPUTS_NODE);
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Empty / template flow
// ---------------------------------------------------------------------------

export function emptyFlow(): FlowDag {
  return { inputs: [], outputs: [], nodes: [] };
}

/** A minimal runnable starter flow: one input -> one LLM node -> one output. */
export function starterFlow(): FlowDag {
  return {
    inputs: [{ name: 'question', type: 'string', default: 'What is the capital of France?' }],
    nodes: [
      {
        name: 'answer',
        type: 'llm',
        api: 'chat',
        provider: 'AzureOpenAI',
        module: 'promptflow.tools.aoai',
        connection: '',
        deploymentName: '',
        source: { type: 'code', path: 'answer.jinja2', code: 'system:\nYou are a helpful assistant.\n\nuser:\n{{question}}' },
        inputs: { question: '${inputs.question}', temperature: 0.7, max_tokens: 256 },
      },
    ],
    outputs: [{ name: 'answer', type: 'string', reference: '${answer.output}' }],
  };
}

// ---------------------------------------------------------------------------
// YAML serialize
// ---------------------------------------------------------------------------

function isPlainScalar(s: string): boolean {
  // Quote when the string would otherwise be ambiguous or contain YAML meta.
  if (s === '') return false;
  if (/^[\s]|[\s]$/.test(s)) return false;
  if (s.includes('\n')) return false;
  // Prompt-flow `${node.output}` / `${inputs.x}` references are emitted
  // unquoted (matching real flow.dag.yaml). They contain {} but no other
  // YAML-hostile chars, so allow them when the whole value is reference-only
  // (single ref, optionally surrounded by plain text without other meta).
  const refOnly = /^\$\{[\w.]+\}$/.test(s);
  if (refOnly) return true;
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(s)) return false;
  if (/^(true|false|null|yes|no|~)$/i.test(s)) return false;
  if (/^-?\d/.test(s)) return false;            // looks numeric
  return true;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (isPlainScalar(s)) return s;
  // Double-quote, escaping backslashes, quotes and newlines.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function emitMap(lines: string[], obj: Record<string, unknown>, indent: number): void {
  const pad = '  '.repeat(indent);
  for (const [k, v] of Object.entries(obj)) {
    emitKeyValue(lines, k, v, indent, pad);
  }
}

function emitKeyValue(lines: string[], key: string, v: unknown, indent: number, pad: string): void {
  if (typeof v === 'string' && v.includes('\n')) {
    lines.push(`${pad}${key}: |-`);
    const childPad = '  '.repeat(indent + 1);
    for (const ln of v.split('\n')) lines.push(`${childPad}${ln}`);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) { lines.push(`${pad}${key}: []`); return; }
    lines.push(`${pad}${key}:`);
    for (const item of v) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length === 0) { lines.push(`${pad}- {}`); continue; }
        const [fk, fv] = entries[0];
        if (typeof fv === 'string' && fv.includes('\n')) {
          lines.push(`${pad}- ${fk}: |-`);
          const childPad = '  '.repeat(indent + 2);
          for (const ln of fv.split('\n')) lines.push(`${childPad}${ln}`);
        } else if (Array.isArray(fv) || (fv && typeof fv === 'object')) {
          lines.push(`${pad}- ${fk}:`);
          emitNested(lines, fv, indent + 2);
        } else {
          lines.push(`${pad}- ${fk}: ${scalar(fv)}`);
        }
        for (const [ck, cv] of entries.slice(1)) {
          emitKeyValue(lines, ck, cv, indent + 1, '  '.repeat(indent + 1));
        }
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) { lines.push(`${pad}${key}: {}`); return; }
    lines.push(`${pad}${key}:`);
    emitMap(lines, v as Record<string, unknown>, indent + 1);
    return;
  }
  lines.push(`${pad}${key}: ${scalar(v)}`);
}

function emitNested(lines: string[], v: unknown, indent: number): void {
  if (Array.isArray(v)) {
    const pad = '  '.repeat(indent);
    for (const item of v) lines.push(`${pad}- ${scalar(item)}`);
  } else if (v && typeof v === 'object') {
    emitMap(lines, v as Record<string, unknown>, indent);
  }
}

/** Serialize a FlowDag to a flow.dag.yaml string. */
export function serializeFlowDag(dag: FlowDag): string {
  const lines: string[] = [];

  // inputs:
  if (dag.inputs.length === 0) {
    lines.push('inputs: {}');
  } else {
    lines.push('inputs:');
    for (const inp of dag.inputs) {
      lines.push(`  ${inp.name}:`);
      lines.push(`    type: ${scalar(inp.type || 'string')}`);
      if (inp.default !== undefined) emitKeyValue(lines, 'default', inp.default, 2, '    ');
    }
  }

  // outputs:
  if (dag.outputs.length === 0) {
    lines.push('outputs: {}');
  } else {
    lines.push('outputs:');
    for (const out of dag.outputs) {
      lines.push(`  ${out.name}:`);
      lines.push(`    type: ${scalar(out.type || 'string')}`);
      lines.push(`    reference: ${scalar(out.reference)}`);
    }
  }

  // nodes:
  if (dag.nodes.length === 0) {
    lines.push('nodes: []');
  } else {
    lines.push('nodes:');
    for (const n of dag.nodes) {
      lines.push(`- name: ${scalar(n.name)}`);
      lines.push(`  type: ${scalar(n.type)}`);
      if (n.source) {
        lines.push('  source:');
        lines.push(`    type: ${scalar(n.source.type || 'code')}`);
        if (n.source.tool) lines.push(`    tool: ${scalar(n.source.tool)}`);
        if (n.source.path) lines.push(`    path: ${scalar(n.source.path)}`);
        if (n.source.code !== undefined) emitKeyValue(lines, 'code', n.source.code, 2, '    ');
      }
      // inputs
      const inputKeys = Object.keys(n.inputs || {});
      if (inputKeys.length === 0) {
        lines.push('  inputs: {}');
      } else {
        lines.push('  inputs:');
        emitMap(lines, n.inputs, 2);
      }
      if (n.connection !== undefined && n.connection !== '') lines.push(`  connection: ${scalar(n.connection)}`);
      if (n.api) lines.push(`  api: ${scalar(n.api)}`);
      if (n.deploymentName) lines.push(`  deployment_name: ${scalar(n.deploymentName)}`);
      if (n.provider) lines.push(`  provider: ${scalar(n.provider)}`);
      if (n.module) lines.push(`  module: ${scalar(n.module)}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// YAML parse (scoped to the flow.dag.yaml shape)
// ---------------------------------------------------------------------------

interface Line { indent: number; text: string; raw: string; blank: boolean; }

const BLANK_INDENT = Number.MAX_SAFE_INTEGER;

function tokenize(yaml: string): Line[] {
  // Blank lines are KEPT (so literal block scalars survive round-trips) but
  // marked with a sentinel indent so structural (map/list) loops skip them.
  // Comment-only lines are dropped.
  return yaml
    .split('\n')
    .map((raw) => raw.replace(/\r$/, ''))
    .filter((raw) => !/^\s*#/.test(raw))
    .map((raw) => {
      const blank = raw.trim() === '';
      const indent = blank ? BLANK_INDENT : raw.length - raw.replace(/^ +/, '').length;
      return { indent, text: raw.trim(), raw, blank };
    });
}

/** Advance the cursor past blank lines (used by structural loops). */
function skipBlanks(lines: Line[], cur: Cursor): void {
  while (cur.i < lines.length && lines[cur.i].blank) cur.i++;
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === '') return '';
  if (t === '{}') return {};
  if (t === '[]') return [];
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    if (t[0] === '"') return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return inner.replace(/''/g, "'");
  }
  return t;
}

interface Cursor { i: number; }

function parseBlock(lines: Line[], cur: Cursor, parentIndent: number): unknown {
  skipBlanks(lines, cur);
  if (cur.i >= lines.length) return null;
  const first = lines[cur.i];
  // List?
  if (first.text.startsWith('- ') || first.text === '-') {
    const arr: unknown[] = [];
    const listIndent = first.indent;
    for (;;) {
      skipBlanks(lines, cur);
      if (cur.i >= lines.length) break;
      const ln = lines[cur.i];
      if (ln.indent !== listIndent || !(ln.text.startsWith('- ') || ln.text === '-')) break;
      const rest = ln.text === '-' ? '' : ln.text.slice(2);
      if (rest === '') {
        cur.i++;
        arr.push(parseBlock(lines, cur, listIndent));
      } else if (findKeyColon(rest) >= 0) {
        // Inline map starting on the dash line: "- key: value"
        const obj: Record<string, unknown> = {};
        const dashKeyIndent = listIndent + 2;
        cur.i++;
        // `rest` is the text of the dash line; cursor already points PAST it.
        // Parse it without re-advancing for the simple-scalar case.
        parseKeyValueInto(obj, rest, lines, cur, dashKeyIndent, /* fromPriorLine */ true);
        for (;;) {
          skipBlanks(lines, cur);
          if (cur.i >= lines.length) break;
          const nx = lines[cur.i];
          if (nx.indent !== dashKeyIndent || nx.text.startsWith('- ')) break;
          parseKeyValueInto(obj, nx.text, lines, cur, dashKeyIndent);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(rest));
        cur.i++;
      }
    }
    return arr;
  }
  // Map
  const obj: Record<string, unknown> = {};
  const mapIndent = first.indent;
  for (;;) {
    skipBlanks(lines, cur);
    if (cur.i >= lines.length) break;
    const ln = lines[cur.i];
    if (ln.indent !== mapIndent || ln.text.startsWith('- ')) break;
    parseKeyValueInto(obj, ln.text, lines, cur, mapIndent);
  }
  void parentIndent;
  return obj;
}

function parseKeyValueInto(obj: Record<string, unknown>, text: string, lines: Line[], cur: Cursor, indent: number, fromPriorLine = false): void {
  const colon = findKeyColon(text);
  if (colon < 0) { if (!fromPriorLine) cur.i++; return; }
  const key = parseScalar(text.slice(0, colon).trim()) as string;
  const after = text.slice(colon + 1).trim();
  if (after === '|' || after === '|-' || after === '|+') {
    // literal block scalar (|- = strip trailing newlines). Gather all lines
    // more-indented than the key; blank lines (BLANK_INDENT) are kept verbatim
    // as empty interior lines but trimmed from the trailing edge.
    if (!fromPriorLine) cur.i++;
    const blockLines: string[] = [];
    let blockIndent = -1;
    while (cur.i < lines.length && lines[cur.i].indent > indent) {
      const ln = lines[cur.i];
      if (ln.blank) {
        blockLines.push('');
      } else {
        if (blockIndent < 0) blockIndent = ln.indent;
        blockLines.push(ln.raw.slice(blockIndent));
      }
      cur.i++;
    }
    // |- and |: strip trailing blank lines; |+ keeps them.
    if (after !== '|+') { while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop(); }
    obj[key] = blockLines.join('\n');
    return;
  }
  if (after === '') {
    if (!fromPriorLine) cur.i++;
    skipBlanks(lines, cur);
    if (cur.i < lines.length) {
      const next = lines[cur.i];
      const nextIsList = next.text.startsWith('- ') || next.text === '-';
      // A nested map must be deeper-indented. A nested LIST may sit at the
      // SAME indent as its parent key (common YAML, e.g. top-level `nodes:`).
      if (next.indent > indent || (nextIsList && next.indent === indent)) {
        obj[key] = parseBlock(lines, cur, indent);
        return;
      }
    }
    obj[key] = null;
    return;
  }
  obj[key] = parseScalar(after);
  if (!fromPriorLine) cur.i++;
}

/** Find the colon that separates key from value, ignoring colons in ${...}. */
function findKeyColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0 && (i + 1 >= text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

/** Parse a flow.dag.yaml string into a FlowDag. Tolerant of partial files. */
export function parseFlowDag(yaml: string): FlowDag {
  const lines = tokenize(yaml);
  const cur: Cursor = { i: 0 };
  const root = (parseBlock(lines, cur, -1) || {}) as Record<string, unknown>;

  const inputsObj = (root.inputs && typeof root.inputs === 'object' && !Array.isArray(root.inputs))
    ? root.inputs as Record<string, any> : {};
  const outputsObj = (root.outputs && typeof root.outputs === 'object' && !Array.isArray(root.outputs))
    ? root.outputs as Record<string, any> : {};
  const nodesArr = Array.isArray(root.nodes) ? root.nodes as any[] : [];

  const inputs: FlowInput[] = Object.entries(inputsObj).map(([name, v]) => ({
    name,
    type: (v?.type as string) || 'string',
    ...(v && 'default' in v ? { default: v.default } : {}),
  }));

  const outputs: FlowOutput[] = Object.entries(outputsObj).map(([name, v]) => ({
    name,
    type: (v?.type as string) || 'string',
    reference: (v?.reference as string) || '',
  }));

  const nodes: FlowNode[] = nodesArr.map((n: any) => ({
    name: String(n?.name ?? ''),
    type: (['llm', 'python', 'prompt'].includes(n?.type) ? n.type : 'python') as FlowNodeType,
    source: n?.source
      ? {
          type: (n.source.type === 'package' ? 'package' : 'code') as 'code' | 'package',
          ...(n.source.path ? { path: n.source.path } : {}),
          ...(n.source.code !== undefined ? { code: n.source.code } : {}),
          ...(n.source.tool ? { tool: n.source.tool } : {}),
        }
      : undefined,
    inputs: (n?.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs)) ? n.inputs : {},
    ...(n?.connection ? { connection: n.connection } : {}),
    ...(n?.api ? { api: n.api } : {}),
    ...(n?.deployment_name ? { deploymentName: n.deployment_name } : {}),
    ...(n?.provider ? { provider: n.provider } : {}),
    ...(n?.module ? { module: n.module } : {}),
  }));

  // Preserve any unmodeled top-level keys.
  const known = new Set(['inputs', 'outputs', 'nodes']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) if (!known.has(k)) extra[k] = v;

  return { inputs, outputs, nodes, ...(Object.keys(extra).length ? { extra } : {}) };
}
