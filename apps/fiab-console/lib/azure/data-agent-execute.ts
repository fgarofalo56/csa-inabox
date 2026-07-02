/**
 * data-agent query execution — runs the per-source query the model emits
 * against the REAL Azure-native backend, read-only, so the agent's answer is
 * grounded on actual rows (not just a query it "would" run).
 *
 * Per .claude/rules/no-vaporware.md: real backends (Synapse SQL via TDS, ADX via
 * the Kusto REST), no mocks. Per .claude/rules/no-fabric-dependency.md the
 * targets are Azure-native (Synapse dedicated/serverless SQL, ADX) resolved from
 * the existing clients' env defaults — no Fabric workspace required.
 *
 * Safety: every query is hard-gated to READ-ONLY before execution and capped to
 * a small row sample. A source whose backend isn't reachable/configured returns
 * an honest `gate` string (surfaced to the model + the editor), never a mock.
 */

import { executeQuery as synapseExecute, dedicatedTarget, serverlessTarget } from './synapse-sql-client';
import { executeQuery as kustoExecute, clusterUri, defaultDatabase, kustoConfigGate } from './kusto-client';
import { searchDocuments, searchConfigGate, getIndex, semanticConfigNames } from './search-index-client';
import type { SearchRequest } from './search-field-shapes';
import { isVectorFieldType } from './search-field-shapes';
import { graphGroundingSearch, GraphSearchAccessError, type GraphGroundingScope } from './graph-search-client';
import type { DataAgentSource } from './data-agent-client';

export interface SourceExecution {
  executed: boolean;
  columns?: string[];
  /** A small sample of rows (capped) for grounding + display. */
  rows?: unknown[][];
  rowCount?: number;
  truncated?: boolean;
  /** Honest gate / error when the query could not be run. */
  gate?: string;
  /** Extra grounding instruction appended to the re-prompt (e.g. citation rule). */
  note?: string;
}

const MAX_ROWS = 25;

// ── read-only guards ─────────────────────────────────────────────────────────

const SQL_WRITE = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec(ute)?|sp_|xp_|into\s)\b/i;

function assertReadonlySql(sql: string): void {
  const trimmed = sql.trim().replace(/^;+/, '').trim();
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Only read-only SELECT/WITH queries are executed by the data agent.');
  }
  if (SQL_WRITE.test(trimmed)) {
    throw new Error('Query contains a write/DDL keyword; the data agent only runs read-only queries.');
  }
}

/** Add a TOP n to a bare SELECT when it has no row cap, so we never pull a table. */
function capSql(sql: string): string {
  const t = sql.trim().replace(/;+\s*$/, '');
  if (/\b(top|offset|fetch)\b/i.test(t)) return t;
  return t.replace(/^select\b/i, `SELECT TOP ${MAX_ROWS}`);
}

function assertReadonlyKql(kql: string): void {
  const t = kql.trim();
  if (t.startsWith('.')) {
    throw new Error('ADX management commands (starting with ".") are not executed by the data agent.');
  }
  // Block known mutating operators.
  if (/\b(\.set|\.append|\.set-or-append|\.set-or-replace|\.drop|\.delete|\.alter|ingest\b)/i.test(t)) {
    throw new Error('Query contains a mutating ADX operator; the data agent only runs read-only queries.');
  }
}

function capKql(kql: string): string {
  const t = kql.trim().replace(/;+\s*$/, '');
  if (/\|\s*(take|limit|top)\b/i.test(t)) return t;
  return `${t}\n| take ${MAX_ROWS}`;
}

// ── per-source execution ─────────────────────────────────────────────────────

/**
 * Execute one source's generated query read-only against its Azure-native
 * backend. Returns rows+count, or an honest gate. Never throws for an
 * unreachable backend — the gate carries the reason.
 */
export async function executeSourceQuery(source: DataAgentSource, query: string): Promise<SourceExecution> {
  if (!query || !query.trim()) return { executed: false, gate: 'No query was produced for this source.' };

  try {
    switch (source.type) {
      case 'warehouse': {
        assertReadonlySql(query);
        const res = await synapseExecute(dedicatedTarget(), capSql(query));
        return { executed: true, columns: res.columns, rows: res.rows.slice(0, MAX_ROWS), rowCount: res.rowCount, truncated: res.rowCount > MAX_ROWS };
      }
      case 'lakehouse': {
        // Azure-native lakehouse query path = Synapse serverless SQL over the
        // delta tables. The source name is treated as the serverless database;
        // if the generated query is Spark-SQL-only it may error → honest gate.
        assertReadonlySql(query);
        const db = source.name && /^[A-Za-z0-9_]+$/.test(source.name) ? source.name : 'master';
        const res = await synapseExecute(serverlessTarget(db), capSql(query));
        return { executed: true, columns: res.columns, rows: res.rows.slice(0, MAX_ROWS), rowCount: res.rowCount, truncated: res.rowCount > MAX_ROWS };
      }
      case 'kql': {
        const gate = kustoConfigGate();
        if (gate) {
          return { executed: false, gate: `ADX not configured: set ${gate.missing}. Cluster: ${clusterUri()}.` };
        }
        assertReadonlyKql(query);
        const db = source.name && /^[A-Za-z0-9_-]+$/.test(source.name) ? source.name : defaultDatabase();
        const res = await kustoExecute(db, capKql(query));
        return { executed: true, columns: res.columns, rows: res.rows.slice(0, MAX_ROWS), rowCount: res.rowCount, truncated: res.truncated };
      }
      case 'semantic-model':
        return {
          executed: false,
          gate:
            'Semantic-model (DAX) execution needs an XMLA endpoint (Azure Analysis Services / Power BI XMLA). ' +
            'Not wired in this deployment — the query is shown but not executed. Route metric questions to a ' +
            'warehouse/lakehouse source to ground on real rows.',
        };
      case 'ai-search': {
        const gate = searchConfigGate();
        if (gate) return { executed: false, gate: `AI Search not configured: set ${gate.missing}.` };
        const index = source.name || (source.tables ? source.tables.split(',')[0].trim() : '');
        if (!index) return { executed: false, gate: 'No AI Search index name on this source.' };

        // Honor the typed per-source retrieval options (queryKind / top /
        // citations — see DataAgentAiSearchConfig). Every mode maps 1:1 onto
        // the real data-plane request; a mode the index can't serve returns an
        // honest gate naming the missing index feature, never a silent fallback.
        const cfg = source.aiSearch || {};
        const kind = cfg.queryKind || 'keyword';
        const top = Math.min(Math.max(Math.floor(cfg.top ?? MAX_ROWS) || MAX_ROWS, 1), 50);
        const req: SearchRequest = { search: query, top };

        if (kind === 'semantic' || kind === 'vector' || kind === 'hybrid') {
          // These modes depend on index capabilities — read the real definition.
          const def = await getIndex(index);
          if (!def) return { executed: false, gate: `AI Search index "${index}" was not found on the service.` };
          if (kind === 'semantic') {
            const configs = semanticConfigNames(def);
            if (!configs.length) {
              return { executed: false, gate: `Index "${index}" has no semantic configuration — add one in the AI Search index editor (Semantic ranking tab) to use semantic retrieval, or switch this source to keyword.` };
            }
            req.queryType = 'semantic';
            req.semanticConfiguration = configs[0];
            req.captions = 'extractive';
            req.answers = 'extractive|count-3';
          } else {
            const vectorFields = (Array.isArray(def.fields) ? def.fields : [])
              .filter((f: any) => isVectorFieldType(f?.type || '') && f?.dimensions)
              .map((f: any) => f.name)
              .filter(Boolean);
            if (!vectorFields.length) {
              return { executed: false, gate: `Index "${index}" has no vector fields — add a vector field + vectorizer in the AI Search index editor to use ${kind} retrieval, or switch this source to keyword.` };
            }
            // kind:'text' = integrated vectorization (the service embeds the
            // query with the index's vectorizer). An index without a vectorizer
            // errors on the wire → surfaced as the honest gate in catch below.
            req.vectorQueries = [{ kind: 'text', text: query, fields: vectorFields.join(','), k: top }];
            if (kind === 'vector') { req.pureVector = true; req.search = undefined; }
          }
        }

        const resp = await searchDocuments(index, req);
        const docs: any[] = Array.isArray(resp?.value) ? resp.value : [];
        // Build a stable column set (skip @search.* internals except score +
        // semantic reranker score when present).
        const cols: string[] = [];
        for (const d of docs) for (const k of Object.keys(d)) {
          if (k.startsWith('@search.') && k !== '@search.score' && k !== '@search.rerankerScore') continue;
          if (!cols.includes(k)) cols.push(k);
        }
        const scoreCols = ['@search.score', ...(kind === 'semantic' ? ['@search.rerankerScore'] : [])];
        const ordered = [...scoreCols, ...cols.filter((c) => !scoreCols.includes(c))].slice(0, 8);
        const withCite = !!cfg.citations;
        const columns = withCite ? ['cite', ...ordered] : ordered;
        const rows = docs.map((d, i) => {
          const vals = ordered.map((c) => {
            const v = d[c];
            return typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
          });
          return withCite ? [`[${i + 1}]`, ...vals] : vals;
        });
        return {
          executed: true, columns, rows, rowCount: docs.length, truncated: docs.length >= top,
          ...(withCite ? { note: 'Cite these documents inline as [1], [2], … (matching the cite column) for every claim grounded on them.' } : {}),
        };
      }
      case 'microsoft-graph': {
        const scope = source.graph as GraphGroundingScope | undefined;
        if (!scope?.kind) {
          return { executed: false, gate: 'No Microsoft 365 scope configured on this source — pick SharePoint site / OneDrive drive / Mailbox in the agent Build tab.' };
        }
        if (scope.kind === 'site' && !(scope.site || '').trim()) {
          return { executed: false, gate: 'The SharePoint scope needs a site id or URL — set it on this source in the Build tab.' };
        }
        if (scope.kind === 'drive' && !(scope.driveId || '').trim()) {
          return { executed: false, gate: 'The drive scope needs a Graph drive id — set it on this source in the Build tab.' };
        }
        if (scope.kind === 'mail' && !(scope.mailbox || '').trim()) {
          return { executed: false, gate: 'The mailbox scope needs a user UPN — set it on this source in the Build tab.' };
        }
        try {
          const res = await graphGroundingSearch(scope, query, MAX_ROWS);
          return { executed: true, columns: res.columns, rows: res.rows, rowCount: res.count, truncated: res.count >= MAX_ROWS };
        } catch (e: any) {
          if (e instanceof GraphSearchAccessError) {
            // Honest consent gate — names the exact Graph app role(s) missing.
            return { executed: false, gate: e.message };
          }
          throw e;
        }
      }
      default:
        return {
          executed: false,
          gate: `Live execution for source type "${source.type}" is not wired; the query is shown but not run.`,
        };
    }
  } catch (e: any) {
    return { executed: false, gate: `Query did not run against ${source.name || source.type}: ${e?.message || String(e)}` };
  }
}

/** Compact a SourceExecution's rows into a short text block for re-prompting. */
export function executionToText(source: string, exec: SourceExecution): string {
  if (!exec.executed) return `Source "${source}": NOT executed — ${exec.gate}`;
  const cols = exec.columns?.join(' | ') ?? '';
  const sample = (exec.rows ?? [])
    .slice(0, 10)
    .map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))).join(' | ') : String(r)))
    .join('\n');
  const note = exec.note ? `\n${exec.note}` : '';
  return `Source "${source}" returned ${exec.rowCount} row(s)${exec.truncated ? ' (truncated)' : ''}:\n${cols}\n${sample}${note}`;
}
