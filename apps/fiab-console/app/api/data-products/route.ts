/**
 * /api/data-products — Loom data-product creation surface (Microsoft Purview
 * Unified Catalog "Data product" parity, F1 + F18 domain picker).
 *
 * POST /api/data-products
 *   body: {
 *     workspaceId?, displayName, description?, type, audience[],
 *     governanceDomainId?, governanceDomainName?, useCase?, endorsed?,
 *     owners?: [{ id, upn, displayName }], customAttributes?: {...}
 *   }
 *   → creates a REAL Cosmos draft (itemType 'data-product', state.status DRAFT)
 *     via createOwnedItem, then BEST-EFFORT registers it in Purview Unified
 *     Catalog when a UC endpoint + a GUID governance domain are available. The
 *     Cosmos write always lands; Purview registration is additive and never
 *     blocks (honest hint when it can't run — per no-vaporware.md / no-fabric).
 *
 * GET /api/data-products → list the tenant's data-product drafts.
 *
 * Azure-native default: with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET and Purview
 * unconfigured, the draft is still created in Loom's own Cosmos store and is
 * fully functional. Purview UC is strictly opt-in (LOOM_PURVIEW_UC_ENDPOINT /
 * LOOM_PURVIEW_ACCOUNT) — its absence is not a gate.
 *
 * Grounding (Microsoft Learn):
 *   - Create data product (single):
 *       https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage
 *   - Data Products - Create (REST, 2026-03-20-preview):
 *       https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/data-products/create
 *   - Authenticate (data-plane), audience https://purview.azure.net:
 *       https://learn.microsoft.com/purview/data-gov-api-rest-data-plane
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createOwnedItem,
  listOwnedItems,
  listOwnedWorkspaces,
} from '@/app/api/items/_lib/item-crud';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import {
  DATA_PRODUCT_DESCRIPTION_MAX,
  DATA_PRODUCT_AUDIENCE_VALUES,
  isValidDataProductType,
} from '@/lib/catalog/data-product-enums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UC_API = process.env.LOOM_PURVIEW_UC_API_VERSION || '2026-03-20-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/** Resolve the Purview Unified Catalog data-plane endpoint (opt-in). */
function resolveUcEndpoint(): string | undefined {
  const explicit = process.env.LOOM_PURVIEW_UC_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  const account = process.env.LOOM_PURVIEW_ACCOUNT;
  if (account) return `https://${account}.purview.azure.com`;
  return undefined;
}

interface OwnerInput { id?: string; upn?: string; displayName?: string }

/**
 * Best-effort Purview Unified Catalog registration. Never throws — returns a
 * structured `{ registered, dataProductId?, hint? }` the caller persists +
 * surfaces. Skips honestly (with a precise hint) when the UC endpoint is
 * unconfigured or the chosen domain isn't a UC GUID, so the Cosmos draft is
 * never blocked by Purview being absent.
 */
async function tryRegisterPurview(opts: {
  displayName: string;
  description: string;
  type: string;
  audience: string[];
  governanceDomainId?: string;
  useCase?: string;
  endorsed: boolean;
  owners: OwnerInput[];
}): Promise<{ registered: boolean; dataProductId?: string; hint?: string }> {
  const endpoint = resolveUcEndpoint();
  if (!endpoint) {
    return {
      registered: false,
      hint:
        'Draft saved in Loom only. To also publish it to Microsoft Purview Unified Catalog, set LOOM_PURVIEW_UC_ENDPOINT (or LOOM_PURVIEW_ACCOUNT) on the Console app and grant the UAMI the Data Product Owner role in the target governance domain.',
    };
  }
  if (!opts.governanceDomainId || !GUID_RE.test(opts.governanceDomainId)) {
    return {
      registered: false,
      hint:
        'Draft saved in Loom. Purview registration skipped: the selected governance domain is a Loom-local domain, not a Purview Unified Catalog domain (which requires a GUID id). Pick a UC governance domain to also register in Purview.',
    };
  }
  let tok: string | undefined;
  try {
    const t = await credential.getToken('https://purview.azure.net/.default');
    tok = t?.token;
  } catch {
    /* fall through to honest hint */
  }
  if (!tok) {
    return {
      registered: false,
      hint:
        'Draft saved in Loom. Purview registration skipped: the Console UAMI could not acquire a Purview data-plane token (audience https://purview.azure.net/.default).',
    };
  }

  const ownerContacts = opts.owners
    .filter((o) => o.id && GUID_RE.test(o.id))
    .map((o) => ({ id: o.id as string, description: o.upn || o.displayName || 'Data product owner' }));

  const id = crypto.randomUUID();
  const body: Record<string, unknown> = {
    id,
    name: opts.displayName,
    description: opts.description,
    domain: opts.governanceDomainId,
    type: opts.type,
    status: 'DRAFT',
    businessUse: opts.useCase || '',
    endorsed: opts.endorsed,
    audience: opts.audience,
    ...(ownerContacts.length ? { contacts: { owner: ownerContacts } } : {}),
  };

  try {
    const res = await fetch(`${endpoint}/datagovernance/catalog/dataProducts?api-version=${UC_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (res.status === 200 || res.status === 201 || res.status === 409) {
      return { registered: true, dataProductId: id };
    }
    const text = await res.text();
    return {
      registered: false,
      hint: `Draft saved in Loom. Purview registration returned ${res.status}: ${text.slice(0, 240)}`,
    };
  } catch (e: any) {
    return { registered: false, hint: `Draft saved in Loom. Purview registration error: ${e?.message || String(e)}` };
  }
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const items = await listOwnedItems('data-product', session.claims.oid);
    return NextResponse.json({
      ok: true,
      dataProducts: items.map((it) => ({
        id: it.id,
        displayName: it.displayName,
        description: it.description,
        type: (it.state as any)?.type,
        status: (it.state as any)?.status || 'DRAFT',
        governanceDomainName: (it.state as any)?.governanceDomainName,
        endorsed: !!(it.state as any)?.endorsed,
        purviewRegistered: !!(it.state as any)?.purviewRegistered,
        updatedAt: it.updatedAt,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }

  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
  const description = typeof body?.description === 'string' ? body.description : '';
  const type = typeof body?.type === 'string' ? body.type : '';
  const useCase = typeof body?.useCase === 'string' ? body.useCase : '';
  const endorsed = !!body?.endorsed;
  const governanceDomainId = typeof body?.governanceDomainId === 'string' ? body.governanceDomainId : undefined;
  const governanceDomainName = typeof body?.governanceDomainName === 'string' ? body.governanceDomainName : undefined;
  const audience: string[] = Array.isArray(body?.audience)
    ? body.audience.filter((a: unknown): a is string => typeof a === 'string')
    : [];
  const owners: OwnerInput[] = Array.isArray(body?.owners)
    ? body.owners
        .filter((o: any) => o && typeof o === 'object')
        .map((o: any) => ({ id: o.id, upn: o.upn, displayName: o.displayName }))
    : [];
  const customAttributes: Record<string, unknown> =
    body?.customAttributes && typeof body.customAttributes === 'object' ? body.customAttributes : {};

  // ── Validation (mirrors Purview's real constraints) ──────────────────────
  if (!displayName) return NextResponse.json({ ok: false, error: 'Name is required.' }, { status: 400 });
  if (description.length > DATA_PRODUCT_DESCRIPTION_MAX) {
    return NextResponse.json(
      { ok: false, error: `Description exceeds the ${DATA_PRODUCT_DESCRIPTION_MAX.toLocaleString()}-character limit (got ${description.length.toLocaleString()}).` },
      { status: 400 },
    );
  }
  if (!type || !isValidDataProductType(type)) {
    return NextResponse.json({ ok: false, error: 'A valid data-product Type is required.' }, { status: 400 });
  }
  const badAudience = audience.find((a) => !DATA_PRODUCT_AUDIENCE_VALUES.includes(a));
  if (badAudience) {
    return NextResponse.json({ ok: false, error: `Unknown audience value '${badAudience}'.` }, { status: 400 });
  }

  // Resolve the target Loom workspace (the Cosmos partition the draft lives in).
  let workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId) {
    const wss = await listOwnedWorkspaces(session.claims.oid);
    if (wss.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No Loom workspace exists yet. Create a workspace first, then create the data product in it.' },
        { status: 400 },
      );
    }
    workspaceId = wss[0].id;
  }

  // Best-effort Purview registration BEFORE the Cosmos write so the receipt can
  // carry the registration outcome (the Cosmos write itself never fails on it).
  const purview = await tryRegisterPurview({
    displayName, description, type, audience, governanceDomainId, useCase, endorsed, owners,
  });

  const state: Record<string, unknown> = {
    status: 'DRAFT',
    type,
    audience,
    governanceDomainId: governanceDomainId || null,
    governanceDomainName: governanceDomainName || null,
    useCase: useCase || '',
    endorsed,
    owners,
    customAttributes,
    purviewRegistered: purview.registered,
    ...(purview.dataProductId ? { purviewDataProductId: purview.dataProductId } : {}),
    ...(purview.hint ? { purviewHint: purview.hint } : {}),
  };

  const created = await createOwnedItem(session, 'data-product', {
    workspaceId,
    displayName,
    description: description || undefined,
    state,
  });
  if (!created.ok) {
    return NextResponse.json({ ok: false, error: created.error }, { status: created.status });
  }

  return NextResponse.json(
    {
      ok: true,
      item: created.item,
      id: created.item.id,
      purviewRegistered: purview.registered,
      purviewDataProductId: purview.dataProductId,
      purviewHint: purview.hint,
    },
    { status: 201 },
  );
}
