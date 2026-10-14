/**
 * EstateAutoPauseSection + its mount in EstatePowerPanel (PRP-02 step 3, #4876).
 * Each `it` names the input that breaks it. NOT a G1 browser E2E: jsdom only.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetch = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => clientFetch(...a) }));
const jsonGet = vi.fn();
vi.mock('@/lib/components/admin-scaling/json-get', () => ({ jsonGet: (...a: unknown[]) => jsonGet(...a) }));

import { EstateAutoPauseSection, EstatePowerPanel, formatIdle, parseIdleHours } from '../estate-power-panel';

const styles = new Proxy({}, { get: (_t, k) => String(k) }) as Record<string, string>;
const mount = (node: React.ReactNode) => render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);

const power = (over: Record<string, unknown> = {}) => ({
  activity: { lastActivityAt: '2026-10-13T08:00:00.000Z', idleForSeconds: 7500, unreadable: false },
  autoPause: { enabled: true, idleHours: 2, source: 'stored', updatedAt: 'T', updatedBy: 'u' },
  lastPausedAt: null,
  lastResumedAt: null,
  ...over,
});

const okResponse = (body: unknown = { ok: true }) => ({ ok: true, status: 200, json: async () => body });
const failResponse = (error: string) => ({ ok: false, status: 503, json: async () => ({ ok: false, error }) });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('pure helpers', () => {
  it.each([
    [7500, '2h 5m'], [3600, '1h 0m'], [59, 'under a minute'], [60, '1m'], [2220, '37m'],
  ])('formatIdle(%s) = %s (breaks if seconds and minutes are mixed up)', (sec, out) => {
    expect(formatIdle(sec)).toBe(out);
  });

  it('formatIdle of a negative/NaN is "unknown", never a number', () => {
    expect(formatIdle(-1)).toBe('unknown');
    expect(formatIdle(NaN)).toBe('unknown');
  });

  it.each([['0', null], ['1', 1], ['168', 168], ['169', null], ['', null], ['abc', null], ['2.5', 2.5]])(
    'parseIdleHours(%j) = %s', (raw, out) => { expect(parseIdleHours(raw)).toBe(out); },
  );
});

describe('EstateAutoPauseSection', () => {
  it('shows idle time from idleForSeconds (7500 s -> "idle for 2h 5m"), not from the idleHours setting', () => {
    mount(<EstateAutoPauseSection power={power()} styles={styles} onChanged={vi.fn()} />);
    expect(screen.getByText(/idle for 2h 5m/)).toBeTruthy();
  });

  it('FIRST OPEN (no activity, default setting): informative text, NO error or warning bar', () => {
    const { container } = mount(
      <EstateAutoPauseSection
        power={power({
          activity: { lastActivityAt: null, idleForSeconds: null, unreadable: false },
          autoPause: { enabled: true, idleHours: 2, source: 'default', updatedAt: null, updatedBy: null },
        })}
        styles={styles}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('no activity recorded yet')).toBeTruthy();
    expect(screen.getByText(/Using the default: on, after 2 idle hours/)).toBeTruthy();
    // A clean first open has no MessageBar at all (positive pair above shows the section rendered).
    expect(container.querySelector('.fui-MessageBar')).toBeNull();
  });

  it('saving 4 hours PUTs exactly {enabled:true, idleHours:4} and refreshes the parent', async () => {
    clientFetch.mockResolvedValue(okResponse());
    const onChanged = vi.fn();
    mount(<EstateAutoPauseSection power={power()} styles={styles} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText('Idle hours before auto-pause'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledTimes(1));
    const [url, init] = clientFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/admin/estate/autopause');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: true, idleHours: 4 });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Auto-pause setting saved.')).toBeTruthy();
  });

  it.each(['0', '169', 'abc'])('idle hours %j: Save is disabled, an inline message appears, nothing is sent', (value) => {
    mount(<EstateAutoPauseSection power={power()} styles={styles} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Idle hours before auto-pause'), { target: { value } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    // 'abc' in a type=number input is coerced to '' by jsdom; either way it is invalid.
    expect(screen.getByText('Enter a number from 1 to 168.')).toBeTruthy();
    expect(clientFetch).not.toHaveBeenCalled();
  });

  it('a refused save shows a warning with Retry (not a bare error), and Retry re-sends', async () => {
    clientFetch.mockResolvedValueOnce(failResponse('store down')).mockResolvedValueOnce(okResponse());
    mount(<EstateAutoPauseSection power={power()} styles={styles} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Idle hours before auto-pause'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The auto-pause setting was not saved')).toBeTruthy();
    expect(screen.getByText(/store down/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse((clientFetch.mock.calls[1][1] as { body: string }).body)).toEqual({ enabled: true, idleHours: 6 });
  });

  it('an UNREADABLE stored setting offers one-click "Reset to defaults" which PUTs {enabled:true, idleHours:2}', async () => {
    clientFetch.mockResolvedValue(okResponse());
    mount(
      <EstateAutoPauseSection
        power={power({ autoPause: { enabled: true, idleHours: 2, source: 'unreadable', updatedAt: null, updatedBy: null } })}
        styles={styles}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('The saved auto-pause setting could not be read')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults (on, 2 hours)' }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse((clientFetch.mock.calls[0][1] as { body: string }).body)).toEqual({ enabled: true, idleHours: 2 });
  });

  it('unreadable ACTIVITY says idleness is unknown (and shows no idle-for badge)', () => {
    mount(
      <EstateAutoPauseSection
        power={power({ activity: { lastActivityAt: null, idleForSeconds: null, unreadable: true } })}
        styles={styles}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('activity unreadable')).toBeTruthy();
    expect(screen.queryByText(/idle for/)).toBeNull();
  });

  it('shows last paused / last resumed from the snapshot, "never" when absent', () => {
    mount(<EstateAutoPauseSection power={power({ lastPausedAt: '2026-08-23T00:05:00.000Z' })} styles={styles} onChanged={vi.fn()} />);
    expect(screen.getByText(/last paused (?!never)/)).toBeTruthy();
    expect(screen.getByText('last resumed never')).toBeTruthy();
  });
});

describe('mounted in EstatePowerPanel', () => {
  it('renders the section once state arrives with a power block; absent power renders no section', async () => {
    jsonGet.mockResolvedValue({ ok: true, state: 'RUNNING', estateId: 'loom:e', preview: { wouldPause: [] }, power: power() });
    mount(<EstatePowerPanel styles={styles} />);
    expect(await screen.findByTestId('estate-autopause')).toBeTruthy();
    cleanup();
    jsonGet.mockResolvedValue({ ok: true, state: 'RUNNING', estateId: 'loom:e', preview: { wouldPause: [] } });
    mount(<EstatePowerPanel styles={styles} />);
    await waitFor(() => expect(jsonGet).toHaveBeenCalledTimes(2));
    await screen.findByText('Estate power');
    expect(screen.queryByTestId('estate-autopause')).toBeNull();
  });
});
