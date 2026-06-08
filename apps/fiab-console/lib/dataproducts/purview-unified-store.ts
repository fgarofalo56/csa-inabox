/**
 * PurviewUnifiedDataProductStore — the OPT-IN DataProductStore adapter that
 * routes data-product CRUD through the Microsoft Purview Unified Catalog REST
 * API (2026-03-20-preview). Selected by the factory (lib/dataproducts/store.ts)
 * ONLY on the Commercial boundary with LOOM_DATAPRODUCTS_BACKEND=unified-catalog
 * AND a configured Unified Catalog account (LOOM_PURVIEW_UNIFIED_ACCOUNT /
 * LOOM_PURVIEW_UC_ENDPOINT). On GCC / GCC-High / IL5 the factory falls through
 * to Cosmos silently; opted-in-but-unconfigured falls through to the honest gate.
 *
 * Implements the SAME `DataProductStore` interface the Cosmos adapter does
 * (register / get / list / update / delete → PurviewDataProduct), so the BFF +
 * UI operate against this backend exactly as they do against Cosmos
 * (ui-parity.md). Maps UCDataProduct <-> PurviewDataProduct. Errors
 * (PurviewNotConfiguredError / PurviewError) propagate UNCHANGED so the route
 * renders an honest infra-gate MessageBar (no-vaporware.md) — never fabricated
 * data.
 */
import { PurviewError } from '@/lib/azure/purview-client';
import {
  ucGet,
  ucList,
  ucCreate,
  ucUpdate,
  ucRemove,
  type UCDataProduct,
  type UCDataProductPayload,
} from '@/lib/azure/purview-unified-client';
import type {
  DataProductStore,
  PurviewDataProduct,
  PurviewDataProductPayload,
} from './store';

/** Map the Unified Catalog REST shape onto the canonical PurviewDataProduct. */
function toPurview(dp: UCDataProduct): PurviewDataProduct {
  return {
    id: dp.id,
    name: dp.name,
    description: dp.description,
    domain: dp.domain,
    status: dp.status,
    type: dp.type,
    endorsed: dp.endorsed,
    contacts: dp.contacts,
    documentation: dp.documentation,
    updatedAt: dp.systemData?.lastModifiedAt,
    raw: dp,
  };
}

/** Resolve the create-name from either `name` or the UI's `displayName`. */
function payloadName(p: PurviewDataProductPayload): string | undefined {
  return (p.name ?? p.displayName)?.toString().trim() || undefined;
}

/** Build a full UC create payload (name + domain are required by the REST surface). */
function toUCCreate(p: PurviewDataProductPayload): UCDataProductPayload {
  const name = payloadName(p);
  if (!name) throw new PurviewError(400, null, 'name is required to create a data product');
  if (!p.domain) {
    throw new PurviewError(
      400,
      null,
      'domain (governance domain id) is required to create a Purview Unified Catalog data product',
    );
  }
  return {
    name,
    domain: p.domain,
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.type !== undefined ? { type: p.type } : {}),
    ...(p.endorsed !== undefined ? { endorsed: p.endorsed } : {}),
  };
}

/** Build a partial UC patch from a partial canonical payload. */
function toUCPatch(p: Partial<PurviewDataProductPayload>): Partial<UCDataProductPayload> {
  const patch: Partial<UCDataProductPayload> = {};
  const name = p.name ?? p.displayName;
  if (name !== undefined) patch.name = String(name);
  if (p.domain !== undefined) patch.domain = p.domain;
  if (p.description !== undefined) patch.description = p.description;
  if (p.type !== undefined) patch.type = p.type;
  if (p.endorsed !== undefined) patch.endorsed = p.endorsed;
  return patch;
}

export class PurviewUnifiedDataProductStore implements DataProductStore {
  /** Create — or upsert when payload.id names an existing product. */
  async register(payload: PurviewDataProductPayload): Promise<PurviewDataProduct> {
    if (payload.id) {
      const existing = await ucGet(payload.id);
      if (existing) return toPurview(await ucUpdate(payload.id, toUCPatch(payload)));
    }
    return toPurview(await ucCreate(toUCCreate(payload)));
  }

  async get(id: string): Promise<PurviewDataProduct | null> {
    const dp = await ucGet(id);
    return dp ? toPurview(dp) : null;
  }

  async list(domain?: string): Promise<PurviewDataProduct[]> {
    const dps = await ucList({ domainId: domain });
    return dps.map(toPurview);
  }

  async update(id: string, payload: Partial<PurviewDataProductPayload>): Promise<PurviewDataProduct> {
    const existing = await ucGet(id);
    if (!existing) throw new PurviewError(404, null, `Data product '${id}' not found`);
    return toPurview(await ucUpdate(id, toUCPatch(payload)));
  }

  async delete(id: string): Promise<void> {
    await ucRemove(id);
  }
}
