/**
 * POST /api/items/report/[id]/powerbi-copilot
 *
 * Power BI Copilot for the report DESIGNER (lib/editors/report-designer.tsx).
 * Distinct from the plain narrative /api/items/report/copilot route: this one
 * (1) grounds the turn in the FULL set of Power BI authoring skills relevant to
 * the report pane (skillsForPane('report') → semantic-model / report-authoring /
 * design / planner / management) AND the curated Microsoft skills, (2) makes the
 * OPT-IN Power BI remote MCP available (buildMcpShim auto-registers its
 * mcp_powerbiremote_* schema-aware query + Copilot-DAX tools when the signed-in
 * user has consented + a Power BI admin enabled the tenant setting), and (3)
 * exposes the structured "act on the open designer" tools (report_designer_add_
 * visual / report_designer_add_page) so the Copilot can BUILD the report — the
 * pane applies each spec to the designer's in-memory state, live-rendering via
 * …/query and persisting on Save (…/definition).
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the acting path
 * is the Loom-native Azure Analysis Services designer + Synapse-backed report
 * tools. The Power BI remote MCP is a strictly opt-in ENHANCEMENT — when it is
 * not configured the route still works (skills + designer-acting), and surfaces
 * the honest POWERBI_REMOTE_MCP_GATE_TEXT to the pane via a `meta` SSE event so
 * the pane can show a non-blocking remediation banner (no-vaporware.md).
 *
 * Body: { prompt, sessionId?, fields?: ModelFieldsContext, page?: PageContext }
 *   - fields : the bound AAS model's tables/columns/measures (read by the
 *              designer from …/fields) — injected so the model references REAL
 *              fields in its specs.
 *   - page   : { index, name, visualCount } of the active designer page (context).
 *
 * 503 { ok:false, error } when no AOAI deployment is wired (editor deep-links the
 * Foundry CTA). Streams Server-Sent Events of OrchestratorStep otherwise.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  orchestrate,
  resolveAoaiTarget,
  NoAoaiDeploymentError,
  LoomToolRegistry,
  getRegistry,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { buildReportTools } from '@/lib/copilot/report-tools';
import { buildReportDesignerActTools } from '@/lib/copilot/report-designer-tools';
import { REPORT_COPILOT_PERSONA } from '@/lib/azure/copilot-personas';
import {
  skillSystemBlocksForPane,
  POWERBI_REMOTE_MCP_GATE_TEXT,
} from '@/lib/copilot/powerbi-skills';
import { msSkillSystemBlocksForPane, msMcpPrefix } from '@/lib/copilot/ms-skills';
import {
  isPbiMcpConfigured,
  msRemoteMcpConfigured,
  REMOTE_BUILTIN_MCP_CATALOG,
} from '@/lib/mcp/catalog';
import { getPbiUserToken } from '@/lib/azure/pbi-user-token-store';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cross-item tools (AAS model read + build-assist) the report Copilot may use
 *  for grounding. Pulled from the default registry by name so they keep their
 *  real handlers; the report + designer-act tools are registered separately. */
const CROSS_TOOLS = [
  'tabular_list_models', 'tabular_list_tables', 'tabular_list_measures', 'tabular_eval_dax',
  'item_list', 'item_configure',
];

interface FieldsCtx {
  tables?: Array<{
    name?: string;
    columns?: Array<{ name?: string; dataType?: string }>;
    measures?: Array<{ name?: string }>;
  }>;
}

/** Render the bound model's fields as a compact grounding block (real names only). */
function serializeFields(fields: FieldsCtx | undefined): string {
  const tables = Array.isArray(fields?.tables) ? fields!.tables! : [];
  if (tables.length === 0) {
    return 'BOUND MODEL FIELDS: none loaded yet (the report has no Azure Analysis Services model bound, or the Fields pane has not loaded). Ask the user to bind a model, or use report_query_model / tabular_* to discover the schema before proposing wells.';
  }
  const lines = tables.slice(0, 60).map((t) => {
    const cols = (t.columns || []).slice(0, 80).map((c) => c?.name).filter(Boolean).join(', ');
    const meas = (t.measures || []).slice(0, 80).map((m) => m?.name).filter(Boolean).join(', ');
    return `- ${t.name}: columns [${cols}]${meas ? ` · measures [${meas}]` : ''}`;
  });
  return `BOUND MODEL FIELDS (reference ONLY these in report_designer_add_visual wells):\n${lines.join('\n')}`;
}

const ACT_INSTRUCTIONS = [
  'YOU ARE EMBEDDED IN THE CSA LOOM REPORT DESIGNER and can ACT on the open report:',
  '- To add a visual, call report_designer_add_visual with the visual type + field wells (category/values/legend).',
  '  The user approves the spec in the pane before it is placed on the canvas — never say a visual was added.',
  '- To add a page, call report_designer_add_page.',
  '- NEVER write raw DAX or JSON config for the user (no-freeform-config): emit structured wells only — the',
  '  designer synthesizes the DAX (SUMMARIZECOLUMNS) and live-renders it against the bound AAS model.',
  '- Wells must reference REAL fields from the BOUND MODEL FIELDS list below. A chart needs a category (axis)',
  '  AND a values field; a card needs values; a table needs values (columns); a slicer needs one category.',
  'You may also use report_query_model for a grounded narrative and tabular_* to inspect the model.',
].join('\n');

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: { prompt?: string; sessionId?: string; fields?: FieldsCtx; page?: { index?: number; name?: string; visualCount?: number } } = {};
  try { body = await req.json(); } catch {}
  const prompt = (body.prompt || '').trim();
  if (!prompt) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });

  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid);

  // Pre-flight: surface AOAI-missing as 503 so the pane can deep-link Foundry.
  try {
    await resolveAoaiTarget(tenantConfig);
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  const userOid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';

  // Best-effort grounding context (report name); never blocks a brand-new report.
  const boundItem = await loadContentBackedItem(cosmosId, 'report', session.claims.oid).catch(() => null);

  // ── Scoped registry: report tools + designer-act tools + select cross tools.
  const reg = new LoomToolRegistry();
  for (const t of buildReportTools(boundItem)) reg.register(t);
  for (const t of buildReportDesignerActTools()) reg.register(t);
  const base = getRegistry();
  for (const name of CROSS_TOOLS) { const t = base.get(name); if (t) reg.register(t); }

  // ── Opt-in Power BI remote MCP. buildMcpShim registers mcp_powerbiremote_*
  // ONLY when LOOM_POWERBI_MCP_CLIENT_ID is set AND this user holds a cached
  // delegated Power BI token (entra-obo). Best-effort — never breaks the chat.
  // We run it HERE (orchestrate skips the shim for a scoped registry).
  try {
    const { buildMcpShim } = await import('@/lib/azure/mcp-shim');
    await buildMcpShim(reg, userOid);
  } catch { /* MCP shim optional */ }

  // Honest connection state for the pane's banner (+ the skill gate text).
  let pbiMcpConnected = false;
  try { pbiMcpConnected = isPbiMcpConfigured() && !!(await getPbiUserToken(userOid)); } catch { /* report unconnected */ }

  // Microsoft MCP prefixes genuinely connected this turn (default-on Learn, or
  // any server whose shim tools landed in `reg`) → honest MS-skill gating.
  const connectedPrefixes: string[] = [];
  for (const e of REMOTE_BUILTIN_MCP_CATALOG) {
    const p = msMcpPrefix(e.id);
    if (msRemoteMcpConfigured(e.id) || reg.list().some((t) => t.name.startsWith(p))) connectedPrefixes.push(p);
  }

  // Compose the system prompt: report persona + acting instructions + the live
  // field grounding + the full Power BI skill blocks (with the honest opt-in MCP
  // gate when not connected) + the relevant Microsoft skill blocks. We do NOT
  // pass contextSlug to orchestrate (which would scope the advertised tool set);
  // every tool in `reg` is advertised, and the skills are injected here.
  const systemPrompt = [
    REPORT_COPILOT_PERSONA.systemPrompt,
    ACT_INSTRUCTIONS,
    serializeFields(body.fields),
    skillSystemBlocksForPane('report', { pbiMcpConnected }),
    msSkillSystemBlocksForPane('report', { connectedPrefixes }),
  ].filter(Boolean).join('\n\n');

  const personaContext: Record<string, unknown> = {
    surface: 'report-designer',
    reportId: cosmosId,
    activePage: body.page ? { index: body.page.index ?? 0, name: body.page.name, visualCount: body.page.visualCount } : undefined,
    powerBiRemoteMcp: pbiMcpConnected ? 'connected' : 'not-connected',
  };

  const sessionId = body.sessionId || `report-pbi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId });
      // Tell the pane the opt-in MCP state up front so it can render the honest,
      // non-blocking remediation banner (the rest of the Copilot still works).
      send('meta', { pbiMcpConnected, gate: pbiMcpConnected ? undefined : POWERBI_REMOTE_MCP_GATE_TEXT });
      try {
        for await (const step of orchestrate({
          prompt,
          sessionId,
          userOid,
          tenantConfig,
          systemPrompt,
          registry: reg,
          personaContext,
        })) {
          send('step', step);
          if (step.kind === 'final' || step.kind === 'error') break;
        }
      } catch (e: any) {
        send('step', { kind: 'error', error: e?.message || String(e) });
      } finally {
        send('done', { sessionId });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
