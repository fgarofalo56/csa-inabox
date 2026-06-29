/**
 * GET /api/items/dataset/[id]/preview?project=&version=&top=
 *
 * Server-side preview + schema profile for a registered Foundry data asset.
 * Resolves the asset (or a named version) to its dataUri, parses the
 * abfss/https ADLS path, samples up to `top` rows via Synapse Serverless
 * OPENROWSET (same engine as /api/lakehouse/preview) and computes a real
 * per-column profile (count / nullCount / distinct / min / max + numeric
 * mean & stddev) from the sampled rows. Profile shape matches DeltaPreviewGrid's
 * ColStat so the dataset editor's profiler card can render without a Spark job.
 *
 * Real backend only: ARM (asset) + Synapse Serverless (OPENROWSET). Honest 503
 * when Serverless is unconfigured; honest 422 when the dataUri is not ADLS;
 * metadata-only ok for non-tabular files. No mock rows.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDataAsset, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { KNOWN_CONTAINERS, pathToHttpsUrl, pathToHttpsUrlFor } from '@/lib/azure/adls-client';
import { executeQuery, serverlessTarget } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TOP = 50;
const MAX_TOP = 1000;
const TABULAR = new Set(['PARQUET', 'CSV', 'JSON', 'DELTA']);

interface ParsedAdls { account: string; container: string; path: string; }

/** abfss://<container>@<account>.dfs.<suffix>/<path> | https://<account>.dfs.<suffix>/<container>/<path>. */
function parseAdlsUri(uri?: string): ParsedAdls | null {
  if (!uri) return null;
  const abfss = uri.match(/^abfss:\/\/([^@/]+)@([^./]+)\.dfs\.[^/]+\/(.*)$/i);
  if (abfss) return { container: abfss[1], account: abfss[2], path: abfss[3] };
  const https = uri.match(/^https:\/\/([^./]+)\.dfs\.[^/]+\/([^/]+)\/(.*)$/i);
  if (https) return { account: https[1], container: https[2], path: https[3] };
  return null;
}

function detectFormat(path: string): string {
  if (path.includes('/_delta_log/') || path.endsWith('/_delta_log') || path.endsWith('/')) return 'DELTA';
  const ext = path.toLowerCase().split('.').pop() || '';
  if (ext === 'parquet') return 'PARQUET';
  if (ext === 'csv' || ext === 'tsv') return 'CSV';
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'JSON';
  return ''; // unknown extension → assume a Delta table directory
}

function normalizeBulk(path: string, fmt: string): string {
  if (fmt !== 'DELTA') return path;
  const i = path.indexOf('/_delta_log');
  return i >= 0 ? path.substring(0, i) : path;
}

function parseTop(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP;
  return Math.min(n, MAX_TOP);
}

/** Per-column profile over the sampled rows — ColStat-shaped for DeltaPreviewGrid. */
function profileRows(columns: string[], rows: unknown[][]) {
  const out: Record<string, { count: number; nullCount: number; distinct: number; min: string | null; max: string | null; mean: number | null; stddev: number | null }> = {};
  columns.forEach((col, c) => {
    let nulls = 0; const seen = new Set<string>(); const nums: number[] = [];
    let lo: string | null = null, hi: string | null = null;
    for (const r of rows) {
      const v = r[c];
      if (v === null || v === undefined || v === '') { nulls++; continue; }
      const s = v instanceof Date ? v.toISOString() : String(v);
      seen.add(s);
      if (lo === null || s < lo) lo = s;
      if (hi === null || s > hi) hi = s;
      const n = typeof v === 'number' ? v : Number(s);
      if (Number.isFinite(n)) nums.push(n);
    }
    const count = rows.length - nulls;
    let mean: number | null = null, stddev: number | null = null;
    if (nums.length && nums.length === count) {
      mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((a, b) => a + (b - mean!) ** 2, 0) / nums.length;
      stddev = Math.sqrt(variance);
    }
    out[col] = { count, nullCount: nulls, distinct: seen.size, min: lo, max: hi, mean, stddev };
  });
  return out;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const project = req.nextUrl.searchParams.get('project') || undefined;
  const version = req.nextUrl.searchParams.get('version') || undefined;
  const top = parseTop(req.nextUrl.searchParams.get('top'));

  // 1) Resolve the asset → dataUri (specific version, else latest/container).
  let dataUri: string | undefined;
  let resolvedVersion: string | undefined;
  try {
    const { container, versions } = await getDataAsset(id, project);
    if (!container) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const picked = version ? versions.find((v: any) => String(v.version) === version) : undefined;
    dataUri = picked?.dataUri || container.dataUri || versions[0]?.dataUri;
    resolvedVersion = picked?.version || container.latestVersion || versions[0]?.version;
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }

  // 2) Parse the dataUri — non-ADLS (azureml://, datastore) is an honest gate.
  const parsed = parseAdlsUri(dataUri);
  if (!parsed) {
    return NextResponse.json({ ok: false, previewable: false, version: resolvedVersion, dataUri, error: `dataUri is not an ADLS path (${dataUri || 'unset'}); preview supports abfss:// / https:// DLZ paths.` }, { status: 422 });
  }
  if (!/^[a-z0-9]{3,24}$/.test(parsed.account)) {
    return NextResponse.json({ ok: false, error: `invalid storage account: ${parsed.account}` }, { status: 400 });
  }

  // 3) Sample rows via Synapse Serverless OPENROWSET (real data plane).
  const fmt = detectFormat(parsed.path) || 'DELTA';
  if (!TABULAR.has(fmt)) {
    return NextResponse.json({ ok: true, previewable: false, version: resolvedVersion, container: parsed.container, path: parsed.path, format: fmt, message: 'Not a tabular file — use Download to inspect.' });
  }
  const known = (KNOWN_CONTAINERS as readonly string[]).includes(parsed.container);
  const url = known ? pathToHttpsUrl(parsed.container, normalizeBulk(parsed.path, fmt)) : pathToHttpsUrlFor(parsed.account, parsed.container, normalizeBulk(parsed.path, fmt));
  const safeUrl = url.replace(/'/g, "''");
  const sql = fmt === 'CSV'
    ? `SELECT TOP ${top} * FROM OPENROWSET(BULK '${safeUrl}', FORMAT='CSV', PARSER_VERSION='2.0', HEADER_ROW=TRUE) AS r;`
    : `SELECT TOP ${top} * FROM OPENROWSET(BULK '${safeUrl}', FORMAT='${fmt}') AS r;`;

  let target;
  try { target = serverlessTarget('master'); }
  catch { return NextResponse.json({ ok: false, error: 'Synapse Serverless is not configured (set LOOM_SYNAPSE_WORKSPACE) — dataset preview is gated until then.', notDeployed: true }, { status: 503 }); }

  try {
    const result = await executeQuery(target, sql);
    return NextResponse.json({
      ok: true, previewable: true, version: resolvedVersion, container: parsed.container, path: parsed.path,
      account: parsed.account, format: fmt, top, dataUri, bulkUrl: url, sql,
      columns: result.columns, rows: result.rows, rowCount: result.rowCount, executionMs: result.executionMs, truncated: result.truncated,
      profile: profileRows(result.columns, result.rows as unknown[][]),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, format: fmt, bulkUrl: url, sql, error: e?.message || String(e), code: e?.code, sqlNumber: e?.number }, { status: 502 });
  }
}
