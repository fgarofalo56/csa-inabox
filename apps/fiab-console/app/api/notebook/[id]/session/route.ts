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
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import {
  createLivySession, getLivySession, killLivySession, keepaliveLivySession,
  resolveNotebookBackend, type LivyKind, type LivySessionOptions,
} from '@/lib/azure/synapse-livy-client';

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

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
  const pool: string = typeof body?.pool === 'string' ? body.pool.trim() : '';
  if (!pool) return NextResponse.json({ ok: false, error: 'pool is required — attach a Spark pool' }, { status: 400 });

  const configure: Partial<LivySessionOptions> =
    body?.configureOptions && typeof body.configureOptions === 'object' ? body.configureOptions : {};
  const existing = typeof body?.existingSessionId === 'number' ? body.existingSessionId : Number(body?.existingSessionId);

  try {
    if (Number.isFinite(existing) && existing > 0) {
      const s = await getLivySession(pool, existing);
      if (ALIVE.has(String(s.state)) && !TERMINAL.has(String(s.state))) {
        return NextResponse.json({ ok: true, sessionId: existing, state: s.state, appInfo: s.appInfo });
      }
      // dead/terminal → fall through and create a fresh session
    }
    const opts: LivySessionOptions = {
      kind,
      name: `loom-nb-${Date.now()}`,
      driverMemory: '4g', driverCores: 4,
      executorMemory: '4g', executorCores: 4,
      numExecutors: 2,
      ...configure,
    };
    const sess = await createLivySession(pool, opts);
    return NextResponse.json({ ok: true, sessionId: sess.id, state: sess.state, appInfo: sess.appInfo });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Backend probe — lets the editor choose the Spark-pool vs Databricks-cluster
  // picker without committing a session.
  if (req.nextUrl.searchParams.get('probe')) {
    return NextResponse.json({ ok: true, backend: resolveNotebookBackend() });
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
  const pool = req.nextUrl.searchParams.get('pool')?.trim() || '';
  const sessionId = Number(req.nextUrl.searchParams.get('sessionId'));
  if (!pool || !Number.isFinite(sessionId)) {
    return NextResponse.json({ ok: false, error: 'pool and sessionId query params required' }, { status: 400 });
  }
  try {
    // Fire-and-forget keepalive resets the idle clock; never fail the poll on it.
    await keepaliveLivySession(pool, sessionId).catch(() => {});
    const s = await getLivySession(pool, sessionId);
    return NextResponse.json({ ok: true, sessionId, state: s.state, appInfo: s.appInfo });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
  const pool = req.nextUrl.searchParams.get('pool')?.trim() || '';
  const sessionId = Number(req.nextUrl.searchParams.get('sessionId'));
  if (!pool || !Number.isFinite(sessionId)) {
    return NextResponse.json({ ok: false, error: 'pool and sessionId query params required' }, { status: 400 });
  }
  try {
    await killLivySession(pool, sessionId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
