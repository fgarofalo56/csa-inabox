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
   * MEASURED in `@fluentui/react-input@9.8.2`: the `contentAfter` wrapper is
   * `.r1572tok{…display:flex}` with no `flex-shrink`, so both it and the chip
   * `<span>` inside it were ordinary SHRINKABLE flex items of the 540px-max,
   * 32px-tall root. Squeezed by an over-long placeholder, `Ctrl K` broke to two
   * lines and bulged out of the root, landing on top of the placeholder text on
   * first paint with no interaction, in both themes.
   *
   * `flexShrink: 0` + `whiteSpace: 'nowrap'` is the operative fix: the chip
   * keeps one line and its natural width, and the input yields instead.
   *
   * NOT the fix, recorded so it is not re-added: `minWidth: 0` on the `input`
   * slot. Fluent's own reset class already carries it —
   * `useInputStyles.styles.js:175` declares `.r12stul0{…flex-grow:1;min-width:0;…}`
   * and `:245` merges it into `state.input.className` unconditionally. Setting
   * it again from the caller is inert.
   *
   * CONTRIBUTING, and named because an unnamed width nudge is how this defect
   * class comes back: the placeholder below is 14 characters shorter than it
   * was (the `(press / )` tail moved into the `aria-label`). That is a real
   * width change. It reduces the pressure that produced the squeeze — it does
   * NOT replace `flexShrink: 0`, which is what makes the chip safe at any
   * width. `topbar-search-chip.test.tsx` pins the property, not the string.
   */
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
        contentBefore={<Search20Regular style={{ color: 'rgba(255,255,255,0.85)' }} />}
        contentAfter={
          <span className={s.shortcut} data-testid="topbar-search-shortcut">
            Ctrl K
          </span>
        }
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
