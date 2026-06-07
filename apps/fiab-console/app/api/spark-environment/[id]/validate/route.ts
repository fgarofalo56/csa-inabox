/**
 * Live validation that the spark-environment's libraries are importable.
 *
 *   POST /api/spark-environment/[id]/validate   body { poolName }
 *        → creates a Livy interactive session on the pool, stores the
 *          bootstrap code keyed by runId, returns { runId } immediately
 *          (Spark cold-start exceeds the 30s Front Door budget, so we poll).
 *
 *   GET  /api/spark-environment/[id]/validate?runId=spark:<pool>:<sessionId>[:<stmtId>]
 *        → drives the lifecycle: when the session reaches 'idle' it submits
 *          the bootstrap statement; subsequent polls return statement output.
 *
 * The bootstrap statement pip-installs the env's public packages at SESSION
 * scope (sessionLevelPackagesEnabled), then imports the requested modules and
 * prints a JSON report — the receipt that proves importability. This ties to
 * the notebook live-run path (T17): a notebook attached to this env, running
 * on the same pool, imports the same packages.
 *
 * Backend: Synapse Livy on the Spark pool. No Microsoft Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-environment';

/** pip name → best-effort import module name (override via state.importChecks). */
function pipToModule(line: string): string {
  // strip comments, version specifiers, extras and markers
  const name = line.split('#')[0].split(';')[0].trim()
    .replace(/\[.*?\]/g, '')
    .split(/[<>=!~ ]/)[0].trim();
  return name.replace(/-/g, '_');
}

function parsePipPackages(content: string): string[] {
  return (content || '').split('\n')
    .map((l) => l.split('#')[0].trim())
    .filter((l) => l && !l.startsWith('-') && !l.startsWith('name:') && !l.startsWith('channels:') && !l.startsWith('dependencies:'));
}

function buildBootstrap(state: any): string {
  const isConda = state.requirementsType === 'conda';
  const pkgs = parsePipPackages(state.requirementsContent || '');
  // Conda env files list packages under "dependencies:" with leading "- ";
  // for validation we install the pip-installable ones with pip (the session
  // already has the conda base). Either way pkgs holds the bare names.
  const mods: string[] = Array.isArray(state.importChecks) && state.importChecks.length
    ? state.importChecks.map((m: string) => String(m).trim()).filter(Boolean)
    : pkgs.map(pipToModule).filter(Boolean);
  const pkgJson = JSON.stringify(pkgs);
  const modJson = JSON.stringify(mods);
  return [
    'import importlib, subprocess, sys, json',
    `pkgs = ${pkgJson}`,
    `mods = ${modJson}`,
    'report = {"backend": "synapse-spark", "conda": ' + (isConda ? 'True' : 'False') + ', "installed": [], "imported": {}, "errors": {}}',
    'for p in pkgs:',
    '    try:',
    '        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", p])',
    '        report["installed"].append(p)',
    '    except Exception as e:',
    '        report["errors"]["install:" + p] = str(e)',
    'for m in mods:',
    '    try:',
    '        mod = importlib.import_module(m)',
    '        report["imported"][m] = getattr(mod, "__version__", "ok")',
    '    except Exception as e:',
    '        report["errors"]["import:" + m] = str(e)',
    'print("SPARK_ENV_VALIDATE " + json.dumps(report))',
  ].join('\n');
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const poolName = (body?.poolName || '').toString().trim();
  if (!poolName) return jerr('poolName is required', 400);

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const s: any = item.state || {};
    if (!(s.requirementsContent || '').trim() && !(Array.isArray(s.importChecks) && s.importChecks.length)) {
      return jerr('Add at least one public library (or an import check) before validating.', 400);
    }
    const code = buildBootstrap(s);

    const sess = await createLivySessionAsync(poolName, 'pyspark', `loom-env-validate-${id.slice(0, 8)}`);
    const runId = `spark:${poolName}:${sess.id}`;

    // Persist the pending bootstrap code keyed by runId so the poll route can
    // submit it once the session is idle.
    const validateRuns = { ...(s.validateRuns || {}) };
    validateRuns[runId] = { code, startedAt: new Date().toISOString() };
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: { ...s, validateRuns } });

    return NextResponse.json({ ok: true, runId, status: sess.state || 'starting', pool: poolName });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;
  const runId = req.nextUrl.searchParams.get('runId');
  if (!runId || !runId.startsWith('spark:')) return jerr('valid runId required', 400);

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const s: any = item.state || {};

    const [, pool, sessionIdStr, statementIdStr] = runId.split(':');
    const sessionId = Number(sessionIdStr);
    const stmtId = statementIdStr ? Number(statementIdStr) : undefined;

    // Phase 1: session not yet idle / no statement submitted.
    if (stmtId === undefined) {
      const sess = await getLivySession(pool, sessionId);
      if (sess.state === 'idle') {
        const pending = s.validateRuns?.[runId];
        const code: string = pending?.code || '';
        if (!code) return jerr('validation run expired — start a new validation', 410);
        const stmt = await submitLivyStatement(pool, sessionId, { code, kind: 'pyspark' });
        return NextResponse.json({
          ok: true,
          status: stmt.state || 'running',
          runId: `spark:${pool}:${sessionId}:${stmt.id}`,
          phase: 'statement-submitted',
        });
      }
      if (['error', 'dead', 'killed'].includes(sess.state)) {
        return NextResponse.json({ ok: false, error: `Spark session ${sessionId} entered terminal state '${sess.state}'`, status: sess.state });
      }
      return NextResponse.json({ ok: true, status: sess.state, runId, phase: 'session-starting' });
    }

    // Phase 2: statement in flight.
    const stmt = await getLivyStatement(pool, sessionId, stmtId);
    const out = (stmt as any).output || {};
    let report: any = null;
    const textPlain: string = out?.data?.['text/plain'] || '';
    const marker = textPlain.indexOf('SPARK_ENV_VALIDATE ');
    if (marker >= 0) {
      try { report = JSON.parse(textPlain.slice(marker + 'SPARK_ENV_VALIDATE '.length)); } catch { /* leave null */ }
    }
    const importable = report
      ? Object.keys(report.imported || {}).length > 0 && Object.keys(report.errors || {}).length === 0
      : undefined;

    return NextResponse.json({
      ok: true,
      status: stmt.state,
      runId,
      phase: 'statement-running',
      importable,
      report,
      output: out.status === 'ok'
        ? { status: 'ok', textPlain: textPlain || '(no output)' }
        : out.status === 'error'
          ? { status: 'error', ename: out.ename, evalue: out.evalue, traceback: out.traceback }
          : null,
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
