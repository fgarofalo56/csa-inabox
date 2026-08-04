import { describe, it, expect } from 'vitest';
import { buildCloneUrl } from '../src/git/clone-model';

describe('buildCloneUrl — GitHub', () => {
  it('builds the HTTPS .git URL from owner/repo', () => {
    expect(buildCloneUrl('github', 'octo/hello')).toEqual({ url: 'https://github.com/octo/hello.git' });
    expect(buildCloneUrl('github', '/octo/hello/')).toEqual({ url: 'https://github.com/octo/hello.git' });
    expect(buildCloneUrl('github', 'octo/hello.git')).toEqual({ url: 'https://github.com/octo/hello.git' });
  });

  it('rejects a malformed GitHub path (mutation-proof: drop the length guard → RED)', () => {
    const r = buildCloneUrl('github', 'octo');
    expect('error' in r).toBe(true);
    const r2 = buildCloneUrl('github', 'a/b/c');
    expect('error' in r2).toBe(true);
  });
});

describe('buildCloneUrl — Azure DevOps', () => {
  it('passes through an org/project/_git/repo path', () => {
    expect(buildCloneUrl('ado', 'myorg/myproj/_git/myrepo')).toEqual({
      url: 'https://dev.azure.com/myorg/myproj/_git/myrepo',
    });
  });
  it('normalises org/project/repo to the _git form', () => {
    expect(buildCloneUrl('ado', 'myorg/myproj/myrepo')).toEqual({
      url: 'https://dev.azure.com/myorg/myproj/_git/myrepo',
    });
  });
  it('rejects a malformed ADO path', () => {
    expect('error' in buildCloneUrl('ado', 'myorg')).toBe(true);
  });
});

describe('buildCloneUrl — unknown provider', () => {
  it('is an honest error, never a guessed URL', () => {
    const r = buildCloneUrl('gitlab', 'group/repo');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/gitlab/i);
  });
  it('is an honest error on an empty path', () => {
    expect('error' in buildCloneUrl('github', '')).toBe(true);
  });
});
