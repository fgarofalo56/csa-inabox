/**
 * Column-summary statistics for a Lakehouse table / file, computed by a real
 * Spark `summary()` job on the Synapse Spark pool via the Livy interactive
 * session API. Backs the column-summary card in the Lakehouse Preview DataGrid.
 *
 *   GET /api/lakehouse/table-stats?container=&path=&pool=
 *     → creates a Livy session, (when idle) submits the PySpark stats
 *       statement, and returns { ok, jobId, status } immediately. `jobId`
 *       encodes "<pool>:<sessionId>:<stmtId>" ("" stmtId while the pool warms).
 *
 *   GET /api/lakehouse/table-stats?jobId=&container=&path=&pool=
 *     → polls. If the session has just become idle and no statement is running
 *       yet, submits it (passing container+path so the abfss URI can be rebuilt
 *       statelessly) and returns the updated jobId. Otherwise polls the Livy
 *       statement and, once 'available', parses the `LOOM_STATS:` marker the
 *       PySpark prints and returns { ok, status:'available', columns, stats }.
 *
 * Async by design — a cold Spark pool can take 60-90s to reach 'idle', well
 * past the Front Door ~30s timeout, so the route never blocks. The client
 * polls every 3s and follows whatever jobId the route hands back.
 *
 * Real Azure data plane only: ADLS Gen2 (abfss) + Synapse Spark (Livy REST,
 * api-version 2019-11-01-preview) via synapse-dev-client. No Fabric / OneLake.
 * Honest 503 gate when LOOM_SYNAPSE_WORKSPACE (or an ADLS account URL) is unset.
 *
 * Learn (Livy interactive session — create / submit / get statement):
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/get-spark-statement
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

function gate(): NextResponse | null {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}. Column statistics run on the Synapse Spark pool.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/** Derive the abfss:// URI Spark needs from the same helper the preview route uses. */
function abfssFor(container: string, path: string): { abfss: string; ext: string } | { error: string } {
  let httpsUrl: string;
  try {
    httpsUrl = pathToHttpsUrl(container, path);
  } catch (e: any) {
    return { error: e?.message || 'ADLS account not configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL.' };
  }
  // https://<acct>.dfs.core.windows.net/<container>/<path>
  // → abfss://<container>@<acct>.dfs.core.windows.net/<path>
  const m = httpsUrl.match(/^https:\/\/([^/]+)\.dfs\.core\.windows\.net\/([^/]+)\/(.+)$/);
  const abfss = m ? `abfss://${m[2]}@${m[1]}.dfs.core.windows.net/${m[3]}` : httpsUrl;
  // For a Delta table the bulk target is the table directory (parent of _delta_log).
  const deltaIdx = abfss.indexOf('/_delta_log');
  const tablePath = deltaIdx >= 0 ? abfss.substring(0, deltaIdx) : abfss;
  let ext = path.toLowerCase().split('.').pop() || '';
  if (deltaIdx >= 0 || path.includes('/_delta_log')) ext = 'delta';
  if (!['delta', 'parquet', 'csv', 'tsv', 'json', 'jsonl', 'ndjson'].includes(ext)) ext = 'delta';
  return { abfss: tablePath, ext };
}

/** Build the PySpark stats statement. Path + ext are server-derived; escaped for a Python string literal. */
function buildStatsCode(abfss: string, ext: string): string {
  const safePath = abfss.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeExt = ext.replace(/[^a-z0-9]/g, '');
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
    '    df = _load()',
    'except Exception:',
    '    try:',
    "        df = spark.read.format('delta').load(_path)",
    '    except Exception:',
    '        df = spark.read.parquet(_path)',
    'cols = df.columns',
    'sample = df.limit(200000).cache()',
    "summary_rows = sample.summary('count','mean','stddev','min','max').collect()",
    'stat_map = {}',
    'for _r in summary_rows:',
    "    _label = _r['summary']",
    '    for _c in cols:',
    '        stat_map.setdefault(_c, {})[_label] = _r[_c]',
    'null_counts = sample.select([F.count(F.when(F.col(_c).isNull(), _c)).alias(_c) for _c in cols]).collect()[0].asDict()',
    "numeric_types = ('IntegerType','LongType','DoubleType','FloatType','ShortType','ByteType')",
    'numeric_cols = [f.name for f in sample.schema.fields if str(f.dataType) in numeric_types or "Decimal" in str(f.dataType)]',
    'hist = {}',
    'for _c in numeric_cols[:40]:',
    '    try:',
    "        _rdd = sample.select(F.col(_c).cast('double')).where(F.col(_c).isNotNull()).rdd.map(lambda row: row[0])",
    '        if not _rdd.isEmpty():',
    '            _edges, _counts = _rdd.histogram(10)',
    '            _mx = max(_counts) if _counts else 0',
    '            hist[_c] = [ (float(x) / _mx) if _mx else 0.0 for x in _counts ]',
    '    except Exception:',
    '        pass',
    'def _num(v):',
    "    if v is None or v == '':",
    '        return None',
    '    try:',
    '        return float(v)',
    '    except Exception:',
    '        return None',
    'result = {}',
    'for _c in cols:',
    '    _sm = stat_map.get(_c, {})',
    '    result[_c] = {',
    "        'count': int(_num(_sm.get('count')) or 0),",
    "        'mean': _num(_sm.get('mean')),",
    "        'stddev': _num(_sm.get('stddev')),",
    "        'min': (str(_sm.get('min')) if _sm.get('min') is not None else None),",
    "        'max': (str(_sm.get('max')) if _sm.get('max') is not None else None),",
    "        'nullCount': int(null_counts.get(_c) or 0),",
    "        'histogram': hist.get(_c),",
    '    }',
    'sample.unpersist()',
    "print('LOOM_STATS:' + json.dumps({'columns': cols, 'stats': result}))",
  ].join('\n');
}

type ColStat = {
  count: number; mean: number | null; stddev: number | null;
  min: string | null; max: string | null; nullCount: number; histogram: number[] | null;
};

function parseStatsOutput(output: any): { columns: string[]; stats: Record<string, ColStat> } | null {
  const text: string | undefined = output?.data?.['text/plain'];
  if (!text || typeof text !== 'string') return null;
  const idx = text.indexOf('LOOM_STATS:');
  if (idx < 0) return null;
  const json = text.substring(idx + 'LOOM_STATS:'.length).trim();
  try {
    const parsed = JSON.parse(json);
    return { columns: parsed.columns || [], stats: parsed.stats || {} };
  } catch {
    return null;
  }
}

const DEAD_SESSION = new Set(['error', 'dead', 'killed', 'shutting_down', 'success']);

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const sp = req.nextUrl.searchParams;
  const jobId = sp.get('jobId') || '';
  const container = sp.get('container') || '';
  const path = sp.get('path') || '';
  const poolParam = sp.get('pool')?.trim() || '';

  if (container && !(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  try {
    // ---- Poll mode -----------------------------------------------------
    if (jobId) {
      const [pool, sidStr, stidStr] = jobId.split(':');
      const sessionId = Number(sidStr);
      if (!pool || !Number.isFinite(sessionId)) {
        return NextResponse.json({ ok: false, error: 'malformed jobId' }, { status: 400 });
      }

      // No statement yet — the pool was warming at kick-off. Submit once idle.
      if (!stidStr) {
        const s = await getLivySession(pool, sessionId);
        if (DEAD_SESSION.has(String(s.state))) {
          return NextResponse.json({ ok: false, status: 'error', error: `Spark session ${sessionId} is ${s.state}.` });
        }
        if (s.state !== 'idle') {
          return NextResponse.json({ ok: true, status: 'warming', jobId, sessionState: s.state });
        }
        if (!container || !path) {
          return NextResponse.json({ ok: false, error: 'container and path required to submit the stats job' }, { status: 400 });
        }
        const abfss = abfssFor(container, path);
        if ('error' in abfss) {
          return NextResponse.json({ ok: false, status: 'error', code: 'not_configured', error: abfss.error }, { status: 503 });
        }
        const stmt = await submitLivyStatement(pool, sessionId, { code: buildStatsCode(abfss.abfss, abfss.ext), kind: 'pyspark' });
        return NextResponse.json({ ok: true, status: 'running', jobId: `${pool}:${sessionId}:${stmt.id}` });
      }

      // Statement submitted — poll it.
      const stmtId = Number(stidStr);
      const st = await getLivyStatement(pool, sessionId, stmtId);
      const state = String(st.state);
      if (state === 'available') {
        const out = st.output;
        if (out?.status === 'error') {
          return NextResponse.json({ ok: false, status: 'error', error: out.evalue || out.ename || 'Spark statement failed.', traceback: out.traceback });
        }
        const parsed = parseStatsOutput(out);
        if (!parsed) {
          return NextResponse.json({ ok: false, status: 'error', error: 'Stats job completed but produced no LOOM_STATS output.' });
        }
        return NextResponse.json({ ok: true, status: 'available', jobId, columns: parsed.columns, stats: parsed.stats });
      }
      if (state === 'error' || state === 'cancelled' || state === 'cancelling') {
        return NextResponse.json({ ok: false, status: 'error', error: `Spark statement ${state}.` });
      }
      return NextResponse.json({ ok: true, status: 'running', jobId });
    }

    // ---- Kick-off mode -------------------------------------------------
    if (!container || !path) {
      return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
    }
    const abfss = abfssFor(container, path);
    if ('error' in abfss) {
      return NextResponse.json({ ok: false, code: 'not_configured', error: abfss.error }, { status: 503 });
    }
    const pool = poolParam || DEFAULT_POOL;
    const fresh = await createLivySessionAsync(pool, 'pyspark', `loom-stats-${Date.now()}`);
    const sessionId = fresh.id;
    const s = await getLivySession(pool, sessionId);
    if (s.state !== 'idle') {
      // Cold pool — hand back a stmtId-less jobId; the client polls and we
      // submit once the session reaches idle.
      return NextResponse.json({ ok: true, status: 'warming', jobId: `${pool}:${sessionId}:`, sessionState: s.state });
    }
    const stmt = await submitLivyStatement(pool, sessionId, { code: buildStatsCode(abfss.abfss, abfss.ext), kind: 'pyspark' });
    return NextResponse.json({ ok: true, status: 'running', jobId: `${pool}:${sessionId}:${stmt.id}` });
  } catch (e: any) {
    return NextResponse.json({ ok: false, status: 'error', error: e?.message || String(e) }, { status: 502 });
  }
}
