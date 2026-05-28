/**
 * Cross-source operation: promote an ADLS Gen2 (or S3 / GCS) path into a
 * OneLake-visible shortcut inside a Fabric Lakehouse, without copying bytes.
 *
 * GET    /api/catalog/shortcut?workspaceId=...&itemId=...
 *   List existing shortcuts on a Lakehouse.
 *
 * POST   /api/catalog/shortcut
 *   Body: {
 *     workspaceId, itemId,                   // Fabric workspace + Lakehouse id
 *     name,                                   // shortcut display name
 *     path?: string,                          // e.g. "Files/bronze" (default: "Files")
 *     target: {                               // exactly one sub-field
 *       adlsGen2?: { location, subpath, connectionId? },
 *       amazonS3?: { location, subpath, connectionId? },
 *       googleCloudStorage?: { location, subpath, connectionId? },
 *       oneLake?: { workspaceId, itemId, path },
 *     },
 *     // optional cross-source: also register the shortcut in Purview Atlas
 *     registerInPurview?: boolean,
 *     domain?: string,                        // Purview businessDomainId guid
 *   }
 *
 * DELETE /api/catalog/shortcut?workspaceId=...&itemId=...&path=...&name=...
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createOneLakeShortcut, listOneLakeShortcuts, deleteOneLakeShortcut,
  FabricError,
} from '@/lib/azure/fabric-client';
import {
  registerAtlasEntity, PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';
  const itemId = req.nextUrl.searchParams.get('itemId') || '';
  if (!workspaceId || !itemId) {
    return NextResponse.json({ ok: false, error: 'workspaceId and itemId required' }, { status: 400 });
  }
  try {
    const shortcuts = await listOneLakeShortcuts(workspaceId, itemId);
    return NextResponse.json({ ok: true, count: shortcuts.length, shortcuts });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), hint: (e as any)?.hint }, { status: status || 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const { workspaceId, itemId, name, target } = body;
  const path = body.path || 'Files';
  if (!workspaceId || !itemId || !name || !target) {
    return NextResponse.json({ ok: false, error: 'workspaceId, itemId, name, target required' }, { status: 400 });
  }
  try {
    const shortcut = await createOneLakeShortcut(workspaceId, { itemId, path, name, target });

    // Optional cross-source: register the shortcut in Purview so it's
    // discoverable from federated search.
    let purviewGuid: string | undefined;
    let purviewDeepLink: string | null = null;
    let purviewError: string | undefined;
    if (body.registerInPurview) {
      try {
        const qualifiedName = `https://onelake.dfs.fabric.microsoft.com/${workspaceId}/${itemId}/${encodeURIComponent(path)}/${encodeURIComponent(name)}`;
        const upsert = await registerAtlasEntity({
          typeName: 'fabric_onelake_shortcut',
          qualifiedName,
          displayName: name,
          comment: target.adlsGen2
            ? `OneLake shortcut → ADLS ${target.adlsGen2.location}${target.adlsGen2.subpath}`
            : `OneLake shortcut: ${name}`,
          domain: body.domain,
        });
        purviewGuid = upsert.primaryGuid;
        if (purviewGuid && process.env.LOOM_PURVIEW_ACCOUNT) {
          purviewDeepLink = `https://${process.env.LOOM_PURVIEW_ACCOUNT}.purview.azure.com/main.html#/asset/${encodeURIComponent(purviewGuid)}`;
        }
      } catch (e: any) {
        // Don't fail the shortcut if Purview registration fails — surface as a
        // soft warning so the operator can retry registration separately.
        purviewError =
          e instanceof PurviewNotConfiguredError
            ? `Purview not configured: ${e.message}`
            : e?.message || String(e);
      }
    }

    return NextResponse.json({
      ok: true,
      shortcut,
      purview: body.registerInPurview ? { guid: purviewGuid, deepLink: purviewDeepLink, error: purviewError } : undefined,
    });
  } catch (e: any) {
    const status = e instanceof FabricError || e instanceof PurviewError ? e.status : 500;
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      endpoint: (e as any)?.endpoint,
      body: (e as any)?.body,
      hint: (e as any)?.hint,
    }, { status: status || 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';
  const itemId = req.nextUrl.searchParams.get('itemId') || '';
  const path = req.nextUrl.searchParams.get('path') || '';
  const name = req.nextUrl.searchParams.get('name') || '';
  if (!workspaceId || !itemId || !path || !name) {
    return NextResponse.json({ ok: false, error: 'workspaceId, itemId, path, name required' }, { status: 400 });
  }
  try {
    await deleteOneLakeShortcut(workspaceId, itemId, path, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}
