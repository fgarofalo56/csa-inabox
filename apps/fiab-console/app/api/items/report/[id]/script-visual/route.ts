/**
 * POST /api/items/report/[id]/script-visual
 *
 * Power BI R / Python SCRIPT VISUAL parity (report-designer parity WAVE 4,
 * docs/fiab/parity/report-designer.md) backed by a REAL sandboxed executor.
 * This is the report program's FIRST executor-backed BFF route — waves 0-3 grew
 * the designer purely client-side over the unchanged /query path; the script
 * visual is the first surface that must run ARBITRARY user code, so it needs a
 * server hop to a hardened container. (The /ai-visual route added in wave 3
 * calls AOAI, not a code sandbox; this is the first that runs user scripts.)
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * Mirrors the Power BI Python/R-visual contract 1:1
 * (learn.microsoft.com/power-bi/connect-data/desktop-python-visuals):
 *   • the fields the author drops into the visual's Values well become a single
 *     `dataset` variable (a pandas DataFrame in Python / a data.frame in R)
 *     whose COLUMN NAMES are the field names — no rename;
 *   • rows are GROUPED + DEDUPED (duplicate rows appear once — PBI's default
 *     "Don't summarize"); we dedupe + cap here so the runner gets PBI-shaped data;
 *   • the script plots to the default device and the runner captures the ACTIVE
 *     figure as a static, non-interactive PNG (out.png @96dpi);
 *   • PBI limits — 150k rows, fixed DPI, a short wall-clock timeout — are
 *     mirrored: row cap below, DPI + per-request timeout enforced in the runner.
 *
 * ── DATA PATH — REAL Synapse aggregation, NO Fabric (no-fabric-dependency.md) ──
 * Two ways to obtain `dataset`, never a mock (no-vaporware.md):
 *   1. `body.rows` — the pane already fetched the visual's rows through the
 *      standard …/query path (Path-3 loom-native Synapse SQL, or Path-2 AAS, or
 *      the opt-in Power BI path). We take them as-is.
 *   2. otherwise we reuse the EXACT same query machinery as …/query Path-3:
 *      load the report item (owner-checked), `resolveReportModel`, and for a
 *      loom-native source compile a raw table projection of the Values-well
 *      fields with `buildSqlFromVisual({type:'table', wells:{values}})` and run
 *      it with `executeQuery` over Synapse; for an AAS source build the grouped
 *      DAX with `buildDaxFromVisual` + `executeAasQuery`. An `unbound` source
 *      returns the SAME honest 412 gate the designer already shows; a cross-table
 *      bind returns the SAME honest `code:'multi-table'` 400. NO call to
 *      api.fabric.microsoft.com / api.powerbi.com on this default path.
 *
 * ── THE SANDBOX (threat model, stated honestly) ────────────────────────────
 * Like Power BI's locked R/Python container, the executor really RUNS arbitrary
 * user code — the CONTAINER is the security boundary, not a language sandbox.
 * The loom-script-runner Container App hardens it: a non-root `runner` user;
 * INTERNAL ingress only (external:false — never public); a per-request ephemeral
 * `mkdtemp` under /tmp (chmod 700, rmtree in finally); a SCRUBBED minimal env
 * (no inherited secrets); POSIX rlimits (CPU / address-space / file-size /
 * nproc); `start_new_session` + a wall-clock timeout that SIGKILLs the whole
 * process group; and script-size / row / output-size caps. CRITICAL wiring note
 * carried into bicep + the runner README: an ACA app exposes its assigned UAMI
 * to in-container code via IMDS, so the runner MUST use a LEAST-PRIVILEGE
 * identity (AcrPull only, ZERO data-plane roles) — a dedicated
 * `uami-loom-script-runner`. Reusing the broadly-permissioned Console UAMI is a
 * real sandbox hole and is documented as a known weakness to tighten, never
 * silently. This BFF adds defense-in-depth BEFORE the hop: auth, a script-size
 * cap, language allow-list, and PBI-shaped row capping.
 *
 * ── no-freeform-config ──────────────────────────────────────────────────────
 * The code editor in the pane is Power BI 1:1 parity — Power BI's R/Python
 * visual IS a code editor — so it is EXEMPT exactly like the ADF/Synapse
 * expression builder. Everything around it (the Values wells, the R/Python
 * language toggle) stays structured picker output.
 *
 * 200 OK → { ok:true, image, mime:'image/png' }
 * 401    → unauthenticated
 * 400/413→ bad request (missing/oversized script, unknown language, no fields)
 * 412    → { ok:false, code:'unbound', error }   (honest data-source gate)
 * 502    → { ok:false, error }                    (Synapse/AAS or runner unreachable)
 * 503    → { ok:false, error }                    (executor not deployed — names env+bicep)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeAasQuery,
  buildDaxFromVisual,
  flattenAasRows,
  AasError,
  type DaxVisual,
  type DaxWellField,
} from '@/lib/azure/aas-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import {
  resolveReportModel,
  type ResolvedReportModel,
} from '@/lib/azure/report-model-resolver';
import { buildSqlFromVisual } from '@/lib/azure/wells-to-sql';
import { toSqlSource, objectRows } from '@/lib/report/query-projection';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Power BI's hard limits (mirrored): 150k dataset rows; a 200KB script ceiling. */
const ROW_CAP = 150_000;
const SCRIPT_MAX_BYTES = 200_000;
/** Wall-clock budget for the runner hop — a hair above the runner's own 30s. */
const RUNNER_TIMEOUT_MS = 35_000;

type ScriptLanguage = 'python' | 'r';

interface ColumnSpec {
  name: string;
  type: 'number' | 'string';
}

interface ScriptVisualRequest {
  visualId?: string;
  /** The Values-well fields (a `DaxWellField[]`, the array the pane drags in), or
   *  the full wells object — both accepted. Only used for the inline-query path. */
  wells?: DaxWellField[] | { values?: DaxWellField[] };
  language?: string;
  script?: string;
  /** Rows already fetched by the pane via …/query (the primary path). */
  rows?: Record<string, unknown>[];
  /** Column order + types the pane already knows (else inferred from the rows). */
  columns?: ColumnSpec[];
}

// ── inline-query bridge (identical projection to …/query Path-3) ────────────────
//
// The resolved-model → single-FROM wells→SQL projection (`toSqlSource`,
// `objectRows`, and the Wave-2 source-groups pick) is SHARED with the …/query
// route via lib/report/query-projection.ts (rel-T64). This route previously
// carried a byte-identical private copy of every one of those helpers; it now
// imports them so the inline fallback resolves rows through the SAME real
// Synapse/AAS path — no new data machinery, no mock. Script visuals carry no
// Filters-pane channel (PBI applies report/page filters upstream; the pane's
// primary path already passes pre-filtered `body.rows`), so `toSqlSource` is
// called filter-free (its `filters` argument is optional).

// ── PBI dataset shaping ─────────────────────────────────────────────────────────

/** Normalize the wells payload to the Values-well field array. */
function valuesWell(wells: ScriptVisualRequest['wells']): DaxWellField[] {
  if (Array.isArray(wells)) return wells;
  if (wells && Array.isArray(wells.values)) return wells.values;
  return [];
}

/** Light number/string inference — scan the first few rows for a non-null value
 *  per column (matches PBI's column typing closely enough to choose a dtype). */
function inferType(rows: Record<string, unknown>[], name: string): 'number' | 'string' {
  for (let i = 0; i < rows.length && i < 25; i++) {
    const v = rows[i]?.[name];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return 'number';
    if (typeof v === 'bigint') return 'number';
    return 'string';
  }
  return 'string';
}

/** Resolve the column spec: prefer the pane's explicit columns, else the query's
 *  column order, else the keys of the first row — every name typed via inference. */
function deriveColumns(
  rows: Record<string, unknown>[],
  explicit: ColumnSpec[] | undefined,
  orderedNames: string[] | undefined,
): ColumnSpec[] {
  if (Array.isArray(explicit) && explicit.length) {
    return explicit
      .map((c) => ({
        name: String((c as ColumnSpec)?.name ?? '').trim(),
        type: (c as ColumnSpec)?.type === 'number' ? ('number' as const) : ('string' as const),
      }))
      .filter((c) => c.name);
  }
  const names =
    orderedNames && orderedNames.length ? orderedNames : Object.keys(rows[0] || {});
  return names.filter(Boolean).map((name) => ({ name, type: inferType(rows, name) }));
}

/** Object rows → column-ordered tuples, deduped (PBI "Don't summarize") + capped. */
function shapeRows(
  rows: Record<string, unknown>[],
  columns: ColumnSpec[],
): unknown[][] {
  const seen = new Set<string>();
  const out: unknown[][] = [];
  for (const r of rows) {
    if (out.length >= ROW_CAP) break;
    const tuple = columns.map((c) => {
      const v = r?.[c.name];
      return v === undefined ? null : v;
    });
    let key: string;
    try {
      key = JSON.stringify(tuple);
    } catch {
      key = String(tuple);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // ── Honest gate FIRST (no-vaporware): without the executor there is nothing
  // real to call, so name the exact env var + the bicep module that deploys it.
  const runner = process.env.LOOM_SCRIPT_RUNNER_URL?.trim();
  if (!runner) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The R/Python script-visual executor is not deployed. Set LOOM_SCRIPT_RUNNER_URL ' +
          '(the internal FQDN of the loom-script-runner Container App) — provisioned by ' +
          'platform/fiab/bicep/modules/admin-plane/script-runner-app.bicep and wired into the ' +
          'console env in admin-plane/main.bicep. No Power BI / Fabric capacity required.',
      },
      { status: 503 },
    );
  }

  let body: ScriptVisualRequest = {};
  try {
    body = (await req.json()) as ScriptVisualRequest;
  } catch {
    /* empty/invalid body → validation below */
  }

  // ── Defense-in-depth validation BEFORE forwarding arbitrary code ─────────────
  const language = body.language === 'r' ? 'r' : body.language === 'python' ? 'python' : null;
  if (!language) {
    return NextResponse.json(
      { ok: false, error: "language is required and must be 'python' or 'r'." },
      { status: 400 },
    );
  }
  const script = typeof body.script === 'string' ? body.script : '';
  if (!script.trim()) {
    return NextResponse.json(
      { ok: false, error: 'script is required — write the R/Python visual code in the editor.' },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(script, 'utf8') > SCRIPT_MAX_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `The script exceeds the ${SCRIPT_MAX_BYTES.toLocaleString()}-byte limit. Trim the code (the same ceiling Power BI enforces).`,
      },
      { status: 413 },
    );
  }
  const lang: ScriptLanguage = language;

  // ── Resolve the dataset rows ─────────────────────────────────────────────────
  let objRows: Record<string, unknown>[];
  let orderedNames: string[] | undefined;

  if (Array.isArray(body.rows)) {
    // Primary path: the pane already fetched the visual's rows through …/query.
    objRows = body.rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  } else {
    // Inline fallback: fetch rows through the SAME real query machinery as …/query.
    const fields = valuesWell(body.wells);
    if (!fields.length) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'This script visual has no fields yet. Add at least one column to the Values well so a ' +
            'dataset can be built (Power BI binds the Values fields into the `dataset` variable).',
        },
        { status: 400 },
      );
    }

    const id = (await ctx.params).id;
    let item: WorkspaceItem | null;
    if (isLoomContentId(id)) {
      item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
      if (!item) {
        return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
      }
    } else {
      item = await loadModelItem(id, 'report', session.claims.oid);
      if (!item) {
        return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
      }
    }

    let resolved: ResolvedReportModel;
    try {
      resolved = await resolveReportModel(item, session.claims.oid);
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
    }

    // Honest data-source gate — the SAME 412 the designer already surfaces.
    if (resolved.backend === 'unbound') {
      return NextResponse.json(
        { ok: false, code: 'unbound', error: resolved.gate.error },
        { status: 412 },
      );
    }

    if (resolved.backend === 'loom-native') {
      // Raw projection of the Values-well fields (PBI "Don't summarize"): a table
      // visual reads category+values as plain columns — no aggregation.
      const sqlVisual: DaxVisual = { type: 'table', wells: { values: fields } };
      const projected = toSqlSource(resolved.tables, resolved.sqlSource, sqlVisual);
      if (projected.kind === 'multi-table') {
        return NextResponse.json(
          {
            ok: false,
            code: 'multi-table',
            error:
              `This script visual binds fields from more than one table of the semantic model ` +
              `(${projected.tables.join(', ')}). The Loom-native (Synapse) renderer builds each ` +
              `visual's dataset from a single model table, so cross-table script datasets aren't ` +
              `supported on this Azure-native path yet. Use a semantic model — or a direct-query ` +
              `SELECT — whose single table already joins these fields, or bind an Azure Analysis ` +
              `Services model where the relationships are defined.`,
          },
          { status: 400 },
        );
      }
      // Wave-2 cross-storage-group "limited relationship": the script visual binds
      // fields from tables in different storage-mode groups. Power BI serves these
      // only via the materialized smaller side, so the renderer requires that side's
      // Import cache. Return an honest 412 naming the exact table to materialize —
      // never a silent partial / cross join (no-vaporware.md). Azure-native
      // throughout; no Power BI / Fabric workspace required.
      if (projected.kind === 'limited') {
        return NextResponse.json(
          {
            ok: false,
            code: 'limited-relationship',
            error: projected.cacheReady
              ? `This script visual combines tables that live in different storage-mode groups ` +
                `(${projected.groups.join(', ')}). Cross-group ("limited relationship") joins need ` +
                `relationship keys defined in the model; the Loom-native (Synapse) renderer builds ` +
                `each visual's dataset from a single relation and won't cross-join "${projected.smaller}" ` +
                `with the other group's source. Model these fields in one semantic-model table (or a ` +
                `direct-query SELECT that already joins them), or bind an Azure Analysis Services model ` +
                `where the relationships are defined. No Power BI / Fabric workspace required either way.`
              : `This script visual combines tables across storage-mode groups via the smaller side ` +
                `"${projected.smaller}", but that table has no materialized Import cache yet. Set ` +
                `"${projected.smaller}" to Import (or Dual) in Storage mode and run Refresh to ` +
                `materialize its Delta cache, then re-run — the cross-group ("limited relationship") ` +
                `dataset reads the materialized smaller side. This is Azure-native (serverless ` +
                `OPENROWSET over Delta); no Power BI / Fabric workspace is required.`,
            missing: projected.smaller,
          },
          { status: 412 },
        );
      }
      if (projected.kind === 'no-columns') {
        return NextResponse.json(
          { ok: false, error: 'The report’s data source has no bindable columns for these fields.' },
          { status: 400 },
        );
      }
      const compiled = buildSqlFromVisual(sqlVisual, undefined, projected.source);
      if (!compiled) {
        return NextResponse.json(
          { ok: false, error: 'None of the chosen fields resolved to a column in the data source.' },
          { status: 400 },
        );
      }
      try {
        // Wave-2 source-group visuals run on THEIR chosen relation's target —
        // serverless for an Import / Dual / Direct-Lake Delta cache, the pinned
        // pool for a live (DirectQuery / Dual-live) relation. Single-source reports
        // set no override and keep the resolver-pinned target, byte-for-byte.
        const runTarget = projected.target ?? resolved.sqlSource.target;
        const result = await executeQuery(
          runTarget,
          compiled.sql,
          30_000,
          compiled.parameters,
        );
        orderedNames = result.columns;
        objRows = objectRows(result.columns, result.rows);
      } catch (e: any) {
        return NextResponse.json(
          { ok: false, error: e?.message || String(e), status: 502 },
          { status: 502 },
        );
      }
    } else if (resolved.backend === 'connection') {
      // ── Get Data (connection) source — the SAME dispatch the …/query route's
      // Path 4 makes (executor.runVisual). Without this arm a Get-Data CONNECTION
      // report fell through to the AAS branch below and called executeAasQuery with
      // an undefined binding (resolved.binding doesn't exist on the 'connection'
      // arm) — a runtime crash that next.config's typescript.ignoreBuildErrors was
      // masking. The resolver already wired a REAL Azure data-plane
      // ConnectionExecutor (azure-sql / synapse / databricks / postgres / cosmos /
      // serverless OPENROWSET), or returned the honest 412 gate handled above. Run
      // a raw table projection of the Values-well fields (PBI "Don't summarize" —
      // no aggregation, exactly like the loom-native script path above) and take
      // the executor's object rows as the dataset. Script visuals carry no
      // Filters-pane channel (PBI applies report/page filters upstream), so no
      // filters are pushed. Azure-native end to end — no Power BI / Fabric
      // (no-fabric-dependency.md), no mock (no-vaporware.md).
      const connVisual: DaxVisual = { type: 'table', wells: { values: fields } };
      try {
        const { rows } = await resolved.executor.runVisual(connVisual, undefined);
        objRows = rows;
      } catch (e: any) {
        return NextResponse.json(
          { ok: false, error: e?.message || String(e), status: 502 },
          { status: 502 },
        );
      }
    } else {
      // AAS: group by the column fields (SUMMARIZECOLUMNS dedupes), evaluate any
      // measure fields per group — so the DAX returns the same distinct dataset.
      const daxVisual: DaxVisual = {
        type: 'table',
        wells: {
          category: fields.filter((f) => f.column && !f.measure),
          values: fields.filter((f) => f.measure),
        },
      };
      const dax = buildDaxFromVisual(daxVisual);
      if (!dax) {
        return NextResponse.json(
          { ok: false, error: 'None of the chosen fields resolved to a model column or measure.' },
          { status: 400 },
        );
      }
      try {
        const result = await executeAasQuery(
          resolved.binding.region,
          resolved.binding.serverName,
          resolved.binding.database,
          dax,
        );
        objRows = flattenAasRows(result);
      } catch (e: any) {
        const status = e instanceof AasError ? e.status : 502;
        return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
      }
    }
  }

  // ── Shape to PBI's dataset contract (dedupe + cap + typed columns) ───────────
  const columns = deriveColumns(objRows, body.columns, orderedNames);
  if (!columns.length) {
    return NextResponse.json(
      { ok: false, error: 'The dataset has no columns to pass to the script.' },
      { status: 400 },
    );
  }
  const rows = shapeRows(objRows, columns);

  // ── Forward to the REAL sandboxed executor ───────────────────────────────────
  // Runner contract (authoritative: platform/runners/script-runner/README.md +
  // Dockerfile + docs/fiab/parity/report-designer.md):
  //   POST /run  { language, script, dataset: { columns: string[], rows: any[][] } }
  //   200 → { ok:true, png:<base64>, dpi, durationMs }
  //   422 → { ok:false, error, stderr }   (user-script error / rlimit / timeout)
  // `dataset.columns` is the field-NAME list (the runner writes dataset.csv and
  // lets pandas / R infer dtypes — no separate type channel); the runner owns its
  // DPI, wall-clock timeout, and row/output caps, so no figure-size/timeout fields
  // are sent. This MUST stay byte-for-byte in step with app.py's request model.
  const base = runner.replace(/\/$/, '');
  const url = (/^https?:\/\//i.test(base) ? base : `https://${base}`) + '/run';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNNER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        language: lang,
        script,
        dataset: { columns: columns.map((c) => c.name), rows },
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return NextResponse.json(
      {
        ok: false,
        error: aborted
          ? 'The script-visual executor did not respond in time (the run was aborted). Reduce the dataset or simplify the script.'
          : `Could not reach the script-visual executor at LOOM_SCRIPT_RUNNER_URL: ${e?.message || String(e)}.`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  // ── Relay the runner's structured result with a matching status ──────────────
  if (!res.ok || !json || json.ok !== true) {
    const status = res.ok ? 502 : res.status;
    return NextResponse.json(
      {
        ok: false,
        error: json?.error || text?.slice(0, 500) || `script execution failed (HTTP ${res.status})`,
        ...(json?.stderr ? { stderr: String(json.stderr).slice(0, 4000) } : {}),
      },
      { status },
    );
  }

  // Runner returns the active figure as a base64 `png` (always image/png). The
  // BFF→UI contract exposes it as `image` + `mime` — the report-designer Run
  // handler (script-visual.tsx) reads `j.image` / `j.mime` and renders a
  // `data:<mime>;base64,<image>` <img>. `dpi`/`durationMs` are not surfaced.
  return NextResponse.json({ ok: true, image: json.png, mime: 'image/png' });
}
