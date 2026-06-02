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
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import type { Provisioner, ProvisionResult } from './types';

// Latest Unified Catalog data-plane API version (public preview).
const UC_API = process.env.LOOM_PURVIEW_UC_API_VERSION || '2026-03-20-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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

  const governanceDomainId = process.env.LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID;
  if (!governanceDomainId) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No Purview governance domain bound for data-product / glossary provisioning.',
        remediation:
          'Create a published governance domain in Purview Unified Catalog (Catalog management > Governance domains > New) and set LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID to its id. Creating a governance domain requires the Governance Domain Creator role. See https://learn.microsoft.com/purview/unified-catalog-governance-domains-create-manage.',
        link: 'https://learn.microsoft.com/purview/unified-catalog-governance-domains-create-manage',
      },
      steps,
    };
  }

  steps.push(`Unified Catalog endpoint: ${endpoint}`);
  steps.push(`Governance domain: ${governanceDomainId}`);

  let tok: string;
  try {
    tok = await token();
  } catch (e: any) {
    return { status: 'failed', error: e?.message || String(e), steps };
  }
  const headers = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' } as const;

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

    const res = await fetch(`${endpoint}/datagovernance/catalog/dataProducts?api-version=${UC_API}`, {
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

      const res = await fetch(`${endpoint}/datagovernance/catalog/terms?api-version=${UC_API}`, {
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
