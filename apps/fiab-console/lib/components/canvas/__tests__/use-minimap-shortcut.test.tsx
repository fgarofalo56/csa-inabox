/**
 * useMinimapShortcut — #3699. Binds `M` at the document level (see the hook's
 * own header comment for why: only 2 of 24 real canvas hosts have ANY
 * hand-rolled keydown handler at all, so per-host binding would mean adding
 * this from scratch in 22 files). These tests pin the guard that keeps it
 * from firing while the user is typing.
 *
 * NOT covered here, or anywhere: the real collision this hook introduced in
 * pipeline/canvas.tsx (fixed there with e.stopPropagation() on the
 * align-chord's own 'm' binding). That file cannot be imported in this
 * vitest/jsdom environment at all — a pre-existing OOM on the @xyflow/react +
 * ELK import chain, already documented inline by
 * pipeline-canvas-viewport.test.tsx:39-42, which stubs the whole file out for
 * exactly this reason. The fix is verified by tracing the event path instead
 * (see the PR description), not by an automated test — disclosed, not hidden.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMinimapShortcut } from '../use-minimap-shortcut';

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useMinimapShortcut — fires on a bare M', () => {
  it('calls onToggle for a lowercase m with no modifiers', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onToggle for an uppercase M (Shift+m is still a bare "M" keypress in practice, but Shift+anything is excluded below — this is the bare physical key without a modifier flag)', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('M');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('preventDefaults the event so the browser does not do anything else with "m"', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle));
    const evt = fireKey('m');
    expect(evt.defaultPrevented).toBe(true);
  });
});

describe('useMinimapShortcut — modifier keys are excluded (the align-chord collision this guards against)', () => {
  it('does NOT fire with Ctrl+M', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', { ctrlKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does NOT fire with Alt+M — this is pipeline/canvas.tsx\'s "Alt+A then M" align-middle chord', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', { altKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does NOT fire with Meta+M', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', { metaKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does NOT fire with Shift+M', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', { shiftKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('useMinimapShortcut — editing-target guard', () => {
  it('does NOT fire while focus is in an <input>', () => {
    const onToggle = vi.fn();
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', {}, input);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does NOT fire while focus is in a <textarea> (covers Monaco\'s hidden textarea)', () => {
    const onToggle = vi.fn();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', {}, textarea);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does NOT fire while focus is in a <select>', () => {
    const onToggle = vi.fn();
    const select = document.createElement('select');
    document.body.appendChild(select);
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', {}, select);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does NOT fire on a contentEditable element', () => {
    const onToggle = vi.fn();
    const div = document.createElement('div');
    div.contentEditable = 'true';
    // jsdom does not implement the editing-host algorithm behind
    // `isContentEditable` (it stays false regardless of the attribute) —
    // https://github.com/jsdom/jsdom/issues/1670. Stub the getter directly so
    // this test exercises the hook's own branch rather than jsdom's gap.
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(div);
    renderHook(() => useMinimapShortcut(onToggle));
    fireKey('m', {}, div);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('useMinimapShortcut — enabled flag and cleanup', () => {
  it('does nothing when enabled=false', () => {
    const onToggle = vi.fn();
    renderHook(() => useMinimapShortcut(onToggle, false));
    fireKey('m');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount (no leak across route changes)', () => {
    const onToggle = vi.fn();
    const { unmount } = renderHook(() => useMinimapShortcut(onToggle));
    unmount();
    fireKey('m');
    expect(onToggle).not.toHaveBeenCalled();
  });
});
