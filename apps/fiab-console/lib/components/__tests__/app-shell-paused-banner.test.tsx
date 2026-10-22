/**
 * The paused banner is mounted in the SHARED shell (every page after login), above
 * the page content, and only appears when the estate is paused. Sibling chrome is
 * stubbed; AppShell, the session context and the banner are real. jsdom only: NOT a
 * G1 in-browser E2E. Each `it` names the input that breaks it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetch = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => clientFetch(...a) }));
vi.mock('@/lib/components/shared/version-skew-guard', () => ({ VersionSkewGuard: () => null }));
vi.mock('next/link', () => ({ default: ({ children }: { children?: React.ReactNode }) => <a>{children}</a> }));
vi.mock('../left-nav', () => ({ LeftNav: () => null }));
vi.mock('../use-nav-collapse', () => ({ useNavCollapse: () => ({ collapsed: false, toggle: () => {} }) }));
vi.mock('../command-palette', () => ({ CommandPalette: () => null }));
vi.mock('../copilot-pane', () => ({ CopilotPane: () => null, openCopilot: () => {} }));
vi.mock('../icons/copilot-icon', () => ({ CopilotIcon: () => null }));
vi.mock('../loom-logo', () => ({ LoomLogo: () => null }));
vi.mock('../cloud-badge', () => ({ CloudBadge: () => null }));
vi.mock('../theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('../topbar-search', () => ({ TopbarSearch: () => null }));
vi.mock('../feedback-widget', () => ({ FeedbackWidget: () => null, openFeedback: () => {} }));
vi.mock('../error-boundary', () => ({
  GlobalErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  GlobalErrorListeners: () => null,
}));
vi.mock('../app-launcher', () => ({ AppLauncher: () => null }));
vi.mock('../workspace-switcher', () => ({ WorkspaceSwitcher: () => null }));
vi.mock('../object-explorer', () => ({ ObjectExplorer: () => null, toggleObjectExplorer: () => {} }));
vi.mock('../tab-strip', () => ({ TabStrip: () => null }));
vi.mock('../saved-status', () => ({ SavedStatus: () => null }));
vi.mock('../notifications-button', () => ({ NotificationsButton: () => null }));
vi.mock('../running-workloads-button', () => ({ RunningWorkloadsButton: () => null }));
vi.mock('../global-job-toaster', () => ({ GlobalJobToaster: () => null }));
vi.mock('../onboarding/onboarding-tour', () => ({ OnboardingTour: () => null, openTour: () => {} }));
vi.mock('../access/request-access-button', () => ({ RequestAccessButton: () => null }));
vi.mock('../time-machine/global-time-bar', () => ({ GlobalTimeBar: () => null }));

import { AppShell } from '../app-shell';

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const ME = { authenticated: true, user: { name: 'U', upn: 'u@x', oid: 'o' }, isTenantAdmin: true };
const mount = () => render(<FluentProvider theme={webLightTheme}><AppShell><div data-testid="page">PAGE</div></AppShell></FluentProvider>);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('AppShell mounts the paused banner', () => {
  // Breaks if: the <EstatePausedBanner /> line is removed from the shell (no page would show it).
  it('paused estate: the banner renders inside <main>, BEFORE the page content', async () => {
    clientFetch.mockImplementation(async (url: string) => {
      if (url === '/api/me') return json(ME);
      if (url === '/api/estate/paused') return json({ ok: true, paused: true, state: 'PAUSED', count: 2, names: ['loom-udf-runtime', 'loom-dab-preview'], pausedAt: '2026-10-22T01:04:00.000Z', pausedBy: 'a@x', pausedByKind: 'person', failure: null, canResume: true });
      return json({ ok: true });
    });
    mount();
    const banner = await screen.findByTestId('estate-paused-banner');
    const page = screen.getByTestId('page');
    expect(banner.closest('main')).toBe(page.closest('main'));
    // DOCUMENT_POSITION_FOLLOWING (4): the page follows the banner.
    expect(banner.compareDocumentPosition(page) & 4).toBe(4);
    expect(screen.getByText('2 services are paused to save cost')).toBeTruthy();
  });

  // Breaks if: a never-paused estate gets a banner (the shell would nag every user).
  it('fresh / never-paused estate: no banner, the page still renders', async () => {
    clientFetch.mockImplementation(async (url: string) => {
      if (url === '/api/me') return json(ME);
      if (url === '/api/estate/paused') return json({ ok: true, paused: false, canResume: true });
      return json({ ok: true });
    });
    mount();
    await waitFor(() => expect(clientFetch).toHaveBeenCalledWith('/api/estate/paused'));
    expect(screen.queryByTestId('estate-paused-banner')).toBeNull();
    expect(screen.getByTestId('page')).toBeTruthy();
  });
});
