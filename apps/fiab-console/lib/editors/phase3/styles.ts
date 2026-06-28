import { makeStyles, tokens } from '@fluentui/react-components';

export const useStyles = makeStyles({
  monaco: {
    width: '100%',
    minHeight: '180px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toolbar: { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' },
  card: {
    padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1,
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingVerticalM },
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM, minHeight: '180px' },
  resultMeta: { display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  tableWrap: { overflow: 'auto', maxHeight: '320px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  treePad: { padding: tokens.spacingVerticalS },
  assistBar: {
    display: 'flex', gap: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  assistResult: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', margin: 0,
    overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%',
    maxHeight: '320px', overflow: 'auto',
  },
  // Live auto-refresh status pill — mirrors Fabric Real-Time Dashboard's
  // "live" affordance so the user can see the continuous cadence is firing.
  livePill: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  liveDot: {
    width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
    backgroundColor: tokens.colorPaletteGreenForeground1,
  },
  liveDotActive: {
    animationName: {
      '0%':   { opacity: 1,   transform: 'scale(1)' },
      '50%':  { opacity: 0.35, transform: 'scale(0.7)' },
      '100%': { opacity: 1,   transform: 'scale(1)' },
    },
    animationDuration: '1.4s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
  },
});
