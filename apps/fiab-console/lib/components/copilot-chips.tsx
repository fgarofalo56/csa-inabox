'use client';

/**
 * CopilotChips — the suggested-prompt chip strip rendered above the Copilot
 * composer. Shared by the global CopilotPane (right rail) and the notebook
 * CopilotChatPane. Renders one Fluent-themed pill per persona/context prompt;
 * the strip wraps and is keyboard-navigable (roving tabindex + arrow keys).
 *
 * Parity target: the starter-prompt buttons Microsoft Fabric Copilot shows at
 * the top of the chat pane before the first message. Clicking a chip sends its
 * prompt — exactly as typing it and pressing Enter would.
 */

import { useRef } from 'react';
import { shorthands, makeStyles, tokens } from '@fluentui/react-components';
import { getPersonaPrompts, type CopilotContext } from '@/lib/azure/copilot-personas';

const useStyles = makeStyles({
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    padding: '6px 12px',
  },
  chip: {
    fontSize: '12px',
    height: '24px',
    padding: '0 10px',
    borderRadius: '999px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
      ...shorthands.borderColor(tokens.colorBrandStroke1),
    },
    ':focus-visible': {
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineColor: tokens.colorBrandStroke1,
    },
    ':disabled': { opacity: 0.5, cursor: 'default' },
  },
});

export interface CopilotChipsProps {
  ctx: CopilotContext;
  /** Disable chips while a request is in flight. */
  busy: boolean;
  /** Send the chosen prompt (same path as composer submit). */
  onSelect: (prompt: string) => void;
}

export function CopilotChips({ ctx, busy, onSelect }: CopilotChipsProps) {
  const s = useStyles();
  const chips = getPersonaPrompts(ctx);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  if (chips.length === 0) return null;

  function onKeyDown(e: React.KeyboardEvent, idx: number) {
    const total = refs.current.length;
    if (total === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      refs.current[(idx + 1) % total]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      refs.current[(idx - 1 + total) % total]?.focus();
    }
  }

  return (
    <div className={s.strip} role="group" aria-label="Suggested prompts">
      {chips.map((chip, idx) => (
        <button
          key={chip.id}
          ref={(el) => {
            refs.current[idx] = el;
          }}
          type="button"
          className={s.chip}
          tabIndex={idx === 0 ? 0 : -1}
          disabled={busy}
          onClick={() => onSelect(chip.prompt)}
          onKeyDown={(e) => onKeyDown(e, idx)}
          title={chip.prompt}
          aria-label={chip.label}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
