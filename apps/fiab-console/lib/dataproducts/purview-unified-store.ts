/**
 * PurviewUnifiedDataProductStore — the OPT-IN DataProductStore adapter that
 * routes data-product CRUD through the Microsoft Purview Unified Catalog REST
 * API (2026-03-20-preview). Selected by the factory ONLY on Commercial with
 * LOOM_DATAPRODUCTS_BACKEND=purview-unified + a configured Unified account.
 *
 * Maps UCDataProduct <-> LoomDataProduct so the SAME BFF + UI operate against
 * this backend exactly as they do against Cosmos (ui-parity.md). Errors
 * (PurviewNotConfiguredError / PurviewError) propagate UNCHANGED so the route
 * renders an honest infra-gate MessageBar (no-vaporware.md) — never fabricated
 * data.
 */
import type { SessionPayload } from '@/lib/auth/session';
import {
  ucGet,
  ucList,
  ucCreate,
  ucUpdate,
  ucRemove,
  type UCDataProduct,
  type UCDataProductPayload,
} from '@/lib/azure/purview-unified-client';
import type { DataProductStore, LoomDataProduct, LoomDataProductPayload } from './store';

function toLoom(dp: UCDataProduct): LoomDataProduct {
  return {
    id: dp.id,
    name: dp.name,
    description: dp.description,
    domain: dp.domain,
    status: dp.status,
    type: dp.type,
    endorsed: dp.endorsed,
    contacts: dp.contacts,
    businessUse: dp.businessUse,
    createdAt: dp.systemData?.createdAt,
    updatedAt: dp.systemData?.lastModifiedAt,
    source: 'purview-unified',
    raw: dp,
  };
}

/** Build the UC create/update payload from a Loom payload (name + domain required). */
function toUCPayload(payload: LoomDataProductPayload): UCDataProductPayload {
  const { name, domain, description, type, status, endorsed, businessUse, contacts } = payload;
  if (!domain) {
    throw new Error('domain (governance domain id) is required to create a Purview Unified Catalog data product');
  }
  return {
    name,
    domain,
    ...(description !== undefined ? { description } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(status !== undefined ? { status: status as UCDataProduct['status'] } : {}),
    ...(endorsed !== undefined ? { endorsed } : {}),
    ...(businessUse !== undefined ? { businessUse } : {}),
    ...(contacts !== undefined ? { contacts: contacts as UCDataProduct['contacts'] } : {}),
  };
}

export class PurviewUnifiedDataProductStore implements DataProductStore {
  readonly backendName = 'purview-unified' as const;

  async list(_session: SessionPayload, opts?: { domain?: string; top?: number; skip?: number }): Promise<LoomDataProduct[]> {
    const dps = await ucList({ domainId: opts?.domain, top: opts?.top, skip: opts?.skip });
    return dps.map(toLoom);
  }

  async get(_session: SessionPayload, id: string): Promise<LoomDataProduct | null> {
    const dp = await ucGet(id);
    return dp ? toLoom(dp) : null;
  }

  async create(_session: SessionPayload, payload: LoomDataProductPayload): Promise<LoomDataProduct> {
    const dp = await ucCreate(toUCPayload(payload));
    return toLoom(dp);
  }

  async update(_session: SessionPayload, id: string, patch: Partial<LoomDataProductPayload>): Promise<LoomDataProduct | null> {
    const existing = await ucGet(id);
    if (!existing) return null;
    const ucPatch: Partial<UCDataProductPayload> = {};
    if (patch.name !== undefined) ucPatch.name = patch.name;
    if (patch.domain !== undefined) ucPatch.domain = patch.domain;
    if (patch.description !== undefined) ucPatch.description = patch.description;
    if (patch.type !== undefined) ucPatch.type = patch.type;
    if (patch.status !== undefined) ucPatch.status = patch.status as UCDataProduct['status'];
    if (patch.endorsed !== undefined) ucPatch.endorsed = patch.endorsed;
    if (patch.businessUse !== undefined) ucPatch.businessUse = patch.businessUse;
    if (patch.contacts !== undefined) ucPatch.contacts = patch.contacts as UCDataProduct['contacts'];
    const dp = await ucUpdate(id, ucPatch);
    return toLoom(dp);
  }

  async remove(_session: SessionPayload, id: string): Promise<boolean> {
    return ucRemove(id);
  }
}
