/**
 * Spindle (Palantir AIP-Logic equivalent) — typed BLOCK GRAPH execution engine.
 *
 * Replaces the old flattened "steps → one system prompt" model with a real,
 * ordered graph of TYPED blocks. Each block is configured by dropdowns / typed
 * inputs (no freeform JSON), executes against a REAL Azure-native backend, and
 * emits a NAMED, typed output variable that later blocks reference by name.
 *
 * Block kinds:
 *   - create-variable     deterministic literal / `{ref}` template   (no backend)
 *   - get-object-property real Synapse read of one property off an   (Synapse)
 *                         ontology entity type, keyed by a prior ref
 *   - use-llm            one grounded turn on the LIVE Azure OpenAI  (AOAI +
 *                         deployment; its tools (apply-action /       Synapse)
 *                         ontology-function / execute-function) run
 *                         real backends and are fed back into the turn
 *   - execute-function   invoke a sibling aip-logic function (its own (recursion
 *                         graph) in-process with resolved args         → AOAI)
 *   - transform          deterministic map/derive over a prior ref   (no backend)
 *   - branch             deterministic ternary on a prior ref        (no backend)
 *
 * Every backend is real (Azure OpenAI chatGrounded / Synapse dedicated pool /
 * in-process sibling recursion). Where a backend is absent the block returns an
 * HONEST gate step (never a mock). 100% Azure-native — no Microsoft Fabric.
 */
import { loadOwnedItem } from '../../_lib/item-crud';
import {
  chatGrounded, NoAoaiDeploymentError,
  type DataAgentConfig, type DataAgentSource,
} from '@/lib/azure/data-agent-client';
import { dedicatedTarget, executeQuery, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import {
  safeSqlIdent, buildInsertSql, buildUpdateSql, buildDeleteSql,
  type OntologyEntityBinding, type AtelierColumnValue,
} from '@/lib/editors/_family-utils';
import { resolveSpindleGrounding, type GroundingResult } from './_spindle-grounding';

const ITEM_TYPE = 'aip-logic';
const MAX_DEPTH = 3; // execute-function recursion guard

// ───────────────────────── types (mirrors the editor) ─────────────────────────

export type AipBlockKind =
  | 'create-variable' | 'get-object-property' | 'use-llm'
  | 'execute-function' | 'transform' | 'branch';
export type AipBlockType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export type AipToolKind = 'apply-action' | 'ontology-function' | 'execute-function';

export interface AipToolBinding {
  id: string;
  kind: AipToolKind;
  // apply-action
  actionName?: string;
  actionKind?: 'create' | 'update' | 'delete';
  objectType?: string;
  keyColumn?: string;
  keyRef?: string;                       // ref providing the key (update/delete)
  valueRefs?: Record<string, string>;    // column → ref (create/update)
  commit?: boolean;                      // false ⇒ propose only (real SQL, not run)
  // ontology-function
  property?: string;                     // property to read off objectType
  // execute-function (as a tool)
  functionItemId?: string;
  functionName?: string;
  argRefs?: Record<string, string>;      // sibling input name → ref
}

export interface AipBlockDef {
  id: string;
  kind: AipBlockKind;
  name?: string;
  output: string;        // NAMED typed output variable (identifier)
  outputType?: AipBlockType;
  // create-variable
  valueExpr?: string;
  // get-object-property
  objectType?: string;
  property?: string;
  keyColumn?: string;
  keyRef?: string;
  // use-llm
  prompt?: string;
  tools?: AipToolBinding[];
  // execute-function (block)
  functionItemId?: string;
  functionName?: string;
  argRefs?: Record<string, string>;
  // transform
  sourceRef?: string;
  transformOp?: 'uppercase' | 'lowercase' | 'trim' | 'length' | 'json-parse' | 'json-stringify' | 'to-number' | 'to-string' | 'template';
  transformExpr?: string;
  // branch
  conditionRef?: string;
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'contains' | 'truthy' | 'empty';
  compareValue?: string;
  thenRef?: string;
  elseRef?: string;
}

export interface AipInputDef { name: string; type: string; objectType?: string; description?: string; required?: boolean }

interface Gate { reason: string; remediation: string }

export interface BlockExecStep {
  kind: string;               // debugger card label (block kind)
  name?: string;
  output?: string;            // the named output this block emitted
  outputType?: string;
  status: 'ok' | 'error' | 'gate' | 'skipped';
  prompt?: string;            // generated prompt / SQL text
  content?: string;           // rendered resolved output
  result?: unknown;           // the resolved value written to the variable bag
  error?: string;
  gate?: Gate;
  model?: string;
  elapsedMs?: number;
  usage?: unknown;
  tools?: unknown[];          // per-block tool-call results (apply-action, etc.)
}

export interface GraphRunResult {
  ok: boolean;
  output: string;
  outputType: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  sourcesUsed?: string[];
  steps: BlockExecStep[];
  gate?: Gate;
  notDeployed?: boolean;
  error?: string;
}

// ───────────────────────── prompt composition (agent mode + legacy) ─────────────────────────

interface LegacyStep { kind: string; name?: string; prompt?: string }

/**
 * Compose the function definition into a strict system prompt. Renders the TYPED
 * BLOCK GRAPH when `state.blocks` is present (each block, its named typed output,
 * and the prior outputs it references), else the legacy ordered-steps list. Used
 * by the agent-mode orchestrator and as the sibling-recursion legacy fallback.
 */
export function composeGraphPrompt(state: Record<string, unknown>): string {
  const inputs = Array.isArray(state.inputs) ? (state.inputs as AipInputDef[]) : [];
  const blocks = Array.isArray(state.blocks) ? (state.blocks as AipBlockDef[]) : [];
  const steps = Array.isArray(state.steps) ? (state.steps as LegacyStep[]) : [];
  const outputType = String(state.outputType || 'string');
  const outputDesc = String(state.outputDescription || '');
  const lines: string[] = [];
  lines.push('You are a deterministic typed function (Palantir AIP-Logic equivalent). Execute the ordered typed-block graph below, resolving each block\'s named output and every variable reference, then return ONLY the final typed output.');
  lines.push('');
  lines.push('Typed inputs:');
  if (!inputs.length) lines.push('- (none)');
  for (const i of inputs) lines.push(`- ${i.name} (${i.type}${i.objectType ? ` of ${i.objectType}` : ''})${i.required ? ' [required]' : ''}${i.description ? `: ${i.description}` : ''}`);
  lines.push('');

  if (blocks.length) {
    lines.push('Typed block graph (each block emits a named, typed output that later blocks reference):');
    blocks.forEach((b, n) => {
      const out = `${b.output}: ${b.outputType || 'string'}`;
      switch (b.kind) {
        case 'create-variable':
          lines.push(`${n + 1}. [create-variable] ${b.name || b.output} → ${out} = ${b.valueExpr ?? ''}`);
          break;
        case 'get-object-property':
          lines.push(`${n + 1}. [get-object-property] ${b.name || b.output} → ${out}: read ${b.objectType || '?'}.${b.property || '?'} keyed by {${b.keyRef || '?'}}`);
          break;
        case 'use-llm': {
          const tools = (b.tools || []).map((t) => t.kind === 'apply-action' ? `apply-action(${t.actionName || t.objectType || ''})` : t.kind === 'ontology-function' ? `ontology-function(${t.objectType || ''}.${t.property || ''})` : `execute-function(${t.functionName || ''})`).join(', ');
          lines.push(`${n + 1}. [use-llm] ${b.name || b.output} → ${out}: ${b.prompt || ''}${tools ? `  [tools: ${tools}]` : ''}`);
          break;
        }
        case 'execute-function':
          lines.push(`${n + 1}. [execute-function] ${b.name || b.output} → ${out}: call function "${b.functionName || b.functionItemId || '?'}" with ${JSON.stringify(b.argRefs || {})}`);
          break;
        case 'transform':
          lines.push(`${n + 1}. [transform] ${b.name || b.output} → ${out}: ${b.transformOp || 'template'} of {${b.sourceRef || ''}}${b.transformExpr ? ` (${b.transformExpr})` : ''}`);
          break;
        case 'branch':
          lines.push(`${n + 1}. [branch] ${b.name || b.output} → ${out}: if {${b.conditionRef || ''}} ${b.operator || 'truthy'} ${b.compareValue ?? ''} then {${b.thenRef || ''}} else {${b.elseRef || ''}}`);
          break;
        default:
          lines.push(`${n + 1}. [${b.kind}] ${b.name || b.output} → ${out}`);
      }
    });
  } else {
    lines.push('Ordered steps:');
    steps.forEach((st, n) => lines.push(`${n + 1}. [${st.kind}] ${st.name || ''}${st.prompt ? ` — ${st.prompt}` : ''}`));
  }
  lines.push('');
  lines.push(`Return a single ${outputType} value as the output${outputDesc ? ` (${outputDesc})` : ''}. Do not include explanations.`);
  return lines.join('\n');
}

// ───────────────────────── value helpers ─────────────────────────

function coerceOut(type: string | undefined, raw: unknown): unknown {
  const t = String(type || 'string');
  if (raw === null || raw === undefined) return t === 'array' ? [] : t === 'object' ? {} : t === 'number' ? null : t === 'boolean' ? false : '';
  if (t === 'number') { const n = Number(typeof raw === 'string' ? raw.trim() : raw); return Number.isFinite(n) ? n : null; }
  if (t === 'boolean') return typeof raw === 'boolean' ? raw : /^(true|1|yes|on)$/i.test(String(raw).trim());
  if (t === 'object' || t === 'array') {
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch { return raw; }
  }
  return typeof raw === 'string' ? raw : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw));
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/** Interpolate `{name}` tokens against the variable bag (missing → empty). */
function interp(text: string | undefined, bag: Record<string, unknown>): string {
  if (!text) return '';
  return text.replace(/\{([A-Za-z_][\w]*)\}/g, (_m, name) => asText(bag[name]));
}

/** Resolve a reference name to a bag value (undefined when unset). */
function refVal(ref: string | undefined, bag: Record<string, unknown>): unknown {
  if (!ref) return undefined;
  return Object.prototype.hasOwnProperty.call(bag, ref) ? bag[ref] : undefined;
}

const SYNAPSE_GATE: Gate = {
  reason: 'The Azure-native property read/write executes against the bound ontology\'s Synapse warehouse.',
  remediation: 'Set LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL on the Console. No Microsoft Fabric required.',
};
const AOAI_GATE: Gate = {
  reason: 'Spindle runs against Azure OpenAI.',
  remediation: 'Open the AI Foundry hub → Quota + usage → deploy a model (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No Fabric required.',
};

/** Load the raw ontology entity bindings (keyColumns / writableColumns). */
async function loadEntityBindings(boundOntologyId: string | undefined, tenantId: string): Promise<OntologyEntityBinding[]> {
  if (!boundOntologyId) return [];
  const onto = await loadOwnedItem(boundOntologyId, 'ontology', tenantId).catch(() => null);
  if (!onto) return [];
  const b = ((onto.state || {}) as Record<string, unknown>).entityBindings;
  return Array.isArray(b) ? (b as OntologyEntityBinding[]) : [];
}

// ───────────────────────── real backend: get-object-property ─────────────────────────

/** Read one property off an ontology entity type via the SAME Synapse path the
 *  Workshop /run-action route uses (dedicated pool, parameterised, identifier-safe). */
async function readObjectProperty(
  block: AipBlockDef, bindings: OntologyEntityBinding[], bag: Record<string, unknown>,
): Promise<{ ok: true; value: unknown; sql: string } | { ok: false; gate?: Gate; error?: string }> {
  const objectType = String(block.objectType || '').trim();
  const property = String(block.property || '').trim();
  if (!objectType || !property) return { ok: false, error: 'pick an object type and property' };
  const binding = bindings.find((b) => (b.entityTypes || []).includes(objectType) && b.sourceKind === 'warehouse');
  if (!binding) {
    return { ok: false, gate: { reason: `No warehouse data source is bound to entity type "${objectType}" on the ontology.`, remediation: `Open the bound ontology and map a Warehouse table to ${objectType} (Bind to data source).` } };
  }
  const table = safeSqlIdent(objectType);
  const col = safeSqlIdent(property);
  const keyColumn = safeSqlIdent(String(block.keyColumn || binding.keyColumns?.[objectType] || '').trim());
  if (!table || !col) return { ok: false, error: 'object type / property is not a safe SQL identifier' };
  if (!keyColumn) return { ok: false, error: 'a key column is required (set keyColumns on the ontology binding or the block keyColumn)' };
  const keyValue = asText(refVal(block.keyRef, bag));
  let target;
  try { target = dedicatedTarget(); } catch (e) { return { ok: false, gate: { ...SYNAPSE_GATE, reason: `${SYNAPSE_GATE.reason} (${e instanceof Error ? e.message : String(e)})` } }; }
  const sql = `SELECT TOP (1) [${col}] AS [value] FROM [${table}] WHERE [${keyColumn}] = @k`;
  try {
    const result = await executeQuery(target, sql, 60_000, [{ name: 'k', value: keyValue } as SynapseQueryParam]);
    const value = result.rows?.[0]?.[0];
    return { ok: true, value, sql };
  } catch (e) {
    return { ok: false, error: `Query failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ───────────────────────── real backend: apply-action (Synapse CRUD) ─────────────────────────

/** Execute (or propose) an ontology Action as REAL parameterised Synapse CRUD —
 *  the same builders + dedicated-pool executor the Workshop /run-action path uses. */
async function runApplyAction(
  tool: AipToolBinding, bindings: OntologyEntityBinding[], bag: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const objectType = String(tool.objectType || '').trim();
  const op = tool.actionKind || 'update';
  const base: Record<string, unknown> = { tool: 'apply-action', action: tool.actionName, entityType: objectType, op, committed: false };
  const binding = bindings.find((b) => (b.entityTypes || []).includes(objectType) && b.sourceKind === 'warehouse');
  if (!binding) return { ...base, gate: `No warehouse source bound to "${objectType}" — map a Warehouse table on the ontology.` };
  const table = safeSqlIdent(objectType);
  if (!table) return { ...base, error: `"${objectType}" is not a safe SQL identifier` };

  // Resolve column values from valueRefs (column → variable ref).
  const cols: AtelierColumnValue[] = [];
  if (op === 'create' || op === 'update') {
    for (const [rawCol, ref] of Object.entries(tool.valueRefs || {})) {
      const c = safeSqlIdent(rawCol);
      if (!c) return { ...base, error: `column "${rawCol}" is not a safe SQL identifier` };
      const allowed = binding.writableColumns?.[objectType];
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(rawCol)) {
        return { ...base, error: `column "${rawCol}" is not a declared writable column for ${objectType}` };
      }
      const v = refVal(ref, bag);
      cols.push({ column: c, value: v === null || v === undefined ? null : asText(v) });
    }
    if (!cols.length) return { ...base, error: `${op} requires at least one column value (add valueRefs)` };
  }

  let built: { sql: string; params: Array<{ name: string; value: string | null }> };
  try {
    if (op === 'create') {
      built = buildInsertSql(table, cols);
    } else {
      const keyColumn = safeSqlIdent(String(tool.keyColumn || binding.keyColumns?.[objectType] || '').trim());
      if (!keyColumn) return { ...base, error: `a key column is required for ${op}` };
      const keyValue = asText(refVal(tool.keyRef, bag));
      built = op === 'update' ? buildUpdateSql(table, cols, keyColumn, keyValue) : buildDeleteSql(table, keyColumn, keyValue);
    }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }

  // Propose (default): show the exact real SQL + bound params the commit would run.
  if (!tool.commit) return { ...base, proposed: true, sql: built.sql, params: built.params };

  // Commit: real write against the Synapse dedicated pool.
  let target;
  try { target = dedicatedTarget(); } catch (e) { return { ...base, gate: `${SYNAPSE_GATE.remediation} (${e instanceof Error ? e.message : String(e)})` }; }
  try {
    const result = await executeQuery(target, built.sql, 60_000, built.params as SynapseQueryParam[]);
    return { ...base, committed: true, sql: built.sql, recordsAffected: result.recordsAffected };
  } catch (e) {
    return { ...base, sql: built.sql, error: `Write failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ───────────────────────── deterministic transform ─────────────────────────

function runTransform(block: AipBlockDef, bag: Record<string, unknown>): unknown {
  const src = refVal(block.sourceRef, bag);
  switch (block.transformOp) {
    case 'uppercase': return asText(src).toUpperCase();
    case 'lowercase': return asText(src).toLowerCase();
    case 'trim': return asText(src).trim();
    case 'length': return Array.isArray(src) ? src.length : asText(src).length;
    case 'to-number': { const n = Number(asText(src)); return Number.isFinite(n) ? n : null; }
    case 'to-string': return asText(src);
    case 'json-parse': { try { return JSON.parse(asText(src)); } catch { return null; } }
    case 'json-stringify': { try { return JSON.stringify(src); } catch { return asText(src); } }
    case 'template':
    default:
      return interp(block.transformExpr, bag);
  }
}

// ───────────────────────── deterministic branch (ternary) ─────────────────────────

function evalBranch(block: AipBlockDef, bag: Record<string, unknown>): { cond: boolean; value: unknown } {
  const left = refVal(block.conditionRef, bag);
  const cmp = block.compareValue ?? '';
  let cond: boolean;
  switch (block.operator) {
    case 'eq': cond = asText(left) === cmp; break;
    case 'ne': cond = asText(left) !== cmp; break;
    case 'gt': cond = Number(left) > Number(cmp); break;
    case 'lt': cond = Number(left) < Number(cmp); break;
    case 'contains': cond = asText(left).includes(cmp); break;
    case 'empty': cond = asText(left).trim() === ''; break;
    case 'truthy':
    default: cond = Boolean(typeof left === 'string' ? left.trim() : left); break;
  }
  const value = block.thenRef || block.elseRef
    ? (cond ? refVal(block.thenRef, bag) : refVal(block.elseRef, bag))
    : cond;
  return { cond, value };
}

// ───────────────────────── use-llm tool pre-resolution (all REAL) ─────────────────────────

async function resolveUseLlmTools(
  block: AipBlockDef, bindings: OntologyEntityBinding[], bag: Record<string, unknown>,
  tenantId: string, depth: number,
): Promise<{ results: Record<string, unknown>[]; text: string }> {
  const results: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  for (const tool of block.tools || []) {
    if (tool.kind === 'apply-action') {
      const r = await runApplyAction(tool, bindings, bag);
      results.push(r);
      textParts.push(`apply-action(${tool.actionName || tool.objectType}): ${r.committed ? `committed, ${r.recordsAffected} row(s)` : r.gate ? `gated (${r.gate})` : r.error ? `error (${r.error})` : `proposed: ${r.sql}`}`);
    } else if (tool.kind === 'ontology-function') {
      const r = await readObjectProperty({ ...block, objectType: tool.objectType, property: tool.property, keyColumn: tool.keyColumn, keyRef: tool.keyRef }, bindings, bag);
      if (r.ok) { results.push({ tool: 'ontology-function', objectType: tool.objectType, property: tool.property, value: r.value, sql: r.sql }); textParts.push(`ontology-function(${tool.objectType}.${tool.property}) = ${asText(r.value)}`); }
      else { results.push({ tool: 'ontology-function', objectType: tool.objectType, property: tool.property, gate: r.gate?.reason, error: r.error }); textParts.push(`ontology-function(${tool.objectType}.${tool.property}): ${r.gate ? `gated (${r.gate.reason})` : `error (${r.error})`}`); }
    } else if (tool.kind === 'execute-function') {
      const args: Record<string, unknown> = {};
      for (const [k, ref] of Object.entries(tool.argRefs || {})) args[k] = refVal(ref, bag);
      const sub = await runSiblingFunction(tool.functionItemId, args, tenantId, depth + 1);
      results.push({ tool: 'execute-function', function: tool.functionName || tool.functionItemId, value: sub.output, ok: sub.ok, gate: sub.gate?.reason, error: sub.error });
      textParts.push(`execute-function(${tool.functionName || tool.functionItemId}) = ${sub.ok ? sub.output : sub.gate ? `gated (${sub.gate.reason})` : `error (${sub.error})`}`);
    }
  }
  return { results, text: textParts.join('\n') };
}

// ───────────────────────── real backend: execute a sibling function ─────────────────────────

async function runSiblingFunction(
  functionItemId: string | undefined, args: Record<string, unknown>, tenantId: string, depth: number,
): Promise<GraphRunResult> {
  const empty: GraphRunResult = { ok: false, output: '', outputType: 'string', steps: [] };
  if (depth > MAX_DEPTH) return { ...empty, error: `execute-function recursion exceeded ${MAX_DEPTH} levels` };
  if (!functionItemId) return { ...empty, error: 'pick a function to execute' };
  const sib = await loadOwnedItem(functionItemId, ITEM_TYPE, tenantId).catch(() => null);
  if (!sib) return { ...empty, gate: { reason: `Sibling function "${functionItemId}" not found.`, remediation: 'Pick a saved Spindle function you own.' } };
  const sibState = (sib.state || {}) as Record<string, unknown>;
  const sibBlocks = Array.isArray(sibState.blocks) ? sibState.blocks : [];
  if (sibBlocks.length) return runBlockGraph(sibState, args, tenantId, depth);
  // Legacy sibling (ordered steps) → one grounded turn.
  const grounding = await resolveSpindleGrounding(sibState.boundOntologyId as string | undefined, tenantId).catch(() => ({ sources: [] as DataAgentSource[], surface: null, entityTypes: [] as string[] }));
  try {
    const answer = await chatGrounded({ instructions: composeGraphPrompt(sibState), sources: grounding.sources }, [], `Inputs:\n${JSON.stringify(args, null, 2)}`);
    return { ok: true, output: asText(answer.answer), outputType: String(sibState.outputType || 'string'), model: answer.model, usage: answer.usage, steps: [] };
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) return { ...empty, notDeployed: true, gate: AOAI_GATE, error: e.message };
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

// ───────────────────────── engine entrypoint ─────────────────────────

/**
 * Execute the typed block graph on `state` with `inputs`, returning the final
 * typed output + per-block debugger steps. All backends are real; absent
 * backends surface honest gate steps.
 */
export async function runBlockGraph(
  state: Record<string, unknown>, inputs: Record<string, unknown>, tenantId: string, depth = 0,
): Promise<GraphRunResult> {
  const blocks = Array.isArray(state.blocks) ? (state.blocks as AipBlockDef[]) : [];
  const outputType = String(state.outputType || 'string');
  const boundOntologyId = (state.boundOntologyId as string | undefined) || undefined;
  const grounding: GroundingResult = await resolveSpindleGrounding(boundOntologyId, tenantId).catch(() => ({ sources: [], surface: null, entityTypes: [] }));
  const bindings = await loadEntityBindings(boundOntologyId, tenantId).catch(() => []);

  // System context each use-llm turn is grounded with (inputs + output contract).
  const fnContext = composeGraphPrompt(state);

  const bag: Record<string, unknown> = { ...(inputs && typeof inputs === 'object' ? inputs : {}) };
  const steps: BlockExecStep[] = [];
  const sourcesUsed = new Set<string>();
  let lastModel: string | undefined;
  let lastOutput: string | undefined;
  let promptTokens = 0, completionTokens = 0, totalTokens = 0;

  for (const block of blocks) {
    const t0 = Date.now();
    const outName = String(block.output || '').trim() || `out_${steps.length + 1}`;
    const step: BlockExecStep = { kind: block.kind, name: block.name || outName, output: outName, outputType: block.outputType, status: 'ok' };
    try {
      switch (block.kind) {
        case 'create-variable': {
          const val = coerceOut(block.outputType, interp(block.valueExpr, bag));
          bag[outName] = val; step.result = val; step.content = asText(val);
          break;
        }
        case 'transform': {
          const val = coerceOut(block.outputType, runTransform(block, bag));
          bag[outName] = val; step.result = val; step.content = asText(val);
          break;
        }
        case 'branch': {
          const { cond, value } = evalBranch(block, bag);
          const val = coerceOut(block.outputType, value);
          bag[outName] = val; step.result = val; step.content = `condition ${cond} → ${asText(val)}`;
          break;
        }
        case 'get-object-property': {
          const r = await readObjectProperty(block, bindings, bag);
          if (r.ok) { const val = coerceOut(block.outputType, r.value); bag[outName] = val; step.result = val; step.content = asText(val); step.prompt = r.sql; }
          else if (r.gate) { step.status = 'gate'; step.gate = r.gate; bag[outName] = null; }
          else { step.status = 'error'; step.error = r.error; bag[outName] = null; }
          break;
        }
        case 'execute-function': {
          const args: Record<string, unknown> = {};
          for (const [k, ref] of Object.entries(block.argRefs || {})) args[k] = refVal(ref, bag);
          step.prompt = `${block.functionName || block.functionItemId}(${JSON.stringify(args)})`;
          const sub = await runSiblingFunction(block.functionItemId, args, tenantId, depth);
          if (sub.ok) { const val = coerceOut(block.outputType, sub.output); bag[outName] = val; step.result = val; step.content = asText(val); if (sub.model) lastModel = sub.model; }
          else if (sub.gate) {
            step.status = 'gate'; step.gate = sub.gate;
            if (sub.notDeployed) { step.elapsedMs = Date.now() - t0; steps.push(step); return finalize(false, '', outputType, steps, sub.gate, true, sub.error, lastModel, sourcesUsed, { promptTokens, completionTokens, totalTokens }); }
            bag[outName] = null;
          }
          else { step.status = 'error'; step.error = sub.error; bag[outName] = null; }
          break;
        }
        case 'use-llm': {
          const tools = await resolveUseLlmTools(block, bindings, bag, tenantId, depth);
          if (tools.results.length) step.tools = tools.results;
          const question = `${interp(block.prompt, bag)}${tools.text ? `\n\nTool results (from real Azure-native backends — ground your answer in these):\n${tools.text}` : ''}`;
          const cfg: DataAgentConfig = { instructions: `${fnContext}\n\nYou are executing block "${block.name || outName}". Produce ONLY its ${block.outputType || 'string'} output.`, sources: grounding.sources };
          step.prompt = question;
          const answer = await chatGrounded(cfg, [], question || 'Execute this block.');
          const val = coerceOut(block.outputType, answer.answer);
          bag[outName] = val; step.result = val; step.content = asText(answer.answer);
          step.model = answer.model; step.usage = answer.usage; lastModel = answer.model || lastModel;
          if (answer.usage) { promptTokens += answer.usage.promptTokens || 0; completionTokens += answer.usage.completionTokens || 0; totalTokens += answer.usage.totalTokens || 0; }
          for (const src of answer.sourcesAvailable || []) sourcesUsed.add(src);
          break;
        }
        default:
          step.status = 'skipped'; step.error = `unknown block kind "${block.kind}"`;
      }
    } catch (e) {
      if (e instanceof NoAoaiDeploymentError) {
        step.status = 'gate'; step.gate = AOAI_GATE; steps.push({ ...step, elapsedMs: Date.now() - t0 });
        return finalize(false, '', outputType, steps, AOAI_GATE, true, e.message, lastModel, sourcesUsed, { promptTokens, completionTokens, totalTokens });
      }
      step.status = 'error'; step.error = e instanceof Error ? e.message : String(e);
    }
    step.elapsedMs = Date.now() - t0;
    steps.push(step);
    lastOutput = outName;
  }

  const finalVal = lastOutput ? bag[lastOutput] : '';
  const output = asText(coerceOut(outputType, finalVal));
  return finalize(true, output, outputType, steps, undefined, false, undefined, lastModel, sourcesUsed, { promptTokens, completionTokens, totalTokens });
}

function finalize(
  ok: boolean, output: string, outputType: string, steps: BlockExecStep[], gate: Gate | undefined,
  notDeployed: boolean, error: string | undefined, model: string | undefined, sourcesUsed: Set<string>,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
): GraphRunResult {
  return {
    ok, output, outputType, steps, model,
    sourcesUsed: sourcesUsed.size ? [...sourcesUsed] : undefined,
    usage: usage.totalTokens || usage.promptTokens || usage.completionTokens ? usage : undefined,
    ...(gate ? { gate } : {}), ...(notDeployed ? { notDeployed } : {}), ...(error ? { error } : {}),
  };
}
