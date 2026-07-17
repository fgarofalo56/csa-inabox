'use client';

import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { Code16Regular, TextHeader1Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  // Fabric add-cell divider — nearly invisible until hovered/focused, then the
  // rule brightens to the brand color and the pill buttons appear. The full
  // strip is the hover target so the affordance is easy to hit between cells.
  wrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXXS} 0`,
    opacity: 0.25,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationNormal,
    ':hover': { opacity: 1 },
    ':focus-within': { opacity: 1 },
    ':hover .nb-adder-line': { backgroundColor: tokens.colorBrandStroke2 },
    ':focus-within .nb-adder-line': { backgroundColor: tokens.colorBrandStroke2 },
  },
  line: {
    flex: 1,
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke2,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationNormal,
  },
  pill: {
    borderRadius: tokens.borderRadiusCircular,
  },
});

export interface CellAdderProps {
  onAddCode: () => void;
  onAddMarkdown: () => void;
}

export function CellAdder({ onAddCode, onAddMarkdown }: CellAdderProps) {
  const s = useStyles();
  return (
    <div className={s.wrap}>
      <div className={`${s.line} nb-adder-line`} />
      <Button className={s.pill} size="small" appearance="outline" icon={<Code16Regular />} onClick={onAddCode}>
        + Code
      </Button>
      <Button className={s.pill} size="small" appearance="outline" icon={<TextHeader1Regular />} onClick={onAddMarkdown}>
        + Markdown
      </Button>
      <div className={`${s.line} nb-adder-line`} />
    </div>
  );
}
