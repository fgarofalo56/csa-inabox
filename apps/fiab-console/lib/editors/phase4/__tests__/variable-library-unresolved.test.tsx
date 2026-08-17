/**
 * VariableLibraryEditor — unresolved-reference warning (#3575).
 *
 * `expandVariables()` (lib/variables/resolve.ts) deliberately leaves an
 * unknown `@{variables.NAME}` reference verbatim rather than blanking it —
 * that is correct, documented behavior. The bug #3575 reported was that the
 * UI gave the user ZERO signal this had happened: input equals output with
 * no explanation reads as a broken/no-op Resolve button.
 *
 * These specs prove:
 *   1. A fresh, untouched item shows no unresolved-reference banner on mount
 *      (ux-baseline.md — no error banners on first open).
 *   2. After clicking Resolve against a server-side variable set that is
 *      missing one of the referenced names, the editor surfaces a
 *      MessageBar (intent="warning") naming exactly that missing variable —
 *      computed by diffing `referencedVariableNames()` against the names the
 *      resolve API actually returned, not a new regex.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VariableLibraryEditor } from '../variable-library-editor';
import { makeItem, installFetchMock, renderWithProviders } from '../../__tests__/test-helpers';

describe('VariableLibraryEditor — unresolved reference warning', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows no unresolved-reference banner on first open of a saved item', async () => {
    installFetchMock({
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Test Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    renderWithProviders(<VariableLibraryEditor item={makeItem('variable-library', 'Variable library')} id="lib1" />);
    await waitFor(() => expect(screen.getByTestId('main-panel')).toBeInTheDocument());
    expect(screen.queryByText(/reference.*left unresolved/i)).not.toBeInTheDocument();
  });

  it('names the specific unresolved variable after Resolve returns a partial set', async () => {
    installFetchMock({
      '/api/items/variable-library/lib1/resolve': () => ({
        ok: true,
        // Server-side set only has ENV — BatchSize (referenced in the default
        // expandText) is absent, so expandVariables() left it verbatim.
        resolved: [{ name: 'ENV', type: 'string', value: 'dev', secret: false }],
        expanded: 'dev/batch?size=@{variables.BatchSize}',
      }),
      '/api/items/variable-library/lib1': () => ({
        id: 'lib1',
        displayName: 'Test Library',
        state: { variables: [{ name: 'ENV', type: 'string', default: 'dev' }] },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VariableLibraryEditor item={makeItem('variable-library', 'Variable library')} id="lib1" />);
    const main = await waitFor(() => screen.getByTestId('main-panel'));

    // No banner before the user has clicked Resolve.
    expect(within(main).queryByText(/reference.*left unresolved/i)).not.toBeInTheDocument();

    const resolveBtn = await waitFor(() => within(main).getByRole('button', { name: /^Resolve$/ }));
    await user.click(resolveBtn);

    await waitFor(() => expect(within(main).getByText(/1 reference left unresolved/i)).toBeInTheDocument());
    expect(within(main).getByText('BatchSize')).toBeInTheDocument();
    // ENV resolved cleanly — it must NOT be reported as unresolved.
    expect(within(main).queryByText(/^ENV$/, { selector: 'code' })).not.toBeInTheDocument();
  });
});
