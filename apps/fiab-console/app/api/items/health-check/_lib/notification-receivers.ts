/**
 * Health-check notification receivers — the persisted shapes, the browser VIEW
 * of them, and the PUT-body parser for the Azure Function + Logic App rows.
 *
 * PURE — no server imports — so the editor imports the same types the route
 * persists (the pattern `check-types.ts` beside it uses).
 *
 * ── #4740: an Azure Function receiver is a BINDING, not a URL ───────────────
 * A function receiver is persisted as `{ functionAppResourceId, functionName }`.
 * Its key-bearing trigger URL is resolved server-side at save
 * (`lib/azure/function-receiver.ts`) and handed straight to the action group;
 * it is never stored on the item and never sent to the browser.
 *
 * LEGACY ROWS. Items saved before this fix hold `{ functionUrl }` — a
 * hand-typed URL that usually carries `?code=<function key>`. They are NOT
 * dropped (that would silently stop the alert reaching the function) and NOT
 * echoed (that would keep rendering the key into the DOM). The browser gets
 * `{ legacyEndpoint }` — scheme + host + path, never the query — and the row is
 * shown for re-binding. Sending `{ legacyEndpoint }` back keeps the stored row
 * as it is; picking a Function App replaces it. A NEW hand-typed `functionUrl`
 * is refused.
 */

export interface BoundFunctionReceiver {
  name?: string;
  /** ARM id of the Function App (Microsoft.Web/sites), from the `function-app-id` picker. */
  functionAppResourceId: string;
  /** The HTTP-triggered function inside that app. */
  functionName: string;
  useCommonAlertSchema?: boolean;
}

/** Pre-#4740 shape. `functionUrl` may carry a function key — server-side only. */
export interface LegacyFunctionReceiver {
  name?: string;
  functionUrl: string;
  useCommonAlertSchema?: boolean;
}

export type PersistedFunctionReceiver = BoundFunctionReceiver | LegacyFunctionReceiver;

/** What the browser sees for a function row. Never carries a key. */
export interface FunctionReceiverView {
  name?: string;
  functionAppResourceId?: string;
  functionName?: string;
  useCommonAlertSchema?: boolean;
  /** Set only on a legacy hand-typed row: its scheme + host + path, query stripped. */
  legacyEndpoint?: string;
}

export interface LogicAppReceiverRow {
  name?: string;
  resourceId: string;
  /**
   * Only when the USER picked one of several request triggers. Absent means
   * "resolve it" — so a renamed trigger re-binds on the next save instead of
   * pinning a stale name (`auto-bind-by-default.md` §3).
   */
  triggerName?: string;
  useCommonAlertSchema?: boolean;
}

export function isLegacyFunctionReceiver(f: unknown): f is LegacyFunctionReceiver {
  return !!f && typeof f === 'object' && typeof (f as LegacyFunctionReceiver).functionUrl === 'string'
    && !(f as BoundFunctionReceiver).functionAppResourceId;
}

/** Placeholder shown for a legacy value that does not parse as a URL. */
export const UNPARSEABLE_LEGACY_ENDPOINT = '(unparseable hand-typed URL)';

/**
 * Scheme + host + path of a hand-typed URL — never the query (where `code=`
 * lives), never userinfo. `URL.host` excludes `user:pass@`.
 */
export function redactedEndpoint(url: string): string {
  try {
    const u = new URL(String(url || '').trim());
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return UNPARSEABLE_LEGACY_ENDPOINT;
  }
}

export function functionReceiverView(f: PersistedFunctionReceiver): FunctionReceiverView {
  if (isLegacyFunctionReceiver(f)) {
    return {
      ...(f.name ? { name: f.name } : {}),
      useCommonAlertSchema: f.useCommonAlertSchema,
      legacyEndpoint: redactedEndpoint(f.functionUrl),
    };
  }
  return {
    ...(f.name ? { name: f.name } : {}),
    functionAppResourceId: f.functionAppResourceId,
    functionName: f.functionName,
    useCommonAlertSchema: f.useCommonAlertSchema,
  };
}

export type ParseResult<T> = { ok: true; rows: T[] } | { ok: false; error: string };

export const HAND_TYPED_FUNCTION_URL_REFUSED =
  'A hand-typed Azure Function trigger URL is no longer accepted: it carries the function key. '
  + 'Pick the Function App and the function instead; the key is resolved server-side at save and never stored on the item.';

/**
 * Parse the PUT body's `functions` against what the item already stores.
 * A row is one of:
 *   { functionAppResourceId, functionName }  a binding (validated at resolve time)
 *   { legacyEndpoint }                        keep the matching stored legacy row
 *   { functionUrl }                           REFUSED — see the header
 *   {}                                        an untouched empty row; dropped
 */
export function parseFunctionRows(
  input: unknown,
  stored: PersistedFunctionReceiver[],
): ParseResult<PersistedFunctionReceiver> {
  if (!Array.isArray(input)) return { ok: true, rows: [] };
  const legacyPool = stored
    .map((f, i) => ({ f, i }))
    .filter((x): x is { f: LegacyFunctionReceiver; i: number } => isLegacyFunctionReceiver(x.f));
  const used = new Set<number>();
  const rows: PersistedFunctionReceiver[] = [];
  for (const r of input as any[]) {
    const useCommonAlertSchema = r?.useCommonAlertSchema !== false;
    const name = r?.name ? String(r.name) : undefined;
    if (typeof r?.functionUrl === 'string' && r.functionUrl.trim()) {
      return { ok: false, error: HAND_TYPED_FUNCTION_URL_REFUSED };
    }
    const appId = typeof r?.functionAppResourceId === 'string' ? r.functionAppResourceId.trim() : '';
    const fn = typeof r?.functionName === 'string' ? r.functionName.trim() : '';
    if (appId || fn) {
      rows.push({ ...(name ? { name } : {}), functionAppResourceId: appId, functionName: fn, useCommonAlertSchema });
      continue;
    }
    if (typeof r?.legacyEndpoint === 'string' && r.legacyEndpoint) {
      const hit = legacyPool.find((x) => !used.has(x.i) && redactedEndpoint(x.f.functionUrl) === r.legacyEndpoint);
      if (!hit) {
        return {
          ok: false,
          error: `The earlier hand-typed Azure Function receiver for ${r.legacyEndpoint} is no longer stored on this item. `
            + 'Re-bind it by picking the Function App and function.',
        };
      }
      used.add(hit.i);
      rows.push({ ...hit.f, useCommonAlertSchema });
      continue;
    }
    // An untouched "Add function" row: nothing picked, nothing to keep.
  }
  return { ok: true, rows };
}

export function parseLogicAppRows(input: unknown): LogicAppReceiverRow[] {
  if (!Array.isArray(input)) return [];
  return (input as any[])
    .map((r) => {
      const triggerName = typeof r?.triggerName === 'string' && r.triggerName.trim() ? r.triggerName.trim() : undefined;
      return {
        ...(r?.name ? { name: String(r.name) } : {}),
        resourceId: String(r?.resourceId || '').trim(),
        ...(triggerName ? { triggerName } : {}),
        useCommonAlertSchema: r?.useCommonAlertSchema !== false,
      };
    })
    .filter((r) => r.resourceId);
}
