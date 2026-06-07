/**
 * BFF for Delta Lake table maintenance — OPTIMIZE / VACUUM / ZORDER BY.
 *
 * Azure-native, NO Fabric: maintenance SQL runs on a Synapse Spark Livy
 * interactive session against Delta tables stored in ADLS Gen2 (abfss://). The
 * Fabric Lakehouse "Maintenance" dialog runs the same three Spark SQL commands;
 * Loom's Azure-native equivalent submits them to Synapse Spark. No Fabric
 * capacity, OneLake API, or Power BI workspace is touched.
 *
 *   POST /api/lakehouse/maintenance   → submit a maintenance job (Livy session)
 *   GET  /api/lakehouse/maintenance   → list + lazily refresh this tenant's jobs
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 * Envelope: { ok, ... } / { ok:false, error, code?, hint? } with HTTP status.
 *
 * Grants this relies on (all pre-existing, see synapse-storage-rbac.bicep +
 * synapse.bicep + cosmos.bicep):
 *   - Synapse workspace MSI: Storage Blob Data Contributor on the DLZ ADLS
 *     account → Spark executors rewrite compacted Parquet + _delta_log.
 *   - Console UAMI: Synapse Administrator at the workspace → Livy session +
 *     statement submission from the BFF.
 *   - Console UAMI: Cosmos DB Built-in Data Contributor → maintenance-jobs rows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { getAccountName } from '@/lib/azure/adls-client';
import { maintenanceJobsContainer } from '@/lib/azure/cosmos-client';
import {
  createLivySessionAsync,
  getLivySession,
  submitLivyStatement,
  getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import {
  validateMaintenanceRequest,
  buildMaintenancePySpark,
} from '@/lib/azure/delta-maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type JobState = 'starting' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface MaintenanceJobDoc {
  id: string;
  tenantId: string;        // partition key (session oid)
  container: string;
  tableName: string;
  pool: string;
  ops: string[];
  code: string;            // the pyspark statement (kept for late submission)
  account: string;
  sessionId: number;
  statementId?: number;
  state: JobState;
  detail?: string;         // last error / status detail
  submittedAt: string;
  updatedAt: string;
  submittedBy: string;
}

const TERMINAL: JobState[] = ['succeeded', 'failed', 'cancelled'];

/** Strip HTML + collapse whitespace so a firewall page / stack never leaks raw. */
function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const v = validateMaintenanceRequest(body);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  const reqVal = v.value;

  // Resolve the DLZ ADLS account from LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL.
  // Honest infra-gate if storage isn't wired up — never a Fabric gate.
  let account: string;
  try {
    account = getAccountName();
  } catch {
    return NextResponse.json({
      ok: false,
      code: 'adls_unconfigured',
      error: 'No Loom ADLS Gen2 account is configured on the Console, so Delta maintenance has no target storage.',
      hint: 'Set LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL on the Console Container App (admin-plane bicep apps[].env). These are emitted by the DLZ storage bicep module.',
    }, { status: 503 });
  }

  const { code, ops } = buildMaintenancePySpark(reqVal, account);

  // Create the Livy interactive session (pyspark). On a cold/auto-paused pool
  // this returns in 'starting' / 'not_started' — we do NOT block on warm-up.
  // The statement is submitted lazily on the first GET once the session is idle.
  let sessionId: number;
  let sessionState: string;
  try {
    const sess = await createLivySessionAsync(reqVal.pool, 'pyspark', `loom-maint-${Date.now()}`);
    sessionId = sess.id;
    sessionState = sess.state || 'starting';
  } catch (e: any) {
    const msg = sanitize(e);
    const denied = /\b401\b|\b403\b|forbidden|denied|not allowed|authoriz/i.test(msg);
    return NextResponse.json({
      ok: false,
      code: denied ? 'livy_access_denied' : 'livy_submit_error',
      error: denied
        ? `The Console identity could not start a Spark session on pool "${reqVal.pool}". Grant the Console UAMI Synapse Administrator on the workspace (LOOM_SYNAPSE_WORKSPACE), then retry. (${msg})`
        : `Could not start the Spark session on pool "${reqVal.pool}": ${msg}`,
      hint: 'Confirm LOOM_SYNAPSE_WORKSPACE is set and the named Spark pool exists + is not deleted.',
    }, { status: 502 });
  }

  const now = new Date().toISOString();
  const doc: MaintenanceJobDoc = {
    id: randomUUID(),
    tenantId: session.claims.oid,
    container: reqVal.container,
    tableName: reqVal.tableName,
    pool: reqVal.pool,
    ops,
    code,
    account,
    sessionId,
    state: 'starting',
    submittedAt: now,
    updatedAt: now,
    submittedBy: session.claims.upn,
  };

  try {
    const c = await maintenanceJobsContainer();
    await c.items.upsert(doc);
  } catch (e: any) {
    // The Livy session is already running; surface the persistence failure but
    // do not pretend the job didn't start.
    return NextResponse.json({
      ok: false,
      code: 'job_persist_error',
      error: `Spark session ${sessionId} started on "${reqVal.pool}", but the job record could not be saved: ${sanitize(e)}`,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    jobId: doc.id,
    sessionId,
    pool: reqVal.pool,
    state: 'starting',
    sessionState,
    ops,
  });
}

/**
 * Lazily advance a single job's state by polling its Livy session/statement.
 * Mutates + persists the doc. Best-effort: a poll error is recorded as detail
 * but never throws (so one bad job can't break the whole list).
 */
async function refreshJob(doc: MaintenanceJobDoc, container: Awaited<ReturnType<typeof maintenanceJobsContainer>>): Promise<MaintenanceJobDoc> {
  if (TERMINAL.includes(doc.state)) return doc;
  try {
    if (doc.statementId === undefined) {
      // Statement not yet submitted — check whether the session is ready.
      const sess = await getLivySession(doc.pool, doc.sessionId);
      const st = (sess.state || '').toLowerCase();
      if (st === 'idle') {
        const stmt = await submitLivyStatement(doc.pool, doc.sessionId, { code: doc.code, kind: 'pyspark' });
        doc.statementId = stmt.id;
        doc.state = 'running';
        doc.detail = undefined;
      } else if (st === 'error' || st === 'dead' || st === 'killed' || st === 'shutting_down') {
        doc.state = 'failed';
        doc.detail = `Spark session entered '${sess.state}' before the statement could run.`;
      } else {
        doc.state = 'starting';
        doc.detail = `Spark session ${doc.sessionId} is ${sess.state} — waiting for it to become idle.`;
      }
    } else {
      // Statement submitted — poll its outcome.
      const stmt = await getLivyStatement(doc.pool, doc.sessionId, doc.statementId);
      const st = (stmt.state || '').toLowerCase();
      if (st === 'available') {
        const outStatus = (stmt.output?.status || '').toLowerCase();
        if (outStatus === 'error') {
          doc.state = 'failed';
          doc.detail = sanitize({ message: `${stmt.output?.ename || 'error'}: ${stmt.output?.evalue || 'statement failed'}` });
        } else {
          doc.state = 'succeeded';
          // Capture the printed receipt line if present.
          const text = stmt.output?.data?.['text/plain'];
          if (typeof text === 'string') {
            const m = text.match(/loom-maintenance-result\s+(.+)/);
            doc.detail = m ? m[1].slice(0, 600) : 'OPTIMIZE/VACUUM completed.';
          } else {
            doc.detail = 'OPTIMIZE/VACUUM completed.';
          }
        }
      } else if (st === 'error') {
        doc.state = 'failed';
        doc.detail = 'Statement returned an error.';
      } else if (st === 'cancelled' || st === 'cancelling') {
        doc.state = 'cancelled';
      } else {
        doc.state = 'running';
      }
    }
  } catch (e: any) {
    // Don't flip to failed on a transient poll error — keep prior state, note it.
    doc.detail = `poll error: ${sanitize(e)}`;
  }
  doc.updatedAt = new Date().toISOString();
  try { await container.items.upsert(doc); } catch { /* best-effort persistence */ }
  return doc;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const tenantId = session.claims.oid;
  const containerFilter = req.nextUrl.searchParams.get('container')?.trim() || '';
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit')) || 50, 1), 200);

  let jobs: MaintenanceJobDoc[];
  try {
    const c = await maintenanceJobsContainer();
    const query = containerFilter
      ? {
          query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.container = @ct ORDER BY c.submittedAt DESC OFFSET 0 LIMIT @n',
          parameters: [{ name: '@t', value: tenantId }, { name: '@ct', value: containerFilter }, { name: '@n', value: limit }],
        }
      : {
          query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.submittedAt DESC OFFSET 0 LIMIT @n',
          parameters: [{ name: '@t', value: tenantId }, { name: '@n', value: limit }],
        };
    const { resources } = await c.items.query<MaintenanceJobDoc>(query, { partitionKey: tenantId }).fetchAll();
    jobs = resources;

    // Lazily refresh non-terminal jobs (poll Livy, submit pending statements).
    const refreshed = await Promise.all(jobs.map((j) => (TERMINAL.includes(j.state) ? Promise.resolve(j) : refreshJob(j, c))));
    jobs = refreshed;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
  }

  // Never leak the full code blob to the list view.
  const safe = jobs.map(({ code, ...rest }) => rest);
  return NextResponse.json({ ok: true, jobs: safe });
}
