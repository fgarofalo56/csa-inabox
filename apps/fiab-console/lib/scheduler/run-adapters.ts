/**
 * run-adapters — the per-JobKind adapters that let the unified scheduler
 * (rel-T81) TRIGGER a REAL Azure-native backend run and capture its outcome.
 *
 * Each adapter reuses the EXISTING data-plane client (no new backend code, no
 * mocks): ADF `runPipeline`, ADX `executeMgmtCommand`/`executeQuery`, AML
 * serverless-Spark `submitAmlSparkCell`, Synapse Livy `createLivySession` +
 * `submitLivyStatement`. Clients are lazily imported so this module stays light
 * and only pulls the SDK for the backend actually invoked — the same pattern the
 * notebook execute-spark route uses.
 *
 * Contract:  triggerRun(schedule) → { status, runId?, exitValue?, error? }
 *   • status 'succeeded' | 'failed' — a terminal result was captured
 *   • status 'running'             — the backend accepted the run; the runId is
 *                                    the poll handle (ADF runId / AML jobName /
 *                                    Livy session id). Honest: the job really
 *                                    started; a terminal state wasn't reached in
 *                                    the request's bounded poll budget.
 *   • error is a SAFE, genericized message (never a raw stack / connection string)
 *
 * gateFor(kind) → { missing } | null  — the honest infra gate for a job kind, so
 *   the UI can render a precise MessageBar (env var / role to provision) and a
 *   scheduled tick can skip a not-configured backend without throwing.
 */

import type { JobKind, ScheduleDoc } from '@/lib/azure/scheduler-store';

export interface TriggerResult {
  status: 'running' | 'succeeded' | 'failed';
  runId?: string;
  exitValue?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Genericize any thrown value into a short, client-safe message. */
function safeMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  // strip anything that looks like a URL / token / connection string
  const cleaned = raw.replace(/https?:\/\/\S+/g, '').replace(/[A-Za-z0-9_-]{40,}/g, '').trim();
  return (cleaned || fallback).slice(0, 400);
}

/**
 * Honest per-kind config gate. Returns the first missing env var (or a role
 * hint) when the backend isn't configured in this deployment, else null.
 */
export async function gateFor(kind: JobKind): Promise<{ missing: string } | null> {
  switch (kind) {
    case 'adf-pipeline': {
      const { adfConfigGate } = await import('@/lib/azure/adf-client');
      return adfConfigGate();
    }
    case 'adx-command': {
      const { kustoConfigGate } = await import('@/lib/azure/kusto-client');
      return kustoConfigGate();
    }
    case 'aml-spark': {
      const { isAmlSparkConfigured } = await import('@/lib/azure/aml-spark-client');
      return isAmlSparkConfigured() ? null : { missing: 'LOOM_AML_SPARK' };
    }
    case 'synapse-livy': {
      const hasPool =
        process.env.LOOM_SYNAPSE_SPARK_POOL ||
        process.env.LOOM_SPARK_POOL ||
        process.env.LOOM_DEFAULT_SPARK_POOL;
      const hasWs = process.env.LOOM_SYNAPSE_WORKSPACE;
      if (!hasWs) return { missing: 'LOOM_SYNAPSE_WORKSPACE' };
      if (!hasPool) return { missing: 'LOOM_SYNAPSE_SPARK_POOL' };
      return null;
    }
    default:
      return { missing: 'unknown job kind' };
  }
}

// ── ADF pipeline ─────────────────────────────────────────────────────────────
async function runAdf(s: ScheduleDoc): Promise<TriggerResult> {
  const { runPipeline, listPipelineRuns } = await import('@/lib/azure/adf-client');
  const name = s.jobConfig.pipelineName?.trim();
  if (!name) return { status: 'failed', error: 'pipelineName is required for an ADF pipeline job' };
  try {
    const { runId } = await runPipeline(name, s.jobConfig.pipelineParameters || {});
    // ONE status lookup so the run history shows an immediate state, not just
    // "accepted". ADF pipeline runs are async — running is the truthful outcome.
    let status: TriggerResult['status'] = 'running';
    try {
      const runs = await listPipelineRuns(name, 1);
      const hit = runs.find((r: any) => r.runId === runId) || runs[0];
      const st = String(hit?.status || '').toLowerCase();
      if (st === 'succeeded') status = 'succeeded';
      else if (st === 'failed' || st === 'cancelled') status = 'failed';
    } catch { /* status lookup best-effort */ }
    return { status, runId, exitValue: `runId ${runId}` };
  } catch (e) {
    return { status: 'failed', error: safeMessage(e, 'ADF pipeline run failed') };
  }
}

// ── ADX command / query (synchronous) ────────────────────────────────────────
async function runAdx(s: ScheduleDoc): Promise<TriggerResult> {
  const { executeMgmtCommand, executeQuery, KustoError } = await import('@/lib/azure/kusto-client');
  const db = s.jobConfig.database?.trim();
  const cmd = s.jobConfig.command?.trim();
  if (!db) return { status: 'failed', error: 'database is required for an ADX command job' };
  if (!cmd) return { status: 'failed', error: 'command is required for an ADX command job' };
  try {
    const isMgmt = cmd.startsWith('.');
    const result = isMgmt ? await executeMgmtCommand(db, cmd) : await executeQuery(db, cmd);
    return {
      status: 'succeeded',
      exitValue: `${result.rowCount} row(s), ${result.executionMs}ms`,
    };
  } catch (e) {
    const status = e instanceof KustoError ? e.status : undefined;
    return { status: 'failed', error: safeMessage(e, `ADX command failed${status ? ` (${status})` : ''}`) };
  }
}

// ── AML serverless Spark ─────────────────────────────────────────────────────
async function runAmlSpark(s: ScheduleDoc): Promise<TriggerResult> {
  const { submitAmlSparkCell, getAmlSparkJob, AmlSparkNotConfiguredError } = await import(
    '@/lib/azure/aml-spark-client'
  );
  const code = s.jobConfig.code?.trim();
  if (!code) return { status: 'failed', error: 'code is required for an AML Spark job' };
  try {
    const { jobName } = await submitAmlSparkCell(code, s.id);
    // Bounded poll — try to capture a terminal state without stalling the request.
    let status: TriggerResult['status'] = 'running';
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      try {
        const job = await getAmlSparkJob(jobName);
        if (job.terminal) { status = job.succeeded ? 'succeeded' : 'failed'; break; }
      } catch { /* keep polling */ }
    }
    return { status, runId: jobName, exitValue: `job ${jobName}` };
  } catch (e) {
    if (e instanceof AmlSparkNotConfiguredError) {
      return { status: 'failed', error: `Azure ML serverless Spark not configured: ${e.missing?.join(', ')}` };
    }
    return { status: 'failed', error: safeMessage(e, 'AML Spark job submission failed') };
  }
}

// ── Synapse Livy (Spark) ─────────────────────────────────────────────────────
async function runSynapseLivy(s: ScheduleDoc): Promise<TriggerResult> {
  const { createLivySession, getLivySession, submitLivyStatement, getLivyStatement, defaultSparkPool } =
    await import('@/lib/azure/synapse-livy-client');
  const code = s.jobConfig.code?.trim();
  if (!code) return { status: 'failed', error: 'code is required for a Synapse Spark job' };
  const pool = s.jobConfig.sparkPoolName?.trim() || defaultSparkPool();
  try {
    const sess = await createLivySession(pool, { kind: 'pyspark', name: `loom-sched-${s.id}-${Date.now()}` });
    const sessionId = sess.id;
    // Bounded wait for the session to reach 'idle' before submitting the code.
    let idle = false;
    for (let i = 0; i < 8; i++) {
      await sleep(3000);
      try {
        const cur = await getLivySession(pool, sessionId);
        if (cur.state === 'idle') { idle = true; break; }
        if (cur.state === 'error' || cur.state === 'dead' || cur.state === 'killed') {
          return { status: 'failed', runId: `session ${sessionId}`, error: `Spark session ${cur.state}` };
        }
      } catch { /* keep waiting */ }
    }
    if (!idle) {
      // Honest: the Spark session really started but wasn't ready inside the
      // request budget. The run is recorded as running with the session handle.
      return { status: 'running', runId: `session ${sessionId}`, exitValue: `Spark session ${sessionId} starting` };
    }
    const stmt = await submitLivyStatement(pool, sessionId, code, 'pyspark');
    let stmtId = stmt.id;
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const cur = await getLivyStatement(pool, sessionId, stmtId);
      if (cur.state === 'available') {
        const ok = (cur.output as any)?.status !== 'error';
        return {
          status: ok ? 'succeeded' : 'failed',
          runId: `session ${sessionId} / stmt ${stmtId}`,
          exitValue: ok ? 'statement available' : undefined,
          error: ok ? undefined : safeMessage((cur.output as any)?.evalue, 'Spark statement error'),
        };
      }
      if (cur.state === 'error' || cur.state === 'cancelled') {
        return { status: 'failed', runId: `session ${sessionId} / stmt ${stmtId}`, error: `statement ${cur.state}` };
      }
    }
    return { status: 'running', runId: `session ${sessionId} / stmt ${stmtId}`, exitValue: 'statement still running' };
  } catch (e) {
    return { status: 'failed', error: safeMessage(e, 'Synapse Spark job failed') };
  }
}

/**
 * Trigger the REAL backend run for a schedule. The caller (run-now route or the
 * tick evaluator) records the returned {@link TriggerResult} as a run history
 * doc — no mock arrays, no placeholder returns.
 */
export async function triggerRun(schedule: ScheduleDoc): Promise<TriggerResult> {
  switch (schedule.jobKind) {
    case 'adf-pipeline':
      return runAdf(schedule);
    case 'adx-command':
      return runAdx(schedule);
    case 'aml-spark':
      return runAmlSpark(schedule);
    case 'synapse-livy':
      return runSynapseLivy(schedule);
    default:
      return { status: 'failed', error: `unsupported job kind: ${schedule.jobKind}` };
  }
}
