/**
 * UnifiedCatalogGateAdapter — opt-in adapter that preserves the legacy
 * PurviewUnifiedCatalogGateError behaviour behind
 * LOOM_DATAPRODUCTS_BACKEND='unified-catalog'.
 *
 * Data products / business domains are a NEW Purview unified-catalog concept
 * (`/datagovernance`) that the deployed CLASSIC Data Map account does not
 * expose. When an operator explicitly opts into this backend, every CRUD call
 * throws the typed honest-gate so the editor renders the MessageBar (subclass
 * of PurviewNotConfiguredError → existing BFF catches map it to a 501/503 + hint
 * with ZERO fabricated data). With the env var UNSET, the Cosmos adapter runs
 * instead and this gate is never reached.
 */
import { PurviewUnifiedCatalogGateError } from '@/lib/azure/purview-client';
import type { DataProductStore } from './store';
import type {
  PurviewDataProduct,
  PurviewDataProductPayload,
} from '@/lib/azure/purview-client';

export class UnifiedCatalogGateAdapter implements DataProductStore {
  async register(_payload: PurviewDataProductPayload): Promise<PurviewDataProduct> {
    throw new PurviewUnifiedCatalogGateError('Data products');
  }
  async get(_id: string): Promise<PurviewDataProduct | null> {
    throw new PurviewUnifiedCatalogGateError('Data products');
  }
  async list(_domain?: string): Promise<PurviewDataProduct[]> {
    throw new PurviewUnifiedCatalogGateError('Data products');
  }
  async update(_id: string, _payload: Partial<PurviewDataProductPayload>): Promise<PurviewDataProduct> {
    throw new PurviewUnifiedCatalogGateError('Data products');
  }
  async delete(_id: string): Promise<void> {
    throw new PurviewUnifiedCatalogGateError('Data products');
  }
}
