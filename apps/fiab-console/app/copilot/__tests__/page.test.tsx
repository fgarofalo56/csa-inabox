/**
 * /copilot landing — code-split guard + status-driven paint (Vitest, jsdom).
 *
 * Issue #2583: the landing chunk was too heavy to paint promptly on a cold
 * Front Door replica because `CopilotConsoleView` (the shared orchestrator
 * console — Transcript/markdown/Monaco, ToolsPanel, SessionList, the editor
 * ribbon) was pulled into the LANDING bundle by a top-level static import,
 * even though it's only needed AFTER "Launch Copilot". The fix code-splits it
 * behind `next/dynamic({ ssr:false })`.
 *
 * These specs lock in the behaviour the fix must preserve:
 *   - the status-driven landing paints its "Ready" hero chip + "Launch Copilot"
 *     CTA (the exact surface the G1 landing check waits for),
 *   - the honest AOAI infra-gate paints when the orchestrator isn't ready,
 *   - the heavy console is NOT mounted on the landing (it's code-split), and
 *   - clicking "Launch Copilot" DOES mount it (the Launch flow is unbroken).
 *
 * `next/dynamic` is stubbed to a sentinel so the test never imports the heavy
 * console module and can assert precisely whether it's mounted. Network is
 * caught by installFetchMock; next/navigation is stubbed by vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';

// Stub next/dynamic → a synchronous sentinel that IGNORES the loader, so the
// heavy `cross-item-copilot-editor` module is never imported here and we can
// assert whether the console is mounted purely from the `launched` gate.
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function LazyConsoleSentinel(props: { onBack?: () => void }) {
      return React.createElement(
        'div',
        { 'data-testid': 'lazy-console' },
        React.createElement('button', { onClick: props.onBack }, 'Back'),
      );
    },
}));

import CopilotPage from '../page';

const READY_STATUS = {
  ok: true,
  ready: true,
  aoai: { ok: true, deployment: 'gpt-5.6-luna' },
  tools: { count: 7, byService: { Synapse: 4, ADX: 3 } },
  sessions: { recent: 2 },
};
const GATED_STATUS = {
  ok: true,
  ready: false,
  aoai: { ok: false, error: 'endpoint unreachable', remediation: 'Set LOOM_AOAI_ENDPOINT.' },
  tools: { count: 7, byService: { Synapse: 4, ADX: 3 } },
  sessions: { recent: 0 },
};

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CopilotPage />
    </FluentProvider>,
  );
}

describe('/copilot landing (issue #2583 code-split guard)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('paints the Ready chip + Launch CTA without mounting the heavy console', async () => {
    installFetchMock({
      '/api/copilot/status': () => READY_STATUS,
      '/api/copilot/sessions': () => ({ ok: true, sessions: [] }),
    });
    mount();
    // The status-driven landing surface the G1 check waits for.
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Launch Copilot' })).toBeInTheDocument();
    // The console is code-split — it must NOT be in the landing render tree.
    expect(screen.queryByTestId('lazy-console')).toBeNull();
  });

  it('paints the honest AOAI infra-gate (not the console) when not ready', async () => {
    installFetchMock({
      '/api/copilot/status': () => GATED_STATUS,
      '/api/copilot/sessions': () => ({ ok: true, sessions: [] }),
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText('Orchestrator not fully ready')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Launch Copilot' })).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-console')).toBeNull();
  });

  it('mounts the console only after Launch Copilot is clicked (flow preserved)', async () => {
    installFetchMock({
      '/api/copilot/status': () => READY_STATUS,
      '/api/copilot/sessions': () => ({ ok: true, sessions: [] }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
    expect(screen.queryByTestId('lazy-console')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Launch Copilot' }));
    // The launched branch renders the (now code-split) console on demand.
    await waitFor(() => expect(screen.getByTestId('lazy-console')).toBeInTheDocument());
  });
});
