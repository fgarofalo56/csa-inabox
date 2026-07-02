'use client';

/**
 * selection-pane — the Power BI "Selection" pane for the Loom-native Report
 * Designer (report-designer wave 2), mounted as a right-rail tab.
 *
 * Power BI report-authoring parity (ui-parity.md): the Selection pane
 * (learn.microsoft.com/power-bi/create-reports/desktop-bookmarks#selection-pane)
 * lists EVERY object on the active page and lets the author (a) toggle each
 * object's visibility with an eye/eye-off control, (b) reorder its z-order /
 * paint order by dragging it up or down the list (top of the list = front-most),
 * and (c) GROUP objects together / UNGROUP them. Crucially, "When you add a
 * bookmark, the visibility status of each object is also saved" — so the
 * Bookmarks pane reads its captured visibility straight from the visual.hidden
 * state this pane authors. This file is the one-for-one Loom build of that
 * surface:
 *   - {@link SelectionPane} renders the active page's visuals as an ordered list
 *     (front-most first), each row carrying a drag-handle (z-order), a type Badge
 *     + title (click selects the visual on the canvas), an eye/eye-off toggle,
 *     and a multi-select checkbox, plus a sticky Group / Ungroup toolbar; and
 *   - the pure helpers {@link reorderZ} / {@link nextZ} / {@link orderByZ} carry
 *     the z-order math with no React/fetch so the host (and unit tests) can reuse
 *     them when packing a newly-added visual or applying a reorder.
 *
 * Rules compliance:
 *  - no-vaporware.md: there are no dead controls. The eye toggle REALLY hides the
 *    visual — the host reads `v.hidden` in its canvas render map (a hidden visual
 *    is not painted) and persists it on `visual.config.hidden`. The drag-handle
 *    REALLY reorders paint order — the host applies the emitted z-map as a CSS
 *    z-index on each card and persists it on `visual.config.layout.z`. Group /
 *    Ungroup REALLY stamp `visual.config.groupId`. Every mutation rides the
 *    existing PUT /api/items/report/[id]/definition (additive keys only — the
 *    read-only viewer / PBIR provisioner ignore the unknown shapes). When the
 *    page has no visuals the pane shows an honest EmptyState gate, not disabled
 *    buttons.
 *  - no-freeform-config.md: every control is structured — an eye ToggleButton, a
 *    Checkbox, a drag-handle, and Group/Ungroup Buttons. There is no typed
 *    expression / JSON anywhere; z-order is a structured ordering, grouping is a
 *    structured set of ids.
 *  - no-fabric-dependency.md: Azure-native by construction. This is plain page
 *    state over the Azure-native report path; nothing here reaches a Fabric /
 *    Power BI workspace.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex);
 *    the list + sticky toolbar chrome matches the sibling interactions.tsx pane.
 *
 * The model is structural — it identifies visuals by id only — so this file does
 * NOT import the designer's private DVisual/DPage types. {@link SelectionVisualRef}
 * is the minimal shape the host satisfies (a DVisual's id/type/title plus the
 * additive wave-2 `hidden` / `z` / `groupId`). The pure helpers carry no React
 * and may be imported by any client surface (e.g. the Bookmarks pane, to capture
 * the visibility status this pane controls).
 */

import { useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import {
  Badge, Button, Caption1, Checkbox, Divider, Text, ToggleButton, Tooltip,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  ReOrderDotsVertical20Regular, Eye16Regular, EyeOff16Regular, Layer20Regular, LayerRegular,
  Group20Regular, GroupDismiss20Regular, ChevronDown16Regular, ChevronRight16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

// ── Model (structural — a designer DVisual satisfies this) ───────────────────

/**
 * The minimal structural shape of a page visual the Selection pane reads/writes.
 * `hidden` / `z` / `groupId` are the additive wave-2 keys persisted on
 * `visual.config.hidden`, `visual.config.layout.z`, and `visual.config.groupId`
 * respectively; a host whose visual predates them simply omits them (they
 * default to visible / z-0 / ungrouped).
 */
export interface SelectionVisualRef {
  /** Stable visual id (matches the designer's DVisual.id). */
  id: string;
  /** Visual type (bar/column/table/card/slicer/map/…); drives the type Badge. */
  type: string;
  /** Optional display title for the row (falls back to the type label). */
  title?: string;
  /** True when the visual is hidden on the canvas (Selection pane eye-toggle). */
  hidden?: boolean;
  /** Paint order: higher z renders in front (top of the Selection list). */
  z?: number;
  /** Group membership — visuals sharing a groupId render nested under a header. */
  groupId?: string;
}

// ── z-order helpers (pure — exported for the host + unit tests) ───────────────

/** Coerce a (possibly missing/invalid) z into a finite number, defaulting to 0. */
function zOf(v: SelectionVisualRef): number {
  const n = Number(v.z);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Order visuals front-most first (highest z at the top of the list, matching the
 * PBI Selection pane). Ties / missing z fall back to the input array order, so a
 * page whose visuals carry no explicit z renders in canvas order. Pure.
 */
export function orderByZ(visuals: SelectionVisualRef[]): SelectionVisualRef[] {
  return (visuals || [])
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const za = zOf(a.v);
      const zb = zOf(b.v);
      if (za !== zb) return zb - za; // higher z first (front-most on top)
      return a.i - b.i; // stable fallback → original order
    })
    .map((x) => x.v);
}

/** Assign descending z to an ordered list (top → highest); returns id → z. */
function zMap(ordered: SelectionVisualRef[]): Record<string, number> {
  const out: Record<string, number> = {};
  const n = ordered.length;
  ordered.forEach((v, i) => { out[v.id] = n - 1 - i; });
  return out;
}

/**
 * Compute the new z-mapping after moving `draggedId` to just before/after
 * `targetId` in the front-most-first display order. Returns a full `id → z` map
 * (the host stamps each onto `visual.config.layout.z`). A no-op move returns the
 * normalized mapping of the current order. Pure — never mutates `visuals`.
 */
export function reorderZ(
  visuals: SelectionVisualRef[],
  draggedId: string,
  targetId: string,
  side: 'before' | 'after',
): Record<string, number> {
  const ordered = orderByZ(visuals);
  const from = ordered.findIndex((v) => v.id === draggedId);
  if (from < 0 || draggedId === targetId) return zMap(ordered);
  const next = ordered.slice();
  const [moved] = next.splice(from, 1);
  let to = next.findIndex((v) => v.id === targetId);
  if (to < 0) return zMap(ordered);
  if (side === 'after') to += 1;
  next.splice(to, 0, moved);
  return zMap(next);
}

/**
 * The z to stamp on a NEWLY-ADDED visual so it lands front-most (on top of the
 * existing stack) — the PBI default for a freshly-dropped visual. Returns 0 for
 * an empty page. Pure.
 */
export function nextZ(visuals: SelectionVisualRef[]): number {
  const list = visuals || [];
  if (list.length === 0) return 0;
  return Math.max(...list.map(zOf)) + 1;
}

/** True when every visual in `members` is hidden (drives the group eye icon). */
function allHidden(members: SelectionVisualRef[]): boolean {
  return members.length > 0 && members.every((m) => !!m.hidden);
}

// ── styles (Fluent v9 + Loom tokens; matches interactions.tsx chrome) ────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  headRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  spacer: { flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  toolbar: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow2,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalXS,
    boxShadow: tokens.shadow2,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXXS,
    paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium,
    border: '1px solid transparent',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowSel: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke2}`,
  },
  rowDropBefore: { boxShadow: `inset 0 2px 0 0 ${tokens.colorBrandStroke1}` },
  rowDropAfter: { boxShadow: `inset 0 -2px 0 0 ${tokens.colorBrandStroke1}` },
  rowIndent: { marginLeft: tokens.spacingHorizontalL },
  grip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForeground3,
    cursor: 'grab',
    borderRadius: tokens.borderRadiusSmall,
    ':hover': { color: tokens.colorNeutralForeground2 },
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleHidden: { color: tokens.colorNeutralForeground4, textDecorationLine: 'line-through' },
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXXS,
    paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
  },
  groupTitle: { flex: 1, minWidth: 0, color: tokens.colorNeutralForeground2 },
  iconBtn: { minWidth: 'auto' },
});

type Styles = ReturnType<typeof useStyles>;

// ── DnD wiring (distinct mime so it never collides with the canvas/fields DnD) ─

/** Distinct DnD payload type for Selection-pane z-order rows. */
const SEL_DND_MIME = 'application/x-loom-selrow';

/** True when a drag event is a Selection-row z-order drag (not a chip/visual drag). */
function isSelRowDrag(e: ReactDragEvent<HTMLElement>): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) if (types[i] === SEL_DND_MIME) return true;
  return false;
}

/** Insert before/after based on the pointer's vertical position over a row. */
function sideFromEvent(e: ReactDragEvent<HTMLElement>): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
}

// ── one visual row (drag-handle + type Badge + title + eye + checkbox) ────────

function VisualRow({
  styles, v, indented, selected, checked, dropSide, label,
  onSelect, onToggleVisible, onToggleChecked,
  onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onMoveZ,
}: {
  styles: Styles;
  v: SelectionVisualRef;
  indented: boolean;
  selected: boolean;
  checked: boolean;
  dropSide: 'before' | 'after' | null;
  label: string;
  onSelect: () => void;
  onToggleVisible: () => void;
  onToggleChecked: (next: boolean) => void;
  onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  onMoveZ: (dir: -1 | 1) => void;
}): ReactElement {
  const onGripKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); onMoveZ(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); onMoveZ(1); }
  };
  return (
    <div
      role="listitem"
      className={mergeClasses(
        styles.row,
        indented && styles.rowIndent,
        selected && styles.rowSel,
        dropSide === 'before' && styles.rowDropBefore,
        dropSide === 'after' && styles.rowDropAfter,
      )}
      onClick={onSelect}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Tooltip content="Drag to change layer order (or use Up/Down arrows)" relationship="label" withArrow>
        <span
          className={styles.grip}
          role="button"
          tabIndex={0}
          aria-label={`Reorder ${label}`}
          draggable
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onGripKey}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <ReOrderDotsVertical20Regular />
        </span>
      </Tooltip>

      <Badge appearance="tint" size="small">{v.type}</Badge>

      <Text className={mergeClasses(styles.title, v.hidden && styles.titleHidden)} weight={selected ? 'semibold' : 'regular'}>
        {label}
      </Text>

      <Tooltip content={v.hidden ? 'Show this visual' : 'Hide this visual'} relationship="label" withArrow>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={!v.hidden}
          aria-label={v.hidden ? `Show ${label}` : `Hide ${label}`}
          icon={v.hidden ? <EyeOff16Regular /> : <Eye16Regular />}
          className={styles.iconBtn}
          onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
        />
      </Tooltip>

      <Checkbox
        aria-label={`Select ${label}`}
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={(_e, d) => onToggleChecked(d.checked === true)}
      />
    </div>
  );
}

// ── SelectionPane ─────────────────────────────────────────────────────────────

export interface SelectionPaneProps {
  /** Every visual on the active page (structural; the host maps DVisual → this). */
  visuals: SelectionVisualRef[];
  /** The canvas's currently-selected visual (highlighted + drives Ungroup). */
  selectedId?: string | null;
  /** Flip a visual's visibility — the host writes `visual.config.hidden = hidden`. */
  onToggleVisible: (id: string, hidden: boolean) => void;
  /** Apply a new z-mapping — the host stamps each `visual.config.layout.z`. */
  onReorderZ: (zById: Record<string, number>) => void;
  /** Select a visual on the canvas (row / title click). */
  onSelect: (id: string) => void;
  /** Group the given visuals under a fresh groupId (the host mints the id). */
  onGroup: (ids: string[]) => void;
  /** Ungroup — clear `visual.config.groupId` for every member of the group. */
  onUngroup: (groupId: string) => void;
}

/**
 * The Selection pane. Controlled + fully structured: it renders the active page's
 * visuals front-most-first, lets the author toggle visibility (eye), reorder
 * z-order (drag-handle / Up-Down arrows), and Group / Ungroup multi-selected
 * rows. Grouped visuals render nested under a collapsible group header. Degrades
 * to a styled EmptyState gate when the page has no visuals (no-vaporware: not
 * disabled controls).
 */
export function SelectionPane({
  visuals, selectedId, onToggleVisible, onReorderZ, onSelect, onGroup, onUngroup,
}: SelectionPaneProps): ReactElement {
  const styles = useStyles();

  // Local UI state: multi-select checkboxes, collapsed groups, and the live drag.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null);

  const ordered = useMemo(() => orderByZ(visuals), [visuals]);
  const labelFor = (v: SelectionVisualRef) => (v.title && v.title.trim()) || v.type;

  // Only checks for visuals that still exist count toward Group/Ungroup.
  const liveChecked = useMemo(
    () => ordered.filter((v) => checked.has(v.id)),
    [ordered, checked],
  );

  const selectedVisual = useMemo(
    () => ordered.find((v) => v.id === selectedId) || null,
    [ordered, selectedId],
  );

  // Distinct groupIds present (for stable "Group N" labels in display order).
  const groupOrdinal = useMemo(() => {
    const map = new Map<string, number>();
    let n = 0;
    for (const v of ordered) if (v.groupId && !map.has(v.groupId)) map.set(v.groupId, (n += 1));
    return map;
  }, [ordered]);

  // Honest gate — a page with no visuals.
  if (ordered.length === 0) {
    return (
      <EmptyState
        icon={<LayerRegular />}
        title="No objects on this page yet"
        body="The Selection pane lists every visual on the active page so you can show or hide it, change its layer order, and group objects together. Add a visual to the page to manage it here."
      />
    );
  }

  const toggleChecked = (id: string, next: boolean) =>
    setChecked((prev) => {
      const out = new Set(prev);
      if (next) out.add(id); else out.delete(id);
      return out;
    });

  const clearChecked = () => setChecked(new Set());

  const toggleCollapsed = (gid: string) =>
    setCollapsed((prev) => {
      const out = new Set(prev);
      if (out.has(gid)) out.delete(gid); else out.add(gid);
      return out;
    });

  // ── z-order drag handlers (per row) ─────────────────────────────────────────
  const startDrag = (id: string) => (e: ReactDragEvent<HTMLElement>) => {
    e.stopPropagation();
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(SEL_DND_MIME, id);
      e.dataTransfer.setData('text/plain', id);
    } catch { /* best-effort */ }
    setDragId(id);
  };
  const endDrag = () => { setDragId(null); setDropTarget(null); };
  const overRow = (id: string) => (e: ReactDragEvent<HTMLElement>) => {
    if (!isSelRowDrag(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
    const side = sideFromEvent(e);
    setDropTarget((prev) => (prev && prev.id === id && prev.side === side ? prev : { id, side }));
  };
  const leaveRow = (id: string) => (e: ReactDragEvent<HTMLElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDropTarget((prev) => (prev && prev.id === id ? null : prev));
  };
  const dropRow = (id: string) => (e: ReactDragEvent<HTMLElement>) => {
    if (!isSelRowDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const dragged = e.dataTransfer.getData(SEL_DND_MIME) || e.dataTransfer.getData('text/plain');
    const side = sideFromEvent(e);
    setDropTarget(null);
    setDragId(null);
    if (!dragged || dragged === id) return;
    onReorderZ(reorderZ(visuals, dragged, id, side));
  };

  // Keyboard reorder from the grip: move one slot up (front) / down (back).
  const moveZ = (id: string, dir: -1 | 1) => {
    const idx = ordered.findIndex((v) => v.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= ordered.length) return;
    onReorderZ(reorderZ(visuals, id, ordered[to].id, dir < 0 ? 'before' : 'after'));
  };

  // ── Group / Ungroup toolbar enablement ──────────────────────────────────────
  const canGroup = liveChecked.length >= 2;
  // Distinct groups touched by the selection (selected visual + checked rows).
  const groupsToUngroup = useMemo(() => {
    const ids = new Set<string>();
    if (selectedVisual?.groupId) ids.add(selectedVisual.groupId);
    for (const v of liveChecked) if (v.groupId) ids.add(v.groupId);
    return [...ids];
  }, [selectedVisual, liveChecked]);
  const canUngroup = groupsToUngroup.length > 0;

  const doGroup = () => {
    if (!canGroup) return;
    onGroup(liveChecked.map((v) => v.id));
    clearChecked();
  };
  const doUngroup = () => {
    if (!canUngroup) return;
    for (const gid of groupsToUngroup) onUngroup(gid);
    clearChecked();
  };

  // ── render the list, clustering grouped visuals under a header ───────────────
  const rows: ReactElement[] = [];
  const seenGroups = new Set<string>();
  for (const v of ordered) {
    const dropSide = dropTarget && dropTarget.id === v.id ? dropTarget.side : null;
    if (v.groupId) {
      if (seenGroups.has(v.groupId)) continue;
      seenGroups.add(v.groupId);
      const gid = v.groupId;
      const members = ordered.filter((m) => m.groupId === gid);
      const isCollapsed = collapsed.has(gid);
      const groupHidden = allHidden(members);
      rows.push(
        <div key={`g-${gid}`} className={styles.groupHead} onClick={() => toggleCollapsed(gid)}>
          <Button
            size="small"
            appearance="subtle"
            className={styles.iconBtn}
            aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}
            icon={isCollapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
            onClick={(e) => { e.stopPropagation(); toggleCollapsed(gid); }}
          />
          <Layer20Regular />
          <Text className={styles.groupTitle} weight="semibold">
            Group {groupOrdinal.get(gid) ?? ''}
          </Text>
          <Badge appearance="tint" size="small">{members.length}</Badge>
          <Tooltip content={groupHidden ? 'Show group' : 'Hide group'} relationship="label" withArrow>
            <ToggleButton
              size="small"
              appearance="subtle"
              checked={!groupHidden}
              aria-label={groupHidden ? 'Show group' : 'Hide group'}
              icon={groupHidden ? <EyeOff16Regular /> : <Eye16Regular />}
              className={styles.iconBtn}
              onClick={(e) => { e.stopPropagation(); members.forEach((m) => onToggleVisible(m.id, !groupHidden)); }}
            />
          </Tooltip>
          <Tooltip content="Ungroup" relationship="label" withArrow>
            <Button
              size="small"
              appearance="subtle"
              className={styles.iconBtn}
              aria-label="Ungroup"
              icon={<GroupDismiss20Regular />}
              onClick={(e) => { e.stopPropagation(); onUngroup(gid); }}
            />
          </Tooltip>
        </div>,
      );
      if (!isCollapsed) {
        for (const m of members) {
          const mSide = dropTarget && dropTarget.id === m.id ? dropTarget.side : null;
          rows.push(
            <VisualRow
              key={m.id}
              styles={styles}
              v={m}
              indented
              selected={selectedId === m.id}
              checked={checked.has(m.id)}
              dropSide={mSide}
              label={labelFor(m)}
              onSelect={() => onSelect(m.id)}
              onToggleVisible={() => onToggleVisible(m.id, !m.hidden)}
              onToggleChecked={(next) => toggleChecked(m.id, next)}
              onDragStart={startDrag(m.id)}
              onDragEnd={endDrag}
              onDragOver={overRow(m.id)}
              onDragLeave={leaveRow(m.id)}
              onDrop={dropRow(m.id)}
              onMoveZ={(dir) => moveZ(m.id, dir)}
            />,
          );
        }
      }
    } else {
      rows.push(
        <VisualRow
          key={v.id}
          styles={styles}
          v={v}
          indented={false}
          selected={selectedId === v.id}
          checked={checked.has(v.id)}
          dropSide={dropSide}
          label={labelFor(v)}
          onSelect={() => onSelect(v.id)}
          onToggleVisible={() => onToggleVisible(v.id, !v.hidden)}
          onToggleChecked={(next) => toggleChecked(v.id, next)}
          onDragStart={startDrag(v.id)}
          onDragEnd={endDrag}
          onDragOver={overRow(v.id)}
          onDragLeave={leaveRow(v.id)}
          onDrop={dropRow(v.id)}
          onMoveZ={(dir) => moveZ(v.id, dir)}
        />,
      );
    }
  }

  return (
    <div className={styles.pane}>
      <div className={styles.headRow}>
        <Layer20Regular />
        <Caption1><strong>Selection</strong></Caption1>
        <div className={styles.spacer} />
        <Caption1 className={styles.hint}>{ordered.length} object{ordered.length === 1 ? '' : 's'}</Caption1>
      </div>

      <Caption1 className={styles.hint}>
        Show or hide each visual, drag the handle to change layer order (top of the list is front-most), and
        group objects to manage them together. Bookmarks capture this visibility.
      </Caption1>

      <div className={styles.toolbar} role="toolbar" aria-label="Selection actions">
        <Tooltip content="Group the selected visuals" relationship="label" withArrow>
          <Button
            size="small"
            appearance="subtle"
            icon={<Group20Regular />}
            disabled={!canGroup}
            onClick={doGroup}
          >
            Group
          </Button>
        </Tooltip>
        <Tooltip content="Ungroup the selected group" relationship="label" withArrow>
          <Button
            size="small"
            appearance="subtle"
            icon={<GroupDismiss20Regular />}
            disabled={!canUngroup}
            onClick={doUngroup}
          >
            Ungroup
          </Button>
        </Tooltip>
        <div className={styles.spacer} />
        {liveChecked.length > 0 && (
          <Caption1 className={styles.hint}>{liveChecked.length} checked</Caption1>
        )}
      </div>

      <Divider />

      <div className={styles.list} role="list" aria-label="Page objects, front to back">
        {rows}
      </div>
    </div>
  );
}

export default SelectionPane;
