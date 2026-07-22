// styles.ts — shared makeStyles for the APIM / data-product editors.
// Extracted verbatim from apim-editors.tsx (WS-E1 decomposition).
import { useMemo } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useSharedEditorStyles } from '../shared-styles';

const useLocalStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  form: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingVerticalM, alignItems: 'start' },
  monaco: {
    width: '100%', minHeight: '400px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  specViewer: {
    width: '100%', minHeight: '280px', maxHeight: '480px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    overflow: 'auto', whiteSpace: 'pre',
  },
  card: {
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease, transform 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)' },
  },
  // Elevated section panel — used for the "Create revision" composer so it reads
  // as a polished card rather than a flat bordered box.
  panel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  protocolRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
});

export function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}
