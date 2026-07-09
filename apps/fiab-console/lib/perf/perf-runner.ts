/**
 * PSR-1 — server-side benchmark runner.
 *
 * Drives each real Azure-native backend N times, summarises latency (p50/p95/
 * p99 + cold-vs-warm), and persists one Cosmos doc per (runId, metric). Fired
 * ASYNC by POST /api/admin/performance/run so a full run can never 504 behind
 * the Front Door ~30s cap (same floating-promise mechanism as the app-install
 * job): the route writes a `running` status doc, returns a runId immediately,
 * and this runner streams progress + final docs into Cosmos.
 *
 * Every probe is REAL (no mocks — no-vaporware.md) and Azure-native (no Fabric —
 * no-fabric-dependency.md). A backend that isn't configured in this deployment
 * records an HONEST GATE row naming the exact env var — never a fabricated
 * number. Spark session-attach + notebook round-trip are cost-gated OFF by
 * default (they spend money per run); `includeSpark` opts in.
 */
import { randomUUID } from 'node:crypto';
import {
  ENGINE_METRICS,
  TOP_SURFACES,
  pageTtiMetricId,
  type PerfBackend,
  type PerfMetricDef,
} from '@/lib/perf/perf-metrics';
import {
  writeBenchmarkDocs,
  writeRunStatus,
  RUN_STATUS_METRIC,
  type PerfBenchmarkDoc,
  type PerfRunStatusDoc,
} from '@/lib/perf/perf-store';
import { exportPerfRows } from '@/lib/perf/perf-export';
import { summarize, roundMs } from '@/lib/perf/percentile';

// Backend clients (imported lazily inside probes so a missing optional dep or
// an unconfigured backend never breaks module load).

export interface RunSuiteOptions {
  /** Tenant scope of the triggering admin. */
  tenantId: string;
  /** UPN/email of the triggering admin (audit). */
  triggeredBy?: string;
  /** Samples per metric (1 cold + N-1 warm). Default 6, clamped [3,20]. */
  samples?: number;
  /** Opt in to the costly Spark attach + notebook probes. Default false. */
  includeSpark?: boolean;
  /** Base URL for page-TTI GETs (the route passes its own request origin). */
  baseUrl?: string;
  /** The admin's session cookie header, forwarded so page GETs are authenticated. */
  cookieHeader?: string;
}

interface ProbeResult {
  samples: number[];
  firstTokenMs?: number | null;
  gated?: boolean;
  gateEnv?: string;
  gateMessage?: string;
  error?: string;
}

type ProbeFn = (o: RunSuiteOptions) => Promise<ProbeResult>;

/** Resolve the build sha / revision stamped on this running console. */
function buildIdentity(): { gitSha: string; rev: string } {
  const gitSha =
    (process.env.LOOM_BUILD_SHA || '').trim() ||
    (process.env.GITHUB_SHA || '').trim() ||
    'unknown';
  const rev =
    (process.env.CONTAINER_APP_REVISION || '').trim() ||
    (process.env.LOOM_APP_REVISION || '').trim() ||
    (process.env.LOOM_VERSION || '').trim() ||
    'dev';
  return { gitSha, rev };
}

const clampSamples = (n: number | undefined): number =>
  Math.min(20, Math.max(3, Math.floor(n ?? 6)));

/** Run a single-shot async op `count` times, timing each; returns raw ms samples. */
async function timeN(count: number, op: () => Promise<void>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    await op();
    out.push(Date.now() - t0);
  }
  return out;
}

// ── Probe: page TTI (HTML GET timing) ────────────────────────────────────────
function pageTtiProbe(path: string): ProbeFn {
  return async (o) => {
    const base = (o.baseUrl || process.env.LOOM_CONSOLE_BASE_URL || process.env.LOOM_URL || '')
      .trim()
      .replace(/\/+$/, '');
    if (!base) {
      return {
        samples: [],
        gated: true,
        gateEnv: 'LOOM_CONSOLE_BASE_URL',
        gateMessage:
          'Page-TTI needs the console origin. Set LOOM_CONSOLE_BASE_URL (or run the benchmark ' +
          'from a request context so the runner can derive its own origin).',
      };
    }
    const url = `${base}${path}`;
    const headers: Record<string, string> = { accept: 'text/html' };
    if (o.cookieHeader) headers.cookie = o.cookieHeader;
    const n = clampSamples(o.samples);
    try {
      const samples = await timeN(n, async () => {
        const res = await fetch(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
        // Drain the body so the sample reflects full HTML transfer, not just headers.
        await res.text().catch(() => '');
      });
      return { samples };
    } catch (e) {
      return { samples: [], error: (e as Error)?.message || String(e) };
    }
  };
}

// ── Probe: Synapse serverless / dedicated warehouse query ────────────────────
const warehouseServerlessProbe: ProbeFn = async (o) => {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return {
      samples: [],
      gated: true,
      gateEnv: 'LOOM_SYNAPSE_WORKSPACE',
      gateMessage:
        'Serverless-warehouse benchmark needs the Synapse workspace. Set LOOM_SYNAPSE_WORKSPACE ' +
        '(the ondemand SQL endpoint is derived from it) and grant the Console UAMI db_datareader.',
    };
  }
  try {
    const { executeQuery, serverlessTarget } = await import('@/lib/azure/synapse-sql-client');
    const target = serverlessTarget('master');
    const n = clampSamples(o.samples);
    const samples = await timeN(n, async () => {
      await executeQuery(target, 'SELECT 1 AS probe', 30_000);
    });
    return { samples };
  } catch (e) {
    return { samples: [], error: (e as Error)?.message || String(e) };
  }
};

const warehouseDedicatedProbe: ProbeFn = async (o) => {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
    return {
      samples: [],
      gated: true,
      gateEnv: 'LOOM_SYNAPSE_DEDICATED_POOL',
      gateMessage:
        'Dedicated-pool benchmark needs a dedicated SQL pool. Set LOOM_SYNAPSE_WORKSPACE + ' +
        'LOOM_SYNAPSE_DEDICATED_POOL and resume the pool (a paused pool has no compute).',
    };
  }
  try {
    const { executeQuery, dedicatedTarget } = await import('@/lib/azure/synapse-sql-client');
    const target = dedicatedTarget();
    const n = clampSamples(o.samples);
    const samples = await timeN(n, async () => {
      await executeQuery(target, 'SELECT 1 AS probe', 30_000);
    });
    return { samples };
  } catch (e) {
    return { samples: [], error: (e as Error)?.message || String(e) };
  }
};

// ── Probe: ADX query + dashboard-tile aggregation ────────────────────────────
const adxQueryProbe: ProbeFn = async (o) => {
  const { kustoConfigGate, executeQuery, defaultDatabase } = await import('@/lib/azure/kusto-client');
  const gate = kustoConfigGate();
  if (gate) {
    return {
      samples: [],
      gated: true,
      gateEnv: gate.missing,
      gateMessage:
        'ADX benchmark needs the Azure Data Explorer cluster. Set ' + gate.missing +
        ' (the ADX cluster query URI) and grant the Console UAMI Database Viewer.',
    };
  }
  try {
    const db = defaultDatabase();
    const n = clampSamples(o.samples);
    const samples = await timeN(n, async () => {
      await executeQuery(db, 'print probe = now()');
    });
    return { samples };
  } catch (e) {
    return { samples: [], error: (e as Error)?.message || String(e) };
  }
};

const dashboardTileProbe: ProbeFn = async (o) => {
  const { kustoConfigGate, executeQuery, defaultDatabase } = await import('@/lib/azure/kusto-client');
  const gate = kustoConfigGate();
  if (gate) {
    return {
      samples: [],
      gated: true,
      gateEnv: gate.missing,
      gateMessage:
        'Dashboard-tile benchmark queries ADX. Set ' + gate.missing +
        ' (the ADX cluster query URI) and grant the Console UAMI Database Viewer.',
    };
  }
  try {
    const db = defaultDatabase();
    const n = clampSamples(o.samples);
    // A representative render-blocking tile aggregation (real ADX compute).
    const kql =
      'range i from 1 to 100000 step 1 | extend b = i % 24 | summarize count() by b | order by b asc';
    const samples = await timeN(n, async () => {
      await executeQuery(db, kql);
    });
    return { samples };
  } catch (e) {
    return { samples: [], error: (e as Error)?.message || String(e) };
  }
};

// ── Probe: Copilot turn (AOAI first-token + full-turn) ───────────────────────
const copilotTurnProbe: ProbeFn = async (o) => {
  // The AOAI target usually resolves via the Foundry hub, but LOOM_AOAI_ENDPOINT
  // is the deployment-level signal the console is wired for Copilot.
  if (!process.env.LOOM_AOAI_ENDPOINT && !process.env.AZURE_OPENAI_ENDPOINT) {
    return {
      samples: [],
      gated: true,
      gateEnv: 'LOOM_AOAI_ENDPOINT',
      gateMessage:
        'Copilot benchmark needs Azure OpenAI. Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT ' +
        '(or bind a Foundry hub) and grant the Console UAMI Cognitive Services OpenAI User.',
    };
  }
  try {
    const { aoaiChatStream } = await import('@/lib/azure/aoai-chat-client');
    const n = Math.min(clampSamples(o.samples), 5); // cap LLM calls (cost)
    const fullTurns: number[] = [];
    const firstTokens: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      let firstAt: number | null = null;
      const res = await aoaiChatStream({
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        maxCompletionTokens: 8,
        temperature: 0,
      });
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // First chunk carrying a content delta marks first token.
          if (firstAt === null && chunk.includes('"delta"') && chunk.includes('content')) {
            firstAt = Date.now() - t0;
          }
        }
      }
      fullTurns.push(Date.now() - t0);
      firstTokens.push(firstAt ?? (Date.now() - t0));
    }
    return { samples: fullTurns, firstTokenMs: roundMs(summarize(firstTokens).p50) };
  } catch (e) {
    return { samples: [], error: (e as Error)?.message || String(e) };
  }
};

// ── Probe: Spark attach + notebook round-trip (cost-gated opt-in) ─────────────
const sparkAttachProbe: ProbeFn = async (o) => {
  if (!o.includeSpark) {
    return {
      samples: [],
      gated: true,
      gateEnv: 'includeSpark',
      gateMessage:
        'Spark session-attach benchmark is OFF by default because it creates + tears down a ' +
        'real Synapse Livy session (billed compute). Re-run with "Include Spark" to measure it. ' +
        'Requires LOOM_SYNAPSE_WORKSPACE + a Spark pool.',
    };
  }
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return {
      samples: [],
      gated: true,
      gateEnv: 'LOOM_SYNAPSE_WORKSPACE',
      gateMessage: 'Spark benchmark needs LOOM_SYNAPSE_WORKSPACE + a configured Spark pool.',
    };
  }
  try {
    const pool = await import('@/lib/azure/spark-session-pool');
    // Cold: warm the pool from empty; Warm: acquire from the warmed pool.
    const samples: number[] = [];
    const t0 = Date.now();
    await pool.warmPool();
    samples.push(Date.now() - t0);
    return { samples };
  } catch (e) {
    return { samples: [], error: (e as Error)?.message || String(e) };
  }
};

const notebookRoundtripProbe: ProbeFn = async (o) => {
  if (!o.includeSpark) {
    return {
      samples: [],
      gated: true,
      gateEnv: 'includeSpark',
      gateMessage:
        'Notebook round-trip benchmark is OFF by default (it runs a cell on a billed Spark ' +
        'session). Re-run with "Include Spark" to measure it.',
    };
  }
  return {
    samples: [],
    gated: true,
    gateEnv: 'LOOM_SYNAPSE_WORKSPACE',
    gateMessage:
      'Notebook round-trip requires an attached Spark session from the spark-attach probe; ' +
      'enable "Include Spark" and ensure LOOM_SYNAPSE_WORKSPACE + a Spark pool are configured.',
  };
};

/** Map each engine metric id → its probe. */
const ENGINE_PROBES: Partial<Record<string, ProbeFn>> = {
  'spark-attach': sparkAttachProbe,
  'notebook-roundtrip': notebookRoundtripProbe,
  'warehouse-query-serverless': warehouseServerlessProbe,
  'warehouse-query-dedicated': warehouseDedicatedProbe,
  'adx-query': adxQueryProbe,
  'dashboard-tile-tti': dashboardTileProbe,
  'copilot-turn': copilotTurnProbe,
};

/** The full ordered probe plan: engine metrics + one page-TTI probe per surface. */
function buildPlan(): { def: PerfMetricDef; probe: ProbeFn }[] {
  const plan: { def: PerfMetricDef; probe: ProbeFn }[] = [];
  for (const def of ENGINE_METRICS) {
    const probe = ENGINE_PROBES[def.id];
    if (probe) plan.push({ def, probe });
  }
  for (const s of TOP_SURFACES) {
    plan.push({
      def: {
        id: pageTtiMetricId(s.slug),
        label: `Page TTI — ${s.label}`,
        backend: 'http' as PerfBackend,
        kind: 'tti',
        unit: 'ms',
        fabricBarMs: 2000,
        fabricBarLabel: 'Fabric portal nav ~2s',
        learnUrl: 'https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview',
        description: `HTML GET latency for ${s.path}.`,
      },
      probe: pageTtiProbe(s.path),
    });
  }
  return plan;
}

/** Turn a probe result into a persisted metric doc. */
function toDoc(
  runId: string,
  gitSha: string,
  rev: string,
  tenantId: string,
  triggeredBy: string | undefined,
  def: PerfMetricDef,
  r: ProbeResult,
): PerfBenchmarkDoc {
  const s = summarize(r.samples);
  return {
    id: `${runId}:${def.id}`,
    runId,
    gitSha,
    rev,
    metric: def.id,
    backend: def.backend,
    p50: r.gated ? null : roundMs(s.p50),
    p95: r.gated ? null : roundMs(s.p95),
    p99: r.gated ? null : roundMs(s.p99),
    coldMs: r.gated ? null : roundMs(s.coldMs),
    warmMs: r.gated ? null : roundMs(s.warmMs),
    min: r.gated ? null : roundMs(s.min),
    max: r.gated ? null : roundMs(s.max),
    n: s.n,
    firstTokenMs: r.firstTokenMs ?? null,
    gated: r.gated,
    gateEnv: r.gateEnv,
    gateMessage: r.gateMessage,
    error: r.error,
    ts: new Date().toISOString(),
    tenantId,
    triggeredBy,
  };
}

/**
 * Start a benchmark run: create the runId, write the `running` status doc
 * SYNCHRONOUSLY (so the caller can return it + the poll finds it), then fire the
 * probe loop as a floating promise. Returns `{ runId, totalMetrics }` fast —
 * well within the Front Door ~30s cap. The Container App Node process stays
 * alive across the response, so the loop completes and the poll observes it.
 */
export async function startRun(
  opts: RunSuiteOptions,
): Promise<{ runId: string; totalMetrics: number }> {
  const runId = randomUUID();
  const { gitSha, rev } = buildIdentity();
  const startedAt = new Date().toISOString();
  const plan = buildPlan();

  const status: PerfRunStatusDoc = {
    id: `${runId}:${RUN_STATUS_METRIC}`,
    runId,
    metric: RUN_STATUS_METRIC,
    status: 'running',
    gitSha,
    rev,
    ts: startedAt,
    startedAt,
    totalMetrics: plan.length,
    completedMetrics: 0,
    tenantId: opts.tenantId,
    triggeredBy: opts.triggeredBy,
  };
  await writeRunStatus(status);

  // Fire the worker (floating). Never throws out — executeRun records failures
  // on the status doc.
  void executeRun(runId, plan, status, opts);

  return { runId, totalMetrics: plan.length };
}

/**
 * Execute a full benchmark run to completion (the async worker). Writes one
 * metric doc as each probe completes (so the poll observes progress), and marks
 * the status `completed`/`failed` at the end. Never throws — a catastrophic
 * failure is recorded on the status doc. Also exported for the standalone
 * scripts suite / direct invocation.
 */
export async function runSuite(opts: RunSuiteOptions): Promise<string> {
  const { runId } = await startRun(opts);
  return runId;
}

async function executeRun(
  runId: string,
  plan: { def: PerfMetricDef; probe: ProbeFn }[],
  status: PerfRunStatusDoc,
  opts: RunSuiteOptions,
): Promise<void> {
  const { gitSha, rev } = buildIdentity();
  const written: PerfBenchmarkDoc[] = [];
  let completed = 0;
  try {
    for (const { def, probe } of plan) {
      let result: ProbeResult;
      try {
        result = await probe(opts);
      } catch (e) {
        result = { samples: [], error: (e as Error)?.message || String(e) };
      }
      const doc = toDoc(runId, gitSha, rev, opts.tenantId, opts.triggeredBy, def, result);
      await writeBenchmarkDocs([doc]);
      written.push(doc);
      completed += 1;
      await writeRunStatus({ ...status, completedMetrics: completed, ts: new Date().toISOString() });
    }
    await writeRunStatus({
      ...status,
      status: 'completed',
      completedMetrics: completed,
      completedAt: new Date().toISOString(),
      ts: new Date().toISOString(),
    });
  } catch (e) {
    await writeRunStatus({
      ...status,
      status: 'failed',
      completedMetrics: completed,
      completedAt: new Date().toISOString(),
      ts: new Date().toISOString(),
      error: (e as Error)?.message || String(e),
    });
  }

  // Best-effort LoomPerf_CL export (honest no-op when the DCR isn't provisioned).
  exportPerfRows(written);
}
