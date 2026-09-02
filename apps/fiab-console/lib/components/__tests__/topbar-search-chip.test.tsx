/**
 * #4280 — the Ctrl-K chip that painted over the search placeholder.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The fix shipped with no test at all, which meant nothing prevented a revert.
 * It also shipped with the WRONG stated cause: `minWidth: 0` on the `input`
 * slot, which is inert — `@fluentui/react-input@9.8.2` already sets it in its
 * own reset class (`useInputStyles.styles.js:175`,
 * `.r12stul0{…flex-grow:1;min-width:0;…}`, merged unconditionally at `:245`).
 *
 * The operative property is on the CHIP, not the input: `contentAfter` is
 * `.r1572tok{…display:flex}` with no `flex-shrink`, so the chip was an ordinary
 * shrinkable flex item and `Ctrl K` could be squeezed onto two lines and bulge
 * out of the 32px-tall root, over the placeholder.
 *
 * So this suite pins the PROPERTY that does the work, not the placeholder
 * string. The placeholder was also shortened by 14 characters, and that is a
 * genuine contributing width change — but a width nudge fixes one viewport and
 * breaks another, so it is deliberately NOT what is asserted here.
 *
 * ── LIMIT ─────────────────────────────────────────────────────────────────
 * jsdom performs no layout, so this cannot prove the chip stops overlapping.
 * It proves the declaration that prevents the squeeze is present and reaches
 * the element. The browser receipt is the visual evidence.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TopbarSearch } from '@/lib/components/topbar-search';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <TopbarSearch />
    </FluentProvider>,
  );
}

describe('the Ctrl-K chip cannot be squeezed over the placeholder', () => {
  it('the chip does NOT shrink, and stays on one line', () => {
    mount();
    const chip = screen.getByTestId('topbar-search-shortcut');
    const css = getComputedStyle(chip);

    // The two declarations that make the chip un-squeezable. Remove either and
    // it becomes a shrinkable flex item again — the shape that overlapped.
    expect(css.flexShrink).toBe('0');
    expect(css.whiteSpace).toBe('nowrap');
  });

  it('the INPUT is the flex item that yields — Fluent already guarantees it', () => {
    // Pinned as an assumption-of-record: the fix relies on the input being the
    // shrinkable side. If a Fluent upgrade ever drops this, the chip's
    // `flexShrink: 0` alone would start pushing the field out instead, and this
    // is the spec that should fail first and say why.
    mount();
    const input = screen.getByRole('textbox');
    // Unit-agnostic: jsdom serialises this as '0', browsers as '0px'.
    expect(parseFloat(getComputedStyle(input).minWidth)).toBe(0);
  });

  it('the chip is still present and still reads Ctrl K', () => {
    // A chip deleted is also a chip that no longer overlaps. Not a fix.
    mount();
    expect(screen.getByTestId('topbar-search-shortcut').textContent).toContain('Ctrl K');
  });

  it('the / and Ctrl+K hints survive the shortened placeholder, in the a11y name', () => {
    // The placeholder lost its `(press / )` tail. That information moved to the
    // accessible name rather than being dropped.
    mount();
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('placeholder')).toBe('Search items, settings, item types…');
    const name = input.getAttribute('aria-label') ?? '';
    expect(name).toContain('press /');
    expect(name).toContain('Ctrl+K');
  });
});
