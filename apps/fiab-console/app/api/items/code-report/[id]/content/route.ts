/**
 * GET  /api/items/code-report/[id]/content — load a Code report's source + engine.
 * PUT  /api/items/code-report/[id]/content — save them (real Cosmos write).
 *
 * The `code-report` item's authoring surface is its SOURCE TEXT (Markdown + fenced
 * `sql` / `sql loom` query blocks + `{visual}` directives) — BI-as-code. This
 * route is the persistence seam the editor saves through; the render route reads
 * the SAME `state.source` + `state.engine` it writes.
 *
 * A save NEVER hard-fails on a parse error (drafts must be saveable — validation
 * surfaces on Run / `loom report validate`, per ux-baseline "validation after
 * save-attempt, never red on first open"); the response carries a best-effort
 * `valid` + `parseError` so the editor can show inline status without blocking.
 * The `engine` binding IS validated (structured enum, no freeform).
 *
 * Auth: withWorkspaceOwner('code-report', …) — the exact loadOwnedItem owner gate
 * (404, not 403). Azure-native (no Fabric/Power BI). IL5-safe (pure Cosmos I/O).
 */
import type { NextRequest } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError, apiNotFound } from '@/lib/api/respond';
import { updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  parseCodeReport,
  CodeReportParseError,
  CODE_REPORT_ENGINES,
  DEFAULT_QUERY_MAX,
  type CodeReportEngine,
} from '@/lib/code-report/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'code-report';
/** Guardrail on stored source size (a report is text, not a data lake). */
const MAX_SOURCE_BYTES = 512 * 1024;

function normalizeEngine(v: unknown): CodeReportEngine {
  return typeof v === 'string' && (CODE_REPORT_ENGINES as readonly string[]).includes(v)
    ? (v as CodeReportEngine)
    : 'synapse';
}

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req: NextRequest, { item }) => {
  const state = (item.state || {}) as Record<string, unknown>;
  const source = typeof state.source === 'string' ? state.source : '';
  const engine = normalizeEngine(state.engine);
  return apiOk({ source, engine, displayName: item.displayName });
});

export const PUT = withWorkspaceOwner(ITEM_TYPE, async (req: NextRequest, { session, item }) => {
  const body = (await req.json().catch(() => ({}))) as { source?: unknown; engine?: unknown };

  if (body.source !== undefined && typeof body.source !== 'string') {
    return apiError('source must be a string', 400);
  }
  const source = body.source === undefined
    ? (typeof (item.state as Record<string, unknown> | undefined)?.source === 'string'
        ? String((item.state as Record<string, unknown>).source)
        : '')
    : String(body.source);
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return apiError(`source too large (> ${Math.round(MAX_SOURCE_BYTES / 1024)} KB)`, 413);
  }

  if (body.engine !== undefined && !(CODE_REPORT_ENGINES as readonly string[]).includes(String(body.engine))) {
    return apiError(`engine must be one of ${CODE_REPORT_ENGINES.join(', ')}`, 400);
  }
  const engine = body.engine === undefined
    ? normalizeEngine((item.state as Record<string, unknown> | undefined)?.engine)
    : (String(body.engine) as CodeReportEngine);

  // Best-effort parse for inline status — NEVER blocks the save (drafts allowed).
  let valid = true;
  let parseError: { message: string; line: number } | null = null;
  let queryCount = 0;
  try {
    const ast = parseCodeReport(source);
    queryCount = ast.queries.length;
  } catch (e) {
    if (e instanceof CodeReportParseError) {
      valid = false;
      parseError = { message: e.message, line: e.line };
    } else {
      return apiServerError(e);
    }
  }

  try {
    const nextState: Record<string, unknown> = {
      ...(item.state as Record<string, unknown> | undefined),
      source,
      engine,
    };
    const saved = await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, { state: nextState });
    if (!saved) return apiNotFound('code report not found or not owned by you');
    return apiOk({ source, engine, valid, parseError, queryCount, maxQueries: DEFAULT_QUERY_MAX });
  } catch (e) {
    return apiServerError(e);
  }
});
