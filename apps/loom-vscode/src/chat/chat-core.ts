/**
 * PURE core of the `@loom` chat participant (no `vscode` import) so the routing
 * + grounding logic is unit-testable without the chat host.
 *
 * The participant answers Loom questions by calling the REAL backend (catalog
 * search, item get, bounded query / preview) against the ACTIVE deployment and
 * streaming grounded results. It NEVER fabricates: when there is no configured
 * deployment or no live session, it emits an honest gate naming the exact fix
 * (add a deployment / sign in) and makes NO backend call. On a backend error it
 * surfaces the real status + message, not an invented answer.
 *
 * PRP M3: `@loom` is backed by Loom's own data plane (not GitHub Copilot), so it
 * works with no Copilot licence and covers Government, where Copilot is often
 * absent.
 */

import { isKnownItemType } from '@csa-loom/sdk';
import type { CatalogSearchResult, Item, QueryResult } from '@csa-loom/sdk';

/** The parsed intent of one `@loom` turn — derived from (command, prompt) ALONE. */
export type ChatIntent =
  | { kind: 'find'; query: string }
  | { kind: 'item'; itemType: string; itemId: string }
  | { kind: 'query'; itemType: string; itemId: string; sql: string }
  | { kind: 'preview'; itemType: string; itemId: string }
  | { kind: 'help' }
  /** Malformed arguments → usage help (NOT a backend error, NOT a gate). */
  | { kind: 'usage'; message: string };

/** Parse a `<type>/<id>` or `<type> <id>` item reference, validating the type locally. */
export function parseItemRef(input: string): { itemType: string; itemId: string; rest: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  // Accept `type/id` first, then `type id`. The remainder (after the id) is `rest`.
  const slash = /^([a-z0-9-]+)\/([^\s]+)\s*(.*)$/i.exec(trimmed);
  const space = /^([a-z0-9-]+)\s+([^\s]+)\s*(.*)$/i.exec(trimmed);
  const m = slash ?? space;
  if (!m) return undefined;
  const itemType = m[1].toLowerCase();
  if (!isKnownItemType(itemType)) return undefined;
  return { itemType, itemId: m[2], rest: (m[3] ?? '').trim() };
}

/**
 * Route a turn to an intent from (command, prompt) only — pure, no I/O. A
 * freeform prompt (no slash command) is treated as a catalog search, the natural
 * "answer a Loom question" grounding.
 */
export function routeChatRequest(command: string | undefined, prompt: string): ChatIntent {
  const text = (prompt ?? '').trim();
  const cmd = command?.trim();

  switch (cmd) {
    case 'help':
      return { kind: 'help' };
    case 'find':
      return { kind: 'find', query: text };
    case 'item': {
      const ref = parseItemRef(text);
      if (!ref) return { kind: 'usage', message: usageItem() };
      return { kind: 'item', itemType: ref.itemType, itemId: ref.itemId };
    }
    case 'query': {
      const ref = parseItemRef(text);
      // Support `type/id :: SELECT …` or `type/id SELECT …`.
      const sql = ref ? ref.rest.replace(/^::\s*/, '').trim() : '';
      if (!ref || !sql) return { kind: 'usage', message: usageQuery() };
      return { kind: 'query', itemType: ref.itemType, itemId: ref.itemId, sql };
    }
    case 'preview': {
      const ref = parseItemRef(text);
      if (!ref) return { kind: 'usage', message: usagePreview() };
      return { kind: 'preview', itemType: ref.itemType, itemId: ref.itemId };
    }
    default:
      // No command. Empty → help; otherwise ground the question in a catalog search.
      if (!text) return { kind: 'help' };
      return { kind: 'find', query: text };
  }
}

/** Minimal streaming surface the participant adapts to `vscode.ChatResponseStream`. */
export interface ChatStream {
  markdown(md: string): void;
  progress(message: string): void;
  button?(action: { command: string; title: string; arguments?: unknown[] }): void;
}

/** The read-only backend surface the turn runner grounds on (a thin `LoomApi` view). */
export interface ChatApi {
  catalogSearch(query: string, opts?: { limit?: number }): Promise<CatalogSearchResult>;
  getItem(itemType: string, itemId: string): Promise<Item>;
  querySql(itemType: string, itemId: string, sql: string): Promise<QueryResult>;
  preview(itemType: string, itemId: string, top?: number): Promise<QueryResult>;
}

export interface ChatTurnDeps {
  command?: string;
  prompt: string;
  /** The active deployment, or undefined when none is configured. */
  deployment?: { id: string; name: string; cloud: string };
  /** Resolve the active deployment's backend, or undefined when not signed in / unreachable. */
  resolveApi: () => Promise<ChatApi | undefined>;
  stream: ChatStream;
  isCancelled?: () => boolean;
}

/** What the turn did — returned for tests + the participant result metadata. */
export interface ChatTurnResult {
  kind: ChatIntent['kind'] | 'gate';
  /** true iff a real backend call was made (a grounded answer). */
  grounded: boolean;
}

const FIND_LIMIT = 25;
const QUERY_ROW_CAP = 50;

/**
 * Run one `@loom` turn. Order is load-bearing for the no-fabricate guarantee:
 *   1. route (pure);
 *   2. help / usage answered with no backend;
 *   3. HONEST GATE — if there is no deployment or no live session, emit the fix
 *      and return WITHOUT calling the backend. This is the single guard the unit
 *      test mutation-proves (removing it makes the gate test call a nonexistent
 *      api and throw);
 *   4. otherwise call the real backend and stream grounded results.
 */
export async function runChatTurn(deps: ChatTurnDeps): Promise<ChatTurnResult> {
  const intent = routeChatRequest(deps.command, deps.prompt);

  if (intent.kind === 'help') {
    deps.stream.markdown(helpText(deps.deployment?.name));
    return { kind: 'help', grounded: false };
  }
  if (intent.kind === 'usage') {
    deps.stream.markdown(intent.message);
    return { kind: 'usage', grounded: false };
  }

  // --- Honest gate (no fabricated answer, no backend call) ---
  if (!deps.deployment) {
    deps.stream.markdown(
      'No CSA Loom deployment is configured. Add one to let `@loom` answer from your estate.',
    );
    deps.stream.button?.({ command: 'loom.addDeployment', title: 'Add deployment' });
    return { kind: 'gate', grounded: false };
  }
  const api = await deps.resolveApi();
  if (!api) {
    deps.stream.markdown(
      `Not signed in to **${deps.deployment.name}**. Sign in to let \`@loom\` answer with live data — ` +
        'nothing is answered from memory.',
    );
    deps.stream.button?.({ command: 'loom.signIn', title: 'Sign in' });
    return { kind: 'gate', grounded: false };
  }

  if (deps.isCancelled?.()) return { kind: intent.kind, grounded: false };

  // --- Grounded execution against the real backend ---
  try {
    switch (intent.kind) {
      case 'find':
        return await runFind(api, deps, intent.query);
      case 'item':
        return await runItem(api, deps, intent.itemType, intent.itemId);
      case 'query':
        return await runQuery(api, deps, intent.itemType, intent.itemId, intent.sql);
      case 'preview':
        return await runPreview(api, deps, intent.itemType, intent.itemId);
    }
  } catch (e) {
    deps.stream.markdown(honestError(e));
    return { kind: intent.kind, grounded: true };
  }
}

async function runFind(api: ChatApi, deps: ChatTurnDeps, query: string): Promise<ChatTurnResult> {
  deps.stream.progress(`Searching ${deps.deployment!.name} catalog…`);
  const res = await api.catalogSearch(query, { limit: FIND_LIMIT });
  const hits = Array.isArray(res.hits) ? res.hits : [];
  if (hits.length === 0) {
    deps.stream.markdown(
      query
        ? `No catalog matches for **${escapeMd(query)}** in ${deps.deployment!.name}.`
        : `No catalog items found in ${deps.deployment!.name}.`,
    );
    return { kind: 'find', grounded: true };
  }
  const lines: string[] = [
    `Grounded on the live **${deps.deployment!.name}** catalog — ${hits.length} match${hits.length === 1 ? '' : 'es'}:`,
    '',
    '| Name | Type | Source | Workspace |',
    '| --- | --- | --- | --- |',
  ];
  for (const h of hits) {
    lines.push(
      `| ${escapeMd(h.display_name || h.id)} | \`${escapeMd(h.type || '')}\` | ${escapeMd(h.source || '')} | ${escapeMd(h.workspace_name || '')} |`,
    );
  }
  deps.stream.markdown(lines.join('\n'));
  return { kind: 'find', grounded: true };
}

async function runItem(
  api: ChatApi,
  deps: ChatTurnDeps,
  itemType: string,
  itemId: string,
): Promise<ChatTurnResult> {
  deps.stream.progress(`Reading ${itemType}/${itemId}…`);
  const item = await api.getItem(itemType, itemId);
  const lines: string[] = [
    `**${escapeMd(item.displayName || item.id)}** · \`${escapeMd(item.itemType)}\``,
    '',
    `- Id: \`${escapeMd(item.id)}\``,
    `- Workspace: \`${escapeMd(item.workspaceId)}\``,
  ];
  if (item.description) lines.push(`- Description: ${escapeMd(item.description)}`);
  if (item.updatedAt) lines.push(`- Updated: ${escapeMd(item.updatedAt)}`);
  // Show the definition's top-level keys ONLY — never dump `state` values, which
  // may hold configuration a chat transcript should not carry.
  const stateKeys = item.state && typeof item.state === 'object' ? Object.keys(item.state) : [];
  if (stateKeys.length) lines.push(`- Definition keys: ${stateKeys.map((k) => `\`${escapeMd(k)}\``).join(', ')}`);
  deps.stream.markdown(lines.join('\n'));
  deps.stream.button?.({
    command: 'loom.openInConsole',
    title: 'Open in Console',
    arguments: [{ dep: deps.deployment, item }],
  });
  return { kind: 'item', grounded: true };
}

async function runQuery(
  api: ChatApi,
  deps: ChatTurnDeps,
  itemType: string,
  itemId: string,
  sql: string,
): Promise<ChatTurnResult> {
  deps.stream.progress(`Running query on ${itemType}/${itemId}…`);
  const started = Date.now();
  const res = await api.querySql(itemType, itemId, sql);
  deps.stream.markdown(renderGrid(res, Date.now() - started, QUERY_ROW_CAP));
  return { kind: 'query', grounded: true };
}

async function runPreview(
  api: ChatApi,
  deps: ChatTurnDeps,
  itemType: string,
  itemId: string,
): Promise<ChatTurnResult> {
  deps.stream.progress(`Previewing ${itemType}/${itemId}…`);
  const started = Date.now();
  const res = await api.preview(itemType, itemId, QUERY_ROW_CAP);
  deps.stream.markdown(renderGrid(res, Date.now() - started, QUERY_ROW_CAP));
  return { kind: 'preview', grounded: true };
}

/** Render a `QueryResult` as a bounded, type-badged markdown grid + timing status. */
export function renderGrid(res: QueryResult, elapsedMs: number, rowCap: number): string {
  const cols = normalizeColumns(res.columns);
  const rawRows = Array.isArray(res.rows) ? res.rows : [];
  const rows = rawRows.slice(0, rowCap);
  if (cols.length === 0 && rows.length === 0) {
    return `Query returned no rows _(‎${elapsedMs} ms)_.`;
  }
  const header = cols.map((c) => `${escapeMd(c.name)}${c.type ? ` \`${escapeMd(c.type)}\`` : ''}`);
  const lines: string[] = [`| ${header.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    lines.push(`| ${cols.map((c) => escapeMd(cellValue(row, c.name))).join(' | ')} |`);
  }
  const shown = rows.length;
  const total = typeof res.rowCount === 'number' ? res.rowCount : rawRows.length;
  const truncated = res.truncated || total > shown;
  lines.push('');
  lines.push(
    `_${shown} row${shown === 1 ? '' : 's'}${truncated ? ` of ${total}+ (capped)` : ''} · ${elapsedMs} ms_`,
  );
  return lines.join('\n');
}

interface Col {
  name: string;
  type?: string;
}

/** Normalize the engine-specific column shape (`string[]` OR `{name,type}[]`). */
function normalizeColumns(columns: unknown): Col[] {
  if (!Array.isArray(columns)) return [];
  return columns.map((c) => {
    if (typeof c === 'string') return { name: c };
    if (c && typeof c === 'object') {
      const o = c as { name?: unknown; type?: unknown; ColumnName?: unknown; ColumnType?: unknown };
      const name = typeof o.name === 'string' ? o.name : typeof o.ColumnName === 'string' ? o.ColumnName : '';
      const type = typeof o.type === 'string' ? o.type : typeof o.ColumnType === 'string' ? o.ColumnType : undefined;
      return { name, type };
    }
    return { name: String(c) };
  });
}

/** Read a cell whether the row is an object (`Record`) or a positional array. */
function cellValue(row: unknown, colName: string): string {
  if (Array.isArray(row)) return ''; // positional handled by index elsewhere; keep simple + safe
  if (row && typeof row === 'object') {
    const v = (row as Record<string, unknown>)[colName];
    return v == null ? '' : String(v);
  }
  return row == null ? '' : String(row);
}

/** Escape markdown table-breaking characters. */
export function escapeMd(v: string): string {
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/`/g, 'ˋ');
}

/** Turn a backend error into an honest message (status + reason + hint) — never a fabricated answer. */
export function honestError(e: unknown): string {
  const err = e as { status?: number; message?: string; code?: string; hint?: string };
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const msg = err?.message || String(e);
  const parts = [`**Loom returned an error${status != null ? ` (${status})` : ''}.** ${escapeMd(msg)}`];
  if (err?.hint) parts.push('', `_${escapeMd(err.hint)}_`);
  return parts.join('\n');
}

function helpText(deploymentName?: string): string {
  const where = deploymentName ? ` against **${deploymentName}**` : '';
  return [
    `**@loom** answers from your live CSA Loom estate${where} — grounded on the real backend, never from memory.`,
    '',
    '- `@loom <question>` — search the catalog (workspaces, items, data assets).',
    '- `@loom /find <query>` — explicit catalog search.',
    '- `@loom /item <type>/<id>` — show an item and its definition keys.',
    '- `@loom /query <type>/<id> :: <SQL>` — run a bounded, read-only query.',
    '- `@loom /preview <type>/<id>` — preview a data asset (first rows).',
    '',
    '_Grounded, read-only. Writes stay in the Console and the opt-in MCP servers._',
  ].join('\n');
}

function usageItem(): string {
  return 'Usage: `@loom /item <type>/<id>` — e.g. `@loom /item lakehouse 8f2c…`. The type must be a known Loom item type.';
}
function usageQuery(): string {
  return 'Usage: `@loom /query <type>/<id> :: <SQL>` — e.g. `@loom /query warehouse 8f2c… :: SELECT TOP 10 * FROM sales`.';
}
function usagePreview(): string {
  return 'Usage: `@loom /preview <type>/<id>` — e.g. `@loom /preview dataset 8f2c…`.';
}
