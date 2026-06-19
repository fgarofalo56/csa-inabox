/**
 * RAI content-filter policies for the Content Safety editor.
 *
 * GET    /api/items/content-safety/rai-policies            — list policies (real ARM)
 * POST   /api/items/content-safety/rai-policies            — create/update a policy
 *   body: { name, basePolicyName?, mode?, contentFilters:[{name,enabled?,blocking?,severityThreshold?,source?}], customBlocklists?:[{blocklistName,blocking?,source?}] }
 * DELETE /api/items/content-safety/rai-policies?name=<policy> — delete a policy
 *
 * Backed by Microsoft.CognitiveServices/accounts/{name}/raiPolicies (ARM,
 * 2024-10-01). Every severity threshold is a REAL persisted policy value — no
 * fabricated thresholds (issue #1410 / no-vaporware.md). When no model-hosting
 * account is configured the client throws CsNotConfiguredError → honest 503 gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listRaiPolicies,
  upsertRaiPolicy,
  deleteRaiPolicy,
  CsError,
  CsNotConfiguredError,
  type RaiContentFilter,
  type RaiCustomBlocklist,
} from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof CsError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { account, policies } = await listRaiPolicies();
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location, kind: account.kind }, policies });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    if (!Array.isArray(body?.contentFilters)) return NextResponse.json({ ok: false, error: 'contentFilters (array) required' }, { status: 400 });
    const contentFilters: RaiContentFilter[] = body.contentFilters
      .filter((f: any) => f && f.name)
      .map((f: any) => ({
        name: String(f.name),
        enabled: typeof f.enabled === 'boolean' ? f.enabled : undefined,
        blocking: typeof f.blocking === 'boolean' ? f.blocking : undefined,
        severityThreshold: f.severityThreshold ? String(f.severityThreshold) as RaiContentFilter['severityThreshold'] : undefined,
        source: f.source ? String(f.source) as RaiContentFilter['source'] : undefined,
      }));
    const customBlocklists: RaiCustomBlocklist[] | undefined = Array.isArray(body?.customBlocklists)
      ? body.customBlocklists.filter((b: any) => b && b.blocklistName).map((b: any) => ({
          blocklistName: String(b.blocklistName),
          blocking: typeof b.blocking === 'boolean' ? b.blocking : undefined,
          source: b.source ? String(b.source) as RaiCustomBlocklist['source'] : undefined,
        }))
      : undefined;
    const policy = await upsertRaiPolicy({
      name,
      basePolicyName: body.basePolicyName ? String(body.basePolicyName) : undefined,
      mode: body.mode ? String(body.mode) as any : undefined,
      contentFilters,
      customBlocklists,
    });
    return NextResponse.json({ ok: true, policy });
  } catch (e: any) { return err(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    await deleteRaiPolicy(name);
    return NextResponse.json({ ok: true, deleted: name });
  } catch (e: any) { return err(e); }
}
