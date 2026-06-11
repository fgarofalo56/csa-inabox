import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProfile, loadProfile, clearProfile, isExpired, normalizeApiUrl } from '../src/credentials.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-cli-test-'));
  process.env.LOOM_CONFIG_DIR = dir;
});

afterEach(async () => {
  delete process.env.LOOM_CONFIG_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('credentials store', () => {
  it('round-trips a profile keyed by normalized API URL', async () => {
    await saveProfile({ apiUrl: 'https://loom.test/', cookie: 'C', expiresAt: 9999999999, claims: { upn: 'a@b' } });
    const p = await loadProfile('https://loom.test');
    expect(p?.cookie).toBe('C');
    expect(p?.apiUrl).toBe('https://loom.test');
    expect(p?.claims?.upn).toBe('a@b');
  });

  it('clears a profile', async () => {
    await saveProfile({ apiUrl: 'https://loom.test', cookie: 'C', expiresAt: 9999999999 });
    expect(await clearProfile('https://loom.test')).toBe(true);
    expect(await loadProfile('https://loom.test')).toBeNull();
    expect(await clearProfile('https://loom.test')).toBe(false);
  });

  it('detects expiry', () => {
    expect(isExpired({ apiUrl: 'x', cookie: 'c', expiresAt: 0, savedAt: '' })).toBe(true);
    expect(isExpired({ apiUrl: 'x', cookie: 'c', expiresAt: Math.floor(Date.now() / 1000) + 3600, savedAt: '' })).toBe(false);
  });

  it('normalizes trailing slashes', () => {
    expect(normalizeApiUrl('https://x/')).toBe('https://x');
    expect(normalizeApiUrl('https://x///')).toBe('https://x');
  });

  it('writes credentials.json with restrictive perms on POSIX', async () => {
    await saveProfile({ apiUrl: 'https://loom.test', cookie: 'C', expiresAt: 9999999999 });
    const stat = await fs.stat(path.join(dir, 'credentials.json'));
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o077).toBe(0);
    } else {
      expect(stat.isFile()).toBe(true);
    }
  });
});
