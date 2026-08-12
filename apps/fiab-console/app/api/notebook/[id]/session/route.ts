/**
 * Livy interactive-session lifecycle for the Synapse Notebook per-cell editor
 * (F16). Keyed by the Cosmos notebook item `id` so the Fabric-native and
 * Synapse-native editors share one session-management surface.
 *
 *   POST   /api/notebook/[id]/session
 *     body { pool, kind?, existingSessionId?, configureOptions? }
 *     → create a Livy session, or reuse `existingSessionId` when it is alive.
 *       Returns { ok, sessionId, state, appInfo? }.
 *       When LOOM_NOTEBOOK_BACKEND=databricks: body { cluster, kind?,
 *       existingContextId? } → create/reuse a Databricks execution context.
 *       Returns { ok, backend:'databricks', sessionId:<contextId>, clusterId,
 *       state }.
 *
 *   GET    /api/notebook/[id]/session?pool=&sessionId=
 *     → keepalive (PUT) + state poll. Returns { ok, sessionId, state, appInfo? }.
 *     ?probe=1 (no pool/sessionId) → { ok, backend } so the editor can pick the
 *     right compute picker (Spark pool vs Databricks cluster) without guessing.
 *
 *   DELETE /api/notebook/[id]/session?pool=&sessionId=
 *     → kill the session (DELETE). 404/already-gone is treated as success.
 *
 * Async by design — the proxy has a ~30s hard timeout and a cold Spark pool can
 * take 60-90s to reach 'idle'; the editor polls GET until idle. Reusing a
 * sessionId keeps the Spark context warm (variables persist across cells).
 *
 * Real Synapse Livy REST + Databricks Execution Context API. Honest 503 gate
 * when LOOM_SYNAPSE_WORKSPACE (or LOOM_DATABRICKS_HOSTNAME) is unset. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import {
  createLivySession, getLivySession, killLivySession, keepaliveLivySession,
  resolveNotebookBackend, type LivyKind, type LivySessionOptions,
} from '@/lib/azure/synapse-livy-client';
import { markSessionInUse } from '@/lib/azure/spark-session-pool';
import {
  resolveSparkPool, createSessionOnResolvedPool,
  type SparkPoolResolution, type ResolvedSparkPool,
} from '@/lib/azure/spark-pool-resolver';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALIVE = new Set(['not_started', 'starting', 'idle', 'busy']);
const TERMINAL = new Set(['error', 'dead', 'killed', 'shutting_down', 'success']);

function normKind(raw: unknown): LivyKind {
  const l = String(raw || 'pyspark').toLowerCase();
  if (l === 'sql' || l === 'sparksql' || l === 'spark-sql') return 'sql';
  if (l === 'spark' || l === 'scala') return 'spark';
  if (l === 'sparkr' || l === 'r') return 'sparkr';
  return 'pyspark';
}

// A pyspark session hosts pyspark / spark / sql statements via per-statement
// kind; sparkr needs its own session kind.
function sessionKindFor(stmt: LivyKind): LivyKind {
  return stmt === 'sparkr' ? 'sparkr' : 'pyspark';
}

function dbxLang(kind: LivyKind): 'python' | 'scala' | 'sql' | 'r' {
  if (kind === 'spark') return 'scala';
  if (kind === 'sql') return 'sql';
  if (kind === 'sparkr') return 'r';
  return 'python';
}

function synapseGate(): NextResponse | null {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/**
 * #3171 — the Spark pool is AUTO-BOUND server-side. `body.pool` / `?pool=` is a
 * HINT: a freshly created notebook has no `properties.bigDataPool`, so the
 * editor sends none and the platform picks from the workspace's real pool list
 * (`auto-bind-by-default.md` §1). Only a resolution that genuinely could not be
 * made surfaces, and it reports what was OBSERVED (R7).
 */
function poolGate(r: SparkPoolResolution): NextResponse | null {
  if (r.ok) return null;
  return NextResponse.json(
    { ok: false, code: r.code, error: r.error, hint: r.hint },
    { status: r.status },
  );
}

// IL5: Databricks Government tier is not IL5-authorized. Block the opt-in when
// the deployment is tagged IL5 so notebooks fall back to Synapse Livy.
function il5BlocksDatabricks(): NextResponse | null {
  if ((process.env.LOOM_CLOUD_TIER || '').trim().toUpperCase() === 'IL5') {
    return NextResponse.json(
      { ok: false, code: 'not_authorized', error: 'Databricks backend is not authorized at IL5; use Synapse Livy (unset LOOM_NOTEBOOK_BACKEND).' },
      { status: 403 },
    );
  }
  return null;
}

export const POST = withSession(async (req: NextRequest, { session }) => {

  const body = await req.json().catch(() => ({}));
  const kind = sessionKindFor(normKind(body?.kind));

  // ---- Databricks opt-in branch ----
  if (resolveNotebookBackend() === 'databricks') {
    const il5 = il5BlocksDatabricks(); if (il5) return il5;
    const cluster: string = typeof body?.cluster === 'string' ? body.cluster.trim() : '';
    if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: 'Databricks backend selected but LOOM_DATABRICKS_HOSTNAME is unset.', missing: 'LOOM_DATABRICKS_HOSTNAME' },
        { status: 503 },
      );
    }
    if (!cluster) return NextResponse.json({ ok: false, error: 'cluster is required — attach a Databricks cluster' }, { status: 400 });
    const { createExecutionContext, getExecutionContextStatus } = await import('@/lib/azure/databricks-client');
    try {
      const existing: string = typeof body?.existingContextId === 'string' ? body.existingContextId : '';
      if (existing) {
        const st = await getExecutionContextStatus(cluster, existing).catch(() => null);
        if (st && (st.status === 'Running' || st.status === 'Pending')) {
          return NextResponse.json({ ok: true, backend: 'databricks', sessionId: existing, clusterId: cluster, state: st.status === 'Running' ? 'idle' : 'starting' });
        }
      }
      const ctx = await createExecutionContext(cluster, dbxLang(normKind(body?.kind)));
      return NextResponse.json({ ok: true, backend: 'databricks', sessionId: ctx.id, clusterId: cluster, state: ctx.status === 'Running' ? 'idle' : 'starting' });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ---- Synapse Livy default ----
  const g = synapseGate(); if (g) return g;
  const requestedPool: string = typeof body?.pool === 'string' ? body.pool.trim() : '';
  // This is the BIND point — a stale saved binding (the `loompool` → `loompool2`
  // drift after the 2026-07-14 capacity incident) would otherwise create a
  // session against a pool that no longer exists, so the request IS verified
  // against the workspace's real pool list here and re-bound when absent.
  const resolution = await resolveSparkPool(requestedPool, { verifyRequested: true });
  const pg = poolGate(resolution); if (pg) return pg;
  const resolved = resolution as ResolvedSparkPool;

  const configure: Partial<LivySessionOptions> =
    body?.configureOptions && typeof body.configureOptions === 'object' ? body.configureOptions : {};
  const existing = typeof body?.existingSessionId === 'number' ? body.existingSessionId : Number(body?.existingSessionId);

  try {
    // Reuse only when the resolver did NOT move us off the caller's pool — a
    // session id is meaningful only on the pool it was created on.
    if (Number.isFinite(existing) && existing > 0 && (!requestedPool || resolved.source === 'request')) {
      const s = await getLivySession(resolved.pool, existing).catch(() => null);
      if (s && ALIVE.has(String(s.state)) && !TERMINAL.has(String(s.state))) {
        // Protect this reused session from the #1796 stale-session reaper.
        markSessionInUse(resolved.pool, existing);
        return NextResponse.json({
          ok: true, sessionId: existing, state: s.state, appInfo: s.appInfo,
          pool: resolved.pool, poolSource: resolved.source, poolVerified: resolved.verified, poolNote: resolved.note,
        });
      }
      // dead/terminal/unreachable → fall through and create a fresh session
    }
    const opts: LivySessionOptions = {
      kind,
      name: `loom-nb-${Date.now()}`,
      driverMemory: '4g', driverCores: 4,
      executorMemory: '4g', executorCores: 4,
      numExecutors: 2,
      ...configure,
    };
    // Proves the resolved pool actually ACCEPTS a Livy session: an established
    // 404 for that pool re-binds once to the next-ranked pool, then fails closed.
    const { session: sess, pool: boundPool, note } =
      await createSessionOnResolvedPool(resolved, (p) => createLivySession(p, opts));
    // Protect this freshly-created (pool-untracked) session from the reaper.
    markSessionInUse(boundPool, sess.id);
    return NextResponse.json({
      ok: true, sessionId: sess.id, state: sess.state, appInfo: sess.appInfo,
      pool: boundPool, poolSource: boundPool === resolved.pool ? resolved.source : 'workspace',
      poolVerified: resolved.verified, poolNote: note,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), pool: resolved.pool }, { status: 502 });
  }
});

export const GET = withSession(async (req: NextRequest, { session }) => {

  // Backend probe — lets the editor choose the Spark-pool vs Databricks-cluster
  // picker without committing a session. On the Synapse default it ALSO hands
  // back the pool the server would auto-bind (#3171), so a freshly created
  // notebook opens already attached instead of asking the user to pick.
  if (req.nextUrl.searchParams.get('probe')) {
    const backend = resolveNotebookBackend();
    if (backend !== 'synapse' || synapseConfigGate()) {
      return NextResponse.json({ ok: true, backend });
    }
    const r = await resolveSparkPool();
    return NextResponse.json(
      r.ok
        ? { ok: true, backend, pool: r.pool, poolSource: r.source, poolVerified: r.verified, poolNote: r.note }
        : { ok: true, backend, pool: null, poolUnresolved: { code: r.code, error: r.error, hint: r.hint } },
    );
  }

  if (resolveNotebookBackend() === 'databricks') {
    const cluster = req.nextUrl.searchParams.get('cluster')?.trim() || '';
    const contextId = req.nextUrl.searchParams.get('sessionId')?.trim() || '';
    if (!cluster || !contextId) return NextResponse.json({ ok: false, error: 'cluster and sessionId required' }, { status: 400 });
    const { getExecutionContextStatus } = await import('@/lib/azure/databricks-client');
    try {
      const st = await getExecutionContextStatus(cluster, contextId);
      return NextResponse.json({ ok: true, backend: 'databricks', sessionId: contextId, state: st.status === 'Running' ? 'idle' : (st.status || 'starting') });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const g = synapseGate(); if (g) return g;
  const requestedPool = req.nextUrl.searchParams.get('pool')?.trim() || '';
  // ABSENT is not 0: `Number(null)` and `Number('')` are both 0 and finite, so
  // presence is checked on the raw param. The `!pool` term used to mask this.
  const sessionParam = req.nextUrl.searchParams.get('sessionId');
  const sessionId = Number(sessionParam);
  if (!sessionParam || !Number.isFinite(sessionId)) {
    return NextResponse.json({ ok: false, error: 'sessionId query param required' }, { status: 400 });
  }
  // Poll/keepalive is paired with a live session id, so a supplied pool is
  // honoured verbatim; only an absent one is resolved.
  const resolution = await resolveSparkPool(requestedPool);
  const pg = poolGate(resolution); if (pg) return pg;
  const pool = (resolution as ResolvedSparkPool).pool;
  try {
    // Fire-and-forget keepalive resets the idle clock; never fail the poll on it.
    await keepaliveLivySession(pool, sessionId).catch(() => {});
    // Heartbeat: this is a live, open notebook — protect its session from the
    // #1796 reaper (the editor polls this every ~4 min while the notebook is open).
    markSessionInUse(pool, sessionId);
    const s = await getLivySession(pool, sessionId);
    return NextResponse.json({ ok: true, sessionId, state: s.state, appInfo: s.appInfo });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const DELETE = withSession(async (req: NextRequest) => {

  if (resolveNotebookBackend() === 'databricks') {
    const cluster = req.nextUrl.searchParams.get('cluster')?.trim() || '';
    const contextId = req.nextUrl.searchParams.get('sessionId')?.trim() || '';
    if (!cluster || !contextId) return NextResponse.json({ ok: false, error: 'cluster and sessionId required' }, { status: 400 });
    const { destroyExecutionContext } = await import('@/lib/azure/databricks-client');
    try {
      await destroyExecutionContext(cluster, contextId);
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const g = synapseGate(); if (g) return g;
  const requestedPool = req.nextUrl.searchParams.get('pool')?.trim() || '';
  // ABSENT is not 0: `Number(null)` and `Number('')` are both 0 and finite, so
  // presence is checked on the raw param. The `!pool` term used to mask this.
  const sessionParam = req.nextUrl.searchParams.get('sessionId');
  const sessionId = Number(sessionParam);
  if (!sessionParam || !Number.isFinite(sessionId)) {
    return NextResponse.json({ ok: false, error: 'sessionId query param required' }, { status: 400 });
  }
  // Teardown targets a live session id, so a supplied pool is honoured verbatim.
  const resolution = await resolveSparkPool(requestedPool);
  const pg = poolGate(resolution); if (pg) return pg;
  const pool = (resolution as ResolvedSparkPool).pool;
  try {
    await killLivySession(pool, sessionId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
