import { makeStyles, tokens } from '@fluentui/react-components';
import { useMemo } from 'react';
import { useSharedEditorStyles } from '../shared-styles';

/**
 * phase3-specific styles: the Real-Time-Intelligence "live" affordance
 * (auto-refresh status pill + pulsing dot) that mirrors Fabric Real-Time
 * Dashboard. The editor-agnostic primitives now live in `../shared-styles`.
 */
const usePhase3Styles = makeStyles({
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

/**
 * phase3 editor styles = the shared editor primitives + phase3-specific
 * live-affordance styles. Same `useStyles()` call-site API as before (returns a
 * class-name map keyed by `pad`/`toolbar`/`card`/…/`livePill`/`liveDot`/…), so
 * the 14 phase3 importers are unchanged. The merge is memoized on the two
 * (stable) Griffel results, preserving object identity across renders.
 */
export function useStyles() {
  const shared = useSharedEditorStyles();
  const local = usePhase3Styles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}
