/**
 * EventGridTopicEditor — UX-baseline render test (UX-Wave 2, UX-206).
 *
 * Verifies the SC-4 GuidedEmptyState replaces the bare "no topics" banner when
 * the topic list is empty, and that the topic fetch fires on mount. Backend
 * wiring is unchanged (mocked /api/items/event-grid-topic).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { EventGridTopicEditor } from '../event-grid-topic-editor';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

describe('EventGridTopicEditor — UX baseline', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/event-grid-topic': () => ({ ok: true, topics: [] }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches topics on mount and renders the guided empty state', async () => {
    renderWithProviders(<EventGridTopicEditor item={makeItem('event-grid-topic', 'Event Grid')} id="egt" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/event-grid-topic'))).toBe(true);
    });
    // SC-4 GuidedEmptyState — a guided launcher, not a bare MessageBar.
    expect(await screen.findByText(/Create your first custom topic/i)).toBeInTheDocument();
    expect(screen.getByText(/New custom topic/i)).toBeInTheDocument();
  });
});
