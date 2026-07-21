/**
 * POST /api/analytics/visualize
 *
 * WS-2.3 AI/BI dashboards (P1-8) — the AI-AUTHORED VISUALIZATION backend behind
 * the "Explain this metric" surface. Given a result set the caller already has
 * (its column names + a SAMPLE of the real rows) and a chosen metric, an Azure
 * OpenAI turn proposes the single best chart to explain that metric: a chart
 * kind + the X / Y (and optional series) encoding, a title, and a one-line
 * rationale. The pane renders the proposal over the REAL rows with the shared
 * in-Loom chart components — this route only PICKS the encoding, it never
 * fabricates data.
 *
 * no-vaporware.md: a real AOAI call (resolveAoaiTarget → the Foundry-hub
 * deployment via the Console UAMI). When no deployment is wired the pre-flight
 * returns an honest 503 { ok:false, error } so the pane shows the Foundry CTA and
 * still renders the (fully-local) forecast + key-driver cards — never a
 * fabricated chart. The returned encoding is VALIDATED against the caller's real
 * column list, so a hallucinated column can never be charted.
 *
 * no-fabric-dependency.md: the ONLY backend reached is Azure OpenAI — never
 * api.fabric.microsoft.com / api.powerbi.com. Columns + sample rows are supplied
 * by the caller; this route adds intelligence over them, it does not query a
 * Fabric host. Runs identically in Commercial and Gov.
 *
 * AUTHZ: getSession() 401. This route reads NO per-tenant Cosmos item by id — it
 * is a stateless AOAI transform grounded purely on the caller-supplied columns +
 * sample rows (same class as items/[type]/[id]/explain and the ai-enrich sample
 * probe), so there is no per-resource ownership to scope. Allowlisted in
 * scripts/ci/check-route-guards.mjs with that reason.
 *
 * runtime nodejs, force-dynamic.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
  aoaiCompleteJson,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Chart kinds the pane can render over real rows (lock-step with result-visualize). */
const CHART_KINDS = ['bar', 'line', 'area', 'pie', 'scatter'] as const;
type ChartKind = (typeof CHART_KINDS)[number];

interface VisualizeRequest {
  /** Result column headers (order matters — the pane maps encoding names back to columns). */
  columns?: string[];
  /** A SAMPLE of the real rows (row-major), for the model to judge shape. Capped server-side. */
  sampleRows?: unknown[][];
  /** The metric column to explain (a numeric column name). */
  metric?: string;
}

/** The structured chart spec the pane renders. All names are REAL column headers. */
interface ChartSpec {
  kind: ChartKind;
  x: string;
  y: string;
  series?: string;
  title: string;
  rationale: string;
}

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return bad('unauthenticated', 401);

  let body: VisualizeRequest = {};
  try { body = (await req.json()) as VisualizeRequest; } catch { /* empty → 400 below */ }

  const columns = Array.isArray(body.columns) ? body.columns.filter((c) => typeof c === 'string') : [];
  const metric = typeof body.metric === 'string' ? body.metric : '';
  if (columns.length < 2) return bad('columns must list at least two result columns.');
  if (!metric || !columns.includes(metric)) return bad('metric must be one of the supplied columns.');

  // Clamp the sample the model sees (never the full result — tokens + PII surface).
  const rawRows = Array.isArray(body.sampleRows) ? body.sampleRows : [];
  const sample = rawRows.slice(0, 25).map((r) => (Array.isArray(r) ? r.slice(0, columns.length) : []));

  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid);

  // Pre-flight: AOAI-missing → honest 503 (the pane keeps its local forecast +
  // key-driver cards and shows the Foundry CTA).
  try {
    await resolveAoaiTarget(tenantConfig);
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) return bad(e.message, 503);
    return bad(e instanceof Error ? e.message : String(e), 502);
  }

  const system = [
    'You are a data-visualization expert. Given a query result (column names + a sample of rows)',
    'and a target METRIC column, choose the single best chart to explain that metric.',
    `Respond with STRICT JSON: {"kind":<one of ${CHART_KINDS.join('|')}>,"x":<column>,"y":<column>,`,
    '"series":<column|null>,"title":<short string>,"rationale":<one sentence>}.',
    'Rules: "y" MUST be the metric column. "x" and "series" MUST be exact column names from the list',
    '(or null for series). Prefer a line/area chart when x looks like a date/time or ordered sequence,',
    'a bar chart for a categorical x, a pie only for few categories summing to a whole, a scatter for',
    'two numeric columns. Never invent a column that is not in the list.',
  ].join(' ');

  const user = JSON.stringify({ columns, metric, sampleRows: sample });

  let spec: ChartSpec;
  try {
    const raw = await aoaiCompleteJson<Partial<ChartSpec>>(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      tenantConfig,
      512,
    );
    // ── Validate the model output against the REAL columns (no-vaporware): a
    // hallucinated column or bogus kind can never reach the chart.
    const kind = (CHART_KINDS as readonly string[]).includes(String(raw.kind)) ? (raw.kind as ChartKind) : 'bar';
    const y = typeof raw.y === 'string' && columns.includes(raw.y) ? raw.y : metric;
    let x = typeof raw.x === 'string' && columns.includes(raw.x) ? raw.x : '';
    if (!x || x === y) x = columns.find((c) => c !== y) ?? columns[0];
    const series = typeof raw.series === 'string' && columns.includes(raw.series) && raw.series !== x && raw.series !== y
      ? raw.series : undefined;
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : `${metric} by ${x}`;
    const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 240) : '';
    spec = { kind, x, y, series, title, rationale };
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) return bad(e.message, 503);
    return bad(e instanceof Error ? e.message : String(e), 502);
  }

  return NextResponse.json({ ok: true, spec });
}
