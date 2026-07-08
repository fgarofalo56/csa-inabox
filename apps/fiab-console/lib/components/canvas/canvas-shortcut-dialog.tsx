'use client';

/**
 * CanvasShortcutDialog — the "?" cheat-sheet overlay (PRP W20). A Fluent v9
 * Dialog that lists every canvas shortcut, generated from the single
 * `CANVAS_SHORTCUTS` registry so it can never drift from the keys the canvas
 * actually binds or from the command-palette coverage (W21). Host-agnostic:
 * every canvas host renders one and opens it on the "?" key.
 */

import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Caption1, Body1Strong, makeStyles, tokens,
} from '@fluentui/react-components';
import { Keyboard20Regular } from '@fluentui/react-icons';
import { CANVAS_SHORTCUTS, CANVAS_SHORTCUT_GROUPS } from './canvas-shortcuts';

const useStyles = makeStyles({
  surface: { maxWidth: '560px', width: '92vw' },
  group: { marginTop: tokens.spacingVerticalM },
  groupTitle: {
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    fontSize: tokens.fontSizeBase200,
    letterSpacing: '0.04em',
    marginBottom: tokens.spacingVerticalXS,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
  label: { color: tokens.colorNeutralForeground1, minWidth: 0 },
  keys: { display: 'flex', gap: tokens.spacingHorizontalXS, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' },
  kbd: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    paddingTop: '1px',
    paddingBottom: '1px',
    whiteSpace: 'nowrap',
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export function CanvasShortcutDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const s = useStyles();
  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <span className={s.titleRow}><Keyboard20Regular /> Canvas keyboard shortcuts</span>
          </DialogTitle>
          <DialogContent>
            {CANVAS_SHORTCUT_GROUPS.map((g) => {
              const rows = CANVAS_SHORTCUTS.filter((sc) => sc.group === g);
              if (rows.length === 0) return null;
              return (
                <div key={g} className={s.group}>
                  <div className={s.groupTitle}>{g}</div>
                  {rows.map((sc) => (
                    <div key={sc.id} className={s.row}>
                      <Body1Strong className={s.label}>{sc.label}</Body1Strong>
                      <span className={s.keys}>
                        {sc.keys.map((k) => <kbd key={k} className={s.kbd}>{k}</kbd>)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
            <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
              On macOS use ⌘ in place of Ctrl. Press <kbd className={s.kbd}>?</kbd> any time to reopen this list.
            </Caption1>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
