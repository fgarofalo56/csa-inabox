/**
 * Real-time transform preview for the Data Wrangler AI tab (G4).
 *
 * Applies a CANDIDATE PySpark transform (an AI cleaning-suggestion snippet, or
 * NL-to-code output) against a SAMPLED copy of the previewed Lakehouse file/table
 * and returns the resulting rows — so the user sees the effect of the transform
 * BEFORE committing it (preview-before-apply per no-vaporware.md). The candidate
 * NEVER writes: it runs over `df.limit(sampleRows)` in a scratch Livy statement
 * and only the first rows are collected back.
 *
 * Uses the SAME Livy interactive-session plumbing as /api/lakehouse/table-stats
 * (createLivySessionAsync → poll to idle → submitLivyStatement → getLivyStatement),
 * so it inherits the cold-pool async contract: `jobId = "<pool>:<sid>:<stmtId>"`,
 * "" stmtId while the pool warms, and the client polls every 3s.
 *
 *   POST /api/lakehouse/transform-preview
 *     body { container, path, pool?, code, sampleRows?, previewRows? }
 *     → 200 { ok, status:'warming'|'running', jobId }        (kick-off)
 *
 *   GET /api/lakehouse/transform-preview?jobId=&container=&path=&code=&sampleRows=&previewRows=
 *     → 200 { ok, status:'available', columns, rows, rowCount }   (poll → done)
 *     → 200 { ok, status:'warming'|'running', jobId }
 *
 * Real Azure data plane: ADLS Gen2 (abfss) + Synapse Spark (Livy REST) via
 * synapse-dev-client. No Fabric / OneLake. Honest 503 gate when the Synapse
 * workspace / ADLS account is unset.
 *
 * Learn (Livy interactive session — create / submit / get statement):
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { KNOWN_CONTAINERS, pathToHttpsUrl } from '@/lib/azure/adls-client';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_POOL = process.env.LOOM_SPARK_POOL || 'loompool';
const MAX_SAMPLE_ROWS = 20_000;   // rows loaded into the scratch DataFrame
const MAX_PREVIEW_ROWS = 100;     // rows collected back to the grid
const MAX_CODE_CHARS = 8000;

function gate(): NextResponse | null {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}. The transform preview runs on the Synapse Spark pool.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/** Derive the abfss:// URI Spark needs (same derivation as table-stats). */
function abfssFor(container: string, path: string): { abfss: string; ext: string } | { error: string } {
  let httpsUrl: string;
  try {
    httpsUrl = pathToHttpsUrl(container, path);
  } catch (e: any) {
    return { error: e?.message || 'ADLS account not configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL.' };
  }
  const m = httpsUrl.match(/^https:\/\/([^/]+)\.dfs\.core\.windows\.net\/([^/]+)\/(.+)$/);
  const abfss = m ? `abfss://${m[2]}@${m[1]}.dfs.core.windows.net/${m[3]}` : httpsUrl;
  const deltaIdx = abfss.indexOf('/_delta_log');
  const tablePath = deltaIdx >= 0 ? abfss.substring(0, deltaIdx) : abfss;
  let ext = path.toLowerCase().split('.').pop() || '';
  if (deltaIdx >= 0 || path.includes('/_delta_log')) ext = 'delta';
  if (!['delta', 'parquet', 'csv', 'tsv', 'json', 'jsonl', 'ndjson'].includes(ext)) ext = 'delta';
  return { abfss: tablePath, ext };
}

/** Indent every line of the candidate so it nests under `try:`. */
function indent(code: string): string {
  return code.split('\n').map((l) => (l.length ? '    ' + l : l)).join('\n');
}

/**
 * Build the PySpark preview statement. It loads the source into `df`, samples it,
 * runs the candidate (which reassigns `df`), then prints LOOM_PREVIEW json of the
 * first `previewRows`. The candidate runs inside a try/except so a bad transform
 * surfaces as an honest error string, not a dead session.
 */
function buildPreviewCode(abfss: string, ext: string, code: string, sampleRows: number, previewRows: number): string {
  const safePath = abfss.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeExt = ext.replace(/[^a-z0-9]/g, '');
  const nSample = Math.max(1, Math.min(sampleRows, MAX_SAMPLE_ROWS));
  const nPreview = Math.max(1, Math.min(previewRows, MAX_PREVIEW_ROWS));
  return [
    'from pyspark.sql import SparkSession',
    'from pyspark.sql import functions as F',
    'import json',
    'spark = SparkSession.builder.getOrCreate()',
    `_path = "${safePath}"`,
    `_ext = "${safeExt}"`,
    'def _load():',
    "    if _ext == 'delta':",
    "        return spark.read.format('delta').load(_path)",
    "    if _ext == 'parquet':",
    '        return spark.read.parquet(_path)',
    "    if _ext in ('csv','tsv'):",
    "        sep = '\\t' if _ext == 'tsv' else ','",
    "        return spark.read.option('header','true').option('inferSchema','true').option('sep', sep).csv(_path)",
    "    if _ext in ('json','jsonl','ndjson'):",
    '        return spark.read.json(_path)',
    "    return spark.read.format('delta').load(_path)",
    'try:',
    '    _src = _load()',
    'except Exception:',
    "    _src = spark.read.format('delta').load(_path)",
    `df = _src.limit(${nSample})`,
    '_before = df.columns',
    '_err = None',
    'try:',
    indent(code),
    'except Exception as _e:',
    '    _err = str(_e)',
    'if _err is not None:',
    "    print('LOOM_PREVIEW:' + json.dumps({'error': _err}))",
    'else:',
    '    _cols = df.columns',
    `    _rows = [ [ (None if _v is None else str(_v)) for _v in _r ] for _r in df.limit(${nPreview}).collect() ]`,
    '    _added = [c for c in _cols if c not in _before]',
    '    _removed = [c for c in _before if c not in _cols]',
    "    print('LOOM_PREVIEW:' + json.dumps({'columns': _cols, 'rows': _rows, 'rowCount': len(_rows), 'addedColumns': _added, 'removedColumns': _removed}))",
  ].join('\n');
}

interface PreviewOut {
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  addedColumns?: string[];
  removedColumns?: string[];
  error?: string;
}

function parsePreviewOutput(output: any): PreviewOut | null {
  const text: string | undefined = output?.data?.['text/plain'];
  if (!text || typeof text !== 'string') return null;
  const idx = text.indexOf('LOOM_PREVIEW:');
  if (idx < 0) return null;
  const json = text.substring(idx + 'LOOM_PREVIEW:'.length).trim();
  try { return JSON.parse(json); } catch { return null; }
}

const DEAD_SESSION = new Set(['error', 'dead', 'killed', 'shutting_down', 'success']);

/** Shared kick-off used by both POST (fresh) and the GET warm-up branch. */
function readCode(v: unknown): string {
  const c = typeof v === 'string' ? v.trim() : '';
  return c.slice(0, MAX_CODE_CHARS);
}

async function kickoff(container: string, path: string, poolParam: string, code: string, sampleRows: number, previewRows: number): Promise<NextResponse> {
  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (container && !(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }
  if (!code) {
    return NextResponse.json({ ok: false, error: 'code is required' }, { status: 400 });
  }
  const abfss = abfssFor(container, path);
  if ('error' in abfss) {
    return NextResponse.json({ ok: false, code: 'not_configured', error: abfss.error }, { status: 503 });
  }
  const pool = poolParam || DEFAULT_POOL;
  const fresh = await createLivySessionAsync(pool, 'pyspark', `loom-wrangler-${Date.now()}`);
  const sessionId = fresh.id;
  const s = await getLivySession(pool, sessionId);
  if (s.state !== 'idle') {
    return NextResponse.json({ ok: true, status: 'warming', jobId: `${pool}:${sessionId}:`, sessionState: s.state });
  }
  const stmt = await submitLivyStatement(pool, sessionId, {
    code: buildPreviewCode(abfss.abfss, abfss.ext, code, sampleRows, previewRows), kind: 'pyspark',
  });
  return NextResponse.json({ ok: true, status: 'running', jobId: `${pool}:${sessionId}:${stmt.id}` });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const container = String(body?.container || '');
  const path = String(body?.path || '');
  const poolParam = String(body?.pool || '').trim();
  const code = readCode(body?.code);
  const sampleRows = Number.isFinite(body?.sampleRows) ? Math.floor(body.sampleRows) : 5000;
  const previewRows = Number.isFinite(body?.previewRows) ? Math.floor(body.previewRows) : 50;

  try {
    return await kickoff(container, path, poolParam, code, sampleRows, previewRows);
  } catch (e: any) {
    return NextResponse.json({ ok: false, status: 'error', error: e?.message || String(e) }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const sp = req.nextUrl.searchParams;
  const jobId = sp.get('jobId') || '';
  const container = sp.get('container') || '';
  const path = sp.get('path') || '';
  const poolParam = sp.get('pool')?.trim() || '';
  const code = readCode(sp.get('code'));
  const sampleRows = Number(sp.get('sampleRows')) || 5000;
  const previewRows = Number(sp.get('previewRows')) || 50;

  if (container && !(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  try {
    if (!jobId) {
      // Allow a GET-based kick-off too (symmetry with table-stats); POST is primary.
      return await kickoff(container, path, poolParam, code, sampleRows, previewRows);
    }

    const [pool, sidStr, stidStr] = jobId.split(':');
    const sessionId = Number(sidStr);
    if (!pool || !Number.isFinite(sessionId)) {
      return NextResponse.json({ ok: false, error: 'malformed jobId' }, { status: 400 });
    }

    // No statement yet — pool was warming at kick-off. Submit once idle.
    if (!stidStr) {
      const s = await getLivySession(pool, sessionId);
      if (DEAD_SESSION.has(String(s.state))) {
        return NextResponse.json({ ok: false, status: 'error', error: `Spark session ${sessionId} is ${s.state}.` });
      }
      if (s.state !== 'idle') {
        return NextResponse.json({ ok: true, status: 'warming', jobId, sessionState: s.state });
      }
      if (!container || !path || !code) {
        return NextResponse.json({ ok: false, error: 'container, path and code required to submit the transform' }, { status: 400 });
      }
      const abfss = abfssFor(container, path);
      if ('error' in abfss) {
        return NextResponse.json({ ok: false, status: 'error', code: 'not_configured', error: abfss.error }, { status: 503 });
      }
      const stmt = await submitLivyStatement(pool, sessionId, {
        code: buildPreviewCode(abfss.abfss, abfss.ext, code, sampleRows, previewRows), kind: 'pyspark',
      });
      return NextResponse.json({ ok: true, status: 'running', jobId: `${pool}:${sessionId}:${stmt.id}` });
    }

    const stmtId = Number(stidStr);
    const st = await getLivyStatement(pool, sessionId, stmtId);
    const state = String(st.state);
    if (state === 'available') {
      const out = st.output;
      if (out?.status === 'error') {
        return NextResponse.json({ ok: false, status: 'error', error: out.evalue || out.ename || 'Spark statement failed.', traceback: out.traceback });
      }
      const parsed = parsePreviewOutput(out);
      if (!parsed) {
        return NextResponse.json({ ok: false, status: 'error', error: 'Transform completed but produced no LOOM_PREVIEW output.' });
      }
      if (parsed.error) {
        // The candidate transform itself threw — honest, actionable, not a dead session.
        return NextResponse.json({ ok: false, status: 'transform_error', error: parsed.error });
      }
      return NextResponse.json({
        ok: true, status: 'available', jobId,
        columns: parsed.columns || [], rows: parsed.rows || [], rowCount: parsed.rowCount ?? 0,
        addedColumns: parsed.addedColumns || [], removedColumns: parsed.removedColumns || [],
      });
    }
    if (state === 'error' || state === 'cancelled' || state === 'cancelling') {
      return NextResponse.json({ ok: false, status: 'error', error: `Spark statement ${state}.` });
    }
    return NextResponse.json({ ok: true, status: 'running', jobId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, status: 'error', error: e?.message || String(e) }, { status: 502 });
  }
}
