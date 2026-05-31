/**
 * DbtJobEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { DbtJobEditor } from '../phase2-misc-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('DbtJobEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [] }),
      '/api/items/dbt-job/dj-1/runs': () => ({ ok: true, runs: [] }),
      '/api/items/dbt-job/dj-1': () => ({
        ok: true,
        item: {
          id: 'dj-1',
          workspaceId: 'ws-1',
          displayName: 'dbt-fixture',
          state: { spec: { projectDir: 'analytics', dbtCommand: 'run', target: 'prod' } },
        },
      }),
    });
  });
  // globals:false in vitest.config means @testing-library's auto-afterEach
  // cleanup never registers, so each render() would otherwise pile up in the
  // same jsdom document.body — making getByTestId('ribbon') find duplicates.
  // Unmount explicitly between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<DbtJobEditor item={makeItem('dbt-job', 'dbt job')} id="dj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions', async () => {
    render(<DbtJobEditor item={makeItem('dbt-job', 'dbt job')} id="dj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
    // Assert the editor's real ribbon actions are present, not just any buttons:
    // a Save/Saved toggle, the primary "Run dbt" action, and "Refresh" runs.
    const ribbon = screen.getByTestId('ribbon');
    const labels = Array.from(ribbon.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toContain('Run dbt');
    expect(labels).toContain('Refresh');
    // Save toggle reads "Saved" when there are no unsaved edits.
    expect(labels.some((l) => l === 'Save' || l === 'Saved')).toBe(true);
  });
});
