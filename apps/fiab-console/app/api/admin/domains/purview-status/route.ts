/**
 * GET /api/admin/domains/purview-status
 *
 * The Purview business-domain mirror state, split out of the main
 * /api/admin/domains GET so a slow / 403-ing Purview Data Map probe can NEVER
 * delay the domains list. The list lives in Cosmos and is fast; this probe hits
 * the Purview Data Map data-plane which, behind a private endpoint, can answer
 * 403 slowly and push a combined GET past the client's fetch timeout (the
 * "Could not load domains — timed out" regression). The page fetches this
 * endpoint LAZILY after the list renders and shows the honest Purview-mirror
 * MessageBar when/if it returns gated — never blocking the list.
 *
 * Returns either the list of Purview business-domain names (so the UI can mark
 * which Cosmos domains are also governed in Purview) or an honest gate
 * describing the one-time provisioning / role-grant step. Never throws —
 * Purview is optional.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  listBusinessDomains,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type PurviewMirrorStatus =
  | { configured: true; domains: Array<{ id?: string; name: string }> }
  | { configured: false; gated: boolean; hint: string };

/**
 * Resolve the Purview business-domain mirror state. Returns either the list
 * of Purview business-domain names (so the UI can show which Cosmos domains
 * are also governed in Purview) or an honest gate describing the one-time
 * provisioning step. Never throws — Purview is optional.
 */
export async function purviewStatus(): Promise<PurviewMirrorStatus> {
  try {
    const domains = await listBusinessDomains();
    return {
      configured: true,
      domains: (domains || []).map((d: any) => ({ id: d.id, name: d.name || d.displayName })),
    };
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return {
        configured: false,
        gated: false,
        hint:
          "Purview mirror inactive — domains live in Loom's Cosmos store and fully work. To also mirror them in Purview, set LOOM_PURVIEW_ACCOUNT (admin-plane/main.bicep apps[] env) and deploy with purviewEnabled=true. NOTE: classic Purview Data Map has no \"business domains\"; Loom maps domains to Atlas collections/assets instead.",
      };
    }
    // 401/403 from the Data Map data-plane = the account is reachable but the
    // Console UAMI lacks a Data Map data-plane role on the root collection
    // (classic metadata-policy, NOT ARM RBAC) — the "Not authorized to access
    // account" 403. Surface it as an HONEST GATE naming the exact role to grant
    // so the page never shows a raw error; domains still render from Loom.
    if (e instanceof PurviewError && (e.status === 401 || e.status === 403)) {
      return {
        configured: false,
        gated: true,
        hint:
          'Purview is provisioned, but the Loom Console managed identity lacks a Microsoft Purview Data Map ' +
          'data-plane role on the root collection (it answered ' + e.status + ', "Not authorized to access account"). ' +
          'Grant the Console UAMI Data Curator (read/write) — or at minimum Data Reader (read-only) — on the ROOT ' +
          'collection via scripts/csa-loom/grant-purview-datamap-role.sh (run by the csa-loom-post-deploy-bootstrap ' +
          'workflow), then refresh. Classic Data Map roles are collection metadata-policy, NOT ARM RBAC, so they ' +
          'cannot be set in bicep. Domains continue to work from Loom’s Cosmos store in the meantime.',
      };
    }
    // Any other Purview error (transient, DNS, token) is still non-fatal here.
    return {
      configured: false,
      gated: false,
      hint: `Purview mirror unavailable: ${e?.message || String(e)}. Domains are stored in Loom and work offline.`,
    };
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const purview = await purviewStatus();
  return NextResponse.json({ ok: true, purview });
}
