/**
 * What the notebook editor shows for an attached lakehouse, from the answer of
 * `GET /api/items/lakehouse/[id]/abfss`: the path, or why there is none.
 *
 * The caption states the cause the route reported. A location the resolver
 * withheld (`root-shared`, `root-unverified`) is not "not configured", and the
 * fix for it is not a configuration value, so it gets its own caption and, for
 * `root-shared`, the page that resolves it.
 */

export interface AttachedLakehouseResolution {
  abfss?: string;
  /** The route's full explanation (shown as the tooltip). */
  hint?: string;
  /** The resolver's reason, when it withheld the location. */
  reason?: string;
  /** A page that resolves the reason (the readiness page, for `root-shared`). */
  fixHref?: string;
}

/**
 * Read one abfss-route answer. Null when the answer says nothing usable
 * (`ok` false, or not an object): the chip then shows neither a path nor a cause.
 */
export function readAttachedLakehouseResolution(j: unknown): AttachedLakehouseResolution | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (o.ok !== true) return null;
  if (o.resolved === true && typeof o.abfss === 'string' && o.abfss) return { abfss: o.abfss };
  return {
    hint: typeof o.hint === 'string' && o.hint ? o.hint : 'Path not resolved.',
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    ...(typeof o.fixHref === 'string' ? { fixHref: o.fixHref } : {}),
  };
}

/** The short visible caption for an attached lakehouse with no path. */
export function attachedLakehouseCaption(r: AttachedLakehouseResolution): string {
  if (r.reason === 'root-shared') return 'storage shared with another item';
  if (r.reason === 'root-unverified') return 'storage ownership not confirmed';
  return 'path not configured';
}
