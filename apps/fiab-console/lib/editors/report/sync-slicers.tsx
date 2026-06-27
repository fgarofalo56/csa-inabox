'use client';

/**
 * Sync-slicers pane (Power BI "Sync slicers"): author per-slicer-field SYNC
 * GROUPS and, per page, whether the slicer is VISIBLE and whether its selection
 * is SYNCED to peer pages. The host (report-designer) lifts slicer selection to
 * a report-level `syncGroups` map; when a synced slicer changes on one page the
 * host applies the same selection to every other page that has the slicer
 * SYNCED — through the SAME `applyFilters` page-filters channel the slicer
 * already writes (no new query path). Persisted ADDITIVELY on
 * `state.content.syncSlicers` via /definition (whitelisted like bookmarks /
 * filterPaneFormat) — purely client-driven, back-compatible.
 *
 * Rules: no-vaporware (the matrix really drives cross-page propagation, no dead
 * toggles), no-freeform-config (a structured page×{visible,synced} matrix — no
 * typed config), web3-ui (Fluent v9 + Loom tokens), no-fabric-dependency
 * (selection lives in Loom report state — no Power BI sync-slicer service).
 */

import { useMemo } from 'react';
import {
  makeStyles, tokens, Caption1, Subtitle2, Switch, Badge, Divider, Text,
} from '@fluentui/react-components';
import { Table20Regular } from '@fluentui/react-icons';

// ── model ─────────────────────────────────────────────────────────────────────

/** One page's participation in a sync group: shown on the page + selection synced. */
export interface SyncMember {
  pageId: string;
  visible: boolean;
  synced: boolean;
}

/**
 * A sync group keyed by a slicer FIELD (table.column or measure key — the SAME
 * `fieldKey` the host derives for a slicer's bound field). Every page that hosts
 * a slicer over that field appears as a member; `synced` members share one
 * selection across pages.
 */
export interface SyncGroup {
  id: string;
  fieldKey: string;
  members: SyncMember[];
}

/** A page reference the matrix renders a column for. */
export interface SyncPageRef { id: string; name: string }
/** A slicer field present in the report (the row axis of the matrix). */
export interface SyncFieldRef { key: string; label: string; pageIds: string[] }

// ── parse / wire (mirror the /definition sanitizer) ────────────────────────────

/** Hydrate persisted `content.syncSlicers` into the in-memory groups (defensive). */
export function parseSyncGroups(raw: unknown): SyncGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: SyncGroup[] = [];
  for (const r of raw) {
    const o = (r || {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const fieldKey = typeof o.fieldKey === 'string' ? o.fieldKey : '';
    if (!id || !fieldKey) continue;
    const members: SyncMember[] = Array.isArray(o.members)
      ? o.members
          .map((m): SyncMember | null => {
            const mo = (m || {}) as Record<string, unknown>;
            const pageId = typeof mo.pageId === 'string' ? mo.pageId : '';
            if (!pageId) return null;
            return { pageId, visible: mo.visible !== false, synced: mo.synced === true };
          })
          .filter((x): x is SyncMember => !!x)
      : [];
    out.push({ id, fieldKey, members });
  }
  return out;
}

/** The wire shape for /definition (already the persisted shape — pass-through). */
export function wireSyncGroups(groups: SyncGroup[]): SyncGroup[] {
  return groups.filter((g) => g.fieldKey && g.members.length);
}

/**
 * Resolve the synced peer pages for a field on a given source page: the page ids
 * that are members of the field's group AND marked `synced` (excluding the
 * source page). The host applies the source slicer's selection to each. Returns
 * [] when the field has no sync group or the source page isn't synced — so a
 * non-synced slicer behaves exactly as before (page-scoped only).
 */
export function syncedPeerPages(groups: SyncGroup[], fieldKey: string, sourcePageId: string): string[] {
  const g = groups.find((x) => x.fieldKey === fieldKey);
  if (!g) return [];
  const src = g.members.find((m) => m.pageId === sourcePageId);
  if (!src || !src.synced) return [];
  return g.members.filter((m) => m.synced && m.pageId !== sourcePageId).map((m) => m.pageId);
}

// ── styles ─────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalM, minHeight: 0 },
  group: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  groupHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  matrixHead: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  row: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: tokens.spacingHorizontalS, alignItems: 'center', paddingBlock: tokens.spacingVerticalXXS },
  pageName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colHead: { width: '64px', textAlign: 'center', color: tokens.colorNeutralForeground3 },
  muted: { color: tokens.colorNeutralForeground3 },
});

// ── pane ────────────────────────────────────────────────────────────────────────

/**
 * The Sync-slicers authoring pane. For each slicer field in the report it draws
 * a page×{Visible,Synced} matrix. Toggling a cell mutates the report-level
 * `groups` (creating the group on first toggle), which the host persists + uses
 * to propagate synced selections. Every toggle is live — no dead control.
 */
export function SyncSlicersPane({ pages, fields, groups, onChange }: {
  pages: SyncPageRef[];
  fields: SyncFieldRef[];
  groups: SyncGroup[];
  onChange: (groups: SyncGroup[]) => void;
}) {
  const styles = useStyles();
  const byField = useMemo(() => {
    const m = new Map<string, SyncGroup>();
    for (const g of groups) m.set(g.fieldKey, g);
    return m;
  }, [groups]);

  const memberOf = (fieldKey: string, pageId: string): SyncMember => {
    const g = byField.get(fieldKey);
    const found = g?.members.find((x) => x.pageId === pageId);
    return found ?? { pageId, visible: true, synced: false };
  };

  const setCell = (fieldKey: string, pageId: string, patch: Partial<SyncMember>) => {
    const next = groups.slice();
    let g = next.find((x) => x.fieldKey === fieldKey);
    if (!g) {
      g = { id: `sync_${fieldKey.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}`, fieldKey, members: [] };
      next.push(g);
    }
    const members = g.members.slice();
    const mi = members.findIndex((m) => m.pageId === pageId);
    const base = mi >= 0 ? members[mi] : { pageId, visible: true, synced: false };
    const merged = { ...base, ...patch };
    if (mi >= 0) members[mi] = merged; else members.push(merged);
    g.members = members;
    onChange(next.map((x) => (x.fieldKey === fieldKey ? { ...g! } : x)));
  };

  if (fields.length === 0) {
    return (
      <div className={styles.pane}>
        <Subtitle2>Sync slicers</Subtitle2>
        <Caption1 className={styles.muted}>
          Add a Slicer visual to a page, then return here to sync its selection across pages.
        </Caption1>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <Subtitle2>Sync slicers</Subtitle2>
      <Caption1 className={styles.muted}>
        For each slicer field, choose which pages SHOW it and which SHARE its selection. A synced
        pick on one page applies to every other synced page (Azure-native report state — no Power BI).
      </Caption1>
      {fields.map((f) => (
        <div key={f.key} className={styles.group}>
          <div className={styles.groupHead}>
            <Table20Regular />
            <Text weight="semibold">{f.label}</Text>
            <div style={{ flex: 1 }} />
            <Badge appearance="tint" size="small">
              {byField.get(f.key)?.members.filter((m) => m.synced).length || 0} synced
            </Badge>
          </div>
          <Divider />
          <div className={styles.matrixHead}>
            <span />
            <Caption1 className={styles.colHead}>Visible</Caption1>
            <Caption1 className={styles.colHead}>Synced</Caption1>
          </div>
          {pages.map((p) => {
            const m = memberOf(f.key, p.id);
            return (
              <div key={p.id} className={styles.row}>
                <Text className={styles.pageName} title={p.name}>{p.name}</Text>
                <div className={styles.colHead}>
                  <Switch checked={m.visible} aria-label={`visible on ${p.name}`}
                    onChange={(_e, d) => setCell(f.key, p.id, { visible: !!d.checked })} />
                </div>
                <div className={styles.colHead}>
                  <Switch checked={m.synced} aria-label={`synced on ${p.name}`}
                    onChange={(_e, d) => setCell(f.key, p.id, { synced: !!d.checked })} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
