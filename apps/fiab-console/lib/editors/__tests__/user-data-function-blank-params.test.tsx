/**
 * UserDataFunctionEditor — Test/Run panel blank-parameter handling (#3574).
 *
 * Bug: a blank Run/Test panel parameter was sent to the runtime as an
 * explicit `null` instead of being omitted (letting the function's own
 * default apply) or validated client-side before dispatch.
 * `compute_score(user_id: str, weight: float = 1.0)` invoked with
 * `user_id="vnv-user-1"` and a blank `weight` sent `{"weight": null}`, and
 * the runtime raised "unsupported operand type(s) for *: 'NoneType' and
 * 'int'" on `weight * 42` — a raw Python traceback surfaced to the user
 * (.claude/rules/deploy-integrity.md R6 violation).
 *
 * These specs prove the fix in user-data-function-editor.tsx's `runTest`:
 *
 *  1. A blank param that DECLARES a default (`weight`, default "1.0") is
 *     OMITTED from the invoke payload entirely — never sent as `null` — so
 *     the function's own default applies.
 *  2. A blank param with NO declared default (`user_id`) BLOCKS Run
 *     client-side: no invoke request is dispatched, and the field shows an
 *     inline validation message naming the missing parameter.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { UserDataFunctionEditor } from '../phase4-editors';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

describe('UserDataFunctionEditor — blank Test/Run parameters (#3574)', () => {
  // vitest runs with globals:false, so @testing-library/react never registers
  // its automatic afterEach(cleanup) — unmount between tests (see sibling
  // stream-analytics-job.test.tsx) so a stale tree from test 1 doesn't leave
  // duplicate labeled inputs for test 2's queries.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('omits a blank param that declares a default, rather than sending null', async () => {
    const { calls } = installFetchMock({
      '/invoke': () => ({ ok: true, status: 200, body: '{"user": "vnv-user-1", "score": 42.0}' }),
    });
    renderWithProviders(
      <UserDataFunctionEditor item={makeItem('user-data-function', 'User data function')} id="new" />,
    );

    const userIdInput = (await screen.findByLabelText('user_id : str')) as HTMLInputElement;
    fireEvent.change(userIdInput, { target: { value: 'vnv-user-1' } });
    // Leave `weight` blank — its signature declares `default: "1.0"`.

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/invoke'))).toBe(true);
    });
    const invoke = calls.find((c) => c.url.includes('/invoke'))!;
    const body = JSON.parse(String(invoke.init!.body));
    expect(body.functionName).toBe('compute_score');
    expect(body.parameters).toEqual({ user_id: 'vnv-user-1' });
    expect(body.parameters).not.toHaveProperty('weight');

    // Run succeeded (no MessageBar "Run failed" — the runtime's own default
    // applied server-side, matching the sample function's real behaviour).
    await screen.findByText(/"score": 42\.0/);
    expect(screen.queryByText('Run failed')).not.toBeInTheDocument();
  });

  it('blocks Run and flags the field when a param with no default is left blank', async () => {
    const { calls } = installFetchMock({
      '/invoke': () => ({ ok: true, status: 200, body: '{"user": null, "score": 105}' }),
    });
    renderWithProviders(
      <UserDataFunctionEditor item={makeItem('user-data-function', 'User data function')} id="new" />,
    );

    const weightInput = (await screen.findByLabelText(/weight : float/)) as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: '2.5' } });
    // Leave `user_id` blank — its signature declares no default.

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    await screen.findByText('Required — compute_score declares no default for this parameter.');
    expect(calls.some((c) => c.url.includes('/invoke'))).toBe(false);
  });
});
