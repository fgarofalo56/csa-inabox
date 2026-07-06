/**
 * Loom app (org app) — shared model + pure helpers.
 *
 * A Loom app BUNDLES existing workspace items into a distributable, audience-
 * scoped consumer app — the Azure-native equivalent of a Microsoft Fabric /
 * Power BI org app, with NO Fabric or Power BI workspace required
 * (.claude/rules/no-fabric-dependency.md). The definition persists to Cosmos as
 * the item's `state` (see app/api/items/loom-app/[id]/route.ts, makeItemRoute);
 * the consumer view (/apps/[id]) and the render route resolve it against the
 * live workspace inventory + the caller's audience membership.
 *
 * This module is React-free so both the editor (client) and the BFF routes
 * (server) can import the types + helpers.
 */

/** One piece of content the app surfaces — a reference to a real workspace item. */
export interface LoomAppContentEntry {
  /** Cosmos item id of the referenced workspace item. */
  itemId: string;
  /** Item-type slug (e.g. 'report', 'dashboard', 'notebook') — drives its route + icon. */
  itemType: string;
  /** Display name cached when added; the render route refreshes it from the live item. */
  displayName: string;
  /** Optional navigation section this entry belongs to (must be one of `sections`). */
  section?: string;
}

/**
 * A named audience — the Fabric org-app "audiences" model on Loom's access
 * layer. Each audience has its own access list (principals) and, optionally, a
 * subset of the app's content it can see (empty/undefined = the whole app).
 */
export interface LoomAppAudience {
  id: string;
  name: string;
  /** Access list: user emails / UPNs / oids / group ids. Matched case-insensitively. */
  principals: string[];
  /** Item ids visible to this audience; empty/undefined = all content. */
  itemIds?: string[];
}

/** The full app definition, persisted as the loom-app item's `state`. */
export interface LoomAppDefinition {
  /** Consumer-facing app description shown on the app landing. */
  description?: string;
  /** Ordered navigation section names. Content entries reference these by name. */
  sections: string[];
  /** Ordered content entries (the app's navigation). */
  content: LoomAppContentEntry[];
  /** Audiences (access + visible-content scope). */
  audiences: LoomAppAudience[];
  /** True once published; consumers can open /apps/<id>. */
  published?: boolean;
  /** ISO timestamp of the last publish. */
  publishedAt?: string | null;
  /** Monotonic publish version (increments each publish). */
  version?: number;
  /** Index signature so this satisfies useItemState<Record<string, unknown>>. */
  [k: string]: unknown;
}

/** A fresh, empty definition — the editor's initial state. */
export const EMPTY_LOOM_APP: LoomAppDefinition = {
  description: '',
  sections: [],
  content: [],
  audiences: [],
  published: false,
  publishedAt: null,
  version: 0,
};

/** Normalize a principal for case-insensitive comparison. */
export function normalizePrincipal(s: string): string {
  return (s || '').trim().toLowerCase();
}

/** Stable-ish id for a new section/audience/entry (no crypto dependency). */
export function newLocalId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Coerce a persisted (possibly partial / legacy) state into a full definition. */
export function coerceDefinition(state: unknown): LoomAppDefinition {
  const s = (state && typeof state === 'object' ? state : {}) as Partial<LoomAppDefinition>;
  return {
    description: typeof s.description === 'string' ? s.description : '',
    sections: Array.isArray(s.sections) ? s.sections.filter((x): x is string => typeof x === 'string') : [],
    content: Array.isArray(s.content) ? (s.content as LoomAppContentEntry[]).filter((c) => c && typeof c.itemId === 'string') : [],
    audiences: Array.isArray(s.audiences) ? (s.audiences as LoomAppAudience[]).filter((a) => a && typeof a.id === 'string') : [],
    published: Boolean(s.published),
    publishedAt: typeof s.publishedAt === 'string' ? s.publishedAt : null,
    version: typeof s.version === 'number' ? s.version : 0,
  };
}

/**
 * Which of the caller's principals (oid / email / upn / group ids) grant access,
 * and what content is visible. Returns the set of visible item ids, or `null`
 * when the caller belongs to NO audience (and at least one audience exists) —
 * i.e. no access. When the app defines NO audiences, everyone with workspace
 * access sees all content (the resolver returns every content id).
 */
export function resolveVisibleContent(
  def: LoomAppDefinition,
  callerPrincipals: string[],
): { itemIds: Set<string>; audiences: string[] } | null {
  const allIds = new Set(def.content.map((c) => c.itemId));
  if (!def.audiences || def.audiences.length === 0) {
    return { itemIds: allIds, audiences: [] };
  }
  const caller = new Set(callerPrincipals.map(normalizePrincipal).filter(Boolean));
  const matched = def.audiences.filter((a) =>
    (a.principals || []).some((p) => caller.has(normalizePrincipal(p))),
  );
  if (matched.length === 0) return null;
  const visible = new Set<string>();
  for (const a of matched) {
    const subset = a.itemIds && a.itemIds.length > 0 ? a.itemIds : def.content.map((c) => c.itemId);
    for (const id of subset) if (allIds.has(id)) visible.add(id);
  }
  return { itemIds: visible, audiences: matched.map((a) => a.name) };
}
