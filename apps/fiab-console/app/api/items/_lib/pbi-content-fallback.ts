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

export function reportListEntry(item: WorkspaceItem) {
  return {
    id: `${LOOM_ID_PREFIX}${item.id}`,
    name: item.displayName,
    reportType: 'PowerBIReport' as const,
    __loomContent: true as const,
  };
}

export function reportDetailFromContent(item: WorkspaceItem) {
  const content = contentOf<ReportContent>(item, 'report');
  if (!content) return null;
  return {
    report: {
      id: `${LOOM_ID_PREFIX}${item.id}`,
      name: item.displayName,
      reportType: 'PowerBIReport' as const,
    },
  };
}

/**
 * Build the report Pages payload from ReportContent. Each bundle page becomes
 * a page entry; the visuals are surfaced via `displayName` enrichment so the
 * editor's Pages panel shows the page name and a visual count. The editor reads
 * `pages[].name` / `pages[].displayName`.
 */
export function reportPagesFromContent(item: WorkspaceItem) {
  const content = contentOf<ReportContent>(item, 'report');
  if (!content) return null;
  return (content.pages || []).map((p, i) => ({
    name: `loom-page-${i + 1}`,
    displayName: p.name,
    order: i,
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
 * Build scorecard goals from ScorecardContent OKRs. The editor's Goals table
 * reads `{ id, name, description, currentValue, targetValue }`.
 */
export function scorecardGoalsFromContent(item: WorkspaceItem) {
  const content = contentOf<ScorecardContent>(item, 'scorecard');
  if (!content) return null;
  return (content.okrs || []).map((o) => ({
    id: o.id,
    name: o.name,
    description: o.description || o.metric,
    currentValue: typeof o.current === 'number' ? o.current : Number(o.current) || undefined,
    targetValue: typeof o.target === 'number' ? o.target : Number(o.target) || undefined,
  }));
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
