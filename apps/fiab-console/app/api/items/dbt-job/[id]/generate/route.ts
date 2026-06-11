/**
 * GET /api/items/dbt-job/[id]/generate
 *
 * Returns the real dbt project files generated from the item's persisted
 * visual-builder graph (state.project). This is the "Generated files" preview
 * + download surface — the same files that get pushed to Databricks / sent to
 * the Synapse runner on a run. No Azure call: pure deterministic codegen over
 * real Cosmos state (not a mock).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';
import { generateProject, findDanglingRefs } from '@/lib/dbt/dbt-codegen';
import type { DbtProjectGraph } from '@/lib/dbt/dbt-project-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'dbt-job';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const { id } = await ctx.params;
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const project = (item.state as any)?.project as DbtProjectGraph | undefined;
    if (!project || !Array.isArray(project.models) || project.models.length === 0) {
      return NextResponse.json({
        ok: false,
        code: 'no_project',
        error: 'No models defined yet. Add a source and a model in the visual builder, then generate.',
      }, { status: 400 });
    }
    const files = generateProject(project);
    const dangling = findDanglingRefs(project);
    return NextResponse.json({ ok: true, files, dangling });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
