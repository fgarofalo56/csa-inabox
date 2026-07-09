/**
 * CopilotBuilderPane (G1) — render + contract tests.
 *
 * The shared inline Copilot builder pane renders its intro, prompt field, and
 * checkpoints section; propose posts { action:'propose', prompt } and renders
 * the returned plan ops (badge + describe); apply posts { action:'apply', plan }
 * and calls onApplied. These jsdom tests exercise the REAL component with a
 * mocked fetch — no network, no AOAI.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CopilotBuilderPane } from '../copilot-builder-pane';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const baseProps = {
  endpoint: '/api/items/eventstream/es1/assist',
  title: 'Copilot — build the topology',
  intro: 'Describe a change.',
  fieldLabel: 'Ask Copilot',
  placeholder: 'e.g. add a filter',
};

afterEach(cleanup);
beforeEach(() => { vi.restoreAllMocks(); });

function mockFetch(routes: Record<string, any>) {
  return vi.fn(async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const key = init?.method === 'POST' ? `POST:${body.action}` : 'GET';
    const data = routes[key] ?? { ok: true, checkpoints: [] };
    return { ok: true, status: 200, json: async () => data } as any;
  });
}

describe('CopilotBuilderPane', () => {
  it('renders the intro, prompt field, and checkpoints section', async () => {
    vi.stubGlobal('fetch', mockFetch({ GET: { ok: true, checkpoints: [] } }));
    wrap(<CopilotBuilderPane {...baseProps} />);
    expect(screen.getByText('Copilot — build the topology')).toBeInTheDocument();
    expect(screen.getByText('Describe a change.')).toBeInTheDocument();
    expect(screen.getByText('Ask Copilot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Propose edits/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No checkpoints yet/i)).toBeInTheDocument());
  });

  it('proposes a plan and renders the returned ops', async () => {
    vi.stubGlobal('fetch', mockFetch({
      GET: { ok: true, checkpoints: [] },
      'POST:propose': { ok: true, plan: { summary: '1 edit', ops: [{ kind: 'add-transform', describe: 'Add filter “only-errors”', badge: 'Add transform', badgeColor: 'brand' }] } },
    }));
    wrap(<CopilotBuilderPane {...baseProps} />);
    fireEvent.change(screen.getByLabelText('Ask Copilot'), { target: { value: 'add a filter' } });
    fireEvent.click(screen.getByRole('button', { name: /Propose edits/i }));
    await waitFor(() => expect(screen.getByText('Add filter “only-errors”')).toBeInTheDocument());
    expect(screen.getByText('Proposed plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply 1 edit/i })).toBeInTheDocument();
  });

  it('surfaces an honest gate when propose returns a gate', async () => {
    vi.stubGlobal('fetch', mockFetch({
      GET: { ok: true, checkpoints: [] },
      'POST:propose': { ok: false, error: 'no aoai', gate: { missing: 'LOOM_AOAI_ENDPOINT', detail: 'Set the endpoint.' } },
    }));
    wrap(<CopilotBuilderPane {...baseProps} />);
    fireEvent.change(screen.getByLabelText('Ask Copilot'), { target: { value: 'add a filter' } });
    fireEvent.click(screen.getByRole('button', { name: /Propose edits/i }));
    await waitFor(() => expect(screen.getByText(/Copilot not configured/i)).toBeInTheDocument());
    expect(screen.getByText('Set the endpoint.')).toBeInTheDocument();
  });

  it('applies an approved plan and calls onApplied', async () => {
    const onApplied = vi.fn();
    vi.stubGlobal('fetch', mockFetch({
      GET: { ok: true, checkpoints: [] },
      'POST:propose': { ok: true, plan: { summary: '1 edit', ops: [{ kind: 'add-transform', describe: 'Add filter', badge: 'Add transform', badgeColor: 'brand' }] } },
      'POST:apply': { ok: true, note: 'Applied.', applied: ['Added filter.'], skipped: [] },
    }));
    wrap(<CopilotBuilderPane {...baseProps} onApplied={onApplied} />);
    fireEvent.change(screen.getByLabelText('Ask Copilot'), { target: { value: 'add a filter' } });
    fireEvent.click(screen.getByRole('button', { name: /Propose edits/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Apply 1 edit/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Apply 1 edit/i }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Edits applied')).toBeInTheDocument();
  });
});
