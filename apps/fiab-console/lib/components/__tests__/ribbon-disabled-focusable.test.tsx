/**
 * Ribbon `disabledFocusable`: a disabled action that asks to stay focusable
 * renders `aria-disabled` (not native `disabled`), keeps its tab stop and its
 * `title`, and does not run its handler even when one is supplied.
 *
 * What breaks each case:
 *   - focusable + inert: the Ribbon not passing `disabledFocusable` to the
 *     Button (native `disabled` returns, focus fails). The "handler not run"
 *     assertion pins the OUTCOME, not the Ribbon's own `onClick` suppression:
 *     Fluent's `disabledFocusable` already swallows the click, so passing the
 *     handler through is an equivalent mutant (measured: it stays green). The
 *     suppression is kept so the Ribbon does not rely on that Fluent detail.
 *   - plain disabled: `disabledFocusable` applied to every disabled action
 *     (the native `disabled` attribute disappears).
 *   - enabled: `disabledFocusable` set without `disabled` graying the button
 *     out (it is documented as ignored when not disabled), or the handler lost.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Ribbon, type RibbonAction } from '../ribbon';

function mount(actions: RibbonAction[]) {
  render(
    <FluentProvider theme={webLightTheme}>
      <Ribbon tabs={[{ id: 'home', label: 'Home', groups: [{ label: 'G', actions }] }]} />
    </FluentProvider>,
  );
}

afterEach(() => cleanup());

describe('Ribbon disabledFocusable', () => {
  it('a disabled, focusable action is aria-disabled, reachable by focus, titled, and does not run its handler', () => {
    const spy = vi.fn();
    mount([{ label: 'Admin only', disabled: true, disabledFocusable: true, onClick: spy, title: 'Reason-7731' }]);
    const btn = screen.getByRole('button', { name: 'Admin only' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute('title')).toBe('Reason-7731');
    fireEvent.click(btn);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a plain disabled action keeps native disabled (the option is opt-in)', () => {
    mount([{ label: 'Busy', disabled: true, onClick: vi.fn() }]);
    expect(screen.getByRole('button', { name: 'Busy' }).hasAttribute('disabled')).toBe(true);
  });

  it('disabledFocusable without disabled leaves the action enabled (positive half)', () => {
    const spy = vi.fn();
    mount([{ label: 'Live', disabledFocusable: true, onClick: spy }]);
    const btn = screen.getByRole('button', { name: 'Live' });
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
