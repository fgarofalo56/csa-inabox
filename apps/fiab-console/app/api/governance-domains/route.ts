/**
 * GET /api/governance-domains — governance domain picker source for the
 * data-product creation wizard (F18 domain picker).
 *
 * Resolution order (Azure-native default, Purview opt-in):
 *   1. Microsoft Purview Unified Catalog business domains (when a UC endpoint is
 *      configured): GET {endpoint}/datagovernance/catalog/businessdomains
 *      filtered to PUBLISHED. These carry the GUID ids the data-product `domain`
 *      foreign key requires, so picking one lets POST /api/data-products also
 *      register in Purview.
 *   2. Loom-local domains from Cosmos (tenant-settings doc `domains:<tenantId>`,
 *      the same store /api/admin/domains writes). Always works with NO Purview,
 *      NO Fabric — the wizard is fully functional on this path; the draft is
 *      saved in Loom (Purview registration is skipped with an honest hint).
 *
 * `source` tells the UI which path produced the list so it can show, when on
 * the Cosmos path with Purview configured-but-classic, that those ids won't act
 * as Purview UC foreign keys.
 *
 * Grounding (Microsoft Learn):
 *   - Governance domains: https://learn.microsoft.com/purview/unified-catalog-governance-domains
 *   - Business Domain (REST): https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/business-domain
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UC_API = process.env.LOOM_PURVIEW_UC_API_VERSION || '2026-03-20-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

interface DomainOption { id: string; name: string; description?: string }

function resolveUcEndpoint(): string | undefined {
  const explicit = process.env.LOOM_PURVIEW_UC_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  const account = process.env.LOOM_PURVIEW_ACCOUNT;
  if (account) return `https://${account}.purview.azure.com`;
  return undefined;
}

/** Read the Loom-local domain list (the Cosmos fallback). Never throws. */
async function cosmosDomains(tenantId: string): Promise<DomainOption[]> {
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(`domains:${tenantId}`, tenantId).read<{ items?: any[] }>();
    const items = Array.isArray(resource?.items) ? resource!.items : [];
    return items.map((d: any) => ({ id: String(d.id), name: String(d.name || d.id), description: d.description }));
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

/** Try the Purview Unified Catalog business-domain list. Returns null when the
 *  UC endpoint isn't configured or the call can't be made (caller falls back to
 *  Cosmos). Only throws nothing — failures resolve to null. */
async function purviewUcDomains(): Promise<DomainOption[] | null> {
  const endpoint = resolveUcEndpoint();
  if (!endpoint) return null;
  let tok: string | undefined;
  try {
    const t = await credential.getToken('https://purview.azure.net/.default');
    tok = t?.token;
  } catch {
    return null;
  }
  if (!tok) return null;
  try {
    const res = await fetch(`${endpoint}/datagovernance/catalog/businessdomains?api-version=${UC_API}`, {
      headers: { authorization: `Bearer ${tok}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = await res.json();
    const value: any[] = Array.isArray(json?.value) ? json.value : [];
    return value
      .filter((d) => !d.status || String(d.status).toUpperCase() === 'PUBLISHED')
      .map((d) => ({ id: String(d.id), name: String(d.name || d.id), description: d.description }));
  } catch {
    return null;
  }
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;
  try {
    const uc = await purviewUcDomains();
    if (uc && uc.length > 0) {
      return NextResponse.json({ ok: true, domains: uc, source: 'purview-uc' });
    }
    const local = await cosmosDomains(tenantId);
    const ucConfigured = !!resolveUcEndpoint();
    return NextResponse.json({
      ok: true,
      domains: local,
      source: 'cosmos',
      ...(ucConfigured
        ? { purviewHint: 'Purview Unified Catalog is configured but returned no published business domains; showing Loom-local domains. Selecting one saves the draft in Loom (Purview registration is skipped until a UC domain exists).' }
        : { purviewHint: 'Showing Loom-local governance domains. To register data products in Microsoft Purview Unified Catalog, set LOOM_PURVIEW_UC_ENDPOINT (or LOOM_PURVIEW_ACCOUNT) and create a published governance domain there.' }),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
