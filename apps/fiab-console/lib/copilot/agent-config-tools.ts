/**
 * Data-agent config copilot — server-side tools.
 *
 * Implements the AGENT_CONFIG_COPILOT persona: given one bound data-agent
 * source, fetch its REAL schema from the Azure-native backend (Synapse SQL /
 * ADX / AI Search), ask the live AOAI deployment (the same one the cross-item
 * Copilot resolves) to generate example NL→query pairs + per-field descriptions
 * grounded ONLY on that schema, then merge the approved result back into the
 * agent's persisted config.
 *
 * Per .claude/rules/no-vaporware.md the schema is read from real backends — an
 * unreachable / unconfigured backend returns an honest `gate` string (never a
 * mock). Per .claude/rules/no-fabric-dependency.md every backend is
 * Azure-native and resolved from existing clients' env defaults — no Fabric
 * workspace required. The generated examples are written to `src.examples`,
 * which `composeSystemPrompt` (data-agent-client) injects verbatim, so they run
 * against the live source on the next test-chat turn.
 */

import { aoaiChat } from '../azure/aoai-chat-client';
import { NoAoaiDeploymentError } from '../azure/copilot-orchestrator';
import { executeQuery as synapseExecute, dedicatedTarget, serverlessTarget } from '../azure/synapse-sql-client';
import { listTableDetails, listTables, listFunctions, getTableSchema, kustoConfigGate, defaultDatabase, clusterUri } from '../azure/kusto-client';
import { getIndex, searchConfigGate } from '../azure/search-index-client';
import { AGENT_CONFIG_COPILOT } from '../azure/copilot-personas';
import { mergeSuggestionIntoSources } from '../editors/_da-config-merge';
import type { DataAgentSource } from '../azure/data-agent-client';

export { NoAoaiDeploymentError };
export { mergeSuggestionIntoSources, mergeInstructions, descriptionsToBlock } from '../editors/_da-config-merge';

const SCHEMA_CHAR_CAP = 8_000;

export interface SchemaResult {
  /** Compact text block of the real schema, sent to AOAI as grounding. */
  schemaText: string;
  /** Honest gate when the backend is unreachable / unconfigured / schema-less. */
  gate?: string;
}

export interface AgentConfigSuggestion {
  examples: { question: string; query: string }[];
  /** table → column → one-sentence description. */
  descriptions: Record<string, Record<string, string>>;
  /** The schema text the model was grounded on (for the receipt). */
  schemaUsed: string;
  /** Set when the model declined (empty/unavailable schema). */
  gate?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parse a comma-separated `tables` selection into a clean string[] (or null for "all"). */
function selectedTables(src: DataAgentSource): string[] | null {
  const raw = (src.tables || '').trim();
  if (!raw) return null;
  const t = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return t.length ? t : null;
}

function cap(text: string): string {
  return text.length > SCHEMA_CHAR_CAP ? text.slice(0, SCHEMA_CHAR_CAP) + '\n… (schema truncated)' : text;
}

// ── schema fetch (real backends) ─────────────────────────────────────────────

/**
 * Fetch the REAL schema for one source from its Azure-native backend.
 * Returns a compact text block for AOAI grounding, or an honest `gate`.
 * Never throws for an unreachable backend — the gate carries the reason.
 */
export async function fetchSourceSchema(src: DataAgentSource): Promise<SchemaResult> {
  const sel = selectedTables(src);
  try {
    switch (src.type) {
      case 'warehouse':
        return await sqlSchema(dedicatedTarget(), sel, 'warehouse (Synapse dedicated SQL pool)');
      case 'lakehouse': {
        const db = src.name && /^[A-Za-z0-9_]+$/.test(src.name) ? src.name : 'master';
        return await sqlSchema(serverlessTarget(db), sel, `lakehouse (Synapse serverless over ${db})`);
      }
      case 'kql':
        return await kqlSchema(src, sel);
      case 'ai-search':
        return await searchSchema(src);
      case 'semantic-model':
        return {
          schemaText: '',
          gate:
            'Semantic-model (DAX) schema is managed in Power BI "Prep for AI" Verified Answers — this copilot ' +
            'generates examples for warehouse, lakehouse, KQL, and AI Search sources.',
        };
      case 'ontology':
      case 'graph':
        return {
          schemaText: '',
          gate: 'Ontology / graph sources are queried whole — no column schema is available for example-query generation.',
        };
      default:
        return { schemaText: '', gate: `Schema introspection for source type "${src.type}" is not wired.` };
    }
  } catch (e: any) {
    return { schemaText: '', gate: `Could not read schema from ${src.name || src.type}: ${e?.message || String(e)}` };
  }
}

async function sqlSchema(
  target: ReturnType<typeof dedicatedTarget>,
  sel: string[] | null,
  label: string,
): Promise<SchemaResult> {
  // INFORMATION_SCHEMA.COLUMNS is read-only metadata — works on both dedicated
  // and serverless SQL. Filter to the selected tables when the author scoped them.
  const where = sel
    ? `WHERE TABLE_NAME IN (${sel.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')})`
    : '';
  const sql =
    'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH ' +
    `FROM INFORMATION_SCHEMA.COLUMNS ${where} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
  const res = await synapseExecute(target, sql);
  if (!res.rowCount) {
    return { schemaText: '', gate: `No tables/columns found in ${label}${sel ? ' for the selected tables' : ''}.` };
  }
  // Group rows into table → columns text.
  const byTable = new Map<string, string[]>();
  for (const row of res.rows) {
    const [schema, table, col, type, len] = row as [string, string, string, string, number | null];
    const key = schema && schema !== 'dbo' ? `${schema}.${table}` : table;
    const typeText = len != null && len > 0 ? `${type}(${len})` : type;
    if (!byTable.has(key)) byTable.set(key, []);
    byTable.get(key)!.push(`${col} ${typeText}`);
  }
  const lines: string[] = [`Source: ${label}`];
  for (const [table, cols] of byTable) lines.push(`Table ${table}: ${cols.join(', ')}`);
  return { schemaText: cap(lines.join('\n')) };
}

async function kqlSchema(src: DataAgentSource, sel: string[] | null): Promise<SchemaResult> {
  const gate = kustoConfigGate();
  if (gate) return { schemaText: '', gate: `ADX not configured: set ${gate.missing}. Cluster: ${clusterUri()}.` };
  const db = src.name && /^[A-Za-z0-9_-]+$/.test(src.name) ? src.name : defaultDatabase();
  const details = await listTableDetails(db);
  const wanted = sel ? details.filter((t) => sel.includes(t.name)) : details;
  if (!wanted.length) return { schemaText: '', gate: `No tables found in ADX database "${db}"${sel ? ' matching the selection' : ''}.` };
  const lines: string[] = [`Source: ADX database "${db}" (KQL)`];
  // Pull column schema per table (cap to the first 20 tables to bound the call).
  for (const t of wanted.slice(0, 20)) {
    try {
      const sch: any = await getTableSchema(db, t.name);
      const cols: any[] = Array.isArray(sch?.OrderedColumns) ? sch.OrderedColumns : Array.isArray(sch?.Columns) ? sch.Columns : [];
      const colText = cols.map((c) => `${c.Name || c.name} ${c.Type || c.CslType || c.type || ''}`.trim()).join(', ');
      lines.push(`Table ${t.name}: ${colText || '(columns unavailable)'}`);
    } catch {
      lines.push(`Table ${t.name}: (columns unavailable)`);
    }
  }
  return { schemaText: cap(lines.join('\n')) };
}

async function searchSchema(src: DataAgentSource): Promise<SchemaResult> {
  const gate = searchConfigGate();
  if (gate) return { schemaText: '', gate: `AI Search not configured: set ${gate.missing}.` };
  const index = src.name || (src.tables ? src.tables.split(',')[0].trim() : '');
  if (!index) return { schemaText: '', gate: 'No AI Search index name on this source.' };
  const def: any = await getIndex(index);
  if (!def) return { schemaText: '', gate: `AI Search index "${index}" not found.` };
  const fields: any[] = Array.isArray(def.fields) ? def.fields : [];
  if (!fields.length) return { schemaText: '', gate: `AI Search index "${index}" has no fields.` };
  const lines = [`Source: AI Search index "${index}" (search query string)`];
  lines.push(
    `Fields: ${fields
      .map((f) => `${f.name} ${f.type}${f.searchable ? ' [searchable]' : ''}${f.filterable ? ' [filterable]' : ''}`)
      .join(', ')}`,
  );
  return { schemaText: cap(lines.join('\n')) };
}

// ── structured object listing (real backends) — powers the Tree source picker ─

export interface SourceObject {
  /** Owning schema (SQL only). */
  schema?: string;
  /** Bare object name — persisted verbatim into `src.tables` (matches the
   *  comma-separated selection filter `selectedTables` reads back). */
  name: string;
  kind: 'table' | 'view' | 'function' | 'field';
}

export interface SourceObjectsResult {
  objects: SourceObject[];
  /** Honest gate when the backend is unreachable / unconfigured / schema-less. */
  gate?: string;
}

/**
 * List the REAL selectable schema objects (tables / views / functions / AI
 * Search index fields) for one source from its Azure-native backend — the
 * structured counterpart of `fetchSourceSchema`, powering the data-agent typed
 * Tree source picker (replaces the freeform comma-separated table Input).
 * Never throws for an unreachable backend — the `gate` carries the reason.
 */
export async function listSourceObjects(src: DataAgentSource): Promise<SourceObjectsResult> {
  try {
    switch (src.type) {
      case 'warehouse':
        return await sqlObjects(dedicatedTarget(), 'warehouse (Synapse dedicated SQL pool)');
      case 'lakehouse': {
        const db = src.name && /^[A-Za-z0-9_]+$/.test(src.name) ? src.name : 'master';
        return await sqlObjects(serverlessTarget(db), `lakehouse (Synapse serverless over ${db})`);
      }
      case 'kql':
        return await kqlObjects(src);
      case 'ai-search':
        return await searchObjects(src);
      case 'semantic-model':
        return {
          objects: [],
          gate: 'Semantic models are scoped in Power BI "Prep for AI" Verified Answers — there is no table selection here.',
        };
      case 'ontology':
      case 'graph':
        return { objects: [], gate: `${src.type === 'graph' ? 'Graphs' : 'Ontologies'} are queried whole — no table scoping.` };
      default:
        return { objects: [], gate: `Schema introspection for source type "${src.type}" is not wired.` };
    }
  } catch (e: any) {
    return { objects: [], gate: `Could not read schema from ${src.name || src.type}: ${e?.message || String(e)}` };
  }
}

async function sqlObjects(target: ReturnType<typeof dedicatedTarget>, label: string): Promise<SourceObjectsResult> {
  // INFORMATION_SCHEMA.TABLES gives real tables + views (TABLE_TYPE); ROUTINES
  // gives scalar/table functions. Both are read-only metadata on dedicated AND
  // serverless SQL. No Fabric.
  const res = await synapseExecute(
    target,
    'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME',
  );
  const objects: SourceObject[] = [];
  for (const row of res.rows) {
    const [schema, name, type] = row as [string, string, string];
    if (!name) continue;
    objects.push({ schema: schema || undefined, name, kind: /view/i.test(String(type)) ? 'view' : 'table' });
  }
  // Functions are best-effort — a serverless endpoint may not expose ROUTINES.
  try {
    const fres = await synapseExecute(
      target,
      "SELECT ROUTINE_SCHEMA, ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME",
    );
    for (const row of fres.rows) {
      const [schema, name] = row as [string, string];
      if (name) objects.push({ schema: schema || undefined, name, kind: 'function' });
    }
  } catch { /* functions optional */ }
  if (!objects.length) return { objects: [], gate: `No tables / views / functions found in ${label}.` };
  return { objects };
}

async function kqlObjects(src: DataAgentSource): Promise<SourceObjectsResult> {
  const gate = kustoConfigGate();
  if (gate) return { objects: [], gate: `ADX not configured: set ${gate.missing}. Cluster: ${clusterUri()}.` };
  const db = src.name && /^[A-Za-z0-9_-]+$/.test(src.name) ? src.name : defaultDatabase();
  const tables = await listTables(db); // real `.show tables`
  const objects: SourceObject[] = tables.map((t) => ({ name: t.name, kind: 'table' as const })).filter((o) => o.name);
  try {
    const fns = await listFunctions(db); // real `.show functions`
    for (const f of fns) if (f.name) objects.push({ name: f.name, kind: 'function' });
  } catch { /* functions optional */ }
  if (!objects.length) return { objects: [], gate: `No tables / functions found in ADX database "${db}".` };
  return { objects };
}

async function searchObjects(src: DataAgentSource): Promise<SourceObjectsResult> {
  const gate = searchConfigGate();
  if (gate) return { objects: [], gate: `AI Search not configured: set ${gate.missing}.` };
  const index = src.name || (src.tables ? src.tables.split(',')[0].trim() : '');
  if (!index) return { objects: [], gate: 'No AI Search index name on this source.' };
  const def: any = await getIndex(index); // real getIndex
  if (!def) return { objects: [], gate: `AI Search index "${index}" not found.` };
  const fields: any[] = Array.isArray(def.fields) ? def.fields : [];
  if (!fields.length) return { objects: [], gate: `AI Search index "${index}" has no fields.` };
  return { objects: fields.map((f) => ({ name: String(f.name), kind: 'field' as const })).filter((o) => o.name) };
}

// ── AOAI generation ──────────────────────────────────────────────────────────

/** Build the grounding user message for a source + its real schema text. */
export function buildUserMessage(src: DataAgentSource, schemaText: string): string {
  const sel = selectedTables(src);
  return [
    '## Source',
    `type: ${src.type}`,
    `name: ${src.name}`,
    sel ? `selected tables: ${sel.join(', ')}` : 'selected tables: (all)',
    '',
    '## Schema',
    schemaText.trim() || '(no schema available)',
  ].join('\n');
}

/**
 * Parse the model's trailing ```json fence into an AgentConfigSuggestion.
 * Tolerant: a non-JSON / malformed response yields a `gate` instead of throwing,
 * so the BFF can surface an honest message rather than a 500.
 */
export function parseSuggestion(content: string, schemaText: string): AgentConfigSuggestion {
  const empty: AgentConfigSuggestion = { examples: [], descriptions: {}, schemaUsed: schemaText };
  const blocks = [...content.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  const last = blocks[blocks.length - 1];
  const jsonText = last ? last[1].trim() : content.trim();
  let obj: any;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return { ...empty, gate: 'The config copilot did not return a parseable suggestion. Try again.' };
  }
  if (obj && typeof obj.gate === 'string' && obj.gate) {
    return { ...empty, gate: obj.gate };
  }
  const examples = Array.isArray(obj?.examples)
    ? obj.examples
        .map((e: any) => ({ question: String(e?.question ?? '').trim(), query: String(e?.query ?? '').trim() }))
        .filter((e: { question: string; query: string }) => e.question && e.query)
    : [];
  const descriptions: Record<string, Record<string, string>> = {};
  if (obj?.descriptions && typeof obj.descriptions === 'object') {
    for (const [table, cols] of Object.entries(obj.descriptions)) {
      if (cols && typeof cols === 'object') {
        const m: Record<string, string> = {};
        for (const [col, desc] of Object.entries(cols as Record<string, unknown>)) {
          const d = String(desc ?? '').trim();
          if (d) m[col] = d;
        }
        if (Object.keys(m).length) descriptions[table] = m;
      }
    }
  }
  if (!examples.length && !Object.keys(descriptions).length) {
    return { ...empty, gate: 'The config copilot returned no usable examples or descriptions for this source.' };
  }
  return { examples, descriptions, schemaUsed: schemaText };
}

/**
 * Ask the live AOAI deployment to generate examples + descriptions grounded on
 * `schemaText`. Throws NoAoaiDeploymentError when no model is deployed (the BFF
 * turns that into a 503 + Foundry-hub remediation).
 */
export async function generateSuggestions(src: DataAgentSource, schemaText: string): Promise<AgentConfigSuggestion> {
  const content = await aoaiChat({
    messages: [
      { role: 'system', content: AGENT_CONFIG_COPILOT.systemPrompt },
      { role: 'user', content: buildUserMessage(src, schemaText) },
    ],
    maxCompletionTokens: 1500,
    temperature: 0.2,
  });
  return parseSuggestion(content, schemaText);
}

// ── apply / merge (pure helpers re-exported from _da-config-merge) ───────────

/**
 * Persist the approved suggestion to the real agent config doc in Cosmos.
 * Loads the owned item, merges, and writes back via updateOwnedItem.
 */
export async function applyToSource(
  id: string,
  itemType: string,
  tenantId: string,
  sourceId: string,
  approved: Partial<AgentConfigSuggestion>,
  currentState: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const { updateOwnedItem } = await import('@/app/api/items/_lib/item-crud');
  const sources = Array.isArray(currentState.sources) ? (currentState.sources as Record<string, unknown>[]) : [];
  const merged = mergeSuggestionIntoSources(sources, sourceId, approved);
  const nextState = { ...currentState, sources: merged };
  const updated = await updateOwnedItem(id, itemType, tenantId, { state: nextState });
  return { ok: !!updated };
}
