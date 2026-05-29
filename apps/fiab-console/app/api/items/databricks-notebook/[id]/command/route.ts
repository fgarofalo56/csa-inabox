/**
 * Per-cell command execution for the interactive Databricks notebook.
 *
 * POST /api/items/databricks-notebook/[id]/command
 *   body {
 *     clusterId: string,
 *     language: 'python' | 'sql' | 'scala' | 'r',
 *     command: string,
 *     contextId?: string,   // reuse an existing REPL context if provided
 *   }
 *   -> {
 *     ok, contextId,
 *     status,                       // 'Finished' | 'Error' | 'Cancelled' | ...
 *     resultType,                   // 'text' | 'table' | 'image' | 'error'
 *     columns?, rows?,              // when resultType === 'table'
 *     text?,                        // when resultType === 'text'
 *     image?,                       // base64 PNG when resultType === 'image'
 *     error?, cause?,               // when resultType === 'error'
 *     truncated?
 *   }
 *
 * Backend: Databricks Command Execution API (api/1.2). If no contextId is
 * supplied, one is created on the fly and returned so the client can reuse
 * it for subsequent cells (preserving REPL state). Markdown cells are never
 * sent here — they render client-side.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createExecutionContext,
  executeCommand,
  type CommandLanguage,
  type CommandResult,
} from '@/lib/azure/databricks-client';

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

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const clusterId = (body?.clusterId || '').toString().trim();
  const language = (body?.language || 'python').toString().toLowerCase() as CommandLanguage;
  const command = (body?.command ?? '').toString();
  let contextId = (body?.contextId || '').toString().trim();

  if (!clusterId) {
    return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  }
  if (!LANGS.includes(language)) {
    return NextResponse.json({ ok: false, error: `invalid language: ${language}` }, { status: 400 });
  }
  if (!command.trim()) {
    return NextResponse.json({ ok: false, error: 'command is empty' }, { status: 400 });
  }

  try {
    if (!contextId) {
      const ctx = await createExecutionContext(clusterId, language);
      contextId = ctx.id;
    }
    const result = await executeCommand(clusterId, contextId, language, command);
    return NextResponse.json({ ok: true, contextId, ...shapeResult(result) });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : e?.status === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, contextId: contextId || undefined, error: e?.message || String(e) },
      { status },
    );
  }
}
