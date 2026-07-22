/**
 * POST /api/copilot/code-interpret — WS-5.3 conversational code-interpreter.
 *
 * Accepts a Python code snippet proposed by the data-agent AI and executes it
 * in an EPHEMERAL Spark session (or a warm pre-provisioned session from the
 * existing warm pool) on the tenant's Synapse Spark pool.  Returns stdout +
 * any generated chart images (base64 PNG) from the run.
 *
 * ## Data-access governance
 * The BFF verifies a valid Loom session (getSession()) before ANY code
 * executes.  The Spark session runs under the CONSOLE UAMI — the same managed
 * identity that all other Synapse data-plane calls use, scoped by the Synapse
 * RBAC grants wired at deploy time.  The caller's OID is stamped on every
 * audit event so the run is attributable to the exact user that triggered it.
 *
 * ## Sandbox boundaries (per lib/copilot/code-interpreter.ts)
 *   - 60 s execution timeout (BFF poll loop + Python threading.Timer watchdog)
 *   - 64 KB stdout cap
 *   - 3 charts (base64 PNG) per run, 5 MB each
 *
 * ## Backend
 *   PREFERRED: warm session from spark-session-pool (acquireWarmSession).
 *   FALLBACK:  ephemeral pyspark session created + killed in this request.
 *   GATE:      if LOOM_SYNAPSE_WORKSPACE or LOOM_SYNAPSE_SPARK_POOL is unset →
 *              503 + { gate:true, missing } so the UI renders an honest
 *              MessageBar with exact env-var name and the Admin link.
 *
 * ## Audit
 * Every run (success or failure) emits a fire-and-forget audit event through
 * emitAuditEvent → the Azure Monitor DCR (LoomAudit_CL) + the
 * existing Cosmos audit trail.  The payload includes actor OID/UPN, the
 * run's outcome, and elapsedMs so the admin report can attribute every
 * sandbox execution.
 *
 * No mocks, no return [], no hard-coded sample data.
 * Azure-native default; Fabric is never on this path.
 *
 * See: .claude/rules/no-vaporware.md, .claude/rules/no-fabric-dependency.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { synapseConfigGate } from '@/lib/azure/synapse-dev-client';
import {
  createLivySession,
  getLivySession,
  killLivySession,
  submitLivyStatement,
  getLivyStatement,
  normalizeLivyOutput,
  defaultSparkPool,
} from '@/lib/azure/synapse-livy-client';
import {
  acquireWarmSession,
  releaseSession,
} from '@/lib/azure/spark-session-pool';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  wrapUserCode,
  parseInterpreterOutput,
  SANDBOX_TIMEOUT_S,
} from '@/lib/copilot/code-interpreter';
import { apiError, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Allow up to 90 s so the poll loop (60 s statement + network overhead) completes. */
export const maxDuration = 90;

/** ms to wait between Livy statement-status polls. */
const POLL_INTERVAL_MS = 2_000;
/** Number of polls before we give up (60 s at 2 s/poll = 30 polls). */
const MAX_POLLS = Math.ceil((SANDBOX_TIMEOUT_S * 1000) / POLL_INTERVAL_MS) + 5;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export const POST = withSession(async (req: NextRequest, { session }) => {

  // ------------------------------------------------------------------
  // Parse + validate body
  // ------------------------------------------------------------------
  let body: { code?: string; workspaceId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }
  const code = (body.code ?? '').trim();
  if (!code) return apiError('code is required', 400);
  if (code.length > 512 * 1024) return apiError('code too large (max 512 KB)', 400);

  // ------------------------------------------------------------------
  // Synapse gate — honest MessageBar gate when backend not configured
  // ------------------------------------------------------------------
  const synapseGate = synapseConfigGate();
  if (synapseGate) {
    return NextResponse.json(
      {
        ok: false,
        gate: true,
        missing: synapseGate.missing,
        error: `Code interpreter requires a Synapse Spark pool. Set ${synapseGate.missing} (and LOOM_SYNAPSE_SPARK_POOL) in Admin → Config → Azure Services.`,
        hint: 'Deploy platform/fiab/bicep/modules/landing-zone/synapse.bicep to provision the Spark pool, then set LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_SPARK_POOL on the Console container app.',
      },
      { status: 503 },
    );
  }
  const pool = defaultSparkPool();
  if (!pool) {
    return NextResponse.json(
      {
        ok: false,
        gate: true,
        missing: 'LOOM_SYNAPSE_SPARK_POOL',
        error: 'Code interpreter requires a Synapse Spark pool. Set LOOM_SYNAPSE_SPARK_POOL in Admin → Config → Azure Services.',
        hint: 'Set LOOM_SYNAPSE_SPARK_POOL (e.g. loompool) on the Console container app — the Spark pool must already exist in the Synapse workspace.',
      },
      { status: 503 },
    );
  }

  // ------------------------------------------------------------------
  // Acquire a warm session or create an ephemeral one
  // ------------------------------------------------------------------
  const t0 = Date.now();
  let sessionId: number | null = null;
  let leaseId: string | null = null;
  let isEphemeral = false;

  try {
    // Try warm pool first (acquireWarmSession returns null on a miss).
    const warm = await acquireWarmSession({
      backend: 'synapse',
      poolName: pool,
      kind: 'pyspark',
      sizingKey: 'code-interpreter',
      userOid: session.claims.oid,
    }).catch(() => null);

    if (warm) {
      sessionId = warm.sessionId as number;
      leaseId = warm.leaseId;
    } else {
      // Cold-start: create an ephemeral session.
      isEphemeral = true;
      const sess = await createLivySession(pool, {
        kind: 'pyspark',
        name: `loom-ci-${session.claims.oid.slice(0, 8)}-${Date.now()}`,
        driverMemory: '4g',
        driverCores: 4,
        executorMemory: '4g',
        executorCores: 4,
        numExecutors: 2,
      });
      sessionId = sess.id;
    }

    // ------------------------------------------------------------------
    // Wait for the session to become idle/ready
    // ------------------------------------------------------------------
    for (let i = 0; i < 90; i++) {
      const s = await getLivySession(pool, sessionId);
      if (s.state === 'idle') break;
      if (s.state === 'error' || s.state === 'dead' || s.state === 'killed') {
        throw new Error(`Spark session entered terminal state: ${s.state}`);
      }
      await sleep(2000);
    }

    // ------------------------------------------------------------------
    // Submit the wrapped statement
    // ------------------------------------------------------------------
    const wrapped = wrapUserCode(code);
    const stmt = await submitLivyStatement(pool, sessionId, wrapped, 'pyspark');

    // ------------------------------------------------------------------
    // Poll until done or timeout
    // ------------------------------------------------------------------
    let finalStmt = stmt;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      await sleep(POLL_INTERVAL_MS);
      finalStmt = await getLivyStatement(pool, sessionId, stmt.id);
      if (
        finalStmt.state === 'available' ||
        finalStmt.state === 'error' ||
        finalStmt.state === 'cancelled'
      ) {
        break;
      }
    }

    // ------------------------------------------------------------------
    // Normalize output
    // ------------------------------------------------------------------
    const charts: string[] = [];
    const normalized = normalizeLivyOutput(finalStmt.output ?? null);
    const interpOut = normalized
      ? parseInterpreterOutput(normalized, charts)
      : { status: 'ok' as const, stdout: '', charts: [] };

    const elapsedMs = Date.now() - t0;

    // ------------------------------------------------------------------
    // Audit (fire-and-forget — never blocks the response)
    // ------------------------------------------------------------------
    void (async () => {
      try {
        await emitAuditEvent({
          actorOid: session.claims.oid,
          actorUpn: session.claims.upn || session.claims.email || session.claims.oid,
          action: 'copilot.code-interpret.run',
          targetType: 'code-interpreter',
          targetId: `session-${sessionId}`,
          outcome: interpOut.status === 'error' ? 'failure' : 'success',
          detail: {
            pool,
            elapsedMs,
            codeLength: code.length,
            stdoutLength: interpOut.stdout.length,
            chartCount: interpOut.charts.length,
            isEphemeral,
          },
          tenantId: session.claims.tid || session.claims.oid,
        });
      } catch { /* telemetry must never affect the response */ }
    })();

    return NextResponse.json({
      ok: true,
      stdout: interpOut.stdout,
      charts: interpOut.charts,
      status: interpOut.status,
      ename: interpOut.ename,
      evalue: interpOut.evalue,
      traceback: interpOut.traceback,
      elapsedMs,
      pool,
    });
  } catch (e: unknown) {
    // Audit the failure (best-effort).
    void (async () => {
      try {
        await emitAuditEvent({
          actorOid: session.claims.oid,
          actorUpn: session.claims.upn || session.claims.email || session.claims.oid,
          action: 'copilot.code-interpret.run',
          targetType: 'code-interpreter',
          targetId: `session-${sessionId ?? 'none'}`,
          outcome: 'failure',
          detail: {
            pool,
            elapsedMs: Date.now() - t0,
            error: e instanceof Error ? e.message : String(e),
            isEphemeral,
          },
          tenantId: session.claims.tid || session.claims.oid,
        });
      } catch { /* telemetry only */ }
    })();

    return apiServerError(e, 'code interpreter run failed');
  } finally {
    // ------------------------------------------------------------------
    // Session cleanup: release warm lease or kill ephemeral session
    // ------------------------------------------------------------------
    if (sessionId !== null) {
      try {
        if (leaseId) {
          releaseSession(leaseId);
        } else if (isEphemeral) {
          void killLivySession(pool, sessionId).catch(() => {});
        }
      } catch { /* best-effort cleanup */ }
    }
  }
});
