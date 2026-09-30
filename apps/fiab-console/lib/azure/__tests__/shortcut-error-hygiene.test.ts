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

  // The five shapes a SAS takes in error text. WHAT BREAKS IT: shape 5 (a bare
  // `sig=` that starts the text, with no `?` or `&` before it) survives
  // `redactUrlSecrets` alone, so dropping BARE_SAS_PARAM_RE turns that row red.
  // Each row pairs the absence check with the text that must survive.
  it.each([
    ['https URL', `GET https://acct.blob.core.windows.net/c/p?sv=2024&sig=${SENTINEL} 403`, 'GET https://acct.blob.core.windows.net/c/p 403'],
    ['host without a scheme', `acct.blob.core.windows.net/c?sv=2024&sig=${SENTINEL}`, 'acct.blob.core.windows.net/c?sv=REDACTED&sig=REDACTED'],
    ['bare sv=…&sig=…', `token was sv=2024&sig=${SENTINEL}&se=2030`, 'token was sv=REDACTED&sig=REDACTED&se=REDACTED'],
    ['URL user-info', `proxy https://user:${SENTINEL}@proxy.example.net/p`, 'proxy https://proxy.example.net/p'],
    ['bare token starting with sig=', `sig=${SENTINEL}&se=2030 was rejected`, 'sig=REDACTED&se=REDACTED was rejected'],
  ])('redacts a SAS given as %s', (_label, input, expected) => {
    const out = redactErrorText(input);
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe(expected);
  });

  it('leaves a word that merely ends in a parameter name alone', () => {
    // WHAT BREAKS IT: a bare-token pattern with no leading anchor, which would
    // rewrite `assign=` and `turnkey=` as if they were `sig=` / `key=`.
    expect(redactErrorText('assign=keepme turnkey=keepme')).toBe('assign=keepme turnkey=keepme');
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
