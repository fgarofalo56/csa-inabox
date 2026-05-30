'use client';

/**
 * CanvasToolbar — the floating zoom / layout controls ADF Studio renders in
 * the bottom-right of the pipeline canvas: Zoom out, % readout (click = reset
 * to 100%), Zoom in, Zoom to fit, Auto align. Pure presentation — it drives
 * the imperative CanvasHandle methods the parent threads in.
 */

import { Button, Tooltip, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import {
  ZoomIn20Regular, ZoomOut20Regular, ArrowMaximize20Regular,
  AutoFitWidth20Regular, ArrowReset20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  bar: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: '2px 4px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  pct: { minWidth: 44, textAlign: 'center', cursor: 'pointer', userSelect: 'none' },
});

export interface CanvasToolbarProps {
  zoomPct: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onAutoAlign: () => void;
  onReset: () => void;
}

export function CanvasToolbar({ zoomPct, onZoomIn, onZoomOut, onFit, onAutoAlign, onReset }: CanvasToolbarProps) {
  const s = useStyles();
  return (
    <div className={s.bar} role="toolbar" aria-label="Canvas controls" data-canvas-toolbar>
      <Tooltip content="Zoom out" relationship="label">
        <Button size="small" appearance="subtle" icon={<ZoomOut20Regular />} aria-label="Zoom out" onClick={onZoomOut} />
      </Tooltip>
      <Tooltip content="Reset to 100%" relationship="label">
        <Caption1 className={s.pct} onClick={onReset} role="button" aria-label="Reset zoom to 100 percent">{zoomPct}%</Caption1>
      </Tooltip>
      <Tooltip content="Zoom in" relationship="label">
        <Button size="small" appearance="subtle" icon={<ZoomIn20Regular />} aria-label="Zoom in" onClick={onZoomIn} />
      </Tooltip>
      <Tooltip content="Zoom to fit" relationship="label">
        <Button size="small" appearance="subtle" icon={<ArrowMaximize20Regular />} aria-label="Zoom to fit" onClick={onFit} />
      </Tooltip>
      <Tooltip content="Auto align" relationship="label">
        <Button size="small" appearance="subtle" icon={<AutoFitWidth20Regular />} aria-label="Auto align" onClick={onAutoAlign} />
      </Tooltip>
      <Tooltip content="Reset view" relationship="label">
        <Button size="small" appearance="subtle" icon={<ArrowReset20Regular />} aria-label="Reset view" onClick={onReset} />
      </Tooltip>
    </div>
  );
}
