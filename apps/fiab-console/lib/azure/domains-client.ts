/**
 * domains-client — pluggable DomainStore adapters for Governance Domains (F4).
 *
 * DEFAULT (LOOM_DOMAINS_BACKEND=cosmos or unset):
 *   cosmosDomainStore — Cosmos `governance-domains` CRUD + best-effort
 *   Purview classic collection mirror (PUT /collections/{colName}). NO Fabric
 *   dependency: every operation completes against Cosmos even when no Purview
 *   account and no Fabric workspace are configured.
 *
 * OPT-IN (LOOM_DOMAINS_BACKEND=fabric):
 *   fabricAdminDomainStore — Fabric Admin REST v1:
 *     GET    /v1/admin/domains?preview=false          → list
 *     POST   /v1/admin/domains?preview=false          → create
 *     PATCH  /v1/admin/domains/{id}?preview=false     → update
 *     DELETE /v1/admin/domains/{id}?preview=false     → delete
 *     POST   /v1/admin/domains/{id}/assignWorkspaces?preview=false
 *            body: { workspacesIds: string[] }        → assign
 *   Blocked at IL5 (Fabric Admin API is not FedRAMP IL5 approved).
 *
 * Per-cloud:
 *   Commercial   — cosmosDomainStore (default) or fabricAdminDomainStore (opt-in)
 *   GCC          — same as Commercial; Fabric uses the Commercial endpoint
 *   GCC-High     — cosmosDomainStore (default); Fabric=fabric uses the GCCH
 *                  endpoint via LOOM_FABRIC_BASE=https://api.fabric.microsoft.us/v1
 *   IL5          — cosmosDomainStore ONLY; getDomainsStore() throws
 *                  DomainsBackendGateError if backend=fabric
 */

import { governanceDomainsContainer } from './cosmos-client';
import {
  createBusinessDomain,
  updateBusinessDomain,
  deleteBusinessDomain,
  domainCollectionName,
  isPurviewConfigured,
} from './purview-client';
import { validateDomainMove } from './domain-hierarchy';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface LoomDomain {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  color?: string;
  imageUrl?: string;
  /** Image picker selection: "color::#0078d4" | "icon::finance" | "blob::<name>". */
  imageKey?: string;
  owners?: string[];
  contributors?: string[];
  /** Domain admins (UPNs / group names) — can change domain settings. */
  admins?: string[];
  /** Users/groups for default-domain auto-assign (Fabric parity). */
  defaultDomainUsers?: string[];
  /** Tenant-setting overrides delegated to the domain level. */
  delegatedSettings?: {
    defaultSensitivityLabelId?: string;
    defaultSensitivityLabelName?: string;
    defaultSensitivityLabelSource?: 'mip' | 'loom';
    certificationEnabled?: boolean;
    certificationUrl?: string;
    certifiers?: string[];
  };
  /**
   * Parent domain id when this is a subdomain. NOTE the field-name split: the
   * governance store (this client) uses `parentDomainId`; the admin route's
   * DomainItem uses `parentId`. Both mean the same thing in different stores.
   */
  parentDomainId?: string;
  purviewCollectionId?: string;
  fabricDomainId?: string;
  /**
   * Unity Catalog mirror coordinates (Azure-native governance back-end). A root
   * domain maps to a UC CATALOG, a subdomain to a UC SCHEMA under the parent's
   * catalog. Populated best-effort by the unified-domain mapper; absent when
   * Databricks is unconfigured (no hard dependency).
   */
  unityCatalogName?: string;
  unityWorkspaceHost?: string;
  unitySchemas?: string[];
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface AssignWorkspacesResult {
  ok: boolean;
  assigned?: string[];
  error?: string;
}

export interface DomainStore {
  listDomains(tenantId: string): Promise<LoomDomain[]>;
  createDomain(
    tenantId: string,
    input: Omit<LoomDomain, 'tenantId' | 'createdAt' | 'createdBy'>,
    who: string,
  ): Promise<LoomDomain>;
  updateDomain(
    tenantId: string,
    id: string,
    patch: Partial<
      Pick<
        LoomDomain,
        | 'name' | 'description' | 'color' | 'imageUrl' | 'imageKey' | 'owners'
        | 'contributors' | 'admins' | 'defaultDomainUsers' | 'delegatedSettings'
      >
    >,
    who: string,
  ): Promise<LoomDomain>;
  deleteDomain(tenantId: string, id: string): Promise<void>;
  /**
   * Reparent a domain (move it under `newParentId`, or to root when undefined).
   * Cosmos is authoritative; the Purview collection mirror is reparented
   * best-effort. Unity Catalog has NO move operation (a catalog is top-level; a
   * schema can't change catalogs), so a UC mirror keeps its mapping — the
   * unified mapper surfaces that honestly. The Fabric Admin adapter throws
   * (Fabric Admin REST has no move-domain endpoint).
   */
  moveDomain(
    tenantId: string,
    id: string,
    newParentId: string | undefined,
    who: string,
  ): Promise<LoomDomain>;
  assignWorkspaces(
    tenantId: string,
    domainId: string,
    workspaceIds: string[],
  ): Promise<AssignWorkspacesResult>;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class DomainsBackendGateError extends Error {
  constructor(public readonly backend: string, public readonly reason: string) {
    super(`Domains backend '${backend}' is not available: ${reason}`);
    this.name = 'DomainsBackendGateError';
  }
}

// ---------------------------------------------------------------------------
// Cosmos adapter (DEFAULT)
// ---------------------------------------------------------------------------

export const cosmosDomainStore: DomainStore = {
  async listDomains(tenantId) {
    const c = await governanceDomainsContainer();
    const { resources } = await c.items
      .query<LoomDomain>({
        query: 'SELECT * FROM c WHERE c.tenantId = @tid ORDER BY c.createdAt ASC',
        parameters: [{ name: '@tid', value: tenantId }],
      })
      .fetchAll();
    return resources;
  },

  async createDomain(tenantId, input, who) {
    const c = await governanceDomainsContainer();
    const now = new Date().toISOString();
    const doc: LoomDomain = {
      ...input,
      tenantId,
      createdAt: now,
      createdBy: who,
      updatedAt: now,
      updatedBy: who,
    };
    // Best-effort Purview classic-collection mirror. Never blocks the Cosmos
    // write — when Purview is unconfigured or the UAMI lacks Collection Admin,
    // the domain still persists (no Fabric/Purview hard dependency).
    if (isPurviewConfigured()) {
      try {
        const mirrored = await createBusinessDomain({
          id: doc.id,
          name: doc.name,
          description: doc.description,
        });
        doc.purviewCollectionId = mirrored.id;
      } catch {
        /* Non-fatal — Purview mirror is best-effort. */
      }
    }
    await c.items.create(doc);
    return doc;
  },

  async updateDomain(tenantId, id, patch, who) {
    const c = await governanceDomainsContainer();
    const { resource } = await c.item(id, tenantId).read<LoomDomain>();
    if (!resource) {
      const err: any = new Error(`Domain '${id}' not found`);
      err.status = 404;
      throw err;
    }
    const updated: LoomDomain = {
      ...resource,
      ...patch,
      updatedAt: new Date().toISOString(),
      updatedBy: who,
    };
    // Best-effort Purview collection update (PUT is idempotent create-or-update).
    if (isPurviewConfigured() && updated.purviewCollectionId) {
      try {
        await updateBusinessDomain(updated.purviewCollectionId, {
          name: updated.name,
          description: updated.description,
        });
      } catch {
        /* Non-fatal. */
      }
    }
    await c.item(id, tenantId).replace(updated);
    return updated;
  },

  async deleteDomain(tenantId, id) {
    const c = await governanceDomainsContainer();
    const { resource } = await c.item(id, tenantId).read<LoomDomain>();
    if (!resource) {
      const err: any = new Error(`Domain '${id}' not found`);
      err.status = 404;
      throw err;
    }
    if (resource.purviewCollectionId && isPurviewConfigured()) {
      try {
        await deleteBusinessDomain(resource.purviewCollectionId);
      } catch {
        /* Non-fatal — Purview may have been deprovisioned. */
      }
    }
    await c.item(id, tenantId).delete();
  },

  async moveDomain(tenantId, id, newParentId, who) {
    const c = await governanceDomainsContainer();
    const { resource } = await c.item(id, tenantId).read<LoomDomain>();
    if (!resource) {
      const err: any = new Error(`Domain '${id}' not found`);
      err.status = 404;
      throw err;
    }
    // Enforce the SAME two-level hierarchy invariants as PATCH /api/admin/domains
    // (self-parent, missing target, cycle, two-level cap). Load the tenant's
    // domains so the target + descendant chain can be checked — without this the
    // governance move path could corrupt the tree and break the unified mapper's
    // root-vs-subdomain (catalog-vs-schema) determination.
    const all = await this.listDomains(tenantId);
    const moveErr = validateDomainMove(
      all.map((d) => ({ id: d.id, parentId: d.parentDomainId })),
      id,
      newParentId,
    );
    if (moveErr) {
      const err: any = new Error(moveErr.message);
      err.status = moveErr.status;
      throw err;
    }
    const moved: LoomDomain = {
      ...resource,
      parentDomainId: newParentId,
      updatedAt: new Date().toISOString(),
      updatedBy: who,
    };
    // Best-effort Purview collection reparent (idempotent PUT re-asserts the new
    // parentCollection). Never blocks the Cosmos write — Purview is optional and
    // there is NO Fabric dependency on this path.
    if (isPurviewConfigured() && moved.purviewCollectionId) {
      try {
        await updateBusinessDomain(moved.purviewCollectionId, {
          name: moved.name,
          description: moved.description,
          parentId: newParentId ? domainCollectionName(newParentId) : undefined,
        });
      } catch {
        /* Non-fatal. */
      }
    }
    await c.item(id, tenantId).replace(moved);
    return moved;
  },

  async assignWorkspaces(tenantId, domainId, workspaceIds) {
    // Cosmos-native: patch each workspace doc to set domain = domainId.
    // Import lazily to avoid any circular-init ordering concerns.
    const { workspacesContainer } = await import('./cosmos-client');
    const c = await workspacesContainer();
    const assigned: string[] = [];
    for (const wsId of workspaceIds) {
      try {
        const { resource: ws } = await c.item(wsId, tenantId).read<any>();
        if (ws) {
          await c.item(wsId, tenantId).replace({ ...ws, domain: domainId });
          assigned.push(wsId);
        }
      } catch {
        /* Skip missing/inaccessible workspaces. */
      }
    }
    return { ok: true, assigned };
  },
};

// ---------------------------------------------------------------------------
// Fabric Admin adapter (OPT-IN)
// ---------------------------------------------------------------------------

// Resolved from LOOM_FABRIC_BASE (wired by main.bicep per boundary):
//   Commercial / GCC:  https://api.fabric.microsoft.com/v1
//   GCC-High / IL5:    https://api.fabric.microsoft.us/v1
const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

function fabricCredential() {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: (ManagedIdentityCredential | DefaultAzureCredential)[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(...chain);
}

async function fabricAdminFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const cred = fabricCredential();
  const token = await cred.getToken(FABRIC_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire Fabric Admin token');
  // Fabric Admin v1 Domains endpoint. `preview=false` is required — without it
  // the API returns 400. (MS Learn: "Domains - Create Domain".)
  const base = FABRIC_BASE.replace(/\/+$/, '');
  const url = `${base}/admin${path}?preview=false`;
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
}

interface FabricDomain {
  id: string;
  displayName: string;
  description?: string;
  parentDomainId?: string;
}

export const fabricAdminDomainStore: DomainStore = {
  async listDomains(tenantId) {
    // GET /v1/admin/domains?preview=false
    const res = await fabricAdminFetch('/domains', { method: 'GET' });
    if (!res.ok) throw new Error(`Fabric Admin listDomains failed: ${res.status}`);
    const j: { domains?: FabricDomain[] } = await res.json();
    return (j.domains || []).map(
      (d): LoomDomain => ({
        id: d.id,
        tenantId,
        name: d.displayName,
        description: d.description,
        parentDomainId: d.parentDomainId,
        fabricDomainId: d.id,
        createdAt: '',
        createdBy: '',
      }),
    );
  },

  async createDomain(tenantId, input, who) {
    // POST /v1/admin/domains?preview=false
    // body: { displayName: string; description?: string; parentDomainId?: string }
    const res = await fabricAdminFetch('/domains', {
      method: 'POST',
      body: JSON.stringify({
        displayName: input.name,
        description: input.description,
        ...(input.parentDomainId ? { parentDomainId: input.parentDomainId } : {}),
      }),
    });
    if (!res.ok)
      throw new Error(`Fabric Admin createDomain failed: ${res.status} ${await res.text()}`);
    const j: FabricDomain = await res.json();
    return {
      id: j.id,
      tenantId,
      name: j.displayName,
      description: j.description,
      parentDomainId: j.parentDomainId,
      fabricDomainId: j.id,
      createdAt: new Date().toISOString(),
      createdBy: who,
    };
  },

  async updateDomain(tenantId, id, patch, who) {
    // PATCH /v1/admin/domains/{domainId}?preview=false
    // body: { displayName?: string; description?: string }
    const res = await fabricAdminFetch(`/domains/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...(patch.name ? { displayName: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Fabric Admin updateDomain failed: ${res.status}`);
    const j: FabricDomain = await res.json();
    return {
      id: j.id,
      tenantId,
      name: j.displayName,
      description: j.description,
      parentDomainId: j.parentDomainId,
      fabricDomainId: j.id,
      createdAt: '',
      createdBy: '',
      updatedAt: new Date().toISOString(),
      updatedBy: who,
    };
  },

  async deleteDomain(_tenantId, id) {
    // DELETE /v1/admin/domains/{domainId}?preview=false
    // 200 on success; 404 is treated as already-gone (idempotent).
    const res = await fabricAdminFetch(`/domains/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Fabric Admin deleteDomain failed: ${res.status}`);
    }
  },

  async moveDomain(_tenantId, _id, _newParentId, _who): Promise<LoomDomain> {
    // The Fabric Admin Domains REST API has NO move/reparent endpoint — PATCH
    // /v1/admin/domains/{id} only accepts displayName/description (MS Learn:
    // "Domains - Update Domain"). Surface that honestly rather than faking it.
    // (Cosmos is the default backend and DOES support move; this only fires when
    // LOOM_DOMAINS_BACKEND=fabric is explicitly opted in.)
    const err: any = new Error(
      'Moving a domain is not supported by the Fabric Admin backend (no reparent endpoint). ' +
        'Use the default Cosmos backend (unset LOOM_DOMAINS_BACKEND) to reparent domains.',
    );
    err.status = 501;
    throw err;
  },

  async assignWorkspaces(_tenantId, domainId, workspaceIds) {
    // POST /v1/admin/domains/{domainId}/assignWorkspaces?preview=false
    // body: { workspacesIds: string[] }  ← Fabric spells this "workspacesIds".
    const res = await fabricAdminFetch(
      `/domains/${encodeURIComponent(domainId)}/assignWorkspaces`,
      { method: 'POST', body: JSON.stringify({ workspacesIds: workspaceIds }) },
    );
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Fabric Admin assignWorkspaces failed: ${res.status} ${text}` };
    }
    return { ok: true, assigned: workspaceIds };
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Return the active DomainStore based on LOOM_DOMAINS_BACKEND (default:
 * 'cosmos'). Throws DomainsBackendGateError if backend='fabric' and
 * LOOM_CLOUD_TIER=IL5 (Fabric Admin API is not FedRAMP IL5 approved).
 */
export function getDomainsStore(): DomainStore {
  const backend = (process.env.LOOM_DOMAINS_BACKEND || 'cosmos').toLowerCase();
  if (backend === 'fabric') {
    const tier = (process.env.LOOM_CLOUD_TIER || '').toUpperCase();
    if (tier === 'IL5') {
      throw new DomainsBackendGateError(
        'fabric',
        'Fabric Admin API is not FedRAMP IL5 approved. ' +
          'Remove LOOM_DOMAINS_BACKEND=fabric for IL5 deployments (Cosmos is the default).',
      );
    }
    return fabricAdminDomainStore;
  }
  return cosmosDomainStore;
}
