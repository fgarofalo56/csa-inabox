/**
 * ActivatorPane — vitest render + interaction.
 *
 * Mounts the workspace-level Activator overview with mocked
 * /api/loom/workspaces + /api/items/activator + .../rules + .../history
 * responses and confirms the pane is wired to REAL Azure Monitor BFF verbs
 * (per .claude/rules/no-vaporware.md — no seedRules useState):
 *   - workspace fetch fires on mount and the picker renders
 *   - rules load from the per-activator /rules route and render in LoomDataTable
 *   - the enable/disable toggle PATCHes .../rules?ruleId=&enabled=<opposite>
 *   - the delete button DELETEs .../rules?ruleId=
 *   - the Action history tab lazily loads from the /history route
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { ActivatorPane } from '../activator';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';

describe('ActivatorPane', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'Default Workspace' }],
      }),
      '/api/items/activator?workspaceId=': () => ({
        ok: true,
        activators: [{ id: 'act-1', displayName: 'Orders SLA' }],
      }),
      // PATCH/DELETE/GET all hit this prefix; the mock just returns ok.
      '/api/items/activator/act-1/rules': () => ({
        ok: true,
        rules: [
          {
            id: 'rule-1', name: 'Overdue orders', azureRuleName: 'orders-sla-overdue',
            query: 'AppEvents_CL\n| where overdue == true', severity: 2,
            evaluationFrequency: 'PT5M', windowSize: 'PT5M', state: 'Active',
            backend: 'azure-monitor',
          },
        ],
      }),
      '/api/items/activator/act-1/history': () => ({
        ok: true,
        events: [{
          id: 'alert-1', alertRule: 'orders-sla-overdue', monitorCondition: 'Fired',
          alertState: 'New', severity: 'Sev2', startDateTime: '2026-06-09T10:00:00Z',
        }],
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('fetches Loom workspaces on mount + auto-loads rules', async () => {
    render(<ActivatorPane />);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/items/activator?workspaceId=ws-1'))).toBe(true));
    await waitFor(() => expect(screen.getByText('Overdue orders')).toBeInTheDocument());
  });

  it('enable/disable PATCHes the rule with the opposite enabled state', async () => {
    render(<ActivatorPane />);
    await waitFor(() => expect(screen.getByText('Overdue orders')).toBeInTheDocument());
    // The active rule shows a "Disable" button.
    const disableBtn = await screen.findByRole('button', { name: /disable/i });
    fireEvent.click(disableBtn);
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH' && c.url.includes('/api/items/activator/act-1/rules'));
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain('ruleId=rule-1');
      expect(patch!.url).toContain('enabled=false');
    });
  });

  it('delete DELETEs the rule (after confirm)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ActivatorPane />);
    await waitFor(() => expect(screen.getByText('Overdue orders')).toBeInTheDocument());
    const delBtn = await screen.findByRole('button', { name: /delete overdue orders/i });
    fireEvent.click(delBtn);
    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === 'DELETE' && c.url.includes('/api/items/activator/act-1/rules'));
      expect(del).toBeTruthy();
      expect(del!.url).toContain('ruleId=rule-1');
    });
  });

  it('Action history tab lazily loads from the /history route', async () => {
    render(<ActivatorPane />);
    await waitFor(() => expect(screen.getByText('Overdue orders')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /action history/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/items/activator/act-1/history?workspaceId=ws-1'))).toBe(true));
  });
});
