/**
 * Pure (dependency-free) helpers for the per-resource Cost Management adapter.
 *
 * Kept separate from cost-client.ts so they can be unit-tested without loading
 * the @azure/identity credential chain (and so a unit test never instantiates a
 * Managed Identity credential at import time). cost-client.ts re-exports these.
 */

/**
 * Extract the subscription GUID from an ARM resource id
 * (`/subscriptions/{sub}/resourceGroups/...`). Returns null when the id is not a
 * subscription-scoped ARM id.
 */
export function subscriptionFromResourceId(resourceId: string): string | null {
  const m = /\/subscriptions\/([0-9a-fA-F-]{36})(\/|$)/.exec(resourceId || '');
  return m ? m[1] : null;
}

/** Column index by name (Cost Management returns columns + rows). */
function colIndex(cols: any[], name: string): number {
  return (cols || []).findIndex((c) => (c?.name || '').toLowerCase() === name.toLowerCase());
}

/**
 * Parse a Microsoft.CostManagement query response into { cost, currency }.
 * The ResourceId dimension filter already scopes the query to one resource, so
 * every returned row belongs to it; we sum the Cost column across rows (a single
 * resource can split rows by currency or meter). Returns 0 when there are no
 * rows (resource has no separate billing line, e.g. a child whose cost rolls up
 * to the parent).
 */
export function parseResourceCost(json: any): { cost: number; currency: string } {
  const cols = json?.properties?.columns || [];
  const rows: any[][] = json?.properties?.rows || [];
  const iCost = colIndex(cols, 'Cost');
  const iCur = colIndex(cols, 'Currency');
  let cost = 0;
  let currency = 'USD';
  for (const row of rows) {
    if (iCost >= 0) cost += Number(row[iCost]) || 0;
    if (iCur >= 0 && row[iCur]) currency = String(row[iCur]);
  }
  return { cost: Math.round(cost * 100) / 100, currency };
}
