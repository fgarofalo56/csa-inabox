/**
 * GET /api/items/tapestry/[id]/databases
 *   → { ok, databases: [{ name }], defaultDatabase }
 *
 * The addressable-database picker for the Tapestry editor's Link / Geo /
 * Timeline panes.
 *
 * WHY THIS ROUTE EXISTS — GHSA-v2g8-gp3r-rg4r. Binding the three tapestry panes
 * to `workspaceAdxScope` left the editor with the exact defect
 * `graph-model/[id]/source-schema` had just lost: its "ADX database (optional)"
 * control was a FREE-TEXT `<Input>` hinted "Defaults to LOOM_KUSTO_DEFAULT_DB",
 * so any value the user typed that is not bound to an ADX-backed item in that
 * workspace now returns 403 — the field 403s on its own documented use. Blank
 * still worked, so it was not a break, but "the picker offers choices its own
 * consumer would refuse" is the precise mismatch this advisory's remediation
 * keeps having to fix, and shipping the fix for one family while creating it in
 * another is not a fix.
 *
 * It returns exactly `workspaceAdxScope(item)` — the same set `[id]/link`,
 * `[id]/geo` and `[id]/timeline` admit, resolved through the same call — so
 * picker and consumer agree by construction rather than by review. It also
 * settles `loom_no_freeform_config`: a typed pick, not a text box.
 */
import { NextRequest, NextResponse } from 'next/server';
import { defaultDatabase, kustoConfigGate } from '@/lib/azure/kusto-client';
import { apiServerError } from '@/lib/api/respond';
import { guardAdxItemRequest, workspaceAdxScope } from '../../../_lib/adx-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    // A picker over data the caller is already authorized to query, so shared
    // read roles are admitted — matching the three panes it feeds.
    const guard = await guardAdxItemRequest({
      itemId: id,
      itemType: 'tapestry',
      notFound: 'tapestry not found',
      allowReadRoles: true,
    });
    if (guard.res) return guard.res;

    const gate = kustoConfigGate();
    if (gate) {
      return NextResponse.json({
        ok: false,
        code: 'not_configured',
        error: `Tapestry needs Azure Data Explorer. Set ${gate.missing} (the ADX cluster that backs Loom graphs) and grant the Console UAMI Database Viewer. No Microsoft Fabric required.`,
      }, { status: 503 });
    }

    // The workspace's OWN bound databases. `.show databases` is deliberately not
    // called: enumerating the shared cluster is the disclosure this advisory is
    // about, and the panes would refuse anything outside this set anyway.
    const scope = await workspaceAdxScope(guard.ctx.item);
    return NextResponse.json({
      ok: true,
      defaultDatabase: defaultDatabase(),
      databases: [...scope].sort().map((name) => ({ name })),
    });
  } catch (e) {
    return apiServerError(e);
  }
}
