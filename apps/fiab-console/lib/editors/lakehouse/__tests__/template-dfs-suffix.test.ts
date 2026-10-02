/**
 * templateDfsSuffix: the DFS host suffix in the editor's generated query
 * templates comes from the server's container URLs, so it follows the cloud.
 */
import { describe, it, expect } from 'vitest';
import { templateDfsSuffix } from '../shared';

describe('templateDfsSuffix', () => {
  it.each([
    // Breaks if the suffix is hard-coded to the Commercial host.
    ['GCC-High / IL5', 'https://govacct.dfs.core.usgovcloudapi.net/landing', 'dfs.core.usgovcloudapi.net'],
    // Positive arm for Commercial: breaks if parsing drops or alters a good host.
    ['Commercial', 'https://acct.dfs.core.windows.net/landing', 'dfs.core.windows.net'],
  ])('%s: reads the suffix from the container URL', (_l, url, want) => {
    expect(templateDfsSuffix([{ url }])).toBe(want);
  });

  it('skips a container without a usable URL and reads the next one', () => {
    // Breaks if only the first entry is read.
    expect(templateDfsSuffix([{ url: 'u' }, { url: 'https://govacct.dfs.core.usgovcloudapi.net/x' }])).toBe('dfs.core.usgovcloudapi.net');
  });

  it.each([
    ['no listing', null],
    ['an empty listing', []],
    ['a URL that is not a DFS host', [{ url: 'https://acct.blob.core.windows.net/x' }]],
  ])('%s: the placeholder, not a guessed cloud', (_l, containers) => {
    // Breaks if the fallback is a Commercial literal.
    expect(templateDfsSuffix(containers as any)).toBe('__dfs_suffix__');
  });
});
