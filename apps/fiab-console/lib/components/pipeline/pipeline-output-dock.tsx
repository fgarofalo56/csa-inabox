'use client';

/**
 * PipelineOutputDock — the U13 in-canvas Output dock for the data-pipeline
 * editor: ADF Studio's output strip below the authoring canvas. Docks the
 * SAME OutputPane (Monitor + Debug over the real queryPipelineRuns /
 * queryActivityRuns APIs — one run path, no mocks) under the graph so a
 * Debug run's receipts and the canvas are visible TOGETHER. Height is
 * user-resizable + persisted via the shared ResizableCanvasRegion primitive
 * (pointer + keyboard + ARIA, `loom.canvasHeight.data-pipeline-output-dock`).
 */

import { Button, Caption1, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { Dismiss16Regular, History20Regular, Open16Regular } from '@fluentui/react-icons';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { OutputPane } from './output-pane';
import type { PipelineParameter } from './types';

const useStyles = makeStyles({
  dock: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    overflow: 'hidden',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  spacer: { flex: 1 },
  headIcon: { color: tokens.colorBrandForeground1 },
});

export interface PipelineOutputDockProps {
  workspaceId: string;
  pipelineId: string;
  pipelineParams?: PipelineParameter[];
  paramNames?: string[];
  variableNames?: string[];
  activityNames?: string[];
  /** Jump to the editor's full Output tab. */
  onOpenFullTab: () => void;
  /** Close the dock. */
  onClose: () => void;
}

export function PipelineOutputDock({
  workspaceId, pipelineId, pipelineParams, paramNames, variableNames, activityNames,
  onOpenFullTab, onClose,
}: PipelineOutputDockProps) {
  const s = useStyles();
  return (
    <ResizableCanvasRegion
      storageKey="data-pipeline-output-dock"
      defaultPx={300}
      minPx={240}
      ariaLabel="Resize pipeline output panel"
    >
      <div className={s.dock}>
        <div className={s.head}>
          <History20Regular className={s.headIcon} />
          <Subtitle2>Output</Subtitle2>
          <Caption1 className={s.hint}>Debug + run history for this pipeline</Caption1>
          <span className={s.spacer} />
          <Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={onOpenFullTab}>
            Open full tab
          </Button>
          <Button
            size="small" appearance="subtle" icon={<Dismiss16Regular />}
            aria-label="Close output panel" onClick={onClose}
          />
        </div>
        <OutputPane
          workspaceId={workspaceId}
          pipelineId={pipelineId}
          pipelineParams={pipelineParams}
          paramNames={paramNames}
          variableNames={variableNames}
          activityNames={activityNames}
        />
      </div>
    </ResizableCanvasRegion>
  );
}

export default PipelineOutputDock;
