/**
 * Power-BI / Purview editor content fallback.
 *
 * The semantic-model / report / scorecard editors (lib/editors/phase3-editors.tsx)
 * are LIVE Power BI surfaces keyed on a Power BI groupId + dataset/report/
 * scorecard id. When an app bundle is installed (see
 * /api/apps/[id]/install/route.ts), each item's rich starter definition is
 * stamped into the Cosmos item's `state.content` (an `AnyContent` per
 * lib/apps/content-bundles/types.ts) — but the Power BI object it represents
 * does NOT yet exist in the tenant. Result: the editor lists the live PBI
 * workspace, finds nothing matching, and opens EMPTY — the bundle's tables /
 * measures / pages / OKRs are stranded in `state.content`.
 *
 * This helper lets the per-type GET routes surface those bundle-installed
 * items as first-class, fully-built-out entries WITHOUT touching the editor:
 *
 *   • List routes append synthetic entries (id = `loom:<cosmosItemId>`) for
 *     every tenant-owned item of that type whose `state.content` matches the
 *     expected kind. The editor auto-picks the first entry and calls detail.
 *   • Detail routes detect a `loom:` id (or fall back when the live fetch
 *     404s) and build the editor's expected definition shape from
 *     `state.content`.
 *
 * Live embed / refresh / DAX-validate / goal-value-entry continue to hit the
 * real Power BI backend for genuine PBI objects. Synthetic (loom:) ids are
 * config-only previews of the bundle definition until the user pushes them to
 * Power BI (Build model) — which is the honest, no-vaporware state.
 */

import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import type {
  SemanticModelContent,
  ReportContent,
  ScorecardContent,
} from '@/lib/apps/content-bundles/types';
import { computeRollups, type ComputedGoal } from '../scorecard/rollup';

/** Prefix that marks a synthetic, Cosmos-backed (not-yet-in-PBI) entry. */
export const LOOM_ID_PREFIX = 'loom:';

export function isLoomContentId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(LOOM_ID_PREFIX);
}

export function cosmosIdFromLoomId(id: string): string {
  return isLoomContentId(id) ? id.slice(LOOM_ID_PREFIX.length) : id;
}

/**
 * List tenant-owned items of `itemType` whose `state.content.kind === kind`.
 * Ownership is verified against the parent workspace's tenantId. Best-effort:
 * any Cosmos error returns [] so the live PBI path is never blocked.
 */
export async function listContentBackedItems(
  itemType: string,
  contentKind: string,
  tenantId: string,
): Promise<WorkspaceItem[]> {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.itemType = @t',
        parameters: [{ name: '@t', value: itemType }],
      })
      .fetchAll();
    const candidates = resources.filter(
      (r) => (r.state as any)?.content?.kind === contentKind,
    );
    if (candidates.length === 0) return [];
    const ws = await workspacesContainer();
    const owned: WorkspaceItem[] = [];
    const cache = new Map<string, boolean>();
    for (const it of candidates) {
      let isOwned = cache.get(it.workspaceId);
      if (isOwned === undefined) {
        try {
          const { resource } = await ws.item(it.workspaceId, tenantId).read<Workspace>();
          isOwned = !!resource && resource.tenantId === tenantId;
        } catch {
          isOwned = false;
        }
        cache.set(it.workspaceId, isOwned);
      }
      if (isOwned) owned.push(it);
    }
    return owned;
  } catch {
    return [];
  }
}

/** Load one tenant-owned item by id, verifying parent-workspace ownership. */
export async function loadContentBackedItem(
  cosmosItemId: string,
  itemType: string,
  tenantId: string,
): Promise<WorkspaceItem | null> {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
        parameters: [
          { name: '@id', value: cosmosItemId },
          { name: '@t', value: itemType },
        ],
      })
      .fetchAll();
    const item = resources[0];
    if (!item) return null;
    const ws = await workspacesContainer();
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return item;
  } catch {
    return null;
  }
}

function contentOf<T>(item: WorkspaceItem, kind: string): T | null {
  const c = (item.state as any)?.content;
  return c && c.kind === kind ? (c as T) : null;
}

// ── Semantic model ────────────────────────────────────────────────────────

/** Synthetic dataset list entry (matches the editor's DatasetLite shape). */
export function semanticModelListEntry(item: WorkspaceItem) {
  return {
    id: `${LOOM_ID_PREFIX}${item.id}`,
    name: item.displayName,
    isRefreshable: false,
    configuredBy: 'CSA Loom (bundle template — push to Power BI to make live)',
    targetStorageMode: 'Template',
    __loomContent: true as const,
  };
}

/**
 * Build the semantic-model detail payload (dataset + tables + relationships)
 * from a bundle-installed item's SemanticModelContent. Tables carry their
 * columns AND the measures that target them (the editor's Tables tab renders
 * `measures` per table; the Relationships tab renders `relationships`).
 */
export function semanticModelDetailFromContent(item: WorkspaceItem) {
  const content = contentOf<SemanticModelContent>(item, 'semantic-model');
  if (!content) return null;
  const measuresByTable = new Map<string, { name: string; expression?: string }[]>();
  for (const m of content.measures || []) {
    const list = measuresByTable.get(m.table) || [];
    list.push({ name: m.name, expression: m.expression });
    measuresByTable.set(m.table, list);
  }
  const tables = (content.tables || []).map((t) => ({
    name: t.name,
    columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })),
    measures: measuresByTable.get(t.name) || [],
  }));
  const relationships = (content.relationships || []).map((r, i) => {
    const [fromTable, fromColumn] = String(r.from || '').split('.');
    const [toTable, toColumn] = String(r.to || '').split('.');
    return {
      name: `rel-${i + 1}`,
      fromTable: fromTable || r.from,
      fromColumn: fromColumn || '',
      toTable: toTable || r.to,
      toColumn: toColumn || '',
      crossFilteringBehavior:
        r.cardinality === 'many:many' ? 'BothDirections' : 'OneDirection',
    };
  });
  return {
    dataset: {
      id: `${LOOM_ID_PREFIX}${item.id}`,
      name: item.displayName,
      isRefreshable: false,
      configuredBy: 'CSA Loom (bundle template)',
      targetStorageMode: 'Template',
    },
    tables,
    relationships,
    refreshSchedule: null,
  };
}

// ── Report ──────────────────────────────────────────────────────────────

/**
 * Read-side view of the persisted report content. ADDITIVE over
 * {@link ReportContent} with the wave-2 members the definition route writes
 * (`ReportContentV2` in `.../report/[id]/definition/route.ts`) but the base
 * bundle type doesn't declare: per-page canvas `config` (type/size/background/
 * hidden + the visual-interactions matrix + drillthrough/tooltip target),
 * report-level `bookmarks`, and the Filters-pane `filterPaneFormat`. Loosely
 * typed — every value is already STRUCTURED + server-sanitized at PUT time
 * (no-freeform-config.md), and the designer reparses each defensively on load
 * (reFilters / parseBookmarks / parseInteractions), so this read path only has
 * to pass the stored shape back through unchanged. `reportFilters` and the
 * page-level `filters` are already declared on ReportContent and need no widen.
 */
type ReportPageRead = ReportContent['pages'][number] & { config?: unknown };
interface ReportContentRead extends Omit<ReportContent, 'pages'> {
  pages: ReportPageRead[];
  bookmarks?: unknown[];
  filterPaneFormat?: unknown;
}

export function reportListEntry(item: WorkspaceItem) {
  return {
    id: `${LOOM_ID_PREFIX}${item.id}`,
    name: item.displayName,
    reportType: 'PowerBIReport' as const,
    __loomContent: true as const,
  };
}

/**
 * Build the report DETAIL payload from a bundle-installed item's ReportContent.
 * Beyond the base `{ report }` identity, this surfaces the wave-2 REPORT-LEVEL
 * state the report designer persists through `.../report/[id]/definition`:
 *   • `reportFilters`     — report-scope structured filters (apply across pages)
 *   • `bookmarks`         — captured page/filter/selection/visibility snapshots
 *   • `filterPaneFormat`  — Filters-pane styling + the deferred-Apply toggle
 * Without these the designer's `loadDetail` reads `j.reportFilters` /
 * `j.bookmarks` as undefined and every report-scope filter, bookmark, and pane
 * format RESETS on reload. Each is emitted only when actually persisted (the PUT
 * route omits empties), so legacy report bundles + the read-only viewer + the
 * PBIR provisioner are unaffected (they ignore the extra keys).
 */
export function reportDetailFromContent(item: WorkspaceItem) {
  const content = contentOf<ReportContentRead>(item, 'report');
  if (!content) return null;
  return {
    report: {
      id: `${LOOM_ID_PREFIX}${item.id}`,
      name: item.displayName,
      reportType: 'PowerBIReport' as const,
    },
    ...(Array.isArray(content.reportFilters) && content.reportFilters.length
      ? { reportFilters: content.reportFilters }
      : {}),
    ...(Array.isArray(content.bookmarks) && content.bookmarks.length
      ? { bookmarks: content.bookmarks }
      : {}),
    ...(content.filterPaneFormat ? { filterPaneFormat: content.filterPaneFormat } : {}),
  };
}

/**
 * Build the report Pages payload from ReportContent. Each bundle page becomes
 * a page entry; the visuals are surfaced via `displayName` enrichment so the
 * editor's Pages panel shows the page name and a visual count. The editor reads
 * `pages[].name` / `pages[].displayName`.
 *
 * Each page also surfaces its wave-2 PAGE-SCOPED state the designer persists via
 * `.../report/[id]/definition`:
 *   • `filters` — page-scope structured filters (apply to every visual on it)
 *   • `config`  — canvas config: type/size/background/hidden + the visual-
 *                 interactions matrix + the drillthrough/tooltip TARGET binding
 * Without these the designer's `loadDetail` reads `p.filters` / `p.config` as
 * undefined and the page background, canvas type, hidden flag, interactions
 * matrix, and drillthrough/tooltip targets all RESET on reload. Both are emitted
 * only when persisted (the PUT route omits empties); the read-only viewer and
 * the PBIR provisioner ignore the extra keys, so legacy bundles are unaffected.
 */
export function reportPagesFromContent(item: WorkspaceItem) {
  const content = contentOf<ReportContentRead>(item, 'report');
  if (!content) return null;
  return (content.pages || []).map((p, i) => ({
    name: `loom-page-${i + 1}`,
    displayName: p.name,
    order: i,
    ...(Array.isArray(p.filters) && p.filters.length ? { filters: p.filters } : {}),
    ...(p.config ? { config: p.config } : {}),
    visuals: (p.visuals || []).map((v) => ({
      type: v.type,
      title: v.title,
      field: v.field,
      config: v.config,
    })),
  }));
}

// ── Scorecard ─────────────────────────────────────────────────────────────

export function scorecardListEntry(item: WorkspaceItem) {
  return {
    id: `${LOOM_ID_PREFIX}${item.id}`,
    displayName: item.displayName,
    description: item.description,
    __loomContent: true as const,
  };
}

/**
 * Build scorecard goals from ScorecardContent OKRs, applying the rollup +
 * status-rule engine. The editor's Goals table reads `{ id, name, description,
 * currentValue, computedValue, targetValue, status, ... }`. Parent goals carry
 * a rolled-up `computedValue`; every goal carries a resolved `status`.
 */
export function scorecardGoalsFromContent(item: WorkspaceItem): ComputedGoal[] | null {
  const content = contentOf<ScorecardContent>(item, 'scorecard');
  if (!content) return null;
  const okrs = content.okrs || [];
  const computed = computeRollups(okrs);
  // Re-attach extended fields the bundle can author inline (owner/dueDate/
  // subGoalIds/status) that the rollup engine drops; the editor's Goals table
  // expects them alongside the computed status/value.
  const byId = new Map(okrs.map((o) => [o.id, o]));
  return computed.map((g) => {
    const src = byId.get(g.id);
    if (!src) return g;
    return {
      ...g,
      // Prefer the rollup engine's resolved status; fall back to bundle-authored
      // status when the engine couldn't resolve one (e.g. no rules + no value).
      status: g.status ?? (src.status as any),
      owner: src.owner,
      dueDate: src.dueDate,
      subGoalIds: src.subGoalIds,
    } as ComputedGoal & { owner?: string; dueDate?: string; subGoalIds?: string[] };
  });
}

export function scorecardMetaFromContent(item: WorkspaceItem) {
  const content = contentOf<ScorecardContent>(item, 'scorecard');
  if (!content) return null;
  return {
    id: `${LOOM_ID_PREFIX}${item.id}`,
    displayName: item.displayName,
    description: item.description,
  };
}
