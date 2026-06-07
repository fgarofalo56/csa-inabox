/**
 * GET /api/items/data-pipeline/[id]/export?workspaceId=...
 *
 * Real pipeline export: reads the pipeline definition using the same
 * resolution chain as the detail GET route (live ADF → state.definition →
 * pipelineDefinitionFromContent), packages it into a PKZIP archive as
 * pipeline-content.json (+ manifest.json), and streams the archive as a
 * download.
 *
 * No simulated success: if the pipeline has no recoverable definition,
 * returns 404 with a structured error. The exported pipeline-content.json
 * is the canonical ADF 2018-06-01 pipeline spec — importable back into
 * Loom or directly into ADF Studio.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { getPipeline, adfConfigGate, type AdfPipeline } from '@/lib/azure/adf-client';
import { pipelineDefinitionFromContent } from '@/lib/azure/pipeline-binding';
import { writeZip } from '@/lib/azure/zip';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);

    const state = (resource.state as any) || {};
    const adfName: string | undefined = state?.adfPipelineName;

    // Resolution chain (mirrors GET [id]/route.ts exactly):
    // 1. Try live ADF (if configured and named)
    // 2. Fall back to state.definition
    // 3. Fall back to pipelineDefinitionFromContent(state.content)
    let definition: AdfPipeline | null = null;
    if (adfName && !adfConfigGate()) {
      try { definition = await getPipeline(adfName); } catch { /* ADF may not have it yet */ }
    }
    if (!definition) {
      if (state?.definition?.properties) {
        definition = state.definition as AdfPipeline;
      } else {
        const fromContent = pipelineDefinitionFromContent(state?.content, adfName);
        if (fromContent) definition = fromContent as AdfPipeline;
      }
    }
    if (!definition) {
      return err('Pipeline has no recoverable definition. Open it in the editor and Save first.', 404);
    }

    const safeName = (resource.displayName || 'pipeline')
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'pipeline';

    // manifest.json gives importers the original displayName + export metadata.
    const manifest = {
      loomExport: true,
      version: 1,
      displayName: resource.displayName,
      exportedAt: new Date().toISOString(),
      workspaceId,
      itemId: resource.id,
    };

    const zipBuf = writeZip([
      { name: 'pipeline-content.json', data: Buffer.from(JSON.stringify(definition, null, 2), 'utf-8') },
      { name: 'manifest.json',         data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8') },
    ]);

    return new NextResponse(new Uint8Array(zipBuf), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeName}.zip"`,
        'Content-Length': String(zipBuf.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    if (e?.code === 404) return err('pipeline not found', 404);
    return err(e?.message || String(e), 500);
  }
}
