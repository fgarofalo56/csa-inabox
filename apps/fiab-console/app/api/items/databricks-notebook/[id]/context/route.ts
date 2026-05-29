/**
 * Execution-context lifecycle for the interactive Databricks notebook.
 *
 * POST   /api/items/databricks-notebook/[id]/context
 *        body { clusterId, language } -> { ok, contextId }
 *        Creates a REPL execution context on the cluster (api/1.2/contexts/create).
 *        State (vars/imports/temp views) persists across cell runs in this context.
 *
 * DELETE /api/items/databricks-notebook/[id]/context
 *        body { clusterId, contextId } -> { ok }
 *        Tears the context down (api/1.2/contexts/destroy). Best-effort.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createExecutionContext,
  destroyExecutionContext,
  type CommandLanguage,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LANGS: CommandLanguage[] = ['python', 'sql', 'scala', 'r'];

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const clusterId = (body?.clusterId || '').toString().trim();
  const language = (body?.language || 'python').toString().toLowerCase() as CommandLanguage;
  if (!clusterId) {
    return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  }
  if (!LANGS.includes(language)) {
    return NextResponse.json({ ok: false, error: `invalid language: ${language}` }, { status: 400 });
  }
  try {
    const ctx = await createExecutionContext(clusterId, language);
    return NextResponse.json({ ok: true, contextId: ctx.id });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : e?.status === 404 ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const clusterId = (body?.clusterId || '').toString().trim();
  const contextId = (body?.contextId || '').toString().trim();
  if (!clusterId || !contextId) {
    return NextResponse.json(
      { ok: false, error: 'clusterId and contextId are required' },
      { status: 400 },
    );
  }
  try {
    await destroyExecutionContext(clusterId, contextId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
