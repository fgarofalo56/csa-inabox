/**
 * POST /api/items/notebook/[id]/run?workspaceId=...
 *   body: { compute: 'spark:<poolName>' | 'databricks:<clusterId>' }
 *
 * v3.24 — async pattern (Front Door has a hard 30s timeout, so we can't
 * block waiting for Spark cold-start). Returns immediately with a runId
 * the client can poll via /api/items/notebook/[id]/runs/[runId].
 *
 * For Synapse Spark: creates the Livy session, returns its ID.
 * For Databricks: submits the run, returns its ID.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, hint?: string) {
  return NextResponse.json({ ok: false, error, hint }, { status });
}

async function loadNotebook(id: string, workspaceId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  try {
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    return (resource && resource.itemType === 'notebook') ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

/**
 * Build the `loom_lakehouses` auto-mount preamble for a notebook (issue #655).
 * Resolves every attached lakehouse to its REAL abfss root and returns the
 * pyspark dict source — or '' when there are no resolvable lakehouses. Each
 * source that can't resolve (no provisioning record / no storage env) is
 * skipped silently (honest gate, never a guessed path). Never throws — a
 * failure here must not break the session.
 */
async function buildAutoMountPreamble(
  attached: Array<{ kind?: string; id?: string; displayName?: string }>,
  workspaceId: string,
): Promise<string> {
  try {
    const lakehouses = (attached || []).filter((a) => a && a.kind === 'lakehouse' && a.id);
    if (lakehouses.length === 0) return '';
    const { resolveLakehouseAbfss } = await import('@/lib/azure/lakehouse-abfss');
    const { buildLakehouseMountPreamble } = await import('@/lib/notebook/lakehouse-mount-preamble');
    const resolved: Array<{ displayName: string; abfss: string }> = [];
    for (const lh of lakehouses) {
      try {
        const r = await resolveLakehouseAbfss(lh.id as string, workspaceId);
        if (r) resolved.push({ displayName: lh.displayName || lh.id || 'lakehouse', abfss: r.abfss });
      } catch { /* skip this source — honest, don't break the session */ }
    }
    return buildLakehouseMountPreamble(resolved);
  } catch { return ''; }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const compute: string = body?.compute || '';
  if (!compute) return err('compute required', 400);

  try {
    const nb = await loadNotebook((await ctx.params).id, workspaceId);
    if (!nb) return err('notebook not found', 404);
    // Per-cell run path: caller passes { source, lang, cellId } — we run
    // only that cell's source. Fallback to notebook-level `code` blob.
    const state = (nb.state as any) || {};
    const cellSource = typeof body?.source === 'string' ? body.source : '';
    const cellLang = typeof body?.lang === 'string' ? body.lang : '';
    const cellId = typeof body?.cellId === 'string' ? body.cellId : '';
    // Whole-notebook run: when no per-cell source is passed, assemble the code
    // from the notebook's cells. Falls back to state.cells, then the bundle-
    // stamped state.content.cells (same fallback the GET route uses), then the
    // legacy state.code blob — so a bundle-installed notebook runs even before
    // its first Save (which is when state.code would otherwise get written).
    const allCells: any[] = (Array.isArray(state.cells) && state.cells.length > 0)
      ? state.cells
      : (state.content?.kind === 'notebook' && Array.isArray(state.content.cells) ? state.content.cells : []);
    const codeFromCells = allCells.filter((c) => c?.type === 'code' && typeof c.source === 'string')
      .map((c) => c.source).join('\n\n');
    const code = cellSource || state.code || codeFromCells || '';
    if (!code.trim()) return err('notebook is empty — write code before running', 400);

    // Map cell-lang to the statement-kind that Livy / Databricks expects.
    // Livy session-kind affects cold-start; statement-kind controls per-cell
    // interpretation. We always start a 'pyspark' session because it can
    // host pyspark / spark / sql / sparkr statements via per-statement kind
    // override (sparkr requires its own session kind, handled separately).
    function statementKind(): 'pyspark' | 'spark' | 'sql' | 'sparkr' {
      const l = (cellLang || state.lang || 'pyspark').toLowerCase();
      if (l === 'sparksql' || l === 'spark-sql' || l === 'sql') return 'sql';
      if (l === 'spark' || l === 'scala') return 'spark';
      if (l === 'sparkr' || l === 'r') return 'sparkr';
      return 'pyspark'; // python / pyspark / unspecified
    }
    function sessionKind(stmt: 'pyspark' | 'spark' | 'sql' | 'sparkr'): 'pyspark' | 'spark' | 'sparkr' | 'sql' {
      // Livy interactive sessions are typed; per-statement override works for
      // sql + spark + pyspark within a pyspark session, but NOT sparkr.
      if (stmt === 'sparkr') return 'sparkr';
      return 'pyspark';
    }
    function tsqlMode(): boolean {
      const l = (cellLang || state.lang || '').toLowerCase();
      return l === 'tsql' || l === 't-sql';
    }
    const stmtKind = statementKind();
    const sessKind = sessionKind(stmtKind);
    // %pip install / %conda install are Spark/IPython magic commands that
    // install libraries into the RUNNING interactive session (Synapse Livy with
    // sessionLevelPackagesEnabled=true; Databricks PYTHON notebooks support them
    // natively). The kernel accepts the magic verbatim inside a pyspark
    // statement — no translation needed. We force pyspark so an inline %pip in a
    // cell whose lang is sql/tsql/scala doesn't get mis-routed (and never trips
    // the T-SQL guard below). The package is then importable in the next cell on
    // the same reused session.
    const isInlineInstall = /^\s*%(?:pip|conda)\s+install\b/.test(code.trim());
    const effectiveStmtKind: 'pyspark' | 'spark' | 'sql' | 'sparkr' = isInlineInstall ? 'pyspark' : stmtKind;
    const effectiveSessKind: 'pyspark' | 'spark' | 'sparkr' | 'sql' = isInlineInstall ? 'pyspark' : sessKind;
    if (tsqlMode() && !isInlineInstall) {
      // T-SQL belongs to Synapse Dedicated / Serverless, not Spark — route
      // the user to the right editor instead of stalling on Livy.
      return NextResponse.json({
        ok: false,
        error: 'T-SQL cells run on a SQL pool, not a Spark pool. Open the Warehouse or Synapse SQL pool editor and run the query there.',
      }, { status: 400 });
    }

    // ---- AML Compute Instance path (Azure-native; no Fabric/Spark needed) ----
    // The notebook editor's "Azure ML" workspace toggle picks an `aml-ci:<name>`
    // compute. We submit a Command job that runs the cell's code (python -c / R)
    // on that CI, then return a runId the client polls via /runs/[runId].
    // Auto-start: a Stopped CI is kicked before submit so the job has compute.
    if (compute.startsWith('aml-ci:')) {
      const ciName = compute.slice('aml-ci:'.length);
      const {
        submitCiJob, startCI, getCI, ciIsStopped, amlIsConfigured, AmlNotConfiguredError,
      } = await import('@/lib/azure/aml-client');
      if (!amlIsConfigured()) {
        const e = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
        return err(e.message, 200, e.hint);
      }
      // Auto-start a stopped CI so the run has somewhere to land.
      let autoStarted = false;
      try {
        const ci = await getCI(ciName);
        if (ci && ciIsStopped(ci.state)) { await startCI(ciName); autoStarted = true; }
      } catch { /* probe/start best-effort — submit still attempted */ }
      // R cells run via Rscript; everything else via python.
      const lang: 'python' | 'r' = stmtKind === 'sparkr' ? 'r' : 'python';
      const job = await submitCiJob({
        ciName,
        code,
        lang,
        displayName: `Loom: ${nb.displayName?.slice(0, 60) || 'notebook'}${cellId ? ' · ' + cellId.slice(0, 6) : ''}`,
      });
      return NextResponse.json({
        ok: true,
        runId: `aml-ci:${job.name}`,
        status: job.status || 'NotStarted',
        autoStarted,
        compute: { kind: 'aml-ci', ciName },
        cellId: cellId || null,
        sourcePreview: code.slice(0, 200),
      });
    }

    if (compute.startsWith('spark:')) {
      const pool = compute.slice('spark:'.length);
      const { createLivySessionAsync, getLivySession } = await import('@/lib/azure/synapse-dev-client');

      // Session sizing from the "Configure session" dialog. The editor sends
      // the real Livy keys; we fall back to the notebook's saved config, then
      // to Synapse defaults inside createLivySessionAsync. NO freeform JSON —
      // these are the four structured fields the dialog produces.
      const rawCfg = (body?.sessionConfig && typeof body.sessionConfig === 'object')
        ? body.sessionConfig
        : (state.sparkSessionSizing && typeof state.sparkSessionSizing === 'object' ? state.sparkSessionSizing : null);
      // Merge the user's preset / config-builder spark.* confs with the
      // Synapse→Loom Log Analytics diagnostic defaults (env-gated; {} when LA is
      // not configured) so EVERY Loom Spark session ships its logging events,
      // metrics, and listener events to the Loom Log Analytics workspace. User
      // confs win on key conflicts. NO freeform JSON — these are structured
      // key/value pairs from the preset catalog + the dialog's row builder.
      const { synapseLogAnalyticsConf } = await import('@/lib/spark/config-presets');
      const laConf = synapseLogAnalyticsConf();
      const userConf = (rawCfg && rawCfg.conf && typeof rawCfg.conf === 'object') ? rawCfg.conf as Record<string, string> : {};
      const mergedConf: Record<string, string> = { ...laConf, ...userConf };
      const sizing = (rawCfg || Object.keys(mergedConf).length) ? {
        numExecutors: typeof rawCfg?.numExecutors === 'number' ? rawCfg.numExecutors : undefined,
        executorMemory: typeof rawCfg?.executorMemory === 'string' ? rawCfg.executorMemory : undefined,
        driverMemory: typeof rawCfg?.driverMemory === 'string' ? rawCfg.driverMemory : undefined,
        heartbeatTimeoutInSecond: typeof rawCfg?.heartbeatTimeoutInSecond === 'number' ? rawCfg.heartbeatTimeoutInSecond : undefined,
        conf: Object.keys(mergedConf).length ? mergedConf : undefined,
      } : undefined;
      const sizingKey = sizing ? JSON.stringify(sizing) : '';

      // REUSE an existing live Livy session for this pool+kind instead of
      // creating a new one per cell. A Synapse Spark pool cold-starts in
      // minutes; creating a fresh session for every cell meant every run paid
      // that cold start — the "takes forever" symptom. A pyspark session also
      // hosts sql/spark statements via per-statement kind, so one session
      // serves Python + Spark SQL + Scala cells. Only re-create when the saved
      // session is gone, terminal, OR its sizing differs from the requested
      // config (so %%configure / Configure-session changes take effect — Livy
      // sizing is fixed at session create, so a new config needs a new session).
      let sessionId: number | undefined;
      let sessState = 'starting';
      let reused = false;
      let sessionReceipt: Record<string, unknown> | null = null;
      const saved = state.sparkSession;
      const savedKey = saved && typeof saved.sizingKey === 'string' ? saved.sizingKey : '';
      if (saved && saved.pool === pool && saved.kind === effectiveSessKind && typeof saved.id === 'number' && savedKey === sizingKey) {
        try {
          const live = await getLivySession(pool, saved.id);
          if (['idle', 'busy', 'starting', 'not_started'].includes(live.state)) {
            sessionId = saved.id; sessState = live.state; reused = true;
            sessionReceipt = saved.request || null;
          }
        } catch { /* stale/expired → fall through to create */ }
      }
      if (sessionId === undefined) {
        const sess = await createLivySessionAsync(pool, effectiveSessKind, undefined, sizing);
        sessionId = sess.id; sessState = sess.state;
        sessionReceipt = sess.request;

        // Rich display() — inject the ai-display.py helper as statement 0 of a
        // FRESH pyspark session so display(df) emits the Loom rich-display MIME.
        // Opt-in via LOOM_RICH_DISPLAY=1 (Azure-native, no Fabric dependency).
        // Skipped on reuse (loaded once per session) and for non-pyspark kinds.
        // Non-fatal: if it fails, display() falls back to the built-in table.
        if ((process.env.LOOM_RICH_DISPLAY || '').trim() === '1' && sessKind === 'pyspark') {
          try {
            const { submitLivyStatement } = await import('@/lib/azure/synapse-dev-client');
            const { AI_DISPLAY_PREAMBLE } = await import('@/lib/notebook/ai-display-preamble');
            await submitLivyStatement(pool, sessionId, { code: AI_DISPLAY_PREAMBLE, kind: 'pyspark' });
          } catch { /* non-fatal — display() degrades to the built-in renderer */ }
        }

        // Auto-mount attached lakehouses (issue #655) — inject the
        // `loom_lakehouses` abfss preamble as a session statement on a FRESH
        // pyspark session so every cell can read the lake without typing paths.
        // Skipped on reuse (defined once per session) + non-pyspark kinds.
        // Honest: unresolvable sources are omitted; empty preamble injects
        // nothing. Non-fatal — a failure here must not break the run.
        if (sessKind === 'pyspark') {
          try {
            const preamble = await buildAutoMountPreamble(state.attachedSources || [], workspaceId);
            if (preamble) {
              const { submitLivyStatement } = await import('@/lib/azure/synapse-dev-client');
              await submitLivyStatement(pool, sessionId, { code: preamble, kind: 'pyspark' });
            }
          } catch { /* non-fatal — user can still type paths manually */ }
        }
      }
      const runIdStr = `spark:${pool}:${sessionId}`;

      // Persist the (possibly new) session for reuse + the per-cell pending run.
      try {
        const items = await itemsContainer();
        const pendingRuns = { ...(state.pendingRuns || {}) };
        if (cellSource) pendingRuns[runIdStr] = { source: cellSource, lang: effectiveStmtKind, cellId };
        await items.item(nb.id, workspaceId).replace({
          ...nb,
          state: {
            ...state,
            pendingRuns,
            sparkSession: { pool, id: sessionId, kind: effectiveSessKind, sizingKey, request: sessionReceipt },
            ...(rawCfg ? { sparkSessionSizing: rawCfg } : {}),
          },
          updatedAt: new Date().toISOString(),
        } as WorkspaceItem);
      } catch { /* non-fatal — poll will fall back to state.code */ }

      return NextResponse.json({
        ok: true,
        runId: runIdStr,
        status: sessState,
        reusedSession: reused,
        compute: { kind: 'synapse-spark', pool },
        cellId: cellId || null,
        // Honest receipt: the real Livy session-create body that provisioned
        // (or is reusing) this session — `numExecutors` here is what the Spark
        // session actually runs with.
        session: sessionReceipt
          ? { id: sessionId, state: sessState, reused, ...sessionReceipt }
          : { id: sessionId, state: sessState, reused },
        sourcePreview: code.slice(0, 200),
      });
    }

    if (compute.startsWith('databricks:')) {
      const clusterId = compute.slice('databricks:'.length);
      const { runOneTimeNotebook } = await import('@/lib/azure/databricks-client');
      const dbLang =
        effectiveStmtKind === 'spark' ? 'SCALA' :
        effectiveStmtKind === 'sql' ? 'SQL' :
        effectiveStmtKind === 'sparkr' ? 'R' :
        'PYTHON';
      // Auto-mount attached lakehouses (issue #655). Databricks one-time runs
      // are isolated (no reused interactive session), so the `loom_lakehouses`
      // dict must be prepended to each PYTHON run for the cell to reference it.
      // Honest: unresolvable sources are omitted; empty preamble prepends
      // nothing. Non-fatal — falls back to the raw code on any error.
      let dbCode = code;
      if (dbLang === 'PYTHON') {
        const preamble = await buildAutoMountPreamble(state.attachedSources || [], workspaceId);
        if (preamble) dbCode = `${preamble}\n\n${code}`;
      }
      const runRes = await runOneTimeNotebook({
        clusterId,
        code: dbCode,
        lang: dbLang,
        jobName: `loom-${nb.displayName.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40)}${cellId ? '-' + cellId.slice(0, 6) : ''}`,
      });
      return NextResponse.json({
        ok: true,
        runId: `databricks:${runRes.run_id}`,
        status: 'PENDING',
        compute: { kind: 'databricks-cluster', clusterId },
        runUrl: runRes.run_page_url,
        cellId: cellId || null,
      });
    }

    return err(`unsupported compute kind: ${compute.split(':')[0]}`, 400);
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502, e?.hint);
  }
}
