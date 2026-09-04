/**
 * GET    /api/items/ai-foundry-project/[id] — project detail
 * DELETE /api/items/ai-foundry-project/[id] — delete project
 *
 * Route-toolkit: withSession (R1/R3). Migrated by
 * `scripts/codemods/migrate-route-toolkit.mjs` under the route-toolkit guard's
 * boy-scout rule — this PR edited `lookupScope()` in a baselined hand-rolled
 * route, and the rule is that you migrate it while you are here. The 401 is
 * unchanged in shape: `apiUnauthorized()` emits the same
 * `{ ok:false, error:'unauthenticated' }` at 401 the hand-rolled prologue did.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getProject, deleteProject, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) {
    return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  }
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

/**
 * The scope `getProject` searched, described in terms this route can actually
 * establish (`deploy-integrity.md` R7).
 *
 * foundry-client resolves the resource group from `LOOM_FOUNDRY_RG` and the
 * subscription from `LOOM_FOUNDRY_SUB` / `LOOM_SUBSCRIPTION_ID`, each with a
 * built-in fallback this route cannot read. So it reports the value when the
 * env var is SET, and names the variable as unset otherwise — never a resolved
 * value it did not observe.
 */
function lookupScope(): string {
  const rg = process.env.LOOM_FOUNDRY_RG;
  const sub = process.env.LOOM_FOUNDRY_SUB || process.env.LOOM_SUBSCRIPTION_ID;
  return [
    rg ? `resource group '${rg}' (LOOM_FOUNDRY_RG)` : 'the console default resource group (LOOM_FOUNDRY_RG is unset)',
    sub ? `subscription '${sub}'` : 'the console default subscription (LOOM_FOUNDRY_SUB / LOOM_SUBSCRIPTION_ID are unset)',
  ].join(' in ');
}

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { params }) => {
  try {
    const id = params.id;
    const project = await getProject(id);
    if (!project) {
      // #3565 — a bare 'not found' left the operator with no way to tell a
      // deleted project from a project that exists under a DIFFERENT hub /
      // account than the one this console is bound to. Name the thing looked
      // for and the scope it was looked for in; assert nothing about why.
      return NextResponse.json({
        ok: false,
        error:
          `No Microsoft.MachineLearningServices/workspaces resource named '${id}' in ${lookupScope()}.`,
        hint:
          'AI Foundry projects are children of the hub this console is bound to. A project created under a different '
          + 'hub or in a different subscription is not visible here — pick that account from the AI Foundry hub editor\'s '
          + 'account picker, or set LOOM_FOUNDRY_HUB_NAME / LOOM_FOUNDRY_RG to the hub that owns it.',
      }, { status: 404 });
    }
    return NextResponse.json({ ok: true, project });
  } catch (e: any) { return err(e); }
});

export const DELETE = withSession<{ id: string }>(async (_req: NextRequest, { params }) => {
  try {
    await deleteProject(params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return err(e); }
});
