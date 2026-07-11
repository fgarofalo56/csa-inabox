'use client';

/**
 * RunProgress — real-time Spark job progress under a running cell (R4-NB-4 /
 * Fabric notebook C10). Consumes the `progress` object the run-poll response
 * carries (shared with R4-SYN-5's poll surface). Until that server-side
 * progress lands on main, the poll returns no `progress` field and this
 * component renders an HONEST indeterminate bar keyed to the run phase +
 * elapsed seconds — never a fabricated percentage.
 *
 * When the poll DOES carry progress, it shows a determinate bar plus real
 * stage/task counts and a "Open Spark UI" drill link (Livy appInfo → Spark
 * History Server). No mocks; all values come straight from the poll response.
 */

import { ProgressBar, Caption1, Button, tokens, makeStyles } from '@fluentui/react-components';
import { Open16Regular, Flash16Regular } from '@fluentui/react-icons';

/**
 * Progress shape surfaced by the run-poll route. Every field is optional so the
 * bar degrades gracefully as the shared server surface (R4-SYN-5) fills it in.
 */
export interface SparkRunProgress {
  /** Overall completion 0..100 (derived server-side from completed/total tasks). */
  percent?: number;
  activeStages?: number;
  completedStages?: number;
  totalStages?: number;
  completedTasks?: number;
  totalTasks?: number;
  /** Spark UI / History Server deep link (Livy session appInfo). */
  sparkUiUrl?: string;
  /** Free-text phase from the poll (e.g. "session-starting", "cell 2/5 running"). */
  phase?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  label: { color: tokens.colorNeutralForeground2, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  counts: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
});

interface Props {
  /** Progress payload from the poll; undefined until the server surface lands. */
  progress?: SparkRunProgress;
  /** Human phase label to show while progress is indeterminate. */
  phase?: string;
  /** Seconds the run has been in flight (drives the honest waiting label). */
  elapsedSec?: number;
}

export function RunProgress({ progress, phase, elapsedSec }: Props) {
  const s = useStyles();
  const pct = typeof progress?.percent === 'number' && Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, progress.percent))
    : undefined;
  const phaseLabel = progress?.phase || phase || 'Running';
  const hasTasks = typeof progress?.totalTasks === 'number' && progress.totalTasks > 0;
  const hasStages = typeof progress?.totalStages === 'number' && progress.totalStages > 0;

  return (
    <div className={s.root} role="status" aria-live="polite">
      <div className={s.head}>
        <Flash16Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Caption1 className={s.label}>
          {phaseLabel}
          {pct !== undefined ? ` · ${Math.round(pct)}%` : elapsedSec !== undefined ? ` · ${elapsedSec}s` : ''}
        </Caption1>
        {hasStages && (
          <Caption1 className={s.counts}>
            {progress!.completedStages ?? 0}/{progress!.totalStages} stages
          </Caption1>
        )}
        {hasTasks && (
          <Caption1 className={s.counts}>
            {progress!.completedTasks ?? 0}/{progress!.totalTasks} tasks
          </Caption1>
        )}
        {progress?.sparkUiUrl && (
          <Button
            size="small"
            appearance="transparent"
            icon={<Open16Regular />}
            onClick={() => window.open(progress.sparkUiUrl, '_blank', 'noopener')}
          >
            Spark UI
          </Button>
        )}
      </div>
      {/* Determinate when the server reports a percent; otherwise an honest
          indeterminate bar (thickness animates) — never a fake number. */}
      <ProgressBar value={pct !== undefined ? pct / 100 : undefined} thickness="large" />
    </div>
  );
}
