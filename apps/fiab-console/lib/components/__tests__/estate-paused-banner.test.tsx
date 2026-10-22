/**
 * EstatePausedBanner. jsdom only: NOT a G1 in-browser E2E (ux-baseline G1).
 * Each `it` names the input that breaks it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetch = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => clientFetch(...a) }));

import { EstatePausedBanner, nameList, BANNER_POLL_MS } from '../estate-paused-banner';
import { SessionProvider, type ShellSession } from '../session-context';

const session = (over: Partial<ShellSession> = {}): ShellSession => ({
  authenticated: true, user: { name: 'U', upn: 'u@x', oid: 'o' }, isTenantAdmin: false, loading: false, ...over,
});
const mount = (s: ShellSession) => render(
  <FluentProvider theme={webLightTheme}><SessionProvider value={s}><EstatePausedBanner /></SessionProvider></FluentProvider>,
);

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });
const paused = (over: Record<string, unknown> = {}) => ({
  ok: true, paused: true, state: 'PAUSED', count: 3, names: ['loom-mcp', 'loom-airflow', 'loom-activator'],
  pausedAt: '2026-10-22T01:04:00.000Z', pausedBy: null, pausedByKind: 'automation', failure: null, canResume: false, ...over,
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('hidden when nothing is paused', () => {
  // Breaks if: the banner renders for a never-paused estate.
  it('{paused:false} renders nothing (and the poll never starts)', async () => {
    clientFetch.mockResolvedValue(json({ ok: true, paused: false, canResume: true }));
    const { container } = mount(session({ isTenantAdmin: true }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledWith('/api/estate/paused'));
    expect(screen.queryByTestId('estate-paused-banner')).toBeNull();
    expect(container.querySelector('.fui-MessageBar')).toBeNull();
  });

  // Breaks if: an unauthenticated visitor (sign-in page) triggers the fetch / banner.
  it('unauthenticated -> no fetch at all', async () => {
    mount(session({ authenticated: false }));
    await Promise.resolve();
    expect(clientFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('estate-paused-banner')).toBeNull();
  });

  // Breaks if: a failed read paints an alarm on every page (advisory surface).
  it.each([
    ['a 503 response', () => Promise.resolve(json({ ok: false, error: 'x' }, false, 503))],
    ['a network error', () => Promise.reject(new Error('net'))],
  ])('%s renders nothing', async (_label, resp) => {
    clientFetch.mockImplementation(resp);
    mount(session());
    await waitFor(() => expect(clientFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('estate-paused-banner')).toBeNull();
  });
});

describe('shown when paused', () => {
  // Breaks if: the count or names are wrong (3 services, all named when <= 5).
  it('PAUSED: states the count, names every service, and when it was paused', async () => {
    clientFetch.mockResolvedValue(json(paused()));
    mount(session());
    expect(await screen.findByText('3 services are paused to save cost')).toBeTruthy();
    expect(screen.getByText(/loom-mcp, loom-airflow, loom-activator/)).toBeTruthy();
    // The exact rendered instant, computed the same way the component does (a loose date regex would pass for any date).
    const when = new Date('2026-10-22T01:04:00.000Z').toLocaleString();
    expect(screen.getByText((t) => t.includes(`Paused ${when} by automation`))).toBeTruthy();
  });

  // Breaks if: singular/plural agreement is wrong.
  it('1 service uses the singular', async () => {
    clientFetch.mockResolvedValue(json(paused({ count: 1, names: ['loom-mcp'] })));
    mount(session());
    expect(await screen.findByText('1 service is paused to save cost')).toBeTruthy();
  });

  // Breaks if: a long list is not truncated, or the remainder is miscounted (7 names -> 5 + "2 more").
  it('nameList truncates at 5 and counts the remainder', () => {
    expect(nameList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, e');
    expect(nameList(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e and 2 more');
  });

  // Breaks if: a non-admin is offered a button the server would refuse.
  it('non-admin: NO Resume button, and read-only text says an administrator can resume', async () => {
    clientFetch.mockResolvedValue(json(paused({ canResume: false })));
    mount(session({ isTenantAdmin: false }));
    await screen.findByText('3 services are paused to save cost');
    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
    expect(screen.getByText(/An administrator can resume them/)).toBeTruthy();
  });

  // Breaks if: an admin has no way to resume from the banner.
  it('admin: a Resume button is offered, and the identity of who paused is shown', async () => {
    clientFetch.mockResolvedValue(json(paused({ canResume: true, pausedBy: 'admin@contoso.com', pausedByKind: 'person' })));
    mount(session({ isTenantAdmin: true }));
    await screen.findByText('3 services are paused to save cost');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByText(/by admin@contoso.com/)).toBeTruthy();
    expect(screen.queryByText(/An administrator can resume them/)).toBeNull();
  });
});

describe('Resume (admin)', () => {
  const adminPaused = () => paused({ canResume: true, pausedBy: 'a@x', pausedByKind: 'person' });

  // Breaks if: the button posts anywhere but the real resume route, or sends no body.
  it('POSTs /api/admin/estate/resume, shows progress, then re-reads the state', async () => {
    let state: Record<string, unknown> = adminPaused();
    clientFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/admin/estate/resume') { state = { ...state, state: 'RESUMING' }; return json({ ok: true }, true, 202); }
      if (url === '/api/estate/paused') return json(state);
      return json({ ok: true });
    });
    mount(session({ isTenantAdmin: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    const post = clientFetch.mock.calls.find((c) => c[0] === '/api/admin/estate/resume');
    expect(post?.[1]).toMatchObject({ method: 'POST' });
    expect(await screen.findByText('Resuming 3 services')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull(); // no double-submit while it runs
  });

  // Breaks if: a refused resume hides the button / swallows the error.
  it('a refused resume shows the server error and KEEPS the button', async () => {
    clientFetch.mockImplementation(async (url: string) => {
      if (url === '/api/admin/estate/resume') return json({ ok: false, error: 'capacity exhausted in region' }, false, 409);
      return json(adminPaused());
    });
    mount(session({ isTenantAdmin: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/capacity exhausted in region/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(false);
  });

  // Breaks if: RESUME_FAILED is shown as success/info, loses the failure text, or drops the retry button.
  it('RESUME_FAILED: error intent with the failure text, and the button stays as "Retry resume"', async () => {
    clientFetch.mockResolvedValue(json(paused({
      canResume: true, state: 'RESUME_FAILED', failure: '1 service(s) are not confirmed back up: loom-airflow.',
    })));
    mount(session({ isTenantAdmin: true }));
    expect(await screen.findByText('Resume did not complete')).toBeTruthy();
    expect(screen.getByText(/not confirmed back up: loom-airflow/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry resume' })).toBeTruthy();
    expect(screen.getByTestId('estate-paused-banner').getAttribute('data-intent')).toBe('error');
  });

  // Breaks if: after RESUMING -> RUNNING the banner stays on screen.
  it('hides once the poll reports the estate is no longer paused', async () => {
    vi.useFakeTimers();
    let paused_ = true;
    clientFetch.mockImplementation(async (url: string) => {
      if (url === '/api/estate/paused') return json(paused_ ? paused({ state: 'RESUMING', canResume: true }) : { ok: true, paused: false, canResume: true });
      return json({ ok: true });
    });
    mount(session({ isTenantAdmin: true }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('estate-paused-banner')).toBeTruthy();
    paused_ = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(BANNER_POLL_MS + 50); });
    expect(screen.queryByTestId('estate-paused-banner')).toBeNull();
    // The admin tab drove the PROMOTING read, or a finished resume would sit at RESUMING.
    expect(clientFetch.mock.calls.some((c) => c[0] === '/api/admin/estate/state')).toBe(true);
  });

  // Breaks if: a NON-admin's poll calls the admin-only state route (403 noise on every page).
  it('a non-admin poll never calls the admin state route', async () => {
    vi.useFakeTimers();
    clientFetch.mockImplementation(async () => json(paused({ state: 'RESUMING', canResume: false })));
    mount(session({ isTenantAdmin: false }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BANNER_POLL_MS * 2 + 50); });
    expect(clientFetch.mock.calls.some((c) => c[0] === '/api/admin/estate/state')).toBe(false);
    expect(clientFetch.mock.calls.filter((c) => c[0] === '/api/estate/paused').length).toBeGreaterThan(1);
  });

  // Breaks if: a settled PAUSED state keeps polling (needless load on every page, forever).
  it('PAUSED does not poll', async () => {
    vi.useFakeTimers();
    clientFetch.mockImplementation(async () => json(paused()));
    mount(session());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const before = clientFetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(BANNER_POLL_MS * 3); });
    expect(clientFetch.mock.calls.length).toBe(before);
  });
});
