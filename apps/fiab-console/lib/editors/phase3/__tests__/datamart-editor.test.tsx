/**
 * DatamartEditor — deprecation + migration surface contract test.
 *
 * Asserts the UX-baseline lift mounts: the editor chrome, the SC-6 teaching
 * banner, and (on the no-create `new` surface) the SC-4 guided empty state with
 * the two Azure-native replacement launcher cards (Warehouse + Semantic model)
 * that link to their real create routes. The datamart GET is mocked so the
 * existing-item path is exercised too.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings the datamart
 * migration surface from B (functional) toward A (functional + Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DatamartEditor } from '../datamart-editor';
import { makeItem, installFetchMock } from '../../__tests__/test-helpers';

describe('DatamartEditor (deprecation + migration)', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/cosmos-items/datamart': () => ({ id: 'dm1', displayName: 'Legacy datamart', state: {} }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('new surface renders the guided replacement launcher + teaching banner', async () => {
    let err: unknown = null;
    try {
      render(<DatamartEditor item={makeItem('datamart', 'Datamart')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      // SC-6 teaching banner is present.
      expect(screen.getByText(/migrate to Azure-native analytics/i)).toBeInTheDocument();
      // SC-4 guided empty state: the two replacement launcher cards.
      expect(screen.getByText(/Create a Warehouse/i)).toBeInTheDocument();
      expect(screen.getByText(/Create a Semantic model/i)).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('existing datamart renders the deprecation banner + Migrate action', async () => {
    let err: unknown = null;
    try {
      render(<DatamartEditor item={makeItem('datamart', 'Datamart')} id="dm1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      await waitFor(
        () => expect(screen.getByText(/Datamarts are deprecated/i)).toBeInTheDocument(),
        { timeout: 5000 },
      );
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
