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
import { loadOwnedItem } from '../../../_lib/item-crud';
import type { DataAgentSource, DataAgentSourceType } from '@/lib/azure/data-agent-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';
const KINDS: DataAgentSourceType[] = ['warehouse', 'lakehouse', 'kql', 'semantic-model', 'ai-search', 'ontology', 'graph'];

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // OWNERSHIP gate — this route probes a caller-supplied source descriptor and
  // reads its live schema (Synapse INFORMATION_SCHEMA / ADX .show / AI Search).
  // A bare session is NOT sufficient: without owning the parent data-agent item
  // any signed-in user could enumerate schema for an arbitrary source by passing
  // someone else's [id]. Mirror the sibling endorsement/security-roles routes:
  // 404 (don't leak existence) when the data-agent isn't the caller's.
  const { id } = await ctx.params;
  if (id && id !== 'new') {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'data-agent not found or not owned by you' }, { status: 404 });
  }

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
