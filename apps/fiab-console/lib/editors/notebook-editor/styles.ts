// styles.ts — makeStyles blocks for the notebook-editor.
// No JSX; makeStyles is build-time. Combines the shared editor styles with the
// notebook-local styles exactly as the original in-file useStyles() did.

import { useMemo } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useSharedEditorStyles } from '../shared-styles';

const useLocalStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', position: 'relative' },
  // Bottom-align so the label+control groups (Compute backend / Workspace /
  // Compute target / Environment) and the bare action buttons (Refresh / Manage
  // / Import / New) line up on one baseline instead of the buttons floating
  // mid-height — which made the row read as crammed/overlapping. Wider gap +
  // row-gap gives the labels breathing room when the row wraps.
  toolbar: { display: 'flex', columnGap: tokens.spacingHorizontalXL, rowGap: tokens.spacingVerticalM, alignItems: 'flex-end', flexWrap: 'wrap', padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS} ${tokens.spacingVerticalM}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginBottom: tokens.spacingVerticalXS },
  // Slim always-visible bar: Run + selected-compute summary + the Compute &
  // setup disclosure + Copilot. Keeps the notebook header to one compact row
  // when the full config is collapsed (the default) so cells get the space.
  computeBar: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, flexWrap: 'wrap', padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginBottom: tokens.spacingVerticalXS },
  computeSummary: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, color: tokens.colorNeutralForeground2 },
  computeSummaryName: { maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  setupCollapsible: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginBottom: tokens.spacingVerticalXS },
  toolDivider: { alignSelf: 'stretch', minHeight: '36px' },
  editor: {
    width: '100%', minHeight: '280px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  // Notebooks-pane folder tree affordances (reuses the workspace folders engine).
  nbPaneToolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalS, flexWrap: 'wrap' },
  nbDragOver: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px', borderRadius: tokens.borderRadiusSmall },
  nbRootDrop: {
    marginTop: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3, border: `1px dashed ${tokens.colorNeutralStroke2}`, textAlign: 'center',
  },
  nbRootDropActive: {
    border: `1px dashed ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2Hover, color: tokens.colorBrandForeground1,
  },
  tableWrap: { overflow: 'auto', maxHeight: '240px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  // Bottom-left session status badge — overlays the editor surface like the
  // Synapse Studio session indicator (Idle / Running / Error).
  statusBadge: { position: 'absolute', bottom: tokens.spacingVerticalM, left: tokens.spacingHorizontalM, zIndex: 5 },
  // Section header with a leading Fluent icon — gives each sidebar/main
  // section a glyph so they read as part of the same polished product
  // (Web 3.0 rule) instead of bare text labels.
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  // Attach-Lakehouse picker row — a selectable list card. Elevated +
  // rounded so it reads as a tappable card with depth, lifting on hover,
  // instead of a flat bordered box.
  lakehouseCard: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 120ms ease, border-color 120ms ease',
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorBrandStroke1}` },
  },
  // Notebook schedules card (R4-NB-1) — matches the Synapse flavor's schedule card.
  scheduleCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  scheduleHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  cardSpacer: { flex: 1 },
  // "Parameters" chip rendered above a parameters-tagged code cell (R4-NB-2).
  paramBadgeRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXXS },
});

export function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

export type Styles = ReturnType<typeof useStyles>;
