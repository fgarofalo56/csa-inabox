/**
 * EstateContainerAppsSection - the global + per-app opt-out in the Admin estate
 * power panel. jsdom only: NOT a G1 in-browser E2E. Each `it` names the input that breaks it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetch = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => clientFetch(...a) }));

import { EstateContainerAppsSection } from '../estate-container-apps-section';

const styles = new Proxy({}, { get: (_t, k) => String(k) }) as Record<string, string>;
const mount = (node: React.ReactNode) => render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);

const power = (containerApps = { enabled: true, exempt: [] as string[] }, source = 'stored') => ({
  autoPause: { enabled: true, idleHours: 4, source, containerApps, updatedAt: 'T', updatedBy: 'u' },
});
const status = (apps: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ configured: true, apps, ...extra });
const A = (name: string, state: string, reason = `${name} reason`) => ({ name, state, reason, minReplicas: 1, maxReplicas: 3 });
const ok = { ok: true, status: 200, json: async () => ({ ok: true }) };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('global switch', () => {
  // Breaks if: the switch is cosmetic or sends the wrong body (idle hours dropped, policy missing).
  it('turning it OFF PUTs {enabled, idleHours} unchanged plus containerApps {enabled:false, exempt kept}', async () => {
    clientFetch.mockResolvedValue(ok);
    const onChanged = vi.fn();
    mount(<EstateContainerAppsSection power={power({ enabled: true, exempt: ['loom-udf-runtime'] })} containerApps={status([])} styles={styles} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('switch', { name: /Include Container Apps in pause/ }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledTimes(1));
    const [url, init] = clientFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/admin/estate/autopause');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: true, idleHours: 4, containerApps: { enabled: false, exempt: ['loom-udf-runtime'] } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  // Breaks if: the displayed state is not the server's (default ON must read as ON).
  it('reflects the server policy: on by default, off when opted out', () => {
    mount(<EstateContainerAppsSection power={power()} containerApps={status([])} styles={styles} onChanged={vi.fn()} />);
    expect((screen.getByRole('switch', { name: /Include Container Apps in pause/ }) as HTMLInputElement).checked).toBe(true);
    cleanup();
    mount(<EstateContainerAppsSection power={power({ enabled: false, exempt: [] })} containerApps={status([])} styles={styles} onChanged={vi.fn()} />);
    expect((screen.getByRole('switch', { name: /opted out of pause/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('per-app opt-out', () => {
  const apps = [
    A('loom-udf-runtime', 'will-pause'), A('loom-dab-preview', 'exempt'), A('loom-risingwave', 'held-out', 'it holds MV state'),
    A('loom-trino', 'already-zero'), A('foreign', 'not-owned'),
  ];

  // Breaks if: unticking an app does not add it to `exempt` (lower-case), or drops the existing exemption.
  it('unticking a will-pause app PUTs it appended to the exempt list; existing exemptions are kept', async () => {
    clientFetch.mockResolvedValue(ok);
    mount(<EstateContainerAppsSection power={power({ enabled: true, exempt: ['loom-dab-preview'] })} containerApps={status(apps)} styles={styles} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-pause loom-udf-runtime' }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse((clientFetch.mock.calls[0][1] as { body: string }).body).containerApps)
      .toEqual({ enabled: true, exempt: ['loom-dab-preview', 'loom-udf-runtime'] });
  });

  // Breaks if: re-ticking an exempt app leaves it in `exempt`.
  it('ticking an exempt app PUTs it REMOVED from the exempt list', async () => {
    clientFetch.mockResolvedValue(ok);
    mount(<EstateContainerAppsSection power={power({ enabled: true, exempt: ['loom-dab-preview'] })} containerApps={status(apps)} styles={styles} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-pause loom-dab-preview' }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse((clientFetch.mock.calls[0][1] as { body: string }).body).containerApps).toEqual({ enabled: true, exempt: [] });
  });

  // Breaks if: an app that can never be paused is offered a toggle, or vanishes from the list (unreviewed).
  it('held-out / already-zero / not-owned apps are LISTED with their reason and have NO toggle', () => {
    mount(<EstateContainerAppsSection power={power()} containerApps={status(apps)} styles={styles} onChanged={vi.fn()} />);
    for (const n of ['loom-risingwave', 'loom-trino', 'foreign']) {
      expect(screen.getByText(n)).toBeTruthy();
      expect(screen.queryByRole('switch', { name: `Auto-pause ${n}` })).toBeNull();
    }
    expect(screen.getByText('it holds MV state')).toBeTruthy();
    expect(screen.getByText('never paused')).toBeTruthy();
    // Positive pair: the pausable apps do have toggles.
    expect(screen.getByRole('switch', { name: 'Auto-pause loom-udf-runtime' })).toBeTruthy();
  });

  // Breaks if: per-app toggles stay live while the global opt-out is on (they would write meaningless exemptions).
  it('per-app toggles are disabled while the global switch is off', () => {
    mount(<EstateContainerAppsSection power={power({ enabled: false, exempt: [] })} containerApps={status([A('loom-udf-runtime', 'will-pause')])} styles={styles} onChanged={vi.fn()} />);
    expect((screen.getByRole('switch', { name: 'Auto-pause loom-udf-runtime' }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('honest states', () => {
  // Breaks if: a refused save looks like success or loses the server message; Retry must re-send.
  it('a refused save shows the error with Retry, and Retry re-sends the same body', async () => {
    clientFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ ok: false, error: 'store down' }) }).mockResolvedValueOnce(ok);
    mount(<EstateContainerAppsSection power={power()} containerApps={status([])} styles={styles} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: /Include Container Apps in pause/ }));
    expect(await screen.findByText('The Container Apps setting was not saved')).toBeTruthy();
    expect(screen.getByText(/store down/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(clientFetch).toHaveBeenCalledTimes(2));
    expect(clientFetch.mock.calls[1][1]).toEqual(clientFetch.mock.calls[0][1]);
  });

  // Breaks if: an unreadable stored setting still lets the operator flip a switch blind.
  it('an UNREADABLE setting disables the switches and says no app is paused', () => {
    mount(<EstateContainerAppsSection power={power(undefined, 'unreadable')} containerApps={status([A('loom-udf-runtime', 'setting-unreadable')])} styles={styles} onChanged={vi.fn()} />);
    expect(screen.getByText('Opt-outs cannot be read')).toBeTruthy();
    expect((screen.getByRole('switch', { name: /Include Container Apps in pause/ }) as HTMLInputElement).disabled).toBe(true);
  });

  // Breaks if: a failed listing renders as an empty "no apps" list.
  it('a list error and a platform note are shown verbatim', () => {
    mount(<EstateContainerAppsSection power={power()} containerApps={status([], { listError: 'ARM GET failed 403', note: 'runs on AKS' })} styles={styles} onChanged={vi.fn()} />);
    expect(screen.getByText(/ARM GET failed 403/)).toBeTruthy();
    expect(screen.getByText('runs on AKS')).toBeTruthy();
  });

  // Breaks if: no power block renders a section (first load).
  it('no autoPause block renders nothing', () => {
    const { container } = mount(<EstateContainerAppsSection power={{}} containerApps={null} styles={styles} onChanged={vi.fn()} />);
    expect(container.querySelector('[data-testid="estate-container-apps"]')).toBeNull();
  });
});
