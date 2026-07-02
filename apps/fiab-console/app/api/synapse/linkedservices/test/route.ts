/**
 * Test (validate) a linked-service spec against the deployment-default Synapse
 * workspace BEFORE the user commits it.
 *
 *   POST /api/synapse/linkedservices/test   body { properties }  → { ok:true } | { ok:false, error }
 *
 * Calls synapse-artifacts-client.testLinkedService, which PUTs a transient
 * linked service under a temp name + deletes it — a real dev-plane round-trip
 * that surfaces a malformed `typeProperties`, an unknown connector `type`, an
 * unreachable workspace, or a rejected credential shape. No mocks
 * (per no-vaporware.md).
 *
 * Workspace is the env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE
 * isn't set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, testLinkedService, type SynapseLinkedService,
} from '@/lib/azure/synapse-artifacts-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const properties = body?.properties as SynapseLinkedService['properties'] | undefined;
  if (!properties || typeof properties.type !== 'string') {
    return NextResponse.json({ ok: false, error: 'properties.type is required' }, { status: 400 });
  }
  try {
    await testLinkedService({ name: 'test', properties });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
