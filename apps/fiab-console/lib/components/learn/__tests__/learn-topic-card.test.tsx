/**
 * LearnTopicCard — "Install live example" wiring render tests (audit-t38).
 *
 * The task goal: an appId-bearing use-case card must surface a WORKING Install
 * button (not just a doc link). Before audit-t38 the card "opened a doc today";
 * now the button mounts the shared <InstallAppDialog appId=…> which runs the
 * real install → provision → seed flow.
 *
 * These jsdom render tests exercise the REAL LearnTopicCard and assert the card
 * side of the contract:
 *   1. A topic WITH `appId` renders the "Install live example" primary button.
 *   2. Clicking it opens the InstallAppDialog with the topic's appId + title
 *      (this is the wiring that was missing — the dialog drives the POST
 *      /api/apps/{appId}/install flow, covered by its own jobs-store + the
 *      use-case-apps UAT).
 *   3. A topic WITHOUT `appId` renders NO Install button (no phantom control,
 *      no dead button per no-vaporware.md).
 *
 * The InstallAppDialog is replaced with a prop-capturing stub so the test stays
 * a focused unit on the card's wiring and does not drag in the jobs-store /
 * fetch / workspace-picker machinery (those have their own coverage). The stub
 * still proves the card passes the correct appId + open state through.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { LearnTopic } from '@/lib/learn/content';

// Capture the props the card hands to the install dialog. The stub renders a
// marker only when `open` so a click-to-open assertion is observable in jsdom.
const dialogProps: Array<{ appId: string; appName: string; open: boolean }> = [];
vi.mock('@/lib/components/apps/install-app-dialog', () => ({
  InstallAppDialog: (p: { appId: string; appName: string; open: boolean }) => {
    dialogProps.push({ appId: p.appId, appName: p.appName, open: p.open });
    return p.open
      ? (
        <div data-testid="install-dialog">
          install-dialog:{p.appId}:{p.appName}
        </div>
      )
      : null;
  },
}));

// Import AFTER the mock is registered so the card picks up the stub.
const { LearnTopicCard } = await import('../learn-topic-card');

const BASE: LearnTopic = {
  id: 'usecase:rti-anomaly',
  title: 'Real-Time Anomaly Detection',
  summary: 'Fraud + anomaly detection on streaming data.',
  section: 'Use cases',
  category: 'Real-Time',
  visualType: 'activator',
  primaryUrl: 'https://docs.example/use-cases/realtime',
  primaryLabel: 'Walkthrough',
  hasLoomDoc: true,
};

function renderCard(topic: LearnTopic) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <LearnTopicCard topic={topic} />
    </FluentProvider>,
  );
}

afterEach(() => {
  cleanup();
  dialogProps.length = 0;
});

describe('LearnTopicCard install wiring', () => {
  it('renders an "Install live example" button when the topic has an appId', () => {
    renderCard({ ...BASE, appId: 'app-iot-realtime', appHref: '/apps/app-iot-realtime', appLabel: 'Install app' });
    expect(screen.getByRole('button', { name: /install live example/i })).toBeInTheDocument();
  });

  it('opens the InstallAppDialog with the topic appId + title when clicked', () => {
    renderCard({ ...BASE, appId: 'app-iot-realtime', appHref: '/apps/app-iot-realtime', appLabel: 'Install app' });

    // Dialog mounts closed first.
    expect(screen.queryByTestId('install-dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /install live example/i }));

    const dlg = screen.getByTestId('install-dialog');
    expect(dlg).toBeInTheDocument();
    expect(dlg.textContent).toContain('install-dialog:app-iot-realtime:Real-Time Anomaly Detection');

    // The card handed the dialog the topic's appId (the input to POST
    // /api/apps/{appId}/install) and flipped open=true on click.
    const opened = dialogProps.filter((p) => p.open);
    expect(opened.length).toBeGreaterThan(0);
    expect(opened[opened.length - 1]).toMatchObject({
      appId: 'app-iot-realtime',
      appName: 'Real-Time Anomaly Detection',
      open: true,
    });
  });

  it('renders NO Install button when the topic has no appId (no dead control)', () => {
    renderCard({ ...BASE, id: 'usecase:no-app' });
    expect(screen.queryByRole('button', { name: /install live example/i })).toBeNull();
    expect(screen.queryByTestId('install-dialog')).toBeNull();
  });
});
