/**
 * tokenizedGitUrl — private-git PAT injection into the ACR clone URL (APP-W4 S3).
 * Pure; no Azure I/O. Verifies each provider's documented PAT-basic-auth
 * username convention and that the token is URL-encoded (never raw).
 */
import { describe, it, expect } from 'vitest';
import { tokenizedGitUrl, parseInfoRefs } from '../loom-apps-client';

describe('tokenizedGitUrl', () => {
  it('uses x-access-token for github', () => {
    expect(tokenizedGitUrl('https://github.com/org/repo#main:app', 'ghp_abc'))
      .toBe('https://x-access-token:ghp_abc@github.com/org/repo#main:app');
  });
  it('uses oauth2 for gitlab and x-token-auth for bitbucket', () => {
    expect(tokenizedGitUrl('https://gitlab.com/g/p', 't')).toBe('https://oauth2:t@gitlab.com/g/p');
    expect(tokenizedGitUrl('https://bitbucket.org/g/p', 't')).toBe('https://x-token-auth:t@bitbucket.org/g/p');
  });
  it('uses a pat username for azure devops', () => {
    expect(tokenizedGitUrl('https://dev.azure.com/org/proj/_git/repo', 'pt'))
      .toBe('https://pat:pt@dev.azure.com/org/proj/_git/repo');
  });
  it('URL-encodes special characters in the token', () => {
    // A token with '@' or '/' would break the URL if not encoded.
    expect(tokenizedGitUrl('https://github.com/o/r', 'a@b/c+d'))
      .toBe('https://x-access-token:a%40b%2Fc%2Bd@github.com/o/r');
  });
});

describe('parseInfoRefs (redeploy-on-push SHA resolution)', () => {
  const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  // First ref line carries capabilities after a NUL, per the smart-HTTP proto.
  const body = [
    `0000${SHA_A} HEAD\0multi_ack symref=HEAD:refs/heads/main`,
    `003f${SHA_A} refs/heads/main`,
    `003f${SHA_B} refs/heads/dev`,
  ].join('\n');

  it('resolves HEAD when no branch is requested', () => {
    expect(parseInfoRefs(body)).toBe(SHA_A);
  });
  it('resolves a specific branch when requested', () => {
    expect(parseInfoRefs(body, 'dev')).toBe(SHA_B);
  });
  it('returns null when the branch is absent', () => {
    expect(parseInfoRefs(body, 'nope')).toBeNull();
  });
});
