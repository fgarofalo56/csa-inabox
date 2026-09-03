/**
 * GET    /api/items/ai-foundry-project/[id] — project detail
 * DELETE /api/items/ai-foundry-project/[id] — delete project
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getProject, deleteProject, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

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

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const id = (await ctx.params).id;
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
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    await deleteProject((await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return err(e); }
}
