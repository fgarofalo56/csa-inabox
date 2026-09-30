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
 * so it inherits the cold-pool async contract: a kick-off may answer `warming`
 * (no statement yet) and the client polls every 3s.
 *
 *   POST /api/lakehouse/transform-preview
 *     body { lakehouseId, container?, path, pool?, code, sampleRows?, previewRows? }
 *     → 200 { ok, status:'warming'|'running', jobId }        (kick-off)
 *
 *   POST /api/lakehouse/transform-preview
 *     body { lakehouseId, jobId, code?, sampleRows?, previewRows? }   (poll)
 *   GET  /api/lakehouse/transform-preview?lakehouseId=&jobId=&code=&sampleRows=&previewRows=
 *     → 200 { ok, status:'available', columns, rows, rowCount }   (poll → done)
 *     → 200 { ok, status:'warming'|'running', jobId }
 *     → 422 { ok:false, status:'transform_error', error }  (the candidate threw)
 *     → 422 { ok:false, status:'error', error, traceback? } (statement failed)
 *     → 409 { ok:false, status:'error', error }  (statement cancelled)
 *     → 502 { ok:false, status:'error', error }  (Spark session dead, or no result printed)
 *     A path holding a control character or a Spark glob character is 400;
 *     a session with no user object id is 401.
 *     `code` is read only while the job is `warming`, and must be the code the
 *     kick-off accepted. The editor polls with POST so the code is sent in the
 *     body rather than the URL.
 *
 * Item scope. Every call names the lakehouse item (`lakehouseId`) and needs
 * EDIT rights on it (`authorizeLakehouse` with `write`): the candidate is
 * Python that runs in a Spark session under the workspace's Spark identity, so
 * running it is an edit-level action even though the preview itself writes
 * nothing. The source it samples is confined to the item's own container and
 * root (`scopeItemPath`), and the `jobId` is a signed handle (`../_lib/job-handle`)
 * that binds the Livy job to that item, this route, the principal, and the
 * scoped container + path — a poll reads the path from the handle, never from
 * the request. What the candidate itself can reach from inside the session is
 * what the workspace's Spark identity can reach; the item scope governs the
 * sampled source and who may run a preview.
 *
 * Real Azure data plane: ADLS Gen2 (abfss) + Synapse Spark (Livy REST) via
 * synapse-dev-client. No Fabric / OneLake. Honest 503 gate when the Synapse
 * workspace / ADLS account is unset.
 *
 * Learn (Livy interactive session — create / submit / get statement):
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 */
import { NextRequest, NextResponse } from 'next/server';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { KNOWN_CONTAINERS } from '@/lib/azure/adls-client';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiError, apiNotFound, apiUnauthorized } from '@/lib/api/respond';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeLakehouse, scopeItemPath } from '../_lib/item-scope';
import { sparkAbfssFor, type SparkAbfss } from '../_lib/spark-path';
import {
  SPARK_POOL_NAME_RE, hashJobCode, mintLakehouseJobHandle, verifyLakehouseJobHandle,
  type LakehouseJobScope,
} from '../_lib/job-handle';

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

/**
 * The abfss:// URI and reader format Spark needs for a SCOPED source, on the
 * item's bound `account` (`sparkAbfssFor`: refuses Spark glob characters,
 * sovereign-cloud aware). A path inside a `_delta_log` folder reads its table.
 */
function sourceFor(
  account: string | null, container: string, path: string,
): { ok: true; abfss: string; ext: string } | Extract<SparkAbfss, { ok: false }> {
  const built = sparkAbfssFor(account, container, path);
  if (!built.ok) return built;
  const deltaIdx = built.abfss.indexOf('/_delta_log');
  const tablePath = deltaIdx >= 0 ? built.abfss.substring(0, deltaIdx) : built.abfss;
  let ext = path.toLowerCase().split('.').pop() || '';
  if (deltaIdx >= 0 || path.includes('/_delta_log')) ext = 'delta';
  if (!['delta', 'parquet', 'csv', 'tsv', 'json', 'jsonl', 'ndjson'].includes(ext)) ext = 'delta';
  return { ok: true, abfss: tablePath, ext };
}

/** The response for a source `sourceFor` refused. */
function sourceRefusal(r: Extract<SparkAbfss, { ok: false }>): NextResponse {
  if (r.status === 400) return apiBadRequest(r.error);
  return NextResponse.json({ ok: false, status: 'error', code: r.code, error: r.error }, { status: r.status });
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
  const safeExt = ext.replace(/[^a-z0-9]/g, '');
  const nSample = Math.max(1, Math.min(sampleRows, MAX_SAMPLE_ROWS));
  const nPreview = Math.max(1, Math.min(previewRows, MAX_PREVIEW_ROWS));
  return [
    'from pyspark.sql import SparkSession',
    'from pyspark.sql import functions as F',
    'import json',
    'spark = SparkSession.builder.getOrCreate()',
    // JSON string syntax is a valid Python string literal: quotes, backslashes
    // and any control character are written as escapes, so the literal stays
    // on this one line whatever the path holds.
    `_path = ${JSON.stringify(abfss)}`,
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

/** The candidate code, trimmed and capped at MAX_CODE_CHARS. */
function readCode(v: unknown): string {
  const c = typeof v === 'string' ? v.trim() : '';
  return c.slice(0, MAX_CODE_CHARS);
}

const READ_ONLY_MESSAGE =
  'Your role on this lakehouse is read-only. Previewing a transform runs its code on the Spark pool, so it needs '
  + 'a workspace Member/Admin role or an item grant that includes Edit.';

/** The job handle's scope for this request: this item, this route, this principal. */
function jobScope(session: SessionPayload, lakehouseId: string): LakehouseJobScope {
  return { lakehouseId, purpose: 'transform-preview', oid: String(session.claims.oid || '') };
}

/**
 * A preview job is bound to the principal that started it, so a session with no
 * user object id cannot start or poll one. Answered before any Spark call.
 */
function missingPrincipal(session: SessionPayload): NextResponse | null {
  if (String(session.claims?.oid || '')) return null;
  return apiUnauthorized(
    'Your sign-in did not include a user object id, so Loom cannot tie a transform preview to you. '
    + 'Sign out and sign in again, then retry.',
  );
}

export const POST = withSession(async (req: NextRequest, { session }) => {
  const g = gate(); if (g) return g;

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const lakehouseId = String(body?.lakehouseId || '').trim();
  const container = String(body?.container || '');
  const path = String(body?.path || '');
  const poolParam = String(body?.pool || '').trim();
  const code = readCode(body?.code);
  const sampleRows = Number.isFinite(body?.sampleRows) ? Math.floor(body.sampleRows) : 5000;
  const previewRows = Number.isFinite(body?.previewRows) ? Math.floor(body.previewRows) : 50;

  if (!lakehouseId) {
    return apiBadRequest('lakehouseId is required: a transform preview runs against a file or table of one lakehouse.');
  }
  const noPrincipal = missingPrincipal(session);
  if (noPrincipal) return noPrincipal;
  // A body carrying a jobId is a POLL. The client polls with POST so the
  // candidate code (up to MAX_CODE_CHARS) travels in the body, not the URL.
  const jobId = typeof body?.jobId === 'string' ? body.jobId : '';
  if (jobId) return pollJob(session, { lakehouseId, jobId, code, sampleRows, previewRows });

  if (!path) return apiBadRequest('path is required');
  if (!code) return apiBadRequest('code is required');
  const pool = poolParam || DEFAULT_POOL;
  if (!SPARK_POOL_NAME_RE.test(pool)) {
    return apiBadRequest('pool must be a Spark pool name: a letter, then letters or digits, 15 characters at most.');
  }

  try {
    const scoped = await scopeItemPath(
      session,
      { lakehouseId, container, rawPath: path },
      { write: true, readOnlyMessage: READ_ONLY_MESSAGE, knownContainers: KNOWN_CONTAINERS },
    );
    if (scoped instanceof NextResponse) return scoped;

    const src = sourceFor(scoped.account, scoped.container, scoped.path);
    if (!src.ok) return sourceRefusal(src);
    const scope = jobScope(session, lakehouseId);
    const fresh = await createLivySessionAsync(pool, 'pyspark', `loom-wrangler-${Date.now()}`);
    const sessionId = fresh.id;
    const s = await getLivySession(pool, sessionId);
    const base = {
      pool, sessionId, container: scoped.container, path: scoped.path, codeHash: hashJobCode(code),
      ...(scoped.account ? { account: scoped.account } : {}),
    };
    if (s.state !== 'idle') {
      return NextResponse.json({
        ok: true, status: 'warming', sessionState: s.state,
        jobId: mintLakehouseJobHandle(scope, { ...base, stmtId: null }),
      });
    }
    const stmt = await submitLivyStatement(pool, sessionId, {
      code: buildPreviewCode(src.abfss, src.ext, code, sampleRows, previewRows), kind: 'pyspark',
    });
    return NextResponse.json({
      ok: true, status: 'running', jobId: mintLakehouseJobHandle(scope, { ...base, stmtId: stmt.id }),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, status: 'error', error: e?.message || String(e) }, { status: 502 });
  }
});

export const GET = withSession(async (req: NextRequest, { session }) => {
  const g = gate(); if (g) return g;

  const sp = req.nextUrl.searchParams;
  const lakehouseId = (sp.get('lakehouseId') || '').trim();
  const jobId = sp.get('jobId') || '';
  const code = readCode(sp.get('code'));
  const sampleRows = Number(sp.get('sampleRows')) || 5000;
  const previewRows = Number(sp.get('previewRows')) || 50;

  if (!lakehouseId) return apiBadRequest('lakehouseId is required');
  if (!jobId) return apiBadRequest('jobId is required; start a transform preview with POST.');
  const noPrincipal = missingPrincipal(session);
  if (noPrincipal) return noPrincipal;
  return pollJob(session, { lakehouseId, jobId, code, sampleRows, previewRows });
});

/**
 * Poll (and, for a warming job, submit) a transform preview job. Shared by GET
 * and by POST-with-jobId. Every poll re-authorizes the item with edit rights,
 * and the job's container + path come from the signed handle.
 */
async function pollJob(
  session: SessionPayload,
  p: { lakehouseId: string; jobId: string; code: string; sampleRows: number; previewRows: number },
): Promise<NextResponse> {
  const { lakehouseId, jobId, code, sampleRows, previewRows } = p;
  try {
    const access = await authorizeLakehouse(session, lakehouseId, { write: true, readOnlyMessage: READ_ONLY_MESSAGE });
    if (access instanceof NextResponse) return access;
    const job = verifyLakehouseJobHandle(jobScope(session, lakehouseId), jobId);
    // One answer for a malformed, expired, or other-item handle: none of them
    // names a job this request may poll.
    if (!job) return apiNotFound('transform preview job not found; start a new preview.');
    const { pool, sessionId } = job;

    // No statement yet — pool was warming at kick-off. Submit once idle.
    if (job.stmtId === null) {
      const s = await getLivySession(pool, sessionId);
      if (DEAD_SESSION.has(String(s.state))) {
        return apiError(
          `Spark session ${sessionId} is ${s.state}, so the preview could not run. Start a new preview.`,
          502, { status: 'error' },
        );
      }
      if (s.state !== 'idle') {
        return NextResponse.json({ ok: true, status: 'warming', jobId, sessionState: s.state });
      }
      if (!code) {
        return apiBadRequest('code is required to submit the transform once the Spark session is ready.');
      }
      if (hashJobCode(code) !== job.codeHash) {
        return apiBadRequest('code does not match the transform this preview was started with; start a new preview.');
      }
      const src = sourceFor(job.account ?? null, job.container, job.path);
      if (!src.ok) return sourceRefusal(src);
      const stmt = await submitLivyStatement(pool, sessionId, {
        code: buildPreviewCode(src.abfss, src.ext, code, sampleRows, previewRows), kind: 'pyspark',
      });
      return NextResponse.json({
        ok: true, status: 'running',
        jobId: mintLakehouseJobHandle(jobScope(session, lakehouseId), { ...job, stmtId: stmt.id }),
      });
    }

    const stmtId = job.stmtId;
    const st = await getLivyStatement(pool, sessionId, stmtId);
    const state = String(st.state);
    if (state === 'available') {
      const out = st.output;
      if (out?.status === 'error') {
        return apiError(out.evalue || out.ename || 'Spark statement failed.', 422, {
          status: 'error', traceback: out.traceback,
        });
      }
      const parsed = parsePreviewOutput(out);
      if (!parsed) {
        return apiError(
          'The Spark statement finished but printed no LOOM_PREVIEW result, so Loom has no rows to show. Start a new preview.',
          502, { status: 'error' },
        );
      }
      if (parsed.error) {
        // The candidate transform itself threw — honest, actionable, not a dead session.
        return apiError(parsed.error, 422, { status: 'transform_error' });
      }
      return NextResponse.json({
        ok: true, status: 'available', jobId,
        columns: parsed.columns || [], rows: parsed.rows || [], rowCount: parsed.rowCount ?? 0,
        addedColumns: parsed.addedColumns || [], removedColumns: parsed.removedColumns || [],
      });
    }
    if (state === 'error') {
      return apiError('The Spark statement ended in an error state. Start a new preview.', 422, { status: 'error' });
    }
    if (state === 'cancelled' || state === 'cancelling') {
      return apiError(`The Spark statement was ${state}. Start a new preview.`, 409, { status: 'error' });
    }
    return NextResponse.json({ ok: true, status: 'running', jobId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, status: 'error', error: e?.message || String(e) }, { status: 502 });
  }
}
