/**
 * Tests for the useDebounce hook.
 */

import { renderHook, act } from '@testing-library/react';
import { useDebounce } from '@/hooks/useDebounce';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useDebounce', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('hello'));
    expect(result.current).toBe('hello');
  });

  it('does not update the value before the delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'ab' });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current).toBe('a');
  });

  it('updates the value after the default delay (300ms)', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'ab' });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe('ab');
  });

  it('respects a custom delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 500),
      { initialProps: { value: 'x' } },
    );

    rerender({ value: 'xy' });

    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe('x');

    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current).toBe('xy');
  });

  it('resets the timer on rapid changes', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'ab' });
    act(() => {
      jest.advanceTimersByTime(200);
    });

    rerender({ value: 'abc' });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    // Only 200ms since last change, should still be 'a'
    expect(result.current).toBe('a');

    act(() => {
      jest.advanceTimersByTime(100);
    });
    // 300ms since last change, should be 'abc' (skipping 'ab')
    expect(result.current).toBe('abc');
  });

  it('works with non-string types', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 300),
      { initialProps: { value: 1 } },
    );

    rerender({ value: 42 });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe(42);
  });
});
