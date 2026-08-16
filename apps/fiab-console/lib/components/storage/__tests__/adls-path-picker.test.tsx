/**
 * AdlsPathPicker / AdlsBrowseDialog — the promoted lake-location picker.
 *
 * The behaviours that make it adoptable by the 33 `abfss://` asks:
 *   - it walks an ARBITRARY account, not just the four DLZ containers;
 *   - when account-scope container enumeration is DENIED (a container-scope-only
 *     grant, common in Gov) it falls back to the DLZ containers rather than
 *     showing a dead end, and says which it is showing;
 *   - an existing value is parsed back into account/container/prefix so the
 *     browser opens where the value points, and a value it cannot parse is kept
 *     rather than blanked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => fetchMock(...a) }));

import { AdlsPathPicker, AdlsBrowseDialog, parseAdlsLocation, toAbfss } from '../adls-path-picker';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

const URI = 'abfss://bronze@loomlake01.dfs.core.windows.net/Tables/orders';

/** The ARG row the shared storage-account discovery returns. */
const ACCOUNT_ROW = {
  id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/loomlake01',
  name: 'loomlake01',
  type: 'microsoft.storage/storageaccounts',
  location: 'eastus2',
  resourceGroup: 'rg',
  subscriptionId: 's1',
};

/** Choose the account through the shared picker, the way a user would. */
async function pickAccount() {
  const combo = await screen.findByRole('combobox');
  fireEvent.click(combo);
  fireEvent.click(await screen.findByRole('option', { name: /loomlake01/ }));
}

afterEach(cleanup);
// NOT `beforeEach(() => fetchMock.mockReset())`: `mockReset()` RETURNS the mock,
// and vitest treats a value returned from a hook as a cleanup function — so it
// calls the spy with no arguments after every test, and any mockImplementation
// that reads its first argument throws inside the teardown.
beforeEach(() => { fetchMock.mockReset(); });

describe('URI round-trip', () => {
  it('parses an abfss URI back into account / host / container / path', () => {
    expect(parseAdlsLocation(URI)).toEqual({
      account: 'loomlake01',
      host: 'loomlake01.dfs.core.windows.net',
      container: 'bronze',
      path: 'Tables/orders',
    });
  });

  it('parses a sovereign https URL too (the Gov suffix must survive)', () => {
    expect(parseAdlsLocation('https://govlake.dfs.core.usgovcloudapi.net/raw/x/y')).toEqual({
      account: 'govlake',
      host: 'govlake.dfs.core.usgovcloudapi.net',
      container: 'raw',
      path: 'x/y',
    });
  });

  it('returns null for something that is not a lake URI', () => {
    expect(parseAdlsLocation('just-a-name')).toBeNull();
    expect(parseAdlsLocation(undefined)).toBeNull();
  });

  it('composes the URI from the account\'s OWN host, never a hard-coded suffix', () => {
    expect(toAbfss('bronze', 'govlake.dfs.core.usgovcloudapi.net', '/Tables/x'))
      .toBe('abfss://bronze@govlake.dfs.core.usgovcloudapi.net/Tables/x');
  });
});

describe('AdlsPathPicker', () => {
  it('shows the selected location as a READ-ONLY receipt, not as something to type', () => {
    wrap(<AdlsPathPicker value={URI} onChange={() => {}} />);
    const box = screen.getByLabelText('Lake location (selected)') as HTMLInputElement;
    expect(box.value).toBe(URI);
    expect(box.readOnly).toBe(true);
    expect(screen.getByText(/loomlake01 · bronze · Tables\/orders/)).toBeInTheDocument();
  });

  it('KEEPS a stored value it cannot parse instead of blanking it', () => {
    wrap(<AdlsPathPicker value="s3://legacy-bucket/data" onChange={() => {}} />);
    expect((screen.getByLabelText('Lake location (selected)') as HTMLInputElement).value)
      .toBe('s3://legacy-bucket/data');
    expect(screen.getByText(/Stored value kept as-is/)).toBeInTheDocument();
  });
});

describe('AdlsBrowseDialog', () => {
  it('walks an ARBITRARY account: containers then paths', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/containers?') || url.endsWith('/containers')) {
        return Promise.resolve(jsonRes({
          ok: true, account: 'loomlake01', host: 'loomlake01.dfs.core.windows.net',
          containers: [{ name: 'bronze', url: 'https://loomlake01.dfs.core.windows.net/bronze' }],
        }));
      }
      if (url.includes('/paths')) {
        return Promise.resolve(jsonRes({ ok: true, paths: [{ name: 'Tables', isDirectory: true, size: 0 }] }));
      }
      return Promise.resolve(jsonRes({ ok: true, resources: [], via: 'user' }));
    });

    const onPick = vi.fn();
    wrap(<AdlsBrowseDialog open initialUri={URI} onClose={() => {}} onPick={onPick} />);

    // Primed from the existing value: it opens on bronze/Tables/orders.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/containers/bronze/paths'))).toBe(true));

    fireEvent.click(await screen.findByRole('button', { name: /use this folder/i }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
      uri: 'abfss://bronze@loomlake01.dfs.core.windows.net/Tables/orders',
      account: 'loomlake01',
      container: 'bronze',
      kind: 'folder',
    }));
  });

  it('falls back to the DLZ containers when account-scope enumeration is DENIED', async () => {
    // A container-scope-only grant is common in Gov. The alternative to this
    // fallback is a dead end, which auto-bind-by-default.md forbids.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/azure/resources')) return Promise.resolve(jsonRes({ ok: true, via: 'user', resources: [ACCOUNT_ROW] }));
      if (url.includes('/api/storage/')) {
        return Promise.resolve(jsonRes({ ok: false, error: 'Storage denied the listing…' }, 403));
      }
      if (url.includes('/api/lakehouse/containers')) {
        return Promise.resolve(jsonRes({
          containers: [{ name: 'bronze', url: 'https://loomlake01.dfs.core.windows.net/bronze' }],
        }));
      }
      return Promise.resolve(jsonRes({ ok: true, resources: [], via: 'user' }));
    });

    wrap(<AdlsBrowseDialog open onClose={() => {}} onPick={() => {}} />);
    await pickAccount();
    expect(await screen.findByText(/known containers/i)).toBeInTheDocument();
    expect(await screen.findByText('bronze')).toBeInTheDocument();
  });

  it('when nothing can be listed at all, the user can still open a container by name', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/azure/resources')) return Promise.resolve(jsonRes({ ok: true, via: 'user', resources: [ACCOUNT_ROW] }));
      if (url.includes('/api/storage/')) return Promise.resolve(jsonRes({ ok: false, error: 'denied' }, 403));
      if (url.includes('/api/lakehouse/containers')) return Promise.resolve(jsonRes({ containers: [] }));
      return Promise.resolve(jsonRes({ ok: true, resources: [], via: 'user' }));
    });

    wrap(<AdlsBrowseDialog open onClose={() => {}} onPick={() => {}} />);
    await pickAccount();
    const input = await screen.findByLabelText('Container to open');
    expect((input as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'raw' } });
    fireEvent.click(screen.getByRole('button', { name: /open container/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/containers/raw/paths'))).toBe(true));
  });
});

/**
 * THE HOST IS THE ACCOUNT'S OWN, ALWAYS.
 *
 * `effectiveHost` used to fall back to `${account}.dfs.core.windows.net`, which
 * (a) let a previous account's host survive an account switch, so the emitted
 * URI named a DIFFERENT account than `AdlsLocation.account`, and (b) hard-coded
 * the Commercial suffix on exactly the denied-enumeration path this component
 * advertises as common in Azure Government. Both corrupt a STORED value, in a
 * way nothing downstream can detect.
 */
describe('the emitted URI never names the wrong account or a guessed suffix', () => {
  /** Two accounts: A enumerates fine, B is denied and must be typed. */
  function twoAccounts(hostForA = 'accta.dfs.core.usgovcloudapi.net') {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/api/azure/resources')) {
        return Promise.resolve(jsonRes({
          ok: true,
          via: 'user',
          resources: [
            { ...ACCOUNT_ROW, id: `${ACCOUNT_ROW.id}-a`, name: 'accta' },
            { ...ACCOUNT_ROW, id: `${ACCOUNT_ROW.id}-b`, name: 'acctb' },
          ],
        }));
      }
      if (u.includes('/api/storage/accta/containers/')) {
        return Promise.resolve(jsonRes({
          ok: true, account: 'accta', host: hostForA,
          paths: [{ name: 'Tables', isDirectory: true, size: 0 }],
        }));
      }
      if (u.includes('/api/storage/accta/containers')) {
        return Promise.resolve(jsonRes({
          ok: true, account: 'accta', host: hostForA,
          containers: [{ name: 'bronze', url: `https://${hostForA}/bronze` }],
        }));
      }
      // Account B: everything denied — the Gov escape-hatch path.
      if (u.includes('/api/storage/acctb')) return Promise.resolve(jsonRes({ ok: false, error: 'denied' }, 403));
      if (u.includes('/api/lakehouse/containers')) return Promise.resolve(jsonRes({ containers: [] }));
      return Promise.resolve(jsonRes({ ok: true, resources: [], via: 'user' }));
    });
  }

  async function chooseAccount(name: string) {
    const combo = await screen.findByRole('combobox');
    fireEvent.click(combo);
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
  }

  it('does NOT carry account A\'s host over to account B after a switch', async () => {
    twoAccounts();
    const onPick = vi.fn();
    wrap(<AdlsBrowseDialog open onClose={() => {}} onPick={onPick} />);

    // A: enumerate, open a container — this is what puts A's host in state.
    await chooseAccount('accta');
    fireEvent.click(await screen.findByText('bronze'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/accta/containers/bronze/paths'))).toBe(true));

    // B: denied, so the container is typed. B's host is unknown.
    await chooseAccount('acctb');
    fireEvent.change(await screen.findByLabelText('Container to open'), { target: { value: 'raw' } });
    fireEvent.click(screen.getByRole('button', { name: /open container/i }));

    fireEvent.click(await screen.findByRole('button', { name: /use this folder/i }));

    // The old build emitted `abfss://raw@accta.dfs.core.usgovcloudapi.net/`
    // with account: 'acctb'. Anything naming A here is the corruption.
    for (const call of onPick.mock.calls) {
      expect(String(call[0].uri)).not.toContain('accta');
    }
  });

  it('REFUSES to compose a URI when the account\'s host is unknown, rather than guessing a Commercial suffix', async () => {
    twoAccounts();
    const onPick = vi.fn();
    wrap(<AdlsBrowseDialog open onClose={() => {}} onPick={onPick} />);

    await chooseAccount('acctb');
    fireEvent.change(await screen.findByLabelText('Container to open'), { target: { value: 'raw' } });
    fireEvent.click(screen.getByRole('button', { name: /open container/i }));
    fireEvent.click(await screen.findByRole('button', { name: /use this folder/i }));

    expect(onPick).not.toHaveBeenCalled();
    expect(await screen.findByText(/does not know this account/i)).toBeInTheDocument();
  });

  it('preserves a SOVEREIGN suffix reported by the route (cloud-parity.md)', async () => {
    twoAccounts('accta.dfs.core.usgovcloudapi.net');
    const onPick = vi.fn();
    wrap(<AdlsBrowseDialog open onClose={() => {}} onPick={onPick} />);

    await chooseAccount('accta');
    fireEvent.click(await screen.findByText('bronze'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/accta/containers/bronze/paths'))).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: /use this folder/i }));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
      uri: 'abfss://bronze@accta.dfs.core.usgovcloudapi.net/',
      account: 'accta',
    }));
  });
});
