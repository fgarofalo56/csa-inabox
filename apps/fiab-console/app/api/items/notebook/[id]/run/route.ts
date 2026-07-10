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
import { assertOwner } from '@/lib/auth/workspace-guard';
import { enforceAdmissionControl } from '@/lib/azure/capacity-guardrails';
import { recordCostAttribution } from '@/lib/azure/cost-attribution';
import { tenantScopeId } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { substituteNotebookPlaceholders } from '@/lib/apps/notebook-placeholders';
import { cellToStatements } from '@/lib/notebook/sql-split';
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
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('notebook not found', 404);
  const body = await req.json().catch(() => ({}));
  const compute: string = body?.compute || '';
  if (!compute) return err('compute required', 400);

  // FGC-25 — capacity surge protection. A Spark/Databricks submit is a compute
  // job; admit-control can reject it (429) when the capacity is over its
  // utilization threshold OR the workspace is over its LCU/hour cap. The AML-CI
  // path is a per-user single-node job (not a shared pool), so it is exempt.
  const surgeEngine: 'spark' | 'databricks' | null =
    compute.startsWith('spark:') ? 'spark' : compute.startsWith('databricks:') ? 'databricks' : null;
  if (surgeEngine) {
    const surge = await enforceAdmissionControl(s, { engine: surgeEngine, workspaceId });
    if (surge) return surge;
  }

  try {
    const nb = await loadNotebook((await ctx.params).id, workspaceId);
    if (!nb) return err('notebook not found', 404);
    // Per-cell run path: caller passes { source, lang, cellId } — we run
    // only that cell's source. Fallback to notebook-level `code` blob.
    // Resolve the `{{ADLS_ACCOUNT}}` deployment placeholder to the real
    // Azure-native ADLS account (LOOM_ADLS_ACCOUNT) BEFORE the source is
    // submitted to Livy / persisted to pendingRuns — so notebooks installed
    // before the install-time substitution (or edited by hand) still execute
    // against a valid abfss host instead of the raw token.
    const state = (nb.state as any) || {};
    const cellSource = substituteNotebookPlaceholders(typeof body?.source === 'string' ? body.source : '');
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
    // cellSource is already placeholder-resolved above; resolve the whole-notebook
    // fallback too so a bundle-installed notebook that predates the fix runs clean.
    const code = cellSource || substituteNotebookPlaceholders(state.code || codeFromCells || '');
    if (!code.trim()) return err('notebook is empty — write code before running', 400);

    // Whole-notebook "Run all": each code cell must run as its OWN Livy
    // statement with its own kind — joining sparksql + pyspark sources into a
    // single pyspark statement is a Python syntax error, and the legacy
    // state.code fallback is EMPTY on bundle-installed notebooks (which made
    // Run all a silent no-op: empty statement → vacuous success). The queue is
    // persisted to pendingRuns below and drained sequentially by the poller.
    const kindOfCell = (l: string | undefined): 'pyspark' | 'spark' | 'sql' | 'sparkr' => {
      const v = (l || state.defaultLang || state.lang || 'pyspark').toLowerCase();
      if (v === 'sparksql' || v === 'spark-sql' || v === 'sql') return 'sql';
      if (v === 'spark' || v === 'scala') return 'spark';
      if (v === 'sparkr' || v === 'r') return 'sparkr';
      return 'pyspark';
    };
    // Each code cell expands to one-or-more Livy statements: SQL cells split on
    // `;` (Livy's sql kind is single-statement — a cell with three
    // `CREATE DATABASE …;` else fails "extra input 'CREATE'"); other kinds stay
    // whole. A single-cell SQL run splits the same way so per-cell SQL matches.
    // Each queue entry carries its originating cellId so the poller can attribute
    // per-statement output back to the right cell (R3 #2 — "Run all" outputs).
    // Single-cell runs tag every split statement with the passed cellId; a
    // whole-notebook run tags each cell's statements with that cell's id.
    const runQueue: Array<{ source: string; lang: string; cellId?: string }> = cellSource
      ? cellToStatements(substituteNotebookPlaceholders(cellSource), kindOfCell(cellLang) as any)
          .map((s) => ({ source: s.source, lang: s.lang, cellId: cellId || undefined }))
      : allCells
          .filter((c) => c?.type === 'code' && typeof c.source === 'string' && c.source.trim())
          .flatMap((c) =>
            cellToStatements(substituteNotebookPlaceholders(c.source), kindOfCell(c.lang) as any)
              .map((s) => ({ source: s.source, lang: s.lang, cellId: typeof c.id === 'string' ? c.id : undefined })),
          );

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
      // The LA shared key rides in laConf so Synapse can authenticate the emitter;
      // it must NEVER be persisted to Cosmos or returned to the client in the
      // receipt. redactReceiptSecrets() masks it at both exits (below).
      const { redactReceiptSecrets } = await import('@/lib/spark/config-presets');
      // Effective sizing + a STABLE sizingKey from the ONE shared source of truth
      // (lib/spark/spark-sizing). Missing fields default from DEFAULT_LIVY_SIZING,
      // so "no config", "explicitly the default config", and the warm pool all
      // normalize to the SAME key (R3 #1 — otherwise a pre-warmed session is never
      // leasable and every first run cold-starts). A genuinely custom config gets
      // its own distinct key → its own correctly-sized session.
      const { computeEffectiveSizing } = await import('@/lib/spark/spark-sizing');
      const { sizing, sizingKey } = computeEffectiveSizing(rawCfg, laConf);

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
      let displayLoaded = false;
      let freshSession = false; // fresh cold-create OR a warm pool hand-off — both need the preamble
      let fromPool = false;
      let poolLeaseId: string | undefined;
      let sessionReceipt: Record<string, unknown> | null = null;
      const saved = state.sparkSession;
      const savedKey = saved && typeof saved.sizingKey === 'string' ? saved.sizingKey : '';
      if (saved && saved.pool === pool && saved.kind === effectiveSessKind && typeof saved.id === 'number' && savedKey === sizingKey) {
        try {
          const live = await getLivySession(pool, saved.id);
          if (['idle', 'busy', 'starting', 'not_started'].includes(live.state)) {
            sessionId = saved.id; sessState = live.state; reused = true;
            sessionReceipt = saved.request || null;
            displayLoaded = (saved as any).displayLoaded === true;
          }
        } catch { /* stale/expired → fall through to create */ }
      }

      // Warm-pool hand-off (kills the 2-4 min Synapse cold start). When the
      // notebook has no reusable session yet, try to lease a pre-warmed idle
      // Livy session from the pool instead of cold-starting one. The lease/
      // return model guarantees the session is handed to exactly THIS run (never
      // shared concurrently); the pool refills itself in the background. Pool
      // disabled / empty → acquireWarmSession returns null and we cold-start
      // below exactly as before (pure accelerator, no hard dependency).
      if (sessionId === undefined) {
        try {
          const { sparkPoolEnabled, acquireWarmSession } = await import('@/lib/azure/spark-session-pool');
          if (sparkPoolEnabled()) {
            const lease = await acquireWarmSession({
              backend: 'synapse', poolName: pool, kind: effectiveSessKind, sizingKey, sizing, userOid: s.claims?.oid,
              // FGC-10 — a run the caller marks read-only may SHARE a warm session
              // with other concurrent read-only runs (when concurrent mode is on).
              // Write runs (default) always get an exclusive session.
              readOnly: body?.readOnly === true,
            });
            if (lease && typeof lease.sessionId === 'number') {
              sessionId = lease.sessionId; sessState = 'idle';
              fromPool = true; freshSession = true; poolLeaseId = lease.leaseId;
              sessionReceipt = lease.request || null;
            }
          }
        } catch { /* pool best-effort — fall through to cold create */ }
      }

      if (sessionId === undefined) {
        const sess = await createLivySessionAsync(pool, effectiveSessKind, undefined, sizing);
        sessionId = sess.id; sessState = sess.state;
        sessionReceipt = sess.request;
        freshSession = true;
      }

      // Auto-mount attached lakehouses + display helper on any FRESH session —
      // whether cold-created just now OR leased warm from the pool (a pooled
      // session is a blank kernel, so it needs the same preamble a cold one
      // gets). Skipped on notebook-level reuse (already injected once).
      if (freshSession && sessKind === 'pyspark' && typeof sessionId === 'number') {
        // Auto-mount attached lakehouses (issue #655) — inject the
        // `loom_lakehouses` abfss preamble as a session statement on a FRESH
        // pyspark session so every cell can read the lake without typing paths.
        // Skipped on reuse (defined once per session) + non-pyspark kinds.
        // Honest: unresolvable sources are omitted; empty preamble injects
        // nothing. Non-fatal — a failure here must not break the run.
        try {
          const preamble = await buildAutoMountPreamble(state.attachedSources || [], workspaceId);
          if (preamble) {
            const { submitLivyStatement } = await import('@/lib/azure/synapse-dev-client');
            await submitLivyStatement(pool, sessionId, { code: preamble, kind: 'pyspark' });
          }
        } catch { /* non-fatal — user can still type paths manually */ }
      }

      // Rich display() helper — ensure it is loaded ONCE per session, for BOTH
      // fresh AND reused pyspark sessions. Injecting only on a fresh session left
      // display() undefined on a REUSED session that predated the helper — the
      // live "NameError: name 'display' is not defined" symptom. The helper is
      // idempotent in-kernel (sys._loom_display_v1); displayLoaded (persisted in
      // sparkSession) keeps us from re-submitting it on every cell run. Submitted
      // BEFORE the cell statement (the poll route submits the cell), so Livy's
      // FIFO ordering guarantees display() is defined by the time the cell runs.
      // DEFAULT-ON (opt-out via LOOM_RICH_DISPLAY='0'): defines display() so a bundle cell calling the Databricks/Fabric-builtin display(df) does not crash 'name display is not defined' on a raw Synapse Livy session (the Azure-native default). Idempotent + non-fatal; upgrades output to the Loom rich grid. No Fabric dependency.
      if ((process.env.LOOM_RICH_DISPLAY || '').trim() !== '0' && effectiveSessKind === 'pyspark' && !displayLoaded && typeof sessionId === 'number') {
        try {
          const { submitLivyStatement } = await import('@/lib/azure/synapse-dev-client');
          const { AI_DISPLAY_PREAMBLE } = await import('@/lib/notebook/ai-display-preamble');
          await submitLivyStatement(pool, sessionId, { code: AI_DISPLAY_PREAMBLE, kind: 'pyspark' });
          displayLoaded = true;
        } catch { /* non-fatal — display() degrades to the built-in renderer */ }
      }

      // FGC-17 — inject the Semantic Link helper (LoomDataFrame / read_table /
      // evaluate_measure / validate_relationships) as a fresh-session statement
      // so notebook cells can read a Loom semantic model with no pip install.
      // Idempotent in-kernel (sys._loom_semantic_link_v1). Default-ON (opt-out
      // via LOOM_SEMANTIC_LINK=0) and Azure-native — the helper only reaches the
      // Loom Console BFF, never Power BI / Fabric. Non-fatal.
      if ((process.env.LOOM_SEMANTIC_LINK || '').trim() !== '0' && effectiveSessKind === 'pyspark' && freshSession && typeof sessionId === 'number') {
        try {
          const { submitLivyStatement } = await import('@/lib/azure/synapse-dev-client');
          const { LOOM_SEMANTIC_LINK_PREAMBLE } = await import('@/lib/notebook/loom-semantic-link-preamble');
          await submitLivyStatement(pool, sessionId, { code: LOOM_SEMANTIC_LINK_PREAMBLE, kind: 'pyspark' });
        } catch { /* non-fatal — cells can `import loom_semantic_link` on the AML env instead */ }
      }
      const runIdStr = `spark:${pool}:${sessionId}`;

      // BR-COSTATTR — tag this Spark submit with who/where/how-much so it feeds
      // the chargeback per-user drill-down + the FGC-25 per-workspace LCU cap.
      void recordCostAttribution({
        tenantId: tenantScopeId(s), userOid: s.claims.oid, userName: s.claims.upn,
        engine: 'spark', workspaceId, itemId: nb.id, itemType: 'notebook', resourceId: pool,
        domainId: (nb as any).domainId || (state as any).domainId,
      });

      // Persist the (possibly new) session for reuse + the per-cell pending run.
      try {
        const items = await itemsContainer();
        const pendingRuns = { ...(state.pendingRuns || {}) };
        if (runQueue.length > 0) {
          // Both whole-notebook AND single-cell runs drain a per-statement queue
          // (a SQL cell can expand to multiple statements). qIdx = next to submit;
          // cellId is retained so the editor can attribute output to its cell.
          pendingRuns[runIdStr] = { queue: runQueue, qIdx: 0, cellId: cellId || undefined, startedAt: new Date().toISOString() };
        } else if (cellSource) {
          // Fallback (should be unreachable — empty code already 400s above).
          pendingRuns[runIdStr] = { source: cellSource, lang: effectiveStmtKind, cellId, startedAt: new Date().toISOString() };
        }
        await items.item(nb.id, workspaceId).replace({
          ...nb,
          state: {
            ...state,
            pendingRuns,
            sparkSession: { pool, id: sessionId, kind: effectiveSessKind, sizingKey, request: redactReceiptSecrets(sessionReceipt), displayLoaded, ...(poolLeaseId ? { poolLeaseId } : {}) },
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
        // True when this session was handed off warm from the pool (no cold
        // start). Surfaced so the editor can show "warm session ready ⚡".
        fromWarmPool: fromPool,
        compute: { kind: 'synapse-spark', pool },
        cellId: cellId || null,
        // Honest receipt: the real Livy session-create body that provisioned
        // (or is reusing) this session — `numExecutors` here is what the Spark
        // session actually runs with.
        session: redactReceiptSecrets(
          sessionReceipt
            ? { id: sessionId, state: sessState, reused, ...sessionReceipt }
            : { id: sessionId, state: sessState, reused },
        ),
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
      // BR-COSTATTR — tag this Databricks submit for the chargeback drill-down.
      void recordCostAttribution({
        tenantId: tenantScopeId(s), userOid: s.claims.oid, userName: s.claims.upn,
        engine: 'databricks', workspaceId, itemId: nb.id, itemType: 'notebook', resourceId: clusterId,
        domainId: (nb as any).domainId || (state as any).domainId,
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
