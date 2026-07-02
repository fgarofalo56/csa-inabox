/**
 * GET /api/items/data-agent/[id]/source-schema?sourceKind=<k>&name=<resource>&tables=<opt>
 *
 * Structured schema browser for the data-agent typed source picker. Replaces the
 * freeform comma-separated table Input (per .claude/rules/loom_no_freeform_config)
 * with a real Tables / Views / Functions / Fields checkbox Tree.
 *
 * Azure-native, NO Fabric: objects come from the SAME real backends the config
 * copilot reads — Synapse INFORMATION_SCHEMA (warehouse / lakehouse), ADX
 * `.show tables` / `.show functions` (kql), and AI Search getIndex fields
 * (ai-search) — via `listSourceObjects` in lib/copilot/agent-config-tools.ts.
 * An unreachable / unconfigured backend returns an honest gate (HTTP 503,
 * ok:false, gate.remediation naming the exact env var) — never a Fabric prompt.
 *
 * The source descriptor is passed in query params (sourceKind + name) rather
 * than read from Cosmos, so a just-added, not-yet-saved source browses its
 * schema immediately without a persist round-trip.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSourceObjects } from '@/lib/copilot/agent-config-tools';
import type { DataAgentSource, DataAgentSourceType } from '@/lib/azure/data-agent-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: DataAgentSourceType[] = ['warehouse', 'lakehouse', 'kql', 'semantic-model', 'ai-search', 'ontology', 'graph'];

export async function GET(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const sourceKind = String(sp.get('sourceKind') || '').trim() as DataAgentSourceType;
  if (!KINDS.includes(sourceKind)) {
    return NextResponse.json({ ok: false, error: `sourceKind must be one of: ${KINDS.join(', ')}` }, { status: 400 });
  }
  const name = String(sp.get('name') || sp.get('connection') || '').trim();
  const tables = String(sp.get('tables') || '').trim();
  const src: DataAgentSource = { id: `${sourceKind}:probe`, type: sourceKind, name, tables: tables || undefined };

  try {
    const { objects, gate } = await listSourceObjects(src);
    if (gate) {
      // Honest infra / N-A gate — the picker surfaces this verbatim in a MessageBar.
      return NextResponse.json({ ok: false, gate: { reason: gate, remediation: gate }, error: gate }, { status: 503 });
    }
    return NextResponse.json({ ok: true, tables: objects });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
