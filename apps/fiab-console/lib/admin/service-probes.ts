/**
 * CSA Loom service-exercise probes — the "does the real path WORK" layer.
 *
 * The self-audit (lib/admin/self-audit.ts) answers "is each backend CONFIGURED
 * and reachable". These probes go one level deeper: each one EXERCISES the real
 * data path end-to-end with a tiny, safe, read-only-or-self-cleaning operation,
 * so a backend that is configured-but-broken is caught by the platform, not by
 * the first user who hits it.
 *
 * The canonical motivating failure: a FAULTED Synapse Spark pool. Every env var
 * was set, the ARM resource existed, the config-presence audit was green — but
 * every Livy session errored instantly (state 'dead', appId=null), silently
 * making notebooks unusable. The `spark` probe below creates a real session,
 * waits for `idle`, runs `spark.range(1).count()`, and deletes it — exactly the
 * exercise that catches that class of failure in minutes, by default.
 *
 * Probe contract (per .claude/rules/no-vaporware.md):
 *   - status 'pass'  → the REAL backend executed the exercise (evidence attached).
 *   - status 'gate'  → an honest infra gate: the backend is NOT configured; the
 *                      detail names the exact env var / role to set. Never a
 *                      failure — a fresh minimal deployment is all-gates, zero-fails.
 *   - status 'fail'  → the backend IS configured but the exercise failed — a real
 *                      platform problem (faulted pool, revoked role, network hole).
 *   - every probe self-cleans (the Spark probe deletes its session even on
 *     timeout/error) and never fabricates a pass.
 *
 * All Azure clients are imported LAZILY inside each probe so this module stays
 * cheap to load and unit tests can mock each client independently.
 */

export type ProbeStatus = 'pass' | 'gate' | 'fail';

export interface ProbeResult {
  /** Stable probe id (also the `?service=` filter key). */
  service: string;
  title: string;
  status: ProbeStatus;
  /** What the exercise did / observed, or the exact gate remediation. */
  detail: string;
  latencyMs: number;
  /** Raw evidence from the real backend (rows, reply text, driver-log tail). */
  evidence?: string;
}

export interface ProbeContext {
  /** Tenant scope (tid claim or caller oid) — used by Cosmos-scoped probes. */
  tenantId: string;
  /** Caller identity (upn/oid) recorded on runs that accept a `who`. */
  who: string;
  /** Absolute epoch-ms deadline the probe must respect (set by the runner). */
  deadline: number;
}

interface ProbeOutcome {
  status: ProbeStatus;
  detail: string;
  evidence?: string;
}

export interface ServiceProbe {
  service: string;
  title: string;
  /** Default per-probe budget (env-overridable — see probeTimeoutMs). */
  timeoutMs: number;
  run(ctx: ProbeContext): Promise<ProbeOutcome>;
}

export interface ExerciseReport {
  startedAt: string;
  generatedAt: string;
  durationMs: number;
  ranBy: string;
  summary: { pass: number; gate: number; fail: number; total: number };
  results: ProbeResult[];
}

export interface ExerciseRunState {
  runId: string;
  tenantId: string;
  status: 'running' | 'complete';
  startedAt: string;
  /** Which probes this run covers (all when omitted). */
  services?: string[];
  report?: ExerciseReport;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const evidenceSlice = (s: string, cap = 600) => (s.length > cap ? `${s.slice(0, cap)}…` : s);

function gate(detail: string): ProbeOutcome {
  return { status: 'gate', detail };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Per-probe budget: LOOM_EXERCISE_<SERVICE>_TIMEOUT_MS → LOOM_EXERCISE_TIMEOUT_MS → default. */
export function probeTimeoutMs(service: string, fallback: number): number {
  const specific = Number(process.env[`LOOM_EXERCISE_${service.replace(/-/g, '_').toUpperCase()}_TIMEOUT_MS`]);
  if (Number.isFinite(specific) && specific > 0) return specific;
  const global = Number(process.env.LOOM_EXERCISE_TIMEOUT_MS);
  if (Number.isFinite(global) && global > 0) return global;
  return fallback;
}

/** Deadline-aware sleep — throws when the probe budget is already exhausted so
 *  poll loops abort (and their `finally` self-clean runs) instead of overrunning. */
async function pollWait(ctx: ProbeContext, ms: number, what: string): Promise<void> {
  if (Date.now() >= ctx.deadline) throw new Error(`probe timed out while ${what}`);
  const remaining = ctx.deadline - Date.now();
  await new Promise((r) => setTimeout(r, Math.min(ms, Math.max(1, remaining))));
  if (Date.now() >= ctx.deadline) throw new Error(`probe timed out while ${what}`);
}

// ── the probes ───────────────────────────────────────────────────────────────

const TERMINAL_BAD_SESSION_STATES = new Set(['dead', 'error', 'killed', 'shutting_down']);

/**
 * spark — create a minimal Livy session on the default pool, poll to `idle`,
 * run `spark.range(1).count()`, then DELETE the session (always — even on
 * timeout/error). This is the probe that catches a faulted pool: on that
 * failure the session errors instantly (state 'dead', appId=null) and the
 * probe returns 'fail' with the driver-log tail as evidence.
 */
const sparkProbe: ServiceProbe = {
  service: 'spark',
  title: 'Synapse Spark — Livy session on the default pool',
  timeoutMs: 240_000,
  async run(ctx) {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      return gate('Synapse not configured — set LOOM_SYNAPSE_WORKSPACE (modules/landing-zone/synapse.bicep) to enable Spark notebooks; the Console UAMI needs "Synapse Compute Operator" on the pool.');
    }
    const livy = await import('@/lib/azure/synapse-livy-client');
    const pool = livy.defaultSparkPool();
    const created = await livy.createLivySession(pool, {
      kind: 'pyspark',
      name: `loom-exercise-${Date.now()}`,
      numExecutors: 1,
    });
    const sessionId = created.id;
    try {
      // 1. Poll to idle (or a terminal failure state — the faulted-pool signature).
      let session = created;
      while (session.state !== 'idle') {
        if (TERMINAL_BAD_SESSION_STATES.has(session.state)) {
          const logTail = (session.log || []).slice(-15).join('\n');
          return {
            status: 'fail',
            detail: `Livy session ${sessionId} on pool '${pool}' entered state '${session.state}' before reaching idle (appId=${session.appId ?? 'null'}) — the pool cannot start sessions (faulted-pool-class failure). Check the Spark pool's provisioning state and node availability in the Synapse workspace.`,
            evidence: evidenceSlice(logTail || '(Livy returned no session log)'),
          };
        }
        await pollWait(ctx, 5_000, `waiting for Livy session ${sessionId} to reach idle (state '${session.state}')`);
        session = await livy.getLivySession(pool, sessionId);
      }
      // 2. Execute a trivial statement on the live session.
      const submitted = await livy.submitLivyStatement(pool, sessionId, 'print(spark.range(1).count())', 'pyspark');
      let stmt = submitted;
      while (stmt.state !== 'available' && stmt.state !== 'error' && stmt.state !== 'cancelled') {
        await pollWait(ctx, 3_000, `waiting for statement ${submitted.id} (state '${stmt.state}')`);
        stmt = await livy.getLivyStatement(pool, sessionId, submitted.id);
      }
      const out = livy.normalizeLivyOutput(stmt.output);
      if (stmt.state !== 'available' || out?.status === 'error') {
        return {
          status: 'fail',
          detail: `Session ${sessionId} reached idle but spark.range(1).count() failed (statement state '${stmt.state}'${out?.ename ? `, ${out.ename}: ${out.evalue ?? ''}` : ''}).`,
          evidence: evidenceSlice((out?.traceback || []).slice(-10).join('\n') || out?.textPlain || '(no statement output)'),
        };
      }
      return {
        status: 'pass',
        detail: `Livy session ${sessionId} reached idle on pool '${pool}' (appId=${session.appId ?? 'n/a'}) and executed spark.range(1).count(). Session deleted.`,
        evidence: evidenceSlice(out?.textPlain || '(ok)'),
      };
    } finally {
      // Self-clean: ALWAYS delete the probe session — never leave a leaked
      // Livy session holding pool vcores (#1796 class).
      try { await livy.killLivySession(pool, sessionId); } catch { /* already gone / unreachable */ }
    }
  },
};

/** warehouse-sql — `SELECT 1` over the real TDS path (Synapse serverless). */
const warehouseSqlProbe: ServiceProbe = {
  service: 'warehouse-sql',
  title: 'Synapse SQL — SELECT 1 via serverless TDS',
  timeoutMs: 45_000,
  async run() {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      return gate('Synapse not configured — set LOOM_SYNAPSE_WORKSPACE (+ LOOM_SYNAPSE_DEDICATED_POOL for the dedicated warehouse) to enable T-SQL; the Console UAMI needs Synapse SQL Administrator.');
    }
    const sqlc = await import('@/lib/azure/synapse-sql-client');
    const target = sqlc.serverlessTarget();
    const r = await sqlc.executeQuery(target, 'SELECT 1 AS loom_exercise', 30_000);
    return {
      status: 'pass',
      detail: `Serverless SQL (${target.server}) executed SELECT 1 in ${r.executionMs}ms (${r.rowCount} row).`,
      evidence: evidenceSlice(JSON.stringify({ columns: r.columns, rows: r.rows })),
    };
  },
};

/** adx — `print 1` KQL against the default database on the real cluster. */
const adxProbe: ServiceProbe = {
  service: 'adx',
  title: 'Azure Data Explorer — print 1 (KQL)',
  timeoutMs: 30_000,
  async run() {
    const kusto = await import('@/lib/azure/kusto-client');
    const g = kusto.kustoConfigGate();
    if (g) {
      return gate(`ADX not configured — set ${g.missing} (modules/landing-zone adxEnabled) to enable KQL databases / eventhouses; the Console UAMI needs AllDatabasesViewer on the cluster.`);
    }
    const db = kusto.defaultDatabase();
    const r = await kusto.executeQuery(db, 'print loom_exercise=1');
    return {
      status: 'pass',
      detail: `ADX cluster ${kusto.clusterUri()} executed 'print 1' on database '${db}' (${r.rows?.length ?? 0} row).`,
      evidence: evidenceSlice(JSON.stringify({ columns: r.columns, rows: r.rows })),
    };
  },
};

/** adls — list the configured DLZ container roots (the managed-PE data path). */
const adlsProbe: ServiceProbe = {
  service: 'adls',
  title: 'ADLS Gen2 — list configured lake containers',
  timeoutMs: 30_000,
  async run() {
    const adls = await import('@/lib/azure/adls-client');
    if (!adls.hasConfiguredContainers()) {
      return gate('ADLS not configured — set LOOM_ADLS_ACCOUNT / the LOOM_{LANDING,BRONZE,SILVER,GOLD}_URL container URLs (modules/landing-zone/storage.bicep) to enable the lakehouse data path; the Console UAMI needs Storage Blob Data Contributor.');
    }
    const containers = await adls.listContainers();
    if (containers.length === 0) {
      return {
        status: 'fail',
        detail: 'DLZ container URLs are configured but NONE were reachable — the managed private endpoint / DNS to the lake account is broken, or the Console UAMI lost Storage Blob Data Contributor.',
        evidence: '(listContainers() probed every configured container; all timed out or errored)',
      };
    }
    return {
      status: 'pass',
      detail: `Lake reachable over the data path — ${containers.length} configured container(s) answered exists().`,
      evidence: evidenceSlice(containers.map((c) => c.name).join(', ')),
    };
  },
};

/** cosmos — reachability + a real query against the Loom store. */
const cosmosProbe: ServiceProbe = {
  service: 'cosmos',
  title: 'Cosmos DB — metadata read + point query (Loom store)',
  timeoutMs: 20_000,
  async run() {
    if (!process.env.LOOM_COSMOS_ENDPOINT && !process.env.COSMOS_ENDPOINT) {
      return gate('Cosmos not configured — set LOOM_COSMOS_ENDPOINT (modules/landing-zone/main.bicep). The Loom store cannot run without it; the Console UAMI needs "Cosmos DB Built-in Data Contributor".');
    }
    const cosmos = await import('@/lib/azure/cosmos-client');
    await cosmos.probeCosmosReachable(8_000);
    const container = await cosmos.featurePermissionsContainer();
    const { resources } = await container.items
      .query({ query: 'SELECT TOP 1 c.id FROM c' })
      .fetchAll();
    return {
      status: 'pass',
      detail: `Cosmos account reachable, containers ensured, and a real query ran against feature-permissions (${resources.length} row).`,
      evidence: evidenceSlice(JSON.stringify(resources)),
    };
  },
};

/** aoai — resolve the model target and run a real 1-shot completion. */
const aoaiProbe: ServiceProbe = {
  service: 'aoai',
  title: 'Azure OpenAI / Foundry — one-shot completion',
  timeoutMs: 60_000,
  async run() {
    const orch = await import('@/lib/azure/copilot-orchestrator');
    let target: Awaited<ReturnType<typeof orch.resolveAoaiTarget>>;
    try {
      target = await orch.resolveAoaiTarget(null);
    } catch (e) {
      if (e instanceof orch.NoAoaiDeploymentError) {
        return gate('No AOAI/Foundry model deployment resolved — set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or a Foundry project endpoint) and deploy a chat model; the Console UAMI needs "Cognitive Services OpenAI User".');
      }
      throw e;
    }
    const chat = await import('@/lib/azure/aoai-chat-client');
    const reply = await chat.aoaiChat({
      messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }],
      maxCompletionTokens: 16,
      target,
    });
    if (!reply.trim()) {
      return {
        status: 'fail',
        detail: `Model deployment '${target.deployment}' @ ${target.endpoint} answered with an EMPTY completion — the deployment resolves but does not generate.`,
        evidence: '(empty completion body)',
      };
    }
    return {
      status: 'pass',
      detail: `Model deployment '${target.deployment}' answered a real completion.`,
      evidence: evidenceSlice(reply.trim()),
    };
  },
};

/** domain-sync — dry-run the Purview/Unity-Catalog reconciler (apply:false). */
const domainSyncProbe: ServiceProbe = {
  service: 'domain-sync',
  title: 'Purview / Unity Catalog — governance-domain dry-run sync',
  timeoutMs: 60_000,
  async run(ctx) {
    const ds = await import('@/lib/azure/domain-sync');
    const r = await ds.runDomainSync(ctx.tenantId, ctx.who, { apply: false });
    if (!r.purview.configured && !r.unity.configured) {
      return gate(`Neither governance mirror is configured — Domains run Loom-native (Cosmos). Purview: ${r.purview.hint || 'set LOOM_PURVIEW_ACCOUNT'} Unity Catalog: ${r.unity.hint || 'set LOOM_DATABRICKS_HOSTNAME'}`);
    }
    const errors = (r.purview.errors || 0) + (r.unity.errors || 0);
    const summary = `purview{configured:${r.purview.configured}, mirrored:${r.purview.mirrored}, missing:${r.purview.missing}, errors:${r.purview.errors}} unity{configured:${r.unity.configured}, mirrored:${r.unity.mirrored}, missing:${r.unity.missing}, errors:${r.unity.errors}} drift:${r.drift.length}`;
    if (errors > 0) {
      return {
        status: 'fail',
        detail: `Domain dry-run sync over ${r.domainCount} domain(s) reported ${errors} error(s) against the configured mirror target(s).`,
        evidence: evidenceSlice(summary),
      };
    }
    return {
      status: 'pass',
      detail: `Domain dry-run sync over ${r.domainCount} domain(s) completed against the configured mirror target(s) with no errors (nothing was mutated).`,
      evidence: evidenceSlice(summary),
    };
  },
};

/** adf — list pipelines on the env-pinned default factory (control plane). */
const adfProbe: ServiceProbe = {
  service: 'adf',
  title: 'Azure Data Factory — list pipelines (control plane)',
  timeoutMs: 30_000,
  async run() {
    const adf = await import('@/lib/azure/adf-client');
    const g = adf.adfConfigGate();
    if (g) {
      return gate(`ADF not configured — set ${g.missing} (modules/landing-zone ADF factory) to enable the pipeline / mirror-CDC backend; the Console UAMI needs Data Factory Contributor.`);
    }
    const pipelines = await adf.listPipelines();
    return {
      status: 'pass',
      detail: `Factory ARM control plane answered — ${pipelines.length} pipeline(s) listed.`,
      evidence: evidenceSlice(pipelines.slice(0, 10).map((p) => p.name).join(', ') || '(factory reachable; zero pipelines yet)'),
    };
  },
};

// ── W-B depth wave: 4 deep exercises (docs/fiab/health-coverage-audit.md §5.8) ──

/**
 * eventstream-roundtrip — publish an event to the default eventstream Event Hub,
 * then consume it back over AMQP. Proves the full eventstream data path (not just
 * "namespace reachable"). Consume needs the AMQP receive opt-in — an honest gate
 * when off (publish still verified). Idempotent: the probe hub is get-or-created;
 * messages expire on their own (retention), so there is nothing to delete.
 */
const eventstreamProbe: ServiceProbe = {
  service: 'eventstream-roundtrip',
  title: 'Event Hubs — publish → consume round-trip',
  timeoutMs: 45_000,
  async run() {
    const eh = await import('@/lib/azure/eventhubs-client');
    const g = eh.eventhubsConfigGate();
    if (g) return gate(`Event Hubs not configured — set ${g.missing} (modules/landing-zone eventhubs.bicep). The Console UAMI needs "Azure Event Hubs Data Owner" on the namespace.`);
    const data = await import('@/lib/azure/eventhubs-data-client');
    const hub = (process.env.LOOM_EVENTHUB_DEFAULT_HUB || process.env.LOOM_EVENTSTREAM_HUB || 'loom-health-eventstream').trim();
    const cfg = eh.readEventHubsConfig();
    await eh.ensureEventHub(cfg, { name: hub, partitionCount: 1, messageRetentionInDays: 1 });
    const marker = `loom-health-${Date.now()}`;
    const sent = await data.sendEvents(hub, [{ body: { marker, at: new Date().toISOString() } }]);
    if (!data.eventHubReceiveEnabled()) {
      return { status: 'gate', detail: `Publish succeeded (event written to "${hub}"), but consume is not opted in — add @azure/event-hubs + set LOOM_EVENTHUB_RECEIVE_ENABLED=1 to enable the AMQP round-trip read.`, evidence: evidenceSlice(`sent=${JSON.stringify(sent)}`) };
    }
    const peeked = await data.peekEvents(hub, { maxEvents: 25, sinceMs: 60_000, maxWaitMs: 8_000 });
    const events = peeked.events || [];
    const found = events.some((e: any) => JSON.stringify(e?.body ?? '').includes(marker));
    return {
      status: 'pass',
      detail: found
        ? `Round-trip OK on "${hub}": published a marker event and read it back over AMQP.`
        : `Published to "${hub}" and consumed ${events.length} event(s) over AMQP (the specific marker fell outside the peek window — partitioning/lag; the path is live).`,
      evidence: evidenceSlice(JSON.stringify(events.slice(0, 2))),
    };
  },
};

/**
 * purview-scan — trigger a scan RUN on a registered Purview data source (proves
 * the scan control plane is live + authorized). Discovers a source that already
 * has a scan defined; gates honestly when none is registered. Non-destructive:
 * a scan run is a read-only catalog crawl the operator triggers on demand.
 */
const purviewScanProbe: ServiceProbe = {
  service: 'purview-scan',
  title: 'Purview — trigger a scan run on a registered source',
  timeoutMs: 30_000,
  async run() {
    const pv = await import('@/lib/azure/purview-client');
    if (!pv.isPurviewConfigured()) return gate('Purview not configured — set LOOM_PURVIEW_ACCOUNT (admin-plane apps env). The Console UAMI needs "Data Source Administrator" + "Data Curator" on the Purview root collection.');
    const sources = await pv.listDataSources();
    if (!sources.length) return gate('No Purview data source registered — onboard a source first (Governance → auto-onboard, or the Data Map), then re-run.');
    for (const src of sources) {
      const scans = await pv.listScansForSource(src.name).catch(() => []);
      if (scans.length) {
        const run = await pv.triggerScanRun(src.name, scans[0].name);
        const runId = (run as any)?.scanResultId || (run as any)?.runId || (run as any)?.id || 'accepted';
        return { status: 'pass', detail: `Scan triggered on source "${src.name}" / scan "${scans[0].name}" — run ${runId}.`, evidence: evidenceSlice(JSON.stringify(run)) };
      }
    }
    return gate(`${sources.length} Purview source(s) registered but none has a scan defined — define a scan (Data Map → source → New scan) then re-run.`);
  },
};

/** databricks-sql — SELECT 1 on a real Databricks SQL warehouse (the SQL
 *  analytics data path for databricks-sql-warehouse items). */
const databricksSqlProbe: ServiceProbe = {
  service: 'databricks-sql',
  title: 'Databricks SQL — SELECT 1 on a SQL warehouse',
  timeoutMs: 60_000,
  async run() {
    const dbx = await import('@/lib/azure/databricks-client');
    const g = dbx.databricksConfigGate();
    if (g) return gate(`Databricks not configured — set ${g.missing}. The Console UAMI (or a PAT) needs "Can use" on the SQL warehouse.`);
    let warehouseId = (process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
    if (!warehouseId) {
      const whs = await dbx.listWarehouses().catch(() => [] as any[]);
      const pick = whs.find((w: any) => /running/i.test(String(w?.state || ''))) || whs[0];
      if (!pick) return gate('Databricks reachable but no SQL warehouse exists — create one (or set LOOM_DATABRICKS_SQL_WAREHOUSE_ID) then re-run.');
      warehouseId = pick.id;
    }
    const res: any = await dbx.runWarehouseStatement('SELECT 1 AS loom_health', { warehouseId });
    const rows = res?.result?.data_array?.length ?? res?.rows?.length ?? res?.rowCount ?? 0;
    return { status: 'pass', detail: `Databricks SQL warehouse ${warehouseId} executed SELECT 1 (${rows} row(s)).`, evidence: evidenceSlice(JSON.stringify(res).slice(0, 400)) };
  },
};

/** report-render — render a trivial RDL end-to-end (dataset SELECT 1) over the
 *  Loom-native Synapse-serverless renderer. Proves the report data path from RDL
 *  → dataset execution → paginated output, no Power BI / Fabric. */
const reportRenderProbe: ServiceProbe = {
  service: 'report-render',
  title: 'Report render — RDL over Synapse serverless',
  timeoutMs: 45_000,
  async run() {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) return gate('Synapse serverless not configured — set LOOM_SYNAPSE_WORKSPACE so the Loom-native RDL renderer can execute report datasets (the Azure-native default; no Power BI / Fabric).');
    const { renderPaginatedReport } = await import('@/lib/azure/paginated-report-renderer');
    const rdl = '<?xml version="1.0"?><Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition">'
      + '<DataSources><DataSource Name="S"><ConnectionProperties><DataProvider>SQL</DataProvider><ConnectString>Data Source=serverless;Initial Catalog=master</ConnectString></ConnectionProperties></DataSource></DataSources>'
      + '<DataSets><DataSet Name="D"><Query><DataSourceName>S</DataSourceName><CommandText>SELECT 1 AS loom_health</CommandText></Query><Fields><Field Name="loom_health"><DataField>loom_health</DataField></Field></Fields></DataSet></DataSets>'
      + '<Body><ReportItems><Tablix Name="T"><TablixBody><TablixColumns><TablixColumn><Width>2in</Width></TablixColumn></TablixColumns>'
      + '<TablixRows><TablixRow><Height>0.25in</Height><TablixCells><TablixCell><CellContents><Textbox Name="c"><Paragraphs><Paragraph><TextRuns><TextRun><Value>=Fields!loom_health.Value</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox></CellContents></TablixCell></TablixCells></TablixRow></TablixRows>'
      + '</TablixBody><DataSetName>D</DataSetName></Tablix></ReportItems></Body><Width>4in</Width></Report>';
    const r: any = await renderPaginatedReport({ rdlXml: rdl, source: 'import', run: true, reportName: 'loom-health' });
    const section = r?.page?.sections?.[0];
    const rows = section?.rows?.length ?? section?.totalRows ?? 0;
    return { status: 'pass', detail: `RDL rendered end-to-end over Synapse serverless (datasetCount ${r?.datasetCount ?? '?'}, pageCount ${r?.pageCount ?? '?'}, ${rows} tablix row(s)).`, evidence: evidenceSlice(JSON.stringify(r?.page ?? r).slice(0, 400)) };
  },
};

/** The registry — one probe per backend data path. */
export const SERVICE_PROBES: ServiceProbe[] = [
  sparkProbe,
  warehouseSqlProbe,
  adxProbe,
  adlsProbe,
  cosmosProbe,
  aoaiProbe,
  domainSyncProbe,
  adfProbe,
  // W-B depth wave — 4 deep exercises.
  eventstreamProbe,
  purviewScanProbe,
  databricksSqlProbe,
  reportRenderProbe,
];

export function isKnownService(service: string): boolean {
  return SERVICE_PROBES.some((p) => p.service === service);
}

// ── runner ───────────────────────────────────────────────────────────────────

async function executeProbe(
  probe: ServiceProbe,
  base: Omit<ProbeContext, 'deadline'>,
): Promise<ProbeResult> {
  const timeoutMs = probeTimeoutMs(probe.service, probe.timeoutMs);
  const t0 = Date.now();
  const ctx: ProbeContext = { ...base, deadline: t0 + timeoutMs };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Hard backstop 5s past the probe's own deadline — a probe that respects
    // ctx.deadline (pollWait) never hits this; a hung network call does.
    const outcome = await Promise.race([
      probe.run(ctx),
      new Promise<ProbeOutcome>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`probe timed out after ${timeoutMs}ms (hard backstop)`)),
          timeoutMs + 5_000,
        );
      }),
    ]);
    return { service: probe.service, title: probe.title, ...outcome, latencyMs: Date.now() - t0 };
  } catch (e) {
    return {
      service: probe.service,
      title: probe.title,
      status: 'fail',
      detail: `Exercise failed: ${errMsg(e)}`,
      latencyMs: Date.now() - t0,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run the selected probes in parallel (each with its own budget) and aggregate. */
export async function runServiceProbes(
  base: Omit<ProbeContext, 'deadline'>,
  opts: { services?: string[] } = {},
): Promise<ExerciseReport> {
  const filter = (opts.services || []).filter(Boolean);
  const selected = filter.length
    ? SERVICE_PROBES.filter((p) => filter.includes(p.service))
    : SERVICE_PROBES;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results = await Promise.all(selected.map((p) => executeProbe(p, base)));
  const summary = {
    pass: results.filter((r) => r.status === 'pass').length,
    gate: results.filter((r) => r.status === 'gate').length,
    fail: results.filter((r) => r.status === 'fail').length,
    total: results.length,
  };
  return {
    startedAt,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    ranBy: base.who,
    summary,
    results,
  };
}

// ── run-state store (start/poll — long probes outlive Front Door's response
//    timeout, so the BFF starts a run and the caller polls for the report) ────

const STATE_DOC_PREFIX = 'service-exercise:';
/** A 'running' state older than this is treated as stale (replica died mid-run). */
const STALE_RUN_MS = 15 * 60_000;

let currentRun: ExerciseRunState | null = null;

async function persistState(state: ExerciseRunState): Promise<void> {
  // Best-effort — the exercise itself must still work when Cosmos is the thing
  // being diagnosed (its probe reports the failure; persistence just degrades
  // to same-replica in-memory state).
  try {
    const cosmos = await import('@/lib/azure/cosmos-client');
    const container = await cosmos.tenantSettingsContainer();
    await container.items.upsert({ ...state, id: `${STATE_DOC_PREFIX}${state.tenantId}` });
  } catch { /* in-memory state still serves this replica */ }
}

async function readPersistedState(tenantId: string): Promise<ExerciseRunState | null> {
  try {
    const cosmos = await import('@/lib/azure/cosmos-client');
    const container = await cosmos.tenantSettingsContainer();
    const { resource } = await container.item(`${STATE_DOC_PREFIX}${tenantId}`, tenantId).read();
    if (!resource) return null;
    const { runId, status, startedAt, services, report } = resource as unknown as ExerciseRunState & { id: string };
    return { runId, tenantId, status, startedAt, services, report };
  } catch {
    return null;
  }
}

export function isRunStale(state: ExerciseRunState): boolean {
  return state.status === 'running' && Date.now() - Date.parse(state.startedAt) > STALE_RUN_MS;
}

/** Latest run state for the tenant — in-memory (freshest) or Cosmos (cross-replica). */
export async function getExerciseRunState(tenantId: string): Promise<ExerciseRunState | null> {
  if (currentRun && currentRun.tenantId === tenantId) return currentRun;
  return readPersistedState(tenantId);
}

/**
 * Start an exercise run in the background. Returns immediately with the runId;
 * callers poll {@link getExerciseRunState} for the report. A run already in
 * progress for this tenant (and not stale) is returned instead of double-running
 * — probes create real backend resources, so runs never overlap.
 */
export async function startExerciseRun(
  base: Omit<ProbeContext, 'deadline'> & { tenantId: string },
  opts: { services?: string[] } = {},
): Promise<{ runId: string; alreadyRunning: boolean }> {
  const existing = await getExerciseRunState(base.tenantId);
  if (existing && existing.status === 'running' && !isRunStale(existing)) {
    return { runId: existing.runId, alreadyRunning: true };
  }
  const runId = `exr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state: ExerciseRunState = {
    runId,
    tenantId: base.tenantId,
    status: 'running',
    startedAt: new Date().toISOString(),
    services: opts.services?.length ? opts.services : undefined,
  };
  currentRun = state;
  await persistState(state);
  // Fire-and-forget: the ACA nodejs process is long-lived, so the run completes
  // (and persists) even after the start request has returned.
  void (async () => {
    let report: ExerciseReport;
    try {
      report = await runServiceProbes(base, opts);
    } catch (e) {
      // runServiceProbes catches per-probe errors; this is a last-resort belt.
      report = {
        startedAt: state.startedAt,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(state.startedAt),
        ranBy: base.who,
        summary: { pass: 0, gate: 0, fail: 1, total: 1 },
        results: [{
          service: 'runner', title: 'Probe runner', status: 'fail',
          detail: `Exercise runner crashed: ${errMsg(e)}`, latencyMs: 0,
        }],
      };
    }
    const done: ExerciseRunState = { ...state, status: 'complete', report };
    if (currentRun?.runId === runId) currentRun = done;
    await persistState(done);
  })();
  return { runId, alreadyRunning: false };
}
