// styles.ts — makeStyles blocks local to the semantic-model editor.
// Extracted byte-for-byte from ../semantic-model-editor.tsx (pure move).
// No JSX; no 'use client' needed (makeStyles is build-time).

import { makeStyles, tokens } from '@fluentui/react-components';

// Visual-fidelity styles local to the semantic-model editor: type-badged field
// icons, hover row-highlight + hover-reveal row actions, and a consistent
// icon + label pane header. makeStyles (Loom tokens only, theme-aware).
export const useSmVisualStyles = makeStyles({
  // Icon slot preceding a field/column name — neutral tint, never shrinks.
  typeIcon: {
    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  // Measures are the model's calculated logic — brand-tint to set them apart
  // from plain columns, exactly like the Power BI fields pane fx glyph.
  measureIcon: {
    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    color: tokens.colorBrandForeground1,
  },
  // Field/column name row: icon + name with consistent XS rhythm.
  fieldName: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // Grid row: hover highlight + hover/focus-reveal of the trailing action cluster.
  gridRow: {
    '&:hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    '& .sm-row-actions': {
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: tokens.durationFaster,
    },
    '&:hover .sm-row-actions, &:focus-within .sm-row-actions': { opacity: 1 },
  },
  // Consistent pane header — Fluent icon + semibold label, brand-tinted glyph.
  paneHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalXS,
    '& svg': { color: tokens.colorBrandForeground1, flexShrink: 0 },
  },
});

export const useCopilotPaneStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  actionRow: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  planCard: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
  },
  opList: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  opRow: {
    display: 'flex',
    alignItems: 'flex-start',
    columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  opText: { flex: 1, minWidth: 0, lineHeight: tokens.lineHeightBase300 },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalS,
  },
  cpList: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
  },
  cpRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'background-color, border-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    },
  },
  cpMeta: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, minWidth: 0 },
  cpLabelRow: { display: 'flex', columnGap: tokens.spacingHorizontalXS, alignItems: 'center' },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
  },
});

export const usePrepForAiStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL },
  section: {
    display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
  },
  sectionHead: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  headText: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, flex: 1, minWidth: 0 },
  actionRow: { display: 'flex', columnGap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  schemaTable: {
    display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS,
    maxHeight: '360px', overflowY: 'auto',
  },
  tableRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2,
  },
  colRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalXXL, paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
  },
  answerCard: {
    display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1,
  },
  answerHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', rowGap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3, textAlign: 'center',
    borderRadius: tokens.borderRadiusMedium, border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
  },
});
