/**
 * #3669 — the AI functions panel's view of the warehouse link.
 *
 * Two pure decisions, kept out of the dialog so they are unit-testable without
 * rendering it:
 *
 *   - {@link runErrorFrom}: turn a refused `POST .../ai-function` body into what
 *     the MessageBar shows — the message, the stable `code`, the server's
 *     `remediation`, and whether "Use Azure OpenAI instead" applies (it does for
 *     the two warehouse refusals, whose cause is the warehouse, not the function).
 *
 *   - {@link linkOfferFor}: given the admin listing from
 *     `GET /api/admin/databricks-warehouses/adopt` and the selected warehouse,
 *     whether a tenant admin should be offered "Link to this item". Only for a
 *     warehouse that carries NO owner tag, has no conflicting tag, and is not
 *     deployment-shared (`loom-default` stays admin-only and is never linked).
 *
 * Zero dependencies beyond the pure id normaliser, so the client bundle pulls in
 * no server module.
 */
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';

/** The refusal codes the item-scoped AI-function route returns for a warehouse. */
export const WAREHOUSE_REFUSAL_CODES: readonly string[] = ['warehouse_not_available', 'warehouse_unverifiable'];

/**
 * The only item type the adopt route links a warehouse to (it 404s any other).
 * Must equal `WAREHOUSE_ITEM_TYPE` in `_lib/warehouse-item-binding.ts` — a test
 * pins the two together; it is restated here so the client bundle does not pull
 * in that server module.
 */
export const LINKABLE_ITEM_TYPE = 'databricks-sql-warehouse';

export interface RunError {
  message: string;
  code?: string;
  remediation?: string;
  /** The refusal was about the warehouse, so the Azure OpenAI path can still run. */
  aoaiFallback: boolean;
}

export function runErrorFrom(body: unknown, status: number): RunError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const code = str(b.code);
  return {
    message: str(b.error) ?? `HTTP ${status}`,
    code,
    remediation: str(b.remediation),
    aoaiFallback: !!code && WAREHOUSE_REFUSAL_CODES.includes(code),
  };
}

/** One row of `GET /api/admin/databricks-warehouses/adopt`. */
export interface AdoptRow {
  id: string;
  name?: string;
  linkedItemId: string | null;
  conflict: boolean;
  deploymentShared?: boolean;
}

export type LinkOffer =
  /** Untagged, not shared — offer "Link to this item". */
  | 'offer'
  /** Already names this item. */
  | 'linked'
  /** Names a different item — never offered; adopt would refuse it. */
  | 'linked_elsewhere'
  /** `loom-default` & co. — admin-only, never linked. */
  | 'shared'
  /** More than one owner value on the warehouse. */
  | 'conflict'
  /** Not in the listing, or no warehouse selected. */
  | 'unknown';

export function linkOfferFor(rows: unknown, warehouseId: string | undefined, itemId: string): LinkOffer {
  if (!warehouseId || !Array.isArray(rows)) return 'unknown';
  const row = (rows as AdoptRow[]).find((r) => r && r.id === warehouseId);
  if (!row) return 'unknown';
  if (row.conflict) return 'conflict';
  if (row.linkedItemId) {
    return cosmosIdFromLoomId(row.linkedItemId) === cosmosIdFromLoomId(itemId) ? 'linked' : 'linked_elsewhere';
  }
  if (row.deploymentShared) return 'shared';
  return 'offer';
}
