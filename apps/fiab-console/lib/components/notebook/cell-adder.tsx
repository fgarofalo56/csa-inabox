'use client';

import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { Code16Regular, Add16Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  wrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    padding: '2px 0',
    opacity: 0.35,
    transition: 'opacity 0.15s',
    ':hover': { opacity: 1 },
  },
  line: {
    flex: 1,
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke2,
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
      <div className={s.line} />
      <Button size="small" appearance="subtle" icon={<Code16Regular />} onClick={onAddCode}>
        + Code
      </Button>
      <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={onAddMarkdown}>
        + Markdown
      </Button>
      <div className={s.line} />
    </div>
  );
}
