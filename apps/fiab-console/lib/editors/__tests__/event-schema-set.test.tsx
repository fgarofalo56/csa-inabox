/**
 * EventSchemaSetEditor — vitest render + ribbon assertion.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EventSchemaSetEditor } from '../event-schema-set-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('EventSchemaSetEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
      '/api/items/event-schema-set': () => ({
        ok: true,
        workspaceId: 'ws-1',
        schemaSets: [{ id: 'ess-1', displayName: 'orders-domain', subjectCount: 2, compatibility: 'BACKWARD' }],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<EventSchemaSetEditor item={makeItem('event-schema-set', 'Event schema set')} id="new" />);
    await waitFor(() => { expect(screen.getByTestId('chrome')).toBeInTheDocument(); });
  });

  it('exposes ribbon actions', async () => {
    render(<EventSchemaSetEditor item={makeItem('event-schema-set', 'Event schema set')} id="new" />);
    await waitFor(() => {
      const buttons = screen.getByTestId('ribbon').querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });
});
