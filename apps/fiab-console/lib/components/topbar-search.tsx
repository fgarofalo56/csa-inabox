'use client';

/**
 * TopbarSearch — full search input baked into the topbar. Clicking it,
 * focusing it, or pressing Ctrl/Cmd+K opens the CommandPalette pre-filled
 * with whatever the user typed.
 */

import { useState, useRef, useEffect } from 'react';
import { shorthands, Input, makeStyles, tokens } from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    flex: 1,
    maxWidth: '540px',
    margin: '0 16px',
  },
  input: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.10)',
    color: 'white',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '6px',
    height: '32px',
    '::placeholder': { color: 'rgba(255,255,255,0.65)' },
    ':hover': { backgroundColor: 'rgba(255,255,255,0.15)' },
    ':focus-within': { backgroundColor: 'rgba(255,255,255,0.18)', ...shorthands.borderColor('rgba(255,255,255,0.4)') },
  },
  /**
   * #4280 — the Ctrl-K chip painted over the placeholder.
   *
   * `contentAfter` is a flex sibling of the `<input>`, and a flex item's
   * default `min-width: auto` resolves for an input to its intrinsic `size`
   * width. So the input refused to shrink, overflowed the field, and the chip
   * came down on top of the placeholder text on FIRST PAINT with no
   * interaction, in both themes. `minWidth: 0` lets the input shrink and
   * ellipsise instead — the `minWidth: 0` half of the `ux-baseline.md` badge
   * rule — and `flexShrink: 0` keeps the chip itself from being squeezed.
   */
  inputEl: { minWidth: 0 },
  shortcut: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase100,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: '1px solid rgba(255,255,255,0.25)',
    color: 'rgba(255,255,255,0.7)',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
});

function fireOpenPalette(prefill?: string) {
  window.dispatchEvent(new CustomEvent('csaloom:open-palette', { detail: { prefill } }));
}

export function TopbarSearch() {
  const s = useStyles();
  const [val, setVal] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // "/" focuses the topbar search like GitHub
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        ref.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function open() {
    fireOpenPalette(val);
    setVal('');
  }

  return (
    <div className={s.root} data-tour="search">
      <Input
        ref={ref}
        className={s.input}
        input={{ className: s.inputEl }}
        contentBefore={<Search20Regular style={{ color: 'rgba(255,255,255,0.85)' }} />}
        contentAfter={<span className={s.shortcut}>Ctrl K</span>}
        placeholder="Search items, settings, item types…"
        value={val}
        onChange={(_, d) => setVal(d.value)}
        onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
        aria-label="Search CSA Loom (press / to focus, Ctrl+K for the command palette)"
      />
    </div>
  );
}
