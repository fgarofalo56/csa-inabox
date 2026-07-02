/**
 * POST /api/items/slate-app/[id]/query/run
 *
 * The Slate-app query engine. Runs ONE named (or ad-hoc) query and returns a
 * uniform tabular result so the in-editor Preview (Run mode) and the Queries
 * panel can bind live widgets to real data. Mirrors Palantir Slate's Queries
 * panel datasource types, mapped 1:1 to Azure-native backends (no Microsoft
 * Fabric on the default path, per .claude/rules/no-fabric-dependency.md):
 *
 *   type 'kql'      → Azure Data Explorer (ADX) via kusto-client
 *   type 'sql'      → Synapse serverless SQL via synapse-sql-client
 *   type 'rest-dab' → Data API Builder / APIM REST (HTTP-JSON, JSONPath-lite
 *                     extractor) — server-side fetch forwarding the caller's
 *                     session cookie so a same-origin /api DAB call authenticates
 *
 * Body:
 *   { queryId?: string, query?: SlateQuerySpec, parameters?: [{name,value}] }
 * Either resolve a saved query from state.queries[] by `queryId`, or run an
 * ad-hoc `query` object (so the editor can Run/Preview before saving).
 *
 * Success → { ok:true, type, columns:string[], rows:unknown[][], rowCount,
 *             executionMs, mode? }
 * Failure → { ok:false, error, code?, gate?:{reason,remediation} }  (honest
 *           infra gate when ADX / Synapse env is unset — never a mock array).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../../_lib/item-crud';
import {
  executeQuery as kustoQuery, executeMgmtCommand as kustoMgmt,
  kustoConfigGate, defaultDatabase, KustoError,
} from '@/lib/azure/kusto-client';
import {
  serverlessTarget, serverlessEndpoint, executeQuery as synapseQuery,
  type SynapseQueryParam,
} from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'slate-app';

type SlateQueryType = 'rest-dab' | 'kql' | 'sql';
interface SlateQuerySpec {
  id?: string;
  name?: string;
  type?: SlateQueryType;
  // rest-dab
  path?: string;
  method?: string;
  resultPath?: string;
  // kql
  kql?: string;
  database?: string;
  // sql
  sql?: string;
}

function err(error: string, status: number, code?: string, gate?: { reason: string; remediation: string }) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

/**
 * True when `hostname` is a literal loopback / private / link-local address
 * (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.0.0.0, ::1,
 * fc00::/7, fe80::/10). A server-side rest-dab fetch must never be pointed at
 * these unless the URL is this console itself — otherwise a query becomes an
 * SSRF probe into the private VNet (adversarial-audit finding).
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  // IPv4 literal (including the IPv4-mapped IPv6 form ::ffff:a.b.c.d).
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 unique-local (fc00::/7) + link-local (fe80::/10) literals.
  if (/^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true;
  return false;
}

/** Dig a dot/bracket path (`data.items[0].rows`) out of a parsed JSON body. */
function digPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Normalize a JSON REST payload into the uniform { columns, rows } table shape. */
function shapeJsonRows(payload: unknown, resultPath?: string): { columns: string[]; rows: unknown[][] } {
  let arr: unknown = resultPath ? digPath(payload, resultPath) : payload;
  // DAB returns { value: [...] }; many REST shapes wrap the array.
  if (!Array.isArray(arr) && arr && typeof arr === 'object') {
    const o = arr as Record<string, unknown>;
    if (Array.isArray(o.value)) arr = o.value;
    else if (Array.isArray(o.data)) arr = o.data;
    else if (Array.isArray(o.items)) arr = o.items;
    else if (Array.isArray(o.results)) arr = o.results;
    else arr = [o]; // single object → one-row table
  }
  if (!Array.isArray(arr)) arr = arr == null ? [] : [arr];
  const records = (arr as unknown[]).map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : { value: r }));
  // Column union (ordered: first row's keys, then any extras).
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const rec of records.slice(0, 200)) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) { seen.add(k); columns.push(k); }
    }
  }
  const rows = records.map((rec) => columns.map((c) => {
    const v = rec[c];
    return v != null && typeof v === 'object' ? JSON.stringify(v) : v;
  }));
  return { columns, rows };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the app first (no id yet)', 400, 'no_id');

  const app = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!app) return err('slate-app not found', 404, 'not_found');
  const state = (app.state || {}) as Record<string, unknown>;

  const body = (await req.json().catch(() => ({}))) as { queryId?: string; query?: SlateQuerySpec; parameters?: Array<{ name?: string; value?: unknown }> };

  // Resolve the query: explicit ad-hoc spec, else a saved query by id.
  let q: SlateQuerySpec | undefined = body?.query && typeof body.query === 'object' ? body.query : undefined;
  if (!q && body?.queryId) {
    const saved = (Array.isArray(state.queries) ? state.queries : []) as SlateQuerySpec[];
    q = saved.find((x) => x?.id === body.queryId);
    if (!q) return err(`query "${body.queryId}" not found on this app`, 404, 'query_not_found');
  }
  if (!q) return err('a query (or queryId) is required', 400, 'no_query');

  const type: SlateQueryType = q.type === 'kql' || q.type === 'sql' ? q.type : 'rest-dab';

  // Optional injection-safe named parameters (bound, never concatenated — SQL only).
  const parameters: SynapseQueryParam[] = (Array.isArray(body?.parameters) ? body.parameters : [])
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({ name: String(p!.name), value: p!.value == null ? null : String(p!.value) }));

  // ── KQL → Azure Data Explorer ──────────────────────────────────────────────
  if (type === 'kql') {
    const kql = String(q.kql || '').trim();
    if (!kql) return err('kql is required for a KQL query', 400, 'no_kql');
    if (kql.length > 65_536) return err('kql too large (>64KB)', 413, 'too_large');
    const gate = kustoConfigGate();
    if (gate) {
      return err(
        'Azure Data Explorer (ADX) is not configured for this deployment.',
        503, 'adx_not_configured',
        { reason: 'KQL widgets run against an Azure Data Explorer cluster (the Azure-native Eventhouse equivalent).', remediation: `Set ${gate.missing} on the Console. No Microsoft Fabric required.` },
      );
    }
    const database = String(q.database || '').trim() || defaultDatabase();
    try {
      const started = Date.now();
      const result = kql.startsWith('.') ? await kustoMgmt(database, kql) : await kustoQuery(database, kql);
      return NextResponse.json({
        ok: true, type, mode: kql.startsWith('.') ? 'mgmt' : 'query', database,
        columns: result.columns, rows: result.rows, rowCount: result.rowCount,
        executionMs: result.executionMs ?? (Date.now() - started),
      });
    } catch (e: unknown) {
      const status = e instanceof KustoError ? e.status : 502;
      return err(`KQL query failed: ${e instanceof Error ? e.message : String(e)}`, status, 'kql_failed');
    }
  }

  // ── SQL → Synapse serverless ────────────────────────────────────────────────
  if (type === 'sql') {
    const sqlText = String(q.sql || '').trim();
    if (!sqlText) return err('sql is required for a SQL query', 400, 'no_sql');
    if (sqlText.length > 65_536) return err('sql too large (>64KB)', 413, 'too_large');
    let target;
    try {
      target = serverlessTarget(String(q.database || 'master'));
    } catch (e: unknown) {
      return err(
        'Azure Synapse serverless SQL is not configured for this deployment.',
        503, 'synapse_not_configured',
        { reason: 'SQL widgets run against a Synapse serverless SQL endpoint (the Azure-native warehouse/lakehouse-SQL equivalent).', remediation: 'Set LOOM_SYNAPSE_WORKSPACE on the Console. No Microsoft Fabric required.' },
      );
    }
    try {
      const result = await synapseQuery(target, sqlText, 60_000, parameters);
      return NextResponse.json({
        ok: true, type, endpoint: serverlessEndpoint(), database: String(q.database || 'master'),
        columns: result.columns, rows: result.rows, rowCount: result.rowCount,
        executionMs: result.executionMs, messages: result.messages,
      });
    } catch (e: unknown) {
      return err(`SQL query failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'sql_failed');
    }
  }

  // ── REST / DAB (HTTP-JSON) ──────────────────────────────────────────────────
  // Resolve the target URL: an absolute http(s) path is used verbatim; a relative
  // path is joined onto the app's apiBaseUrl, and a relative apiBaseUrl (e.g.
  // "/api") is resolved against this request's own origin so a same-origin DAB
  // call authenticates via the forwarded session cookie.
  const apiBaseUrl = String(state.apiBaseUrl || '/api');
  const path = String(q.path || '').trim();
  if (!path) return err('a query path is required for a REST query', 400, 'no_path');
  let url: URL;
  try {
    if (/^https?:\/\//i.test(path)) {
      url = new URL(path);
    } else if (/^https?:\/\//i.test(apiBaseUrl)) {
      url = new URL(`${apiBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
    } else {
      const base = `${apiBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
      url = new URL(base.startsWith('/') ? base : `/${base}`, req.nextUrl.origin);
    }
  } catch {
    return err('could not resolve the REST query URL from the API base + path', 400, 'bad_url');
  }

  // ── SSRF / credential-forwarding guard (adversarial-audit finding) ─────────
  // The caller's session cookie + Authorization header are forwarded ONLY when
  // the resolved URL's origin is trusted: this console itself (same-origin /api
  // DAB) or the deployment-configured DAB runtime (LOOM_DAB_PREVIEW_URL / the
  // item's published serviceUrl). Any other absolute host is fetched WITHOUT
  // credentials — a rest-dab query configured with an external URL must never
  // exfiltrate the runner's Loom session cookie. Literal private / link-local
  // hosts are refused outright unless same-origin (no VNet SSRF probing).
  const sameOrigin = url.origin === req.nextUrl.origin;
  const trustedOrigins = new Set<string>([req.nextUrl.origin]);
  for (const base of [process.env.LOOM_DAB_PREVIEW_URL, String(state.serviceUrl || '')]) {
    const v = (base || '').trim();
    if (!v) continue;
    try { trustedOrigins.add(new URL(v).origin); } catch { /* unparseable base — ignore */ }
  }
  const forwardCredentials = trustedOrigins.has(url.origin);
  if (!sameOrigin && isPrivateHost(url.hostname)) {
    return err(
      `REST query target "${url.hostname}" is a private/link-local address and not this console — refusing the request.`,
      400, 'private_host_blocked',
    );
  }

  const method = String(q.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const started = Date.now();
  try {
    const upstream = await fetch(url.toString(), {
      method,
      headers: {
        accept: 'application/json',
        // Forward the caller's session ONLY to trusted origins (this console's
        // own /api DAB or the configured DAB runtime) so a same-origin call
        // authenticates as this user — never to an arbitrary external host.
        ...(forwardCredentials && req.headers.get('cookie') ? { cookie: req.headers.get('cookie') as string } : {}),
        ...(forwardCredentials && req.headers.get('authorization') ? { authorization: req.headers.get('authorization') as string } : {}),
      },
      cache: 'no-store',
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return err(`REST query failed: HTTP ${upstream.status} ${upstream.statusText} — ${text.slice(0, 200)}`, 502, 'rest_failed');
    }
    let payload: unknown;
    try { payload = text ? JSON.parse(text) : []; }
    catch { return err('REST endpoint did not return JSON', 502, 'rest_not_json'); }
    const { columns, rows } = shapeJsonRows(payload, q.resultPath ? String(q.resultPath) : undefined);
    return NextResponse.json({
      ok: true, type, mode: method, url: url.toString(),
      columns, rows, rowCount: rows.length, executionMs: Date.now() - started,
    });
  } catch (e: unknown) {
    return err(`REST query failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'rest_failed');
  }
}
