/**
 * Column-summary statistics for a Lakehouse table / file, computed by a real
 * Spark `summary()` job on the Synapse Spark pool via the Livy interactive
 * session API. Backs the column-summary card in the Lakehouse Preview DataGrid.
 *
 *   GET /api/lakehouse/table-stats?lakehouseId=&container=&path=&pool=
 *     → creates a Livy session, (when idle) submits the PySpark stats
 *       statement, and returns { ok, jobId, status } immediately. `jobId` is a
 *       signed handle (`_lib/job-handle.ts`) bound to the lakehouse item, this
 *       route, the principal, the Spark session and the scoped container + path.
 *
 *   GET /api/lakehouse/table-stats?lakehouseId=&jobId=
 *     → polls. If the session has just become idle and no statement is running
 *       yet, submits it over the container + path the handle carries and
 *       returns the updated jobId. Otherwise polls the Livy statement and, once
 *       'available', parses the `LOOM_STATS:` marker the PySpark prints and
 *       returns { ok, status:'available', columns, stats }.
 *
 * Item scope: every call needs read access to the lakehouse item; the file
 * must sit strictly below the item's root in its own container. A handle for
 * another item, route or principal answers 404.
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
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { KNOWN_CONTAINERS, pathToHttpsUrl } from '@/lib/azure/adls-client';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiNotFound } from '@/lib/api/respond';
import { authorizeLakehouse, scopeItemPath } from '../_lib/item-scope';
import {
  SPARK_POOL_NAME_RE, mintLakehouseJobHandle, verifyLakehouseJobHandle, type LakehouseJobScope,
} from '../_lib/job-handle';

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

export const GET = withSession(async (req: NextRequest, { session }) => {
  const g = gate(); if (g) return g;

  const sp = req.nextUrl.searchParams;
  const lakehouseId = (sp.get('lakehouseId') || '').trim();
  const jobId = sp.get('jobId') || '';
  const container = (sp.get('container') || '').trim();
  const path = sp.get('path') || '';
  const poolParam = sp.get('pool')?.trim() || '';

  if (!lakehouseId) {
    return apiBadRequest('lakehouseId is required: column statistics run on a file of a lakehouse item.');
  }
  const scope: LakehouseJobScope = { lakehouseId, purpose: 'table-stats', oid: session.claims.oid };

  try {
    // ---- Poll mode -----------------------------------------------------
    if (jobId) {
      const access = await authorizeLakehouse(session, lakehouseId);
      if (access instanceof NextResponse) return access;
      const job = verifyLakehouseJobHandle(scope, jobId);
      // One answer for a malformed, expired, or other-item handle.
      if (!job) return apiNotFound('column statistics job not found; open the file again to start a new one.');
      const { pool, sessionId } = job;

      // No statement yet — the pool was warming at kick-off. Submit once idle,
      // over the container + path the handle carries.
      if (job.stmtId === null) {
        const s = await getLivySession(pool, sessionId);
        if (DEAD_SESSION.has(String(s.state))) {
          return NextResponse.json({ ok: false, status: 'error', error: `Spark session ${sessionId} is ${s.state}.` });
        }
        if (s.state !== 'idle') {
          return NextResponse.json({ ok: true, status: 'warming', jobId, sessionState: s.state });
        }
        const abfss = abfssFor(job.container, job.path);
        if ('error' in abfss) {
          return NextResponse.json({ ok: false, status: 'error', code: 'not_configured', error: abfss.error }, { status: 503 });
        }
        const stmt = await submitLivyStatement(pool, sessionId, { code: buildStatsCode(abfss.abfss, abfss.ext), kind: 'pyspark' });
        return NextResponse.json({ ok: true, status: 'running', jobId: mintLakehouseJobHandle(scope, { ...job, stmtId: stmt.id }) });
      }

      // Statement submitted — poll it.
      const st = await getLivyStatement(pool, sessionId, job.stmtId);
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
    if (!path) {
      return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
    }
    const pool = poolParam || DEFAULT_POOL;
    if (!SPARK_POOL_NAME_RE.test(pool)) {
      return apiBadRequest('pool must be a Spark pool name: a letter, then letters or digits, 15 characters at most.');
    }
    const scoped = await scopeItemPath(
      session,
      { lakehouseId, container, rawPath: path },
      { knownContainers: KNOWN_CONTAINERS },
    );
    if (scoped instanceof NextResponse) return scoped;
    const abfss = abfssFor(scoped.container, scoped.path);
    if ('error' in abfss) {
      return NextResponse.json({ ok: false, code: 'not_configured', error: abfss.error }, { status: 503 });
    }
    const fresh = await createLivySessionAsync(pool, 'pyspark', `loom-stats-${Date.now()}`);
    const sessionId = fresh.id;
    const s = await getLivySession(pool, sessionId);
    const base = { pool, sessionId, container: scoped.container, path: scoped.path };
    if (s.state !== 'idle') {
      // Cold pool — hand back a statement-less handle; the client polls and we
      // submit once the session reaches idle.
      return NextResponse.json({
        ok: true, status: 'warming', sessionState: s.state,
        jobId: mintLakehouseJobHandle(scope, { ...base, stmtId: null }),
      });
    }
    const stmt = await submitLivyStatement(pool, sessionId, { code: buildStatsCode(abfss.abfss, abfss.ext), kind: 'pyspark' });
    return NextResponse.json({ ok: true, status: 'running', jobId: mintLakehouseJobHandle(scope, { ...base, stmtId: stmt.id }) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, status: 'error', error: e?.message || String(e) }, { status: 502 });
  }
});
