/**
 * Data pipeline detail.
 * GET    /api/items/data-pipeline/[id]?workspaceId=...   — metadata + ADF spec
 * PUT    /api/items/data-pipeline/[id]?workspaceId=...   — update displayName/description and/or definition (writes to ADF)
 * DELETE /api/items/data-pipeline/[id]?workspaceId=...   — delete (removes ADF pipeline + Cosmos item)
 *
 * v3.25: backed by ADF, not Fabric REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { getPipeline, upsertPipeline, deletePipeline, adfConfigGate, type AdfPipeline } from '@/lib/azure/adf-client';
import { pipelineDefinitionFromContent, toAdfWireShape } from '@/lib/azure/pipeline-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, read-scoped.
  {
    const denied = await authorizeItemWorkspace(s, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'data-pipeline',
      allowReadRoles: true,
      notFound: 'pipeline not found',
    });
    if (denied) return denied;
  }
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const state = (resource.state as any) || {};
    const adfName = state?.adfPipelineName;
    let definition: AdfPipeline | null = null;
    if (adfName) {
      try { definition = await getPipeline(adfName); } catch { /* ADF may not have it yet */ }
    }
    // Fallback for bundle-installed pipelines whose rich activity graph was
    // stamped only into state.content (AdfPipelineContent / SynapsePipelineContent)
    // and never pushed to the live ADF factory — surface it as the editor's
    // expected ADF-pipeline JSON so the canvas opens FULLY BUILT-OUT (every
    // activity + dependency + parameter) rather than an empty pipeline. A
    // previously-saved state.definition takes precedence over the bundle content.
    if (!definition) {
      if (state?.definition?.properties) {
        definition = toAdfWireShape(state.definition as AdfPipeline);
      } else {
        // #3700 — `target: 'adf'`, matching `export/route.ts`. The default
        // 'canvas' target spreads activity config onto the activity ROOT, and
        // this route would then have to repair it; using the install-path
        // translator that PR #3696 verified against a real bundle means the
        // editor is handed the shape it actually reads in the first place.
        const fromContent = pipelineDefinitionFromContent(state?.content, adfName, { target: 'adf' });
        if (fromContent) definition = toAdfWireShape(fromContent) as AdfPipeline;
      }
    }
    // THE MIXED-SHAPE CLASS, NARROWED AT ITS SOURCE — on two of this route's
    // three branches. "One shape out of this route" was the earlier heading and
    // it overstated the change; the live-ADF branch below is excluded on purpose.
    //
    // WHAT WAS MEASURED. `toAdfWireShape` treats "has a `typeProperties` object"
    // as "already wire-shaped" and then preserves every root key, which is what
    // keeps a live-ADF `state`/`onInactiveMarkAs` at the root where ADF reads
    // it. That discriminator is right for a PURE shape and blind on a MIXED one.
    // This route used to hand the editor a CANVAS-shaped activity (config on the
    // root, no `typeProperties`); the inspector patches with
    // `onPatch({ typeProperties: setPath(activity.typeProperties || {}, ...) })`
    // (`activity-forms.tsx:545`) and `patchActivity` is a shallow merge
    // (`data-pipeline-editor.tsx:582`), so ONE inspector edit produced
    // `{ name, type, notebookPath, baseParameters, typeProperties:{...} }`.
    // `toAdfWireShape` then saw `typeProperties`, took the preserve-everything
    // branch, and left `notebookPath` at the root — #3700's own "publishes green
    // and does nothing" symptom, surviving the fix for it. Probed directly:
    //   root keys      : ['name','type','notebookPath','baseParameters','typeProperties']
    //   typeProperties : {"libraries":[...]}
    //
    // WHY THE REPAIR IS NOT IN `normalizeActivity`. On a mixed activity a stray
    // root key is structurally indistinguishable from a root key ADF added and
    // this codebase does not know: `{name,type,foo,typeProperties}` is the same
    // document whether `foo` is leaked canvas config or a future ADF field.
    // Measured against the published ARM schema (fetched 2026-09-08, HTTP 200,
    // 693244 bytes): `definitions.Activity.properties` is
    // `{additionalProperties, dependsOn, description, name, userProperties}` and
    // the document contains ZERO occurrences of `onInactiveMarkAs` or `"state"`,
    // so no allowlist built from it can be complete and neither default is safe.
    // The decidable place is the two branches above, where the provenance of the
    // shape is still known.
    //
    // WHY ONLY THOSE TWO AND NOT THE LIVE-ADF BRANCH — AND *NOT* BECAUSE A LIVE
    // READ IS ALREADY WIRE-SHAPED. An earlier revision of this comment said "a
    // definition read from ADF IS the wire shape, so normalizing it is a no-op".
    // That is false, and this PR's own #3700 finding is what falsifies it: three
    // write paths PUT the CANVAS shape, so for every pipeline Loom published
    // before that fix, ADF holds the canvas shape and `getPipeline` returns it.
    // What `toAdfWireShape` actually promises is narrower and is all that those
    // tests pin — IDEMPOTENT ON WIRE-SHAPED INPUT (its own docblock;
    // `lib/azure/__tests__/pipeline-binding.test.ts`, and the byte-identical
    // control in `publish/__tests__/publish-shape.test.ts`). Neither says
    // anything about a canvas-shaped input read live from ADF.
    //
    // THE REAL REASON is the decidability argument above, applied to the OTHER
    // side of the same discriminator. On a definition Loom authored, a root key
    // outside `ADF_ACTIVITY_ROOT_KEYS` is leaked canvas config. On one read live
    // from ADF the same key may be a service key this codebase does not know, and
    // the published ARM schema cannot break that tie either — it carries ZERO
    // occurrences of `onInactiveMarkAs` or `"state"`, two keys ADF demonstrably
    // does put at the activity root (the deactivated-Copy fixture recorded in
    // `pipeline-binding.ts`). Normalizing here would take `normalizeActivity`'s
    // CANVAS branch on any live activity that lacks `typeProperties` and move
    // those keys — re-inflicting the exact regression review already caught once.
    //
    // CONSEQUENCE, STATED RATHER THAN LEFT TO BE FOUND: a pre-fix-published
    // pipeline still opens canvas-shaped, and one inspector patch can still mint
    // the mixed activity. That is residual 1 in `normalizeActivity`'s docblock.
    //
    // SAFE FOR THE EDITOR, measured rather than assumed: `extractActivities`
    // reads `parsed?.properties?.activities` and nothing deeper
    // (`pipeline-dag-view.tsx:602`), so the canvas is shape-agnostic; and the
    // inspector reads `getPath(tp, ...)` for every field except the `rootPath`
    // ones, whose single site is `linkedServiceName.referenceName` — a genuine
    // ADF root key this translation keeps at the root. A canvas-shaped activity
    // actually rendered those fields EMPTY, because `activity.typeProperties`
    // was `{}`.
    return NextResponse.json({
      ok: true,
      pipeline: { id: resource.id, displayName: resource.displayName, description: resource.description, adfPipelineName: adfName },
      definition,
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('pipeline not found', 404);
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(s, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'data-pipeline',
      notFound: 'pipeline not found',
    });
    if (denied) return denied;
  }
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    let adfName = (existing.state as any)?.adfPipelineName;
    const props = body?.definition ? (body.definition.properties || body.definition) : null;
    // Save = publish: when ADF is configured, ensure a LIVE ADF pipeline backs
    // this item. On first save of a new / bundle-installed pipeline there is no
    // adfPipelineName yet, so we mint one and create the ADF pipeline — without
    // this the pipeline saved to Cosmos but never got an ADF backing, and Run
    // gated forever ("no ADF backing — publish it first") with no way out.
    // When ADF isn't configured we still persist the definition to Cosmos; Run
    // surfaces the honest env-var gate instead.
    if (props && !adfConfigGate()) {
      if (!adfName) {
        const base = (body?.displayName?.trim() || existing.displayName || 'pipeline')
          .replace(/[^A-Za-z0-9 _()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'pipeline';
        adfName = `${base}_${(existing.id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'loom'}`;
      }
      try {
        // #3700 — the "Save = publish" WRITE BOUNDARY. `props` is
        // `body.definition.properties`, i.e. the CANVAS shape the designer holds
        // (activity config spread onto the activity root). ADF reads
        // `typeProperties` and ignores root keys, so PUT raw this authored a
        // pipeline that saved green and did nothing. `state.definition` below
        // keeps the CANVAS shape deliberately — that is what the editor reloads.
        await upsertPipeline(adfName, { name: adfName, properties: toAdfWireShape(props) });
      } catch (e: any) { return apiError(`ADF write failed: ${e?.message || e}`, 502); }
    }
    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName?.trim() || existing.displayName,
      description: 'description' in body ? body.description : existing.description,
      state: {
        ...(existing.state || {}),
        ...(body?.definition ? { definition: body.definition } : {}),
        ...(adfName ? { adfPipelineName: adfName } : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({ ok: true, pipeline: resource, adfPipelineName: adfName, published: !!adfName });
  } catch (e: any) { return apiServerError(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(s, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'data-pipeline',
      notFound: 'pipeline not found',
    });
    if (denied) return denied;
  }
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    const adfName = (existing?.state as any)?.adfPipelineName;
    if (adfName) { try { await deletePipeline(adfName); } catch { /* tolerate ADF 404 */ } }
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return apiServerError(e);
  }
}
