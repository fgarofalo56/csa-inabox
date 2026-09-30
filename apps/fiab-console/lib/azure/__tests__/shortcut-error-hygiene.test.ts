/**
 * Shortcut error hygiene: URLs in error text lose their query string, fragment
 * and credentials, and a failed SAS probe reports a symbolic reason, never the
 * request URL (which carries the SAS).
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - redactErrorText: removing the query cut (the sentinel rides in `sig=`, and
 *     in `?token=` which `redactUrlSecrets` alone does not know), or the
 *     user-info cut (`https://user:SENTINEL@host`). Each absence check is paired
 *     with a positive check that the host/path survived, so deleting the text
 *     cannot pass it.
 *   - listAdlsWithSas: the pre-change `ADLS endpoint unreachable: ${e.message}`.
 *     The mocked timeout's message is the real `FetchTimeoutError` shape
 *     (it names the URL), so the SAS sentinel is in it.
 */
import { describe, it, expect, vi } from 'vitest';

const SENTINEL = 'Hx4Tq8Wz2Nv6Kc1Mb9Pr3Ly7';

vi.mock('@/lib/azure/fetch-with-timeout', async (orig) => {
  const actual = await orig<typeof import('@/lib/azure/fetch-with-timeout')>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(async (url: string) => { throw new actual.FetchTimeoutError(url, 30_000); }),
  };
});

import { redactErrorText, stripUrlQueryAndCredentials, networkFailureReason } from '../shortcut-error-hygiene';
import { listAdlsWithSas, ShortcutSourceError } from '../shortcut-client';

describe('redactErrorText', () => {
  it('strips query strings, fragments and http(s) user-info from every URL', () => {
    const text =
      `probe https://acct.dfs.core.windows.net/fs?resource=filesystem&sig=${SENTINEL} failed; ` +
      `retry https://svc.example.net/a?token=${SENTINEL}#frag; ` +
      `proxy https://user:${SENTINEL}@proxy.example.net/p`;
    const out = redactErrorText(text);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain('https://acct.dfs.core.windows.net/fs failed');
    expect(out).toContain('retry https://svc.example.net/a ');
    expect(out).toContain('https://proxy.example.net/p');
  });

  it('keeps an abfss container name (the part before @ is not a credential)', () => {
    expect(stripUrlQueryAndCredentials('abfss://raw@acct.dfs.core.windows.net/x?sig=1'))
      .toBe('abfss://raw@acct.dfs.core.windows.net/x');
  });

  it('redacts a bare SAS parameter outside any URL', () => {
    const out = redactErrorText(`token was sv=2024&sig=${SENTINEL}&se=2030`);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain('sig=REDACTED');
  });

  it('networkFailureReason returns a symbol, never the message', () => {
    expect(networkFailureReason({ name: 'FetchTimeoutError', message: `https://x/?sig=${SENTINEL}` })).toBe('timeout');
    expect(networkFailureReason({ cause: { code: 'ENOTFOUND' }, message: 'x' })).toBe('ENOTFOUND');
    expect(networkFailureReason({ message: `https://x/?sig=${SENTINEL}` })).toBe('network error');
  });
});

describe('listAdlsWithSas — a timed-out SAS probe', () => {
  it('reports "(timeout)" with code adls_unreachable and no part of the SAS', async () => {
    const err = await listAdlsWithSas({
      account: 'acct', container: 'fs', path: 'p', sasToken: `sv=2024-01-01&sig=${SENTINEL}`, maxResults: 1,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ShortcutSourceError);
    expect(err.code).toBe('adls_unreachable');
    expect(err.message).toBe('ADLS endpoint unreachable (timeout).');
    expect(err.message).not.toContain(SENTINEL);
  });
});
