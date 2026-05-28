/**
 * POST /api/items/data-pipeline/[id]/validate?workspaceId=...
 *   body: { definition?: { properties: {...} } }  // optional in-memory payload
 *
 * Hits ADF's pipeline-validation endpoint:
 *   - With body: factories/{f}/validatePipeline   (validate JSON-in-flight)
 *   - Without:   factories/{f}/pipelines/{name}/validate  (validate persisted)
 *
 * Returns the structured ADF validate response — ok=true means the ADF
 * parser is happy with refs, expressions, parameter signatures, etc.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { validatePipeline, type AdfPipeline } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);

  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) return err('Pipeline has no ADF backing — save first', 409);

    let spec: AdfPipeline | undefined = undefined;
    if (body?.definition) {
      spec = {
        name: adfName,
        properties: body.definition.properties || body.definition,
      };
    }
    const result = await validatePipeline(adfName, spec);
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      validation: result.body,
      error: result.ok ? null : (result.errorText || result.body?.error?.message || `validate failed ${result.status}`),
    }, { status: result.ok ? 200 : 200 });
    // We deliberately return 200 even when validation fails — the UI surfaces
    // ok=false with the error string. A 502 here would just confuse callers.
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}
