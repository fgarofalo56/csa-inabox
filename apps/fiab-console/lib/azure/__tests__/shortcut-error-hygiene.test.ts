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

  // The shapes a secret takes in error text, each checked for the EXACT output
  // (so a lost bracket or an over-long cut fails, not only a leak). Which rows
  // witness which pattern — the input that turns them red:
  //   - SAS_PARAM_RE removed: 'bare sv=…&sig=…' (after a space, no `?`/`&`
  //     before `sv=`), 'bare token starting with sig=', '[sig=…]', '(sig=…)',
  //     'host without a scheme' and 'query in parentheses'.
  //   - its value class allowed to run over `)`/`]` (the round-3 class):
  //     '(sig=…)', '[sig=…]' and 'query in parentheses' lose their closer.
  //   - its lead anchor narrowed back to the round-3 set (no `[`): '[sig=…]'
  //     only.
  //   - CONNECTION_STRING_SECRET_RE removed: 'AccountKey=', 'SharedAccessKey='.
  //   - JSON_SECRET_RE removed: the two JSON rows.
  //   - ENCODED_SAS_PARAM_RE removed: 'URL-encoded sig%3D'.
  //   - QUERY_CODE_RE removed: 'function key ?code='.
  //   - the URL cut dropping a trailing `)`: 'URL in parentheses'.
  // 'https URL' and 'URL user-info' are witnesses for stripUrlQueryAndCredentials
  // only; no SAS pattern is reached by them.
  it.each([
    ['https URL', `GET https://acct.blob.core.windows.net/c/p?sv=2024&sig=${SENTINEL} 403`, 'GET https://acct.blob.core.windows.net/c/p 403'],
    ['host without a scheme', `acct.blob.core.windows.net/c?sv=2024&sig=${SENTINEL}`, 'acct.blob.core.windows.net/c?sv=REDACTED&sig=REDACTED'],
    ['bare sv=…&sig=…', `token was sv=2024&sig=${SENTINEL}&se=2030`, 'token was sv=REDACTED&sig=REDACTED&se=REDACTED'],
    ['URL user-info', `proxy https://user:${SENTINEL}@proxy.example.net/p`, 'proxy https://proxy.example.net/p'],
    ['bare token starting with sig=', `sig=${SENTINEL}&se=2030 was rejected`, 'sig=REDACTED&se=REDACTED was rejected'],
    ['[sig=…]', `token [sig=${SENTINEL}] rejected`, 'token [sig=REDACTED] rejected'],
    ['(sig=…)', `rejected (sig=${SENTINEL}) at 12:00`, 'rejected (sig=REDACTED) at 12:00'],
    ['query in parentheses', `(acct.blob.core.windows.net/c?sig=${SENTINEL})`, '(acct.blob.core.windows.net/c?sig=REDACTED)'],
    ['URL in parentheses', `(see https://acct.blob.core.windows.net/c?sig=${SENTINEL}) retry`, '(see https://acct.blob.core.windows.net/c) retry'],
    ['AccountKey=', `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${SENTINEL}+a/b==;EndpointSuffix=core.windows.net`,
      'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=REDACTED;EndpointSuffix=core.windows.net'],
    ['SharedAccessKey=', `Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=${SENTINEL}=`,
      'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=REDACTED'],
    ['JSON "sig":"…"', `{"error":{"sig":"${SENTINEL}","sv": "2024-11-04"}}`, '{"error":{"sig":"REDACTED","sv": "REDACTED"}}'],
    ['JSON escaped in a string', `detail: "{\\"sig\\":\\"${SENTINEL}\\"}"`, 'detail: "{\\"sig\\":\\"REDACTED\\"}"'],
    ['URL-encoded sig%3D', `redirect=https%3A%2F%2Facct.blob.core.windows.net%2Fc%3Fsv%3D2024%26sig%3D${SENTINEL}%26se%3D2030 failed`,
      'redirect=https%3A%2F%2Facct.blob.core.windows.net%2Fc%3Fsv%3DREDACTED%26sig%3DREDACTED%26se%3DREDACTED failed'],
    ['function key ?code=', `POST func.azurewebsites.net/api/x?code=${SENTINEL} 401`, 'POST func.azurewebsites.net/api/x?code=REDACTED 401'],
  ])('redacts a secret given as %s', (_label, input, expected) => {
    const out = redactErrorText(input);
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe(expected);
  });

  it('leaves a word that merely ends in a parameter name, and an error code, alone', () => {
    // WHAT BREAKS IT: a SAS pattern with no leading anchor (rewrites `assign=` /
    // `turnkey=` as `sig=` / `key=`), a bare or JSON `code` redaction (rewrites
    // an ARM error code), or a connection-string pattern that matches
    // `SharedAccessKeyName=`.
    expect(redactErrorText('assign=keepme turnkey=keepme')).toBe('assign=keepme turnkey=keepme');
    expect(redactErrorText('{"code": "AuthorizationFailed"} code=AuthorizationFailure'))
      .toBe('{"code": "AuthorizationFailed"} code=AuthorizationFailure');
    expect(redactErrorText('SharedAccessKeyName=RootManageSharedAccessKey;'))
      .toBe('SharedAccessKeyName=RootManageSharedAccessKey;');
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
