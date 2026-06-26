/**
 * Phase 2 — Data Product provisioner (Microsoft Purview Unified Catalog).
 *
 * Real REST: Microsoft Purview Unified Catalog data-plane API. The bundle's
 * DataProductContent is materialized as REAL governed assets:
 *   1. One Purview *data product* per dataset
 *        POST {endpoint}/datagovernance/catalog/dataProducts?api-version=2026-03-20-preview
 *   2. One Purview *glossary term* per glossaryTerms[] entry
 *        POST {endpoint}/datagovernance/catalog/terms?api-version=2026-03-20-preview
 *
 * Both calls target a pre-existing **governance domain** (the boundary that
 * owns data products + terms). Provisioning a governance domain itself is a
 * one-time tenant-admin action (it requires the Governance Domain Creator
 * role and a published state), so we GATE on its id via the
 * LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID env var rather than silently inventing
 * one — per .claude/rules/no-vaporware.md the gate names the exact env var /
 * role to set.
 *
 * Auth: DefaultAzureCredential / UAMI against the Purview data-plane
 *   audience  https://purview.azure.net/.default
 * The Console UAMI must hold the **Data Product Owner** role (for data
 * products) and **Data Steward** role (for glossary terms) in the target
 * governance domain. 401/403 surfaces as a remediation gate naming both.
 *
 * Grounding (Microsoft Learn):
 *   - Unified Catalog API overview:
 *       https://learn.microsoft.com/rest/api/purview/unified-catalog-api-overview
 *   - Data Products - Create:
 *       https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/data-products/create
 *   - Terms - Create:
 *       https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/terms/create
 *   - Authenticate (data-plane), audience https://purview.azure.net:
 *       https://learn.microsoft.com/purview/data-gov-api-rest-data-plane
 *   - Roles & permissions (Data Product Owner / Data Steward):
 *       https://learn.microsoft.com/purview/data-governance-roles-permissions
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

// Latest Unified Catalog data-plane API version (public preview).
const UC_API = process.env.LOOM_PURVIEW_UC_API_VERSION || '2026-03-20-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  // Purview data-plane audience (Unified Catalog uses the same resource).
  const t = await credential.getToken('https://purview.azure.net/.default');
  if (!t?.token) throw new Error('Failed to acquire AAD token for Purview (https://purview.azure.net/.default).');
  return t.token;
}

/**
 * Resolve the Unified Catalog data-plane endpoint. Accepts either the
 * documented well-known host, or a per-tenant Purview account host.
 * Trailing slashes are normalized off.
 */
function resolveEndpoint(): string | undefined {
  const explicit = process.env.LOOM_PURVIEW_UC_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  const account = process.env.LOOM_PURVIEW_ACCOUNT;
  if (account) {
    // Per-account data-plane host: https://{account}.purview.azure.com
    return `https://${account}.purview.azure.com`;
  }
  return undefined;
}

/**
 * Map a bundle dataset classification (Public / Internal / Confidential /
 * Restricted) onto a Purview data-product *type*. Classification itself is
 * carried through as a managed attribute so the steward UI shows it; the
 * REST type enum is a coarse categorization (we use Dataset for curated
 * tabular products). Grounded in the CatalogModelDataProductTypeEnum list.
 */
const DEFAULT_PRODUCT_TYPE = 'Dataset' as const;

/** Deterministic RFC-4122 v4-shaped GUID from a stable seed so re-installs
 * address the same data-product / term ids (idempotent upsert by id).
 * FNV-1a derived — not cryptographic, only needs to be stable + unique per
 * (appId,name). The catalog dedupes by id on create. */
function seededGuid(seed: string): string {
  // 128 bits from four FNV-1a passes over salted seeds.
  const fnv = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(seed).toString(16).padStart(8, '0');
  const b = fnv('b:' + seed).toString(16).padStart(8, '0');
  const c = fnv('c:' + seed).toString(16).padStart(8, '0');
  const d = fnv('d:' + seed).toString(16).padStart(8, '0');
  const hex = (a + b + c + d).slice(0, 32);
  // Force version 4 + RFC-4122 variant bits.
  const v4 = hex.slice(0, 12) + '4' + hex.slice(13, 16) +
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 32);
  return `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-${v4.slice(16, 20)}-${v4.slice(20, 32)}`;
}

function authGate(status: number, ws: string, endpoint: string): ProvisionResult {
  return {
    status: 'remediation',
    gate: {
      reason: `Purview Unified Catalog ${status}: cannot write data products / glossary terms.`,
      remediation:
        'Grant the Console UAMI the Data Product Owner role (for data products) and the Data Steward role (for glossary terms) in the target governance domain. In the Purview portal: Unified Catalog > Catalog management > Governance domains > <domain> > Roles tab > add the UAMI to both roles. See https://learn.microsoft.com/purview/data-governance-roles-permissions.',
      link: 'https://purview.microsoft.com/',
    },
    steps: [`Endpoint: ${endpoint}`, `Governance domain: ${ws}`],
  };
}

// Default governance domain Loom auto-provisions when none is bound. Name is
// stable so re-installs converge on the same domain (discovery dedupes by name).
const DEFAULT_DOMAIN_NAME = process.env.LOOM_PURVIEW_DEFAULT_DOMAIN_NAME || 'Loom Governance';
// Process-cache the resolved domain id so we discover/create once per process.
let cachedDomainId: string | undefined;

/**
 * Resolve the governance domain to provision data products / terms into —
 * WITHOUT hard-gating on LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID as the default.
 *
 * Day-one order (no-vaporware: real REST or an honest gate naming the exact
 * role — never a silent invent):
 *   1. Explicit env binding (LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID) — authoritative.
 *   2. AUTO-DISCOVER — GET businessdomains; reuse the first Published domain
 *      (or, failing that, the named default if present in any state).
 *   3. AUTO-CREATE — POST a published default domain (best-effort; requires the
 *      Console UAMI to hold the Governance Domain Creator role).
 *   4. Honest gate — only when discovery 401/403s or create is forbidden,
 *      naming Governance Domain Creator + the env var to pin an existing one.
 *
 * Returns the domain id, or a ProvisionResult gate to surface verbatim.
 */
async function ensureGovernanceDomain(
  endpoint: string,
  headers: Record<string, string>,
  steps: string[],
): Promise<{ id: string } | { gate: ProvisionResult }> {
  const pinned = process.env.LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID;
  if (pinned) { steps.push(`Governance domain (pinned): ${pinned}`); return { id: pinned }; }
  if (cachedDomainId) { steps.push(`Governance domain (cached): ${cachedDomainId}`); return { id: cachedDomainId }; }

  const base = `${endpoint}/datagovernance/catalog/businessdomains?api-version=${UC_API}`;
  const domainGate = (status: number): { gate: ProvisionResult } => ({
    gate: {
      status: 'remediation',
      gate: {
        reason: `No Purview governance domain bound, and Loom could not ${status === 403 || status === 401 ? 'access' : 'auto-provision'} one (Unified Catalog ${status}).`,
        remediation:
          'Grant the Console UAMI the Governance Domain Creator role (Unified Catalog > Catalog management > Roles) so Loom can auto-create a default governance domain, OR create a published domain yourself and pin it via LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID. See https://learn.microsoft.com/purview/data-governance-roles-permissions#catalog-level-permissions.',
        link: 'https://learn.microsoft.com/purview/unified-catalog-governance-domains-create-manage',
      },
      steps,
    },
  });

  // ── 2. Auto-discover an existing domain ──────────────────────────────────
  try {
    const res = await fetchWithTimeout(base, { method: 'GET', headers, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) { steps.push(`Domain discovery: ${res.status} (no catalog read access).`); return domainGate(res.status); }
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const domains: any[] = Array.isArray(body?.value) ? body.value : (Array.isArray(body) ? body : []);
      const isPub = (s: any) => String(s ?? '').toLowerCase() === 'published';
      const pick =
        domains.find((d) => d?.name === DEFAULT_DOMAIN_NAME && isPub(d?.status)) ||
        domains.find((d) => isPub(d?.status)) ||
        domains.find((d) => d?.name === DEFAULT_DOMAIN_NAME);
      if (pick?.id) {
        cachedDomainId = pick.id;
        steps.push(`Governance domain (auto-discovered): ${pick.name} [${pick.id}]${isPub(pick.status) ? '' : ' (publishing…)'}`);
        if (!isPub(pick.status)) await publishDomain(endpoint, headers, pick.id).catch(() => undefined);
        return { id: pick.id };
      }
      steps.push(`Domain discovery: ${domains.length} domain(s), none usable — auto-creating '${DEFAULT_DOMAIN_NAME}'.`);
    }
  } catch (e: any) {
    steps.push(`Domain discovery failed: ${e?.message || e}. Attempting create.`);
  }

  // ── 3. Auto-create a published default domain (best-effort) ──────────────
  try {
    const createRes = await fetchWithTimeout(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: DEFAULT_DOMAIN_NAME,
        description: 'Default governance domain auto-provisioned by CSA Loom for data-product and glossary governance.',
        type: 'FunctionalUnit',
        status: 'Published',
      }),
      cache: 'no-store',
    });
    if (createRes.status === 401 || createRes.status === 403) { steps.push(`Domain create: ${createRes.status} (needs Governance Domain Creator).`); return domainGate(createRes.status); }
    if (createRes.status === 200 || createRes.status === 201) {
      const created = await createRes.json().catch(() => ({}));
      if (created?.id) {
        cachedDomainId = created.id;
        steps.push(`Governance domain (auto-created): ${DEFAULT_DOMAIN_NAME} [${created.id}]`);
        if (String(created?.status ?? '').toLowerCase() !== 'published') await publishDomain(endpoint, headers, created.id).catch(() => undefined);
        return { id: created.id };
      }
    }
    // A 409 (already exists) means a concurrent install created it — re-discover once.
    if (createRes.status === 409) {
      const again = await fetchWithTimeout(base, { method: 'GET', headers, cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null);
      const list: any[] = Array.isArray(again?.value) ? again.value : [];
      const found = list.find((d) => d?.name === DEFAULT_DOMAIN_NAME);
      if (found?.id) { cachedDomainId = found.id; steps.push(`Governance domain (existing): ${found.id}`); return { id: found.id }; }
    }
    steps.push(`Domain create: ${createRes.status} — ${(await createRes.text().catch(() => '')).slice(0, 200)}`);
    return domainGate(createRes.status);
  } catch (e: any) {
    steps.push(`Domain create failed: ${e?.message || e}`);
    return domainGate(0);
  }
}

/** Publish a governance domain so its business concepts can be published.
 *  Best-effort: tries the `publish` action, then a status PATCH. */
async function publishDomain(endpoint: string, headers: Record<string, string>, id: string): Promise<void> {
  const root = `${endpoint}/datagovernance/catalog/businessdomains/${encodeURIComponent(id)}`;
  const act = await fetchWithTimeout(`${root}:publish?api-version=${UC_API}`, { method: 'POST', headers, body: '{}', cache: 'no-store' }).catch(() => null);
  if (act && (act.status === 200 || act.status === 202 || act.status === 204)) return;
  // Fallback: PATCH status=Published.
  await fetchWithTimeout(`${root}?api-version=${UC_API}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'Published' }), cache: 'no-store' }).catch(() => undefined);
}

export const dataProductProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = input.content as any;
  const datasets: any[] = Array.isArray(content?.datasets) ? content.datasets : [];
  const glossaryTerms: any[] = Array.isArray(content?.glossaryTerms) ? content.glossaryTerms : [];

  if (datasets.length === 0 && glossaryTerms.length === 0) {
    return { status: 'skipped', steps: ['No datasets or glossary terms in bundle; nothing to provision.'] };
  }

  const endpoint = resolveEndpoint();
  if (!endpoint) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Purview Unified Catalog endpoint not configured.',
        remediation:
          'Set LOOM_PURVIEW_UC_ENDPOINT to the Unified Catalog data-plane endpoint (e.g. https://api.purview-service.microsoft.com), OR set LOOM_PURVIEW_ACCOUNT to your Purview account name (resolves to https://<account>.purview.azure.com).',
        link: 'https://learn.microsoft.com/rest/api/purview/unified-catalog-api-overview',
      },
      steps,
    };
  }

  steps.push(`Unified Catalog endpoint: ${endpoint}`);

  let tok: string;
  try {
    tok = await token();
  } catch (e: any) {
    return resolveInfraResidual(e, 'Could not acquire an Entra token for the Purview Unified Catalog data plane. Confirm the Console managed identity (LOOM_UAMI_CLIENT_ID) is configured and has Catalog access on the Purview account.', { link: 'https://learn.microsoft.com/purview/unified-catalog-governance-domains-create-manage', steps });
  }
  const headers = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' } as const;

  // Resolve the governance domain WITHOUT hard-gating: pinned id → auto-discover
  // an existing published domain → auto-create a default one. Only surfaces a
  // remediation gate when the catalog can't be read / the domain can't be
  // created (naming the Governance Domain Creator role). (no-vaporware day-one.)
  const domainResolution = await ensureGovernanceDomain(endpoint, headers, steps);
  if ('gate' in domainResolution) return domainResolution.gate;
  const governanceDomainId = domainResolution.id;

  const owner = content?.owner || {};
  // Purview contacts[].id must be an AAD oid (uuid). Only attach an owner
  // contact when an explicit oid is supplied; a display name/email cannot be
  // sent as an id (it would 400). The owner name is still carried in the
  // description so the steward UI shows accountability either way.
  const ownerOid: string | undefined =
    typeof owner.oid === 'string' && /^[0-9a-f-]{36}$/i.test(owner.oid) ? owner.oid : undefined;
  const contacts = ownerOid
    ? { owner: [{ id: ownerOid, description: owner.name || 'Data product owner' }] }
    : undefined;

  const createdProductIds: string[] = [];
  const createdTermIds: string[] = [];
  let firstAuthGate: ProvisionResult | undefined;

  // ─── 1. Data products (one per dataset) ───────────────────────────────
  for (const ds of datasets) {
    const id = seededGuid(`${input.appId}:dp:${ds.id || ds.name}`);
    const ownerDesc = owner.name ? ` Owner: ${owner.name}${owner.email ? ` <${owner.email}>` : ''}.` : '';
    const body: Record<string, unknown> = {
      id,
      name: ds.name,
      domain: governanceDomainId,
      type: DEFAULT_PRODUCT_TYPE,
      status: 'DRAFT',
      description: `${ds.description || ''}${ownerDesc}`.trim(),
      businessUse: ds.description || `Curated dataset '${ds.name}' governed by ${input.appId}.`,
      endorsed: content?.endorsement === 'certified' || content?.endorsement === 'promoted',
      // Classification is a steward-facing managed attribute on the product.
      managedAttributes: ds.classification
        ? [{ name: 'Classification', value: String(ds.classification) }]
        : undefined,
      ...(contacts ? { contacts } : {}),
    };

    const res = await fetchWithTimeout(`${endpoint}/datagovernance/catalog/dataProducts?api-version=${UC_API}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      firstAuthGate = firstAuthGate || authGate(res.status, governanceDomainId, endpoint);
      steps.push(`Data product '${ds.name}': ${res.status} (auth gate).`);
      break;
    }
    if (res.status === 201 || res.status === 200) {
      createdProductIds.push(id);
      steps.push(`Created data product '${ds.name}' (${id}).`);
    } else if (res.status === 409) {
      createdProductIds.push(id);
      steps.push(`Data product '${ds.name}' already exists (${id}); left as-is.`);
    } else {
      steps.push(`Data product '${ds.name}' failed ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  // ─── 2. Glossary terms (one per glossaryTerms[]) ──────────────────────
  if (!firstAuthGate) {
    for (const t of glossaryTerms) {
      const id = seededGuid(`${input.appId}:term:${t.term}`);
      const body: Record<string, unknown> = {
        id,
        name: t.term,
        domain: governanceDomainId,
        status: 'DRAFT',
        description: t.definition || '',
        isLeaf: true,
        ...(contacts ? { contacts } : {}),
      };

      const res = await fetchWithTimeout(`${endpoint}/datagovernance/catalog/terms?api-version=${UC_API}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const text = await res.text();

      if (res.status === 401 || res.status === 403) {
        firstAuthGate = firstAuthGate || authGate(res.status, governanceDomainId, endpoint);
        steps.push(`Glossary term '${t.term}': ${res.status} (auth gate).`);
        break;
      }
      if (res.status === 201 || res.status === 200) {
        createdTermIds.push(id);
        steps.push(`Created glossary term '${t.term}' (${id}).`);
      } else if (res.status === 409) {
        createdTermIds.push(id);
        steps.push(`Glossary term '${t.term}' already exists (${id}); left as-is.`);
      } else {
        steps.push(`Glossary term '${t.term}' failed ${res.status}: ${text.slice(0, 200)}`);
      }
    }
  }

  // If the very first write hit auth and nothing landed, surface the gate so
  // the wizard shows the exact role to grant and the user can Retry.
  if (firstAuthGate && createdProductIds.length === 0 && createdTermIds.length === 0) {
    return { ...firstAuthGate, steps: [...(firstAuthGate.steps || []), ...steps] };
  }

  const total = createdProductIds.length + createdTermIds.length;
  if (total === 0) {
    return { status: 'failed', error: 'No data products or glossary terms were created (see steps).', steps };
  }

  steps.push(`Provisioned ${createdProductIds.length} data product(s) + ${createdTermIds.length} glossary term(s).`);
  return {
    status: 'created',
    resourceId: createdProductIds[0] || createdTermIds[0],
    secondaryIds: {
      governanceDomainId,
      dataProductIds: createdProductIds.join(','),
      glossaryTermIds: createdTermIds.join(','),
      endpoint,
    },
    steps,
  };
};
