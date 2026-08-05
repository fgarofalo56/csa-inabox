/**
 * Per-cell command execution for the interactive Databricks notebook.
 *
 * POST /api/items/databricks-notebook/[id]/command
 *   body {
 *     clusterId?: string,   // OPTIONAL — validated against this workspace's
 *                           // entitlement, or derived when omitted (#2988)
 *     language: 'python' | 'sql' | 'scala' | 'r',
 *     command: string,
 *     contextId?: string,   // an opaque handle a PREVIOUS response returned
 *     workspaceId?: string, // optional; resolved from the item when absent
 *   }
 *   -> {
 *     ok, contextId,                // opaque handle, not a raw Databricks id
 *     clusterId,                    // the cluster actually authorized + used
 *     status,                       // 'Finished' | 'Error' | 'Cancelled' | ...
 *     resultType,                   // 'text' | 'table' | 'image' | 'error'
 *     columns?, rows?,              // when resultType === 'table'
 *     text?,                        // when resultType === 'text'
 *     image?,                       // base64 PNG when resultType === 'image'
 *     error?, cause?,               // when resultType === 'error'
 *     truncated?
 *   }
 *
 * Backend: Databricks Command Execution API (api/1.2). If no context handle is
 * supplied, one is created on the fly and returned so the client can reuse it
 * for subsequent cells (preserving REPL state). Markdown cells are never sent
 * here — they render client-side.
 *
 * SECURITY (#2988). This route EXECUTES ARBITRARY CODE as the Console's UAMI on
 * the shared Databricks workspace. It shipped with `[id]` decorative — the
 * handler did not accept `ctx.params` at all — and no workspace authorization,
 * so any signed-in user could run anything on any cluster. Every coordinate is
 * now bound: see `../../_lib/notebook-exec-scope.ts` for the two-layer rule and
 * why neither layer alone suffices. The guard is deliberately WRITE-scoped (no
 * `allowReadRoles`) because execution is a mutation regardless of what it reads.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  createExecutionContext,
  executeCommand,
  type CommandLanguage,
  type CommandResult,
} from '@/lib/azure/databricks-client';
import {
  authorizeNotebookItem,
  mintExecContextHandle,
  resolveAuthorizedClusterId,
  verifyExecContextHandle,
} from '../../_lib/notebook-exec-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LANGS: CommandLanguage[] = ['python', 'sql', 'scala', 'r'];

/**
 * Normalise a raw Command Execution result into the flat JSON shape the
 * notebook cell UI renders. The api/1.2 'table' resultType carries a
 * `schema` (column name+type) and `data` (array of row arrays); 'text'
 * carries a string in `data`; 'image' carries base64 in `data`; 'error'
 * carries `summary`/`cause`.
 */
function shapeResult(r: CommandResult) {
  const res = r.results || {};
  const type = res.resultType || 'text';
  const out: Record<string, unknown> = {
    status: r.status,
    resultType: type,
    truncated: !!res.truncated,
  };
  if (type === 'table') {
    out.columns = (res.schema || []).map((c) => c?.name ?? '');
    out.rows = Array.isArray(res.data) ? res.data : [];
  } else if (type === 'image') {
    out.image = typeof res.data === 'string' ? res.data : '';
    out.fileName = res.fileName;
  } else if (type === 'error') {
    out.error = res.summary || 'Command failed';
    out.cause = res.cause;
  } else {
    // text / unknown — stringify whatever came back.
    out.text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
  }
  return out;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  // LAYER 1 — authorize the caller against THIS notebook item, write-scoped.
  // Runs before anything is read from the body that reaches Databricks.
  const { denied } = await authorizeNotebookItem(
    id,
    body?.workspaceId ?? req.nextUrl.searchParams.get('workspaceId'),
  );
  if (denied) return denied;

  const language = (body?.language || 'python').toString().toLowerCase() as CommandLanguage;
  const command = (body?.command ?? '').toString();
  if (!LANGS.includes(language)) {
    return NextResponse.json({ ok: false, error: `invalid language: ${language}` }, { status: 400 });
  }
  if (!command.trim()) {
    return NextResponse.json({ ok: false, error: 'command is empty' }, { status: 400 });
  }

  // LAYER 2a — the cluster is derived when omitted and entitlement-checked when
  // supplied. It is never the caller's raw string.
  const cluster = await resolveAuthorizedClusterId(body?.clusterId, { autoStart: true });
  if (!cluster.ok) {
    return NextResponse.json(
      { ok: false, error: cluster.error, ...(cluster.remediation ? { remediation: cluster.remediation } : {}) },
      { status: cluster.status },
    );
  }
  const clusterId = cluster.clusterId;
  const scope = { itemId: id, clusterId, language };

  // LAYER 2b — a supplied context handle must verify against THIS item's scope.
  // A raw or foreign context id does not verify, so it can never be attached to.
  let contextId: string;
  const rawHandle = body?.contextId;
  if (rawHandle) {
    const verified = verifyExecContextHandle(scope, rawHandle);
    if (!verified) {
      return NextResponse.json(
        { ok: false, error: 'contextId is not a valid execution context for this notebook.' },
        { status: 403 },
      );
    }
    contextId = verified;
  } else {
    try {
      const created = await createExecutionContext(clusterId, language);
      contextId = created.id;
    } catch (e: any) {
      const status = e?.status === 403 ? 403 : e?.status === 404 ? 404 : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  try {
    const result = await executeCommand(clusterId, contextId, language, command);
    return NextResponse.json({
      ok: true,
      contextId: mintExecContextHandle(scope, contextId),
      clusterId,
      ...shapeResult(result),
    });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : e?.status === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, contextId: mintExecContextHandle(scope, contextId), error: e?.message || String(e) },
      { status },
    );
  }
}
