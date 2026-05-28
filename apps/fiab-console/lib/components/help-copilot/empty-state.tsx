'use client';

/**
 * EmptyState — first-load suggestions for the Help Copilot widget.
 *
 * 6 baked-in starter prompts the user can click. Each click fires the
 * onPick handler which the parent widget pipes into send().
 */

import { Body1, Button, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { Sparkle20Regular, ChevronRight16Regular } from '@fluentui/react-icons';

const STARTERS = [
  'What is CSA Loom?',
  'How do I deploy?',
  'How do I create my first workspace?',
  "What's a data product?",
  'How does Direct Lake parity work?',
  'Why does Cluster save return PERMISSION_DENIED?',
] as const;

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 4px' },
  hero: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 12,
    background: 'linear-gradient(135deg, rgba(125,108,255,0.12), rgba(89,165,255,0.08))',
    border: `1px solid ${tokens.colorBrandStroke2}`,
  },
  heroIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  starters: { display: 'flex', flexDirection: 'column', gap: 6 },
  starter: {
    justifyContent: 'space-between', textAlign: 'left',
    height: 'auto', padding: '8px 12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    transition: 'background-color 120ms ease, border-color 120ms ease',
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
      borderColor: tokens.colorBrandStroke1,
    },
  },
});

export function HelpEmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  const s = useStyles();
  return (
    <div className={s.wrap}>
      <div className={s.hero}>
        <Sparkle20Regular className={s.heroIcon} />
        <div>
          <Body1 style={{ fontWeight: 600 }}>Hi! I'm the CSA Loom Help Copilot.</Body1>
          <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
            I answer how-to questions, grounded in the docs + this repo. Every answer cites its sources.
          </Caption1>
        </div>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3, paddingLeft: 4 }}>Try one of these:</Caption1>
      <div className={s.starters}>
        {STARTERS.map((s_text) => (
          <Button
            key={s_text}
            className={s.starter}
            appearance="subtle"
            iconPosition="after"
            icon={<ChevronRight16Regular />}
            onClick={() => onPick(s_text)}
            data-testid="help-starter"
          >
            {s_text}
          </Button>
        ))}
      </div>
    </div>
  );
}
