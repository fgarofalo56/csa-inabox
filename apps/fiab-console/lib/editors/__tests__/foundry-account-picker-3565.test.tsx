/**
 * #3565 — AccountPickerBar must not auto-select an arbitrary account, and a
 * non-default selection must have a way back.
 *
 * THE DEFECT, restated as the property under test: the preselect effect ended
 * `|| accounts[0]`. When `defaultAccount` did not resolve, whatever row Azure
 * Resource Graph happened to return first became the account every tab in the
 * editor queried — silently, and with a "default" badge that only ever appeared
 * on the already-selected chip, so nothing on screen distinguished the
 * Loom-bound account from an unrelated one. There was then no control that
 * returned to the auto-bound account.
 *
 * The ORDER of the fixture is load-bearing: `unrelated-cs-account` is FIRST, so
 * a reintroduced `accounts[0]` fallback selects it and these tests go red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { AccountPickerBar, type FoundryAccount } from '../foundry-account-picker-bar';
import { installFetchMock } from './test-helpers';

const UNRELATED: FoundryAccount = {
  id: '/subscriptions/s1/resourceGroups/rg-other/providers/Microsoft.CognitiveServices/accounts/unrelated-cs-account',
  name: 'unrelated-cs-account', kind: 'OpenAI', location: 'westus', resourceGroup: 'rg-other',
};
const LOOM: FoundryAccount = {
  id: '/subscriptions/s1/resourceGroups/rg-csa-loom/providers/Microsoft.CognitiveServices/accounts/aoai-csa-loom',
  name: 'aoai-csa-loom', kind: 'AIServices', location: 'eastus2', resourceGroup: 'rg-csa-loom',
};

/** Host that owns `acct` exactly the way FoundryHubEditor does. */
function Harness({ onSelectSpy }: { onSelectSpy?: (a: FoundryAccount | null) => void }) {
  const [acct, setAcct] = useState<FoundryAccount | null>(null);
  return (
    <AccountPickerBar
      acct={acct}
      onSelect={(a) => { onSelectSpy?.(a); setAcct(a); }}
    />
  );
}

function mockAccounts(defaultAccount?: string) {
  return installFetchMock({
    '/api/foundry/accounts': () => ({
      ok: true,
      accounts: [UNRELATED, LOOM],
      ...(defaultAccount ? { defaultAccount } : {}),
    }),
  });
}

describe('AccountPickerBar — no arbitrary auto-selection (#3565)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('selects NOTHING when no Loom-managed default resolves', async () => {
    mockAccounts(undefined);
    const spy = vi.fn();
    render(<Harness onSelectSpy={spy} />);

    // PROVE THE POPULATION LOADED before asserting an absence. An earlier draft
    // waited on the caption's "LOOM_AOAI_ACCOUNT is unset" text — which the
    // restore Button's Tooltip ALSO renders as its aria description, on the
    // FIRST paint, before any fetch resolved. The wait therefore returned
    // instantly and "nothing was selected" was true only because nothing had
    // loaded yet: the assertion passed against the defect it exists to catch.
    // Waiting on the OPTIONS makes the denominator real.
    fireEvent.click(await screen.findByRole('combobox'));
    await screen.findByRole('option', { name: new RegExp(UNRELATED.name) });
    await screen.findByRole('option', { name: new RegExp(LOOM.name) });

    // THE assertion: the first Resource Graph row was not adopted.
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ name: UNRELATED.name }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('selects the Loom-managed default even when it is not first in the list', async () => {
    mockAccounts(LOOM.name);
    const spy = vi.fn();
    render(<Harness onSelectSpy={spy} />);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: LOOM.name }));
    });
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ name: UNRELATED.name }));
  });

  it('says WHICH default it could not resolve when the env names a missing account', async () => {
    mockAccounts('aoai-that-was-deleted');
    render(<Harness />);
    // The name only appears in the caption — the Tooltip's description names no
    // account — so this text is an unambiguous oracle for the caption itself.
    await waitFor(() => {
      expect(screen.getByText(/aoai-that-was-deleted/)).toBeInTheDocument();
    });
  });
});

describe('AccountPickerBar — recovery path (#3565)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('offers an ENABLED restore control after a non-default account is selected', async () => {
    mockAccounts(LOOM.name);
    const spy = vi.fn();
    render(<Harness onSelectSpy={spy} />);
    // Settle on the default first.
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: LOOM.name })));

    const restore = screen.getByRole('button', { name: /Use the Loom-managed default/i });
    // On the default there is nothing to restore, so the control is disabled —
    // an enabled button that does nothing would be the dead end
    // auto-bind-by-default.md forbids.
    expect(restore).toBeDisabled();

    // Move to the unrelated account through the real Dropdown.
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(UNRELATED.name) }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: UNRELATED.name })));

    const restoreNow = screen.getByRole('button', { name: /Use the Loom-managed default/i });
    expect(restoreNow).toBeEnabled();

    // And it actually goes back.
    spy.mockClear();
    fireEvent.click(restoreNow);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: LOOM.name })));
  });

  it('marks the Loom default in the OPTIONS, not only on the selected chip', async () => {
    mockAccounts(LOOM.name);
    render(<Harness />);
    fireEvent.click(await screen.findByRole('combobox'));
    const loomOption = await screen.findByRole('option', { name: new RegExp(LOOM.name) });
    expect(loomOption.textContent).toMatch(/Loom default/i);
    const otherOption = screen.getByRole('option', { name: new RegExp(UNRELATED.name) });
    expect(otherOption.textContent).not.toMatch(/Loom default/i);
  });
});

describe('AccountPickerBar — cross-subscription pickers are secondary (#3565)', () => {
  beforeEach(() => { mockAccounts(LOOM.name); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps the any-subscription pickers behind an explicit disclosure', async () => {
    render(<Harness />);
    const toggle = await screen.findByRole('button', { name: /another subscription/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/any subscription/i)).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Hide other subscriptions/i })).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
