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
import { searchDocuments, searchConfigGate } from './search-index-client';
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
        // The model emits a search string; run it read-only and flatten the top docs.
        const resp = await searchDocuments(index, { search: query, top: MAX_ROWS } as any);
        const docs: any[] = Array.isArray(resp?.value) ? resp.value : [];
        // Build a stable column set (skip @search.* internals except score).
        const cols: string[] = [];
        for (const d of docs) for (const k of Object.keys(d)) {
          if (k.startsWith('@search.') && k !== '@search.score') continue;
          if (!cols.includes(k)) cols.push(k);
        }
        const ordered = ['@search.score', ...cols.filter((c) => c !== '@search.score')].slice(0, 8);
        const rows = docs.map((d) => ordered.map((c) => {
          const v = d[c];
          return typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
        }));
        return { executed: true, columns: ordered, rows, rowCount: docs.length, truncated: docs.length >= MAX_ROWS };
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
  return `Source "${source}" returned ${exec.rowCount} row(s)${exec.truncated ? ' (truncated)' : ''}:\n${cols}\n${sample}`;
}
