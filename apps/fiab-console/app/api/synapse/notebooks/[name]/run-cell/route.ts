/**
 * Run a single notebook cell against a Synapse Spark Big Data pool via the
 * Livy interactive-session API. Backs the notebook-designer "Run cell" button.
 *
 *   POST /api/synapse/notebooks/[name]/run-cell
 *     body { pool, code, kind?, sessionId? }
 *     → creates a Livy session (if no sessionId) and submits the code as a
 *       statement; returns { ok, sessionId, stmtId, state }.
 *
 *   GET  /api/synapse/notebooks/[name]/run-cell?pool=&session=&stmt=
 *     → polls the statement; returns { ok, state, output } where output is the
 *       Livy statement output ({ status, data:{ 'text/plain' }, ename, evalue,
 *       traceback }).
 *
 * Async by design: the Front Door / proxy has a hard ~30s timeout, and a cold
 * Spark pool can take 60-90s to reach 'idle'. POST returns immediately with the
 * session id; the client polls GET until the session is idle and the statement
 * is 'available'. Reusing a sessionId across cells keeps the Spark context warm
 * (notebook semantics — variables persist between cells).
 *
 * Real Synapse Livy REST (api-version 2019-11-01-preview) via synapse-dev-client.
 * Honest 503 gate when LOOM_SYNAPSE_WORKSPACE unset. No mocks.
 *
 * Learn (Livy interactive session — create / submit statement / get statement):
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/get-spark-statement
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Kind = 'pyspark' | 'spark' | 'sql' | 'sparkr';

function gate() {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function normKind(raw: unknown): Kind {
  const l = String(raw || 'pyspark').toLowerCase();
  if (l === 'sql' || l === 'sparksql' || l === 'spark-sql') return 'sql';
  if (l === 'spark' || l === 'scala') return 'spark';
  if (l === 'sparkr' || l === 'r') return 'sparkr';
  return 'pyspark';
}

// Livy interactive sessions are typed; a 'pyspark' session can host pyspark /
// spark / sql statements via per-statement kind, but sparkr needs its own.
function sessionKindFor(stmt: Kind): Kind {
  return stmt === 'sparkr' ? 'sparkr' : 'pyspark';
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const body = await req.json().catch(() => ({}));
  const pool: string = typeof body?.pool === 'string' ? body.pool.trim() : '';
  const code: string = typeof body?.code === 'string' ? body.code : '';
  if (!pool) return NextResponse.json({ ok: false, error: 'pool is required — attach a Spark pool' }, { status: 400 });
  if (!code.trim()) return NextResponse.json({ ok: false, error: 'cell is empty' }, { status: 400 });

  const stmtKind = normKind(body?.kind);
  const existing = typeof body?.sessionId === 'number' ? body.sessionId : Number(body?.sessionId);

  try {
    let sessionId: number;
    if (Number.isFinite(existing) && existing > 0) {
      // Reuse the warm session. Verify it isn't dead before submitting.
      const s = await getLivySession(pool, existing);
      if (['error', 'dead', 'killed', 'shutting_down', 'success'].includes(String(s.state))) {
        const fresh = await createLivySessionAsync(pool, sessionKindFor(stmtKind));
        sessionId = fresh.id;
      } else {
        sessionId = existing;
      }
    } else {
      const fresh = await createLivySessionAsync(pool, sessionKindFor(stmtKind));
      sessionId = fresh.id;
    }

    // Probe current session state; only submit the statement once idle.
    const s = await getLivySession(pool, sessionId);
    if (s.state !== 'idle') {
      // Still warming up — hand the session id back so the client polls until
      // idle, then re-POSTs with the same sessionId to submit.
      return NextResponse.json({ ok: true, sessionId, stmtId: null, state: s.state, sessionWarming: true });
    }

    const stmt = await submitLivyStatement(pool, sessionId, { code, kind: stmtKind });
    return NextResponse.json({ ok: true, sessionId, stmtId: stmt.id, state: stmt.state || 'running' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const pool = req.nextUrl.searchParams.get('pool')?.trim() || '';
  const sessionId = Number(req.nextUrl.searchParams.get('session'));
  const stmtParam = req.nextUrl.searchParams.get('stmt');
  if (!pool || !Number.isFinite(sessionId)) {
    return NextResponse.json({ ok: false, error: 'pool and session query params required' }, { status: 400 });
  }

  try {
    // No stmt → caller is polling for the session to become idle.
    if (stmtParam == null || stmtParam === '') {
      const s = await getLivySession(pool, sessionId);
      return NextResponse.json({ ok: true, sessionId, sessionState: s.state, appInfo: s.appInfo });
    }
    const stmtId = Number(stmtParam);
    if (!Number.isFinite(stmtId)) {
      return NextResponse.json({ ok: false, error: 'stmt must be a number' }, { status: 400 });
    }
    const st = await getLivyStatement(pool, sessionId, stmtId);
    return NextResponse.json({ ok: true, sessionId, stmtId, state: st.state, output: st.output ?? null });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
