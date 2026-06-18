'use client';

/**
 * Shared admin-tab style atoms.
 *
 * The ~dozen admin tabs (tenant-settings, usage, updates, security,
 * permissions, domains, sensitivity-labels, …) all re-implemented the same
 * handful of inline styles: a MessageBar bottom-margin, muted captions, a
 * monospace ID cell inside a LoomDataTable column, full-width dialog inputs,
 * badge spacing, and a couple of icon nudges. Centralising them here:
 *   • kills the inconsistent literals (16 / 12 / '16px' / token) that drifted
 *     across tabs,
 *   • keeps every value on a Fluent token so the surfaces theme cleanly across
 *     Commercial / Gov / sovereign clouds,
 *   • removes the per-cell `style={{}}` that LoomColumn has no className for —
 *     the class is applied to the element returned inside `render`.
 *
 * Tabs may still keep their own `useStyles` for tab-specific layout; this hook
 * only provides the cross-tab atoms.
 */

import { makeStyles, tokens } from '@fluentui/react-components';

export const useAdminTabStyles = makeStyles({
  /** Standard gap below a notice/MessageBar. Replaces marginBottom: 16/12/'16px'. */
  messageBar: { marginBottom: tokens.spacingVerticalL },
  /** Muted inline text (captions, secondary copy). */
  muted: { color: tokens.colorNeutralForeground3 },
  /** Body copy inside an explainer/info row — slightly softer than primary. */
  explainerText: { color: tokens.colorNeutralForeground2, lineHeight: 1.5 },
  /** Muted text forced to its own block, with a small top gap. */
  mutedBlock: {
    display: 'block',
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
  },
  /** Monospace ID / target cell rendered inside a LoomColumn.render(). */
  codeCell: { fontSize: '11px' },
  /** Monospace muted caption (e.g. a stable resource id under a title). */
  monoMuted: {
    display: 'block',
    fontFamily: 'monospace',
    color: tokens.colorNeutralForeground3,
  },
  /** Dialog field label above an input. Replaces display:block + marginBottom:4. */
  fieldLabel: {
    display: 'block',
    marginBottom: tokens.spacingVerticalXS,
  },
  /** Full-width form control inside a create/edit dialog. */
  fullWidth: { width: '100%' },
  /** Vertical stack used in create dialogs (label + control rows). */
  dialogGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  /** Leading gap on a Badge that sits after inline text. Replaces marginLeft:8. */
  badgeGap: { marginLeft: tokens.spacingHorizontalS },
  /** Trailing gap on a Badge that sits before more content. Replaces marginRight:4. */
  badgeGapEnd: { marginRight: tokens.spacingHorizontalXS },
  /** Brand info icon that leads an explainer row. */
  infoIcon: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
    marginTop: '2px',
  },
  /** Icon nudged inline with a Section title. */
  headIcon: {
    verticalAlign: 'middle',
    marginRight: tokens.spacingHorizontalS,
  },
  /** Scrollable bordered list box (e.g. selectable workspace rows in a dialog). */
  scrollList: {
    maxHeight: '320px',
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  /** Single-line truncation with an ellipsis (name/description cells). */
  ellipsis: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** Small fixed-size inline icon (e.g. 18px glyph inside a rounded avatar). */
  iconSm: { width: '18px', height: '18px' },
  /** Filter control (Dropdown/SearchBox) with a sensible minimum width. */
  filterControl: { minWidth: '200px' },
  /** Dialog footer action row — right-aligned buttons with a gap. */
  dialogFooter: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    justifyContent: 'flex-end',
  },
  /** Wide create/edit DialogSurface (e.g. attribute-group builder). */
  dialogWide: { maxWidth: '720px', width: '92vw' },
  /** Caption used as a sub-heading inside a dialog (semibold). */
  captionStrong: { fontWeight: tokens.fontWeightSemibold },
  /** Muted text forced onto its own line, with no extra spacing. */
  blockMuted: { display: 'block', color: tokens.colorNeutralForeground3 },
  /** Brand-colored inline label (e.g. a source tag next to an option). */
  brandText: { color: tokens.colorBrandForeground1 },
  /** Tight inline row of icon buttons / chips. */
  rowGapXS: { display: 'flex', gap: tokens.spacingHorizontalXS },
  /**
   * Responsive stat/KPI card grid — `repeat(auto-fill, minmax(200px,1fr))`.
   * Use wherever a row of stat cards needs to reflow on narrow viewports.
   * Each card should use the `cardSection` style or its own padding/border.
   */
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  /**
   * Bordered section separator card — token border-top + paddingTop.
   * Replaces `borderTop: '1px solid …' + paddingTop: 'NNpx'` patterns
   * inside admin tabs and detail panes.
   */
  cardSection: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: tokens.spacingVerticalM,
  },
});
