/**
 * Read side of the `loom` CLI credential store.
 *
 * This mirrors — and reads the SAME on-disk file as — `apps/loom-cli/src/credentials.ts`.
 * The CLI's `loom auth login` writes an encrypted `loom_session` cookie to
 * `~/.loom/credentials.json` (mode 0600), keyed by normalized API base URL. The
 * MCP auth layer reuses that store so a developer who has already run
 * `loom auth login` can point an MCP client at Loom with no extra credential.
 *
 * We re-implement the read here (rather than import across the CLI package's
 * `src/`) so this package stays an isolated, independently-installable workspace;
 * the file format, path resolution (`LOOM_CONFIG_DIR` override), key
 * normalization, and expiry check are identical to the CLI's.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A stored profile — the shape the CLI writes (`StoredProfile`). */
export interface StoredProfile {
  apiUrl: string;
  cookie: string;
  /** Unix seconds the session expires. */
  expiresAt: number;
  claims?: { oid?: string; name?: string; upn?: string; email?: string };
  savedAt: string;
}

interface CredentialsFile {
  version: 1;
  profiles: Record<string, StoredProfile>;
}

/** `~/.loom` unless `LOOM_CONFIG_DIR` overrides it (identical to the CLI). */
export function loomHome(): string {
  return process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom');
}

function credPath(): string {
  return path.join(loomHome(), 'credentials.json');
}

/** Strip trailing slashes so cookie keys are stable (identical to the CLI). */
export function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function readFile(): Promise<CredentialsFile> {
  try {
    const raw = await fs.readFile(credPath(), 'utf-8');
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.profiles) return { version: 1, profiles: {} };
    return parsed;
  } catch {
    return { version: 1, profiles: {} };
  }
}

/** Load the stored profile for a specific API URL, or null. */
export async function loadProfile(apiUrl: string): Promise<StoredProfile | null> {
  const data = await readFile();
  return data.profiles[normalizeApiUrl(apiUrl)] ?? null;
}

/** All stored profiles (used to pick a lone default when no URL is given). */
export async function listProfiles(): Promise<StoredProfile[]> {
  const data = await readFile();
  return Object.values(data.profiles);
}

/** Is the session at/near expiry? (30s skew, identical to the CLI.) */
export function isExpired(p: StoredProfile, skewSecs = 30): boolean {
  return p.expiresAt <= Math.floor(Date.now() / 1000) + skewSecs;
}
