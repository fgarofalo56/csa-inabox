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
 *
 * PR #3692 review added three more, closing the same silent-coercion family
 * the original fix left open in the typed-coercion branch, plus the evidence
 * loss the friendly summary introduced:
 *
 *  3. A whitespace-only numeric entry is blank, not `Number('  ') === 0`.
 *  4. Unparseable numeric text blocks Run instead of sending `NaN`, which
 *     `JSON.stringify` serialises as the very `null` #3574 removed.
 *  5. The raw traceback stays reachable next to the friendly summary — a
 *     summary that destroys the evidence leaves nothing to debug with
 *     (.claude/rules/deploy-integrity.md R6/R7).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { UserDataFunctionEditor } from '../phase4-editors';
import { paramInputKind } from '../phase4/user-data-function-editor';
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

  // ── PR #3692 review — the same silent-coercion family as #3574 ────────────
  //
  // `Number('')` and `Number('   ')` are both 0, and `Number('abc')` is NaN
  // which `JSON.stringify` serialises as `null`. So the typed-coercion branch
  // could invent a real 0 the user never typed, or re-create the exact `None`
  // #3574 was written to eliminate.

  it('treats a whitespace-only numeric entry as blank, never as Number(" ") === 0', async () => {
    const { calls } = installFetchMock({
      '/invoke': () => ({ ok: true, status: 200, body: '{"user": "u1", "score": 42.0}' }),
    });
    renderWithProviders(
      <UserDataFunctionEditor item={makeItem('user-data-function', 'User data function')} id="new" />,
    );

    fireEvent.change(await screen.findByLabelText('user_id : str'), { target: { value: 'u1' } });
    fireEvent.change(await screen.findByLabelText(/weight : float/), { target: { value: '   ' } });

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => { expect(calls.some((c) => c.url.includes('/invoke'))).toBe(true); });
    const body = JSON.parse(String(calls.find((c) => c.url.includes('/invoke'))!.init!.body));
    // Omitted so the function's declared default applies — NOT sent as 0.
    expect(body.parameters).toEqual({ user_id: 'u1' });
    expect(body.parameters.weight).toBeUndefined();
  });

  it('blocks Run on unparseable numeric text instead of sending JSON null', async () => {
    const { calls } = installFetchMock({
      '/invoke': () => ({ ok: true, status: 200, body: '{}' }),
    });
    renderWithProviders(
      <UserDataFunctionEditor item={makeItem('user-data-function', 'User data function')} id="new" />,
    );

    fireEvent.change(await screen.findByLabelText('user_id : str'), { target: { value: 'u1' } });
    fireEvent.change(await screen.findByLabelText(/weight : float/), { target: { value: 'abc' } });

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    // Previously this dispatched {"weight": null} — JSON.stringify(NaN) is null.
    await screen.findByText(/is not a valid float/);
    expect(calls.some((c) => c.url.includes('/invoke'))).toBe(false);
  });

  it('keeps the raw traceback reachable next to the friendly summary', async () => {
    const RAW = [
      'Traceback (most recent call last):',
      '  File "/app/app.py", line 88, in invoke',
      '    result = fn(**params)',
      '  File "<udf-source>", line 7, in compute_score',
      '    return {"score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    ].join('\n');
    installFetchMock({
      '/invoke': () => ({
        ok: false,
        status: 400,
        body: 'The function raised TypeError: unsupported operand type(s).',
        detail: RAW,
      }),
    });
    renderWithProviders(
      <UserDataFunctionEditor item={makeItem('user-data-function', 'User data function')} id="new" />,
    );

    fireEvent.change(await screen.findByLabelText('user_id : str'), { target: { value: 'u1' } });
    fireEvent.change(await screen.findByLabelText(/weight : float/), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    // The summary is what the user sees first — never the traceback.
    await screen.findByText('Run failed');
    expect(screen.queryByText(/Traceback \(most recent call last\)/)).not.toBeInTheDocument();

    // But the traceback is NOT destroyed: it is one click away.
    fireEvent.click(await screen.findByRole('button', { name: /Show full traceback/ }));
    const shown = await screen.findByText(/Traceback \(most recent call last\)/);
    expect(shown.textContent).toContain('line 7, in compute_score');
  });
});

// ── PR #3692 second review, finding 14 ─────────────────────────────────────
//
// `/int|float|number|decimal/.test(type)` matched the `int` INSIDE `List[int]`,
// so the Test panel rendered that field as numeric and then rejected every
// value a list can take: `Enter a number — "[1, 2]" is not a valid List[int]`.
// The field became impossible to fill. `Optional[float]` tripped the same
// substring test from the other direction — it IS a float, merely nullable, so
// it must still coerce.
describe('paramInputKind — only a genuinely scalar annotation is coerced', () => {
  it.each([
    ['int', 'number'],
    ['float', 'number'],
    ['Decimal', 'number'],
    ['bool', 'bool'],
    ['str', 'text'],
    [undefined, 'text'],
  ])('classifies the scalar %s as %s', (type, kind) => {
    expect(paramInputKind(type as string | undefined)).toBe(kind);
  });

  it.each([
    'List[int]', 'list[int]', 'Dict[str, int]', 'Tuple[int, int]',
    'Set[float]', 'Sequence[bool]', 'Optional[Dict[str, int]]',
  ])('does NOT treat the container %s as a scalar', (type) => {
    expect(paramInputKind(type)).toBe('text');
  });

  it.each([
    ['Optional[float]', 'number'],
    ['Union[int, None]', 'number'],
    ['float | None', 'number'],
    ['Optional[bool]', 'bool'],
  ])('unwraps the nullable scalar %s to %s', (type, kind) => {
    expect(paramInputKind(type)).toBe(kind);
  });
});
