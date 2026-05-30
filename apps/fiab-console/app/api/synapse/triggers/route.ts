/**
 * Triggers on the deployment-default Synapse workspace (workspace-wide). Backs
 * the "Triggers" group in the Workspace Resources navigator.
 *
 *   GET    /api/synapse/triggers              → { ok, triggers: [{name, type, runtimeState, pipelines}] }
 *   POST   /api/synapse/triggers              body { name, properties }                  → upsert
 *                                             body { name, action:'start'|'stop'|'delete' } → lifecycle
 *   DELETE /api/synapse/triggers?name=NAME    → delete
 *
 * Workspace is the env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE
 * isn't set. Real Synapse dev-plane REST (api-version 2020-12-01). No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listTriggers, upsertTrigger, deleteTrigger, startTrigger, stopTrigger,
  type SynapseTrigger,
} from '@/lib/azure/synapse-dev-client';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_-]{1,260}$/;

function gate() {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const triggers = (await listTriggers()).map((t) => ({
      name: t.name,
      type: t.properties?.type,
      runtimeState: t.properties?.runtimeState,
      pipelines: (t.properties?.pipelines || []).map((p) => p.pipelineReference?.referenceName).filter(Boolean),
    }));
    return NextResponse.json({ ok: true, triggers });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _ or -' }, { status: 400 });
  try {
    if (body.action === 'start') { await startTrigger(name); return NextResponse.json({ ok: true, action: 'start' }); }
    if (body.action === 'stop')  { await stopTrigger(name);  return NextResponse.json({ ok: true, action: 'stop' }); }
    if (body.action === 'delete'){ await deleteTrigger(name); return NextResponse.json({ ok: true, action: 'delete' }); }

    // Upsert. Caller may pass full `properties`; otherwise build a daily
    // ScheduleTrigger (Stopped, no pipelines wired — the operator wires a
    // pipeline reference from the pipeline editor's per-pipeline triggers UI).
    const properties: SynapseTrigger['properties'] = body.properties || {
      type: 'ScheduleTrigger',
      runtimeState: 'Stopped',
      typeProperties: {
        recurrence: { frequency: 'Day', interval: 1, startTime: new Date().toISOString(), timeZone: 'UTC' },
      },
    };
    const saved = await upsertTrigger(name, { name, properties });
    return NextResponse.json({
      ok: true,
      trigger: { name: saved.name, type: saved.properties?.type, runtimeState: saved.properties?.runtimeState },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteTrigger(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
