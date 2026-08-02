/**
 * GET /api/items/report/[id]/pages[?workspaceId=...]
 *
 * Returns the report's pages so the editor can render a page-navigation list
 * and deep-link the embed via the powerbi-client setPage(name) API.
 *
 * Azure-native DEFAULT (no-fabric-dependency.md): a `loom:<cosmosItemId>` id is
 * served from the item's own Cosmos `state.content` and NEVER calls Power BI —
 * `workspaceId` is not read on that branch and is therefore OPTIONAL. The live
 * Power BI REST read (`GET /groups/{ws}/reports/{id}/pages`, groupId-scoped) is
 * the opt-in path and still requires a groupId.
 *
 * No mocks. Power BI errors (401/403, report not found) surface verbatim.
 *
 * #2830 — FOUND-BUT-EMPTY IS NOT NOT-FOUND. `state.content` is written by the
 * report designer's `…/definition` PUT (or stamped by an app-bundle install), so
 * a report that has been CREATED but not yet saved has none. This route used to
 * collapse "no such item / not yours" and "your item has no pages yet" into the
 * same 404, which is what the live click-walk caught on a freshly created report:
 *
 *   404 GET /api/items/report/loom%3A8872fd18-…/pages?workspaceId=loom-native
 *
 * An owned report with nothing saved has ZERO pages — that is a 200 with an empty
 * list, and it is what `ux-baseline.md`'s clean-first-open rule requires. 404 now
 * means only what it says: the item does not exist, or it is not yours.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getReportPages, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, reportPagesFromContent,
} from '../../../_lib/pbi-content-fallback';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve a Cosmos-backed report's pages.
 *
 * Discriminated on purpose: `null` = the item is not there / not the caller's
 * (a real 404), `[]` = the item IS there and has no persisted pages yet.
 */
async function loomPages(
  cosmosItemId: string,
  tenantId: string,
): Promise<Array<Record<string, unknown>> | null> {
  const item = await loadContentBackedItem(cosmosItemId, 'report', tenantId);
  if (!item) return null;
  // reportPagesFromContent returns null when `state.content` isn't a report yet
  // (a created-but-never-saved report). The item resolved, so the honest answer
  // is an empty page list, not "not found".
  return reportPagesFromContent(item) ?? [];
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const id = params.id;

  // Bundle-installed / Loom-native report → pages/visuals come from state.content.
  // Reached BEFORE the workspace check: this branch never touches Power BI, so
  // requiring a groupId here only forced callers to invent one (#2830 —
  // `workspaceId=loom-native`, a backend NAME in a workspace-id parameter).
  if (isLoomContentId(id)) {
    const pages = await loomPages(cosmosIdFromLoomId(id), session.claims.oid);
    if (pages) return NextResponse.json({ ok: true, native: true, pages });
    return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  }

  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const pages = await getReportPages(workspaceId, id);
    return NextResponse.json({ ok: true, pages });
  } catch (e: any) {
    if (e instanceof PowerBiError && e.status === 404) {
      const pages = await loomPages(id, session.claims.oid);
      if (pages) return NextResponse.json({ ok: true, native: true, pages });
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
