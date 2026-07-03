/**
 * GET /api/admin/domains/images
 *
 * Lists custom domain images from the operator-configured storage container so
 * the domain Image tab can show a real Blob gallery (Fabric's domain image
 * gallery equivalent). This is an HONEST infra-gate, not a Fabric dependency:
 *
 *   - When LOOM_DOMAIN_IMAGE_STORAGE is set (format
 *     `https://<account>.dfs.core.windows.net/<container>[/<prefix>]`), we list
 *     image blobs (png/jpg/jpeg/gif/webp/svg) via the ADLS Gen2 data plane
 *     using the Console UAMI (Storage Blob Data Reader) and return their names
 *     + https URLs.
 *   - When unset, we return `{ ok: true, configured: false, hint }` so the UI
 *     shows a MessageBar naming the exact env var + role to grant. The preset
 *     color swatches and icon tiles in the gallery work regardless.
 *
 * No Fabric / OneLake call on any path.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { getServiceClientFor, pathToHttpsUrlFor } from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Parse the configured container URL into { account, container, prefix }. */
function parseStorage(raw: string): { account: string; container: string; prefix: string } | null {
  try {
    const u = new URL(raw);
    const account = u.hostname.split('.')[0];
    const parts = u.pathname.split('/').filter(Boolean);
    if (!account || parts.length === 0) return null;
    const container = parts[0];
    const prefix = parts.slice(1).join('/');
    return { account, container, prefix };
  } catch {
    return null;
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const configured = process.env.LOOM_DOMAIN_IMAGE_STORAGE;
  if (!configured) {
    return NextResponse.json({
      ok: true,
      configured: false,
      hint: 'Custom domain images are not wired in this deployment. Set LOOM_DOMAIN_IMAGE_STORAGE to a storage container URL (https://<account>.dfs.core.windows.net/<container>) on the loom-console Container App (admin-plane/main.bicep apps[].env), and grant the Console UAMI the Storage Blob Data Reader role on that container. Preset color swatches and icon tiles remain available without this.',
      images: [],
    });
  }

  const parsed = parseStorage(configured);
  if (!parsed) {
    return NextResponse.json({
      ok: false,
      configured: true,
      error: `LOOM_DOMAIN_IMAGE_STORAGE is not a valid container URL: "${configured}". Expected https://<account>.dfs.core.windows.net/<container>.`,
    }, { status: 500 });
  }

  try {
    const { account, container, prefix } = parsed;
    const fs = getServiceClientFor(account).getFileSystemClient(container);
    const iter = fs.listPaths({ path: prefix || undefined, recursive: true });
    const images: Array<{ name: string; url: string; size: number; lastModified?: string }> = [];
    for await (const p of iter) {
      const name = p.name ?? '';
      if (p.isDirectory || !IMAGE_RE.test(name)) continue;
      images.push({
        name,
        url: pathToHttpsUrlFor(account, container, name),
        size: typeof p.contentLength === 'number' ? p.contentLength : Number(p.contentLength ?? 0),
        lastModified: p.lastModified ? new Date(p.lastModified).toISOString() : undefined,
      });
      if (images.length >= 200) break;
    }
    return NextResponse.json({ ok: true, configured: true, account, container, images });
  } catch (e: any) {
    // Likely a missing Storage Blob Data Reader grant — surface it honestly.
    return NextResponse.json({
      ok: false,
      configured: true,
      error: `Could not list domain images from ${configured}: ${e?.message || String(e)}. Confirm the Console UAMI has Storage Blob Data Reader on this container.`,
    }, { status: e?.statusCode === 403 || e?.statusCode === 401 ? 403 : 502 });
  }
}
