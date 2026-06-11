/**
 * Credential store for the `loom` CLI.
 *
 * The Loom API authenticates with the encrypted `loom_session` cookie value
 * (there is no separate bearer/API-key scheme). `loom auth login` obtains that
 * value from `POST /api/auth/cli-session` and we persist it here so subsequent
 * commands replay it as the `Cookie` header — exactly the browser's contract.
 *
 * Stored at ~/.loom/credentials.json with 0600 perms (best-effort on Windows).
 * Keyed by API base URL so one machine can target Commercial + GCC-High etc.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StoredProfile {
  apiUrl: string;
  cookie: string;
  /** Unix seconds the session expires. */
  expiresAt: number;
  /** Identity claims echoed back by the mint route (display only). */
  claims?: { oid?: string; name?: string; upn?: string; email?: string };
  savedAt: string;
}

interface CredentialsFile {
  version: 1;
  /** Map of apiUrl -> profile. */
  profiles: Record<string, StoredProfile>;
}

export function loomHome(): string {
  return process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom');
}

function credPath(): string {
  return path.join(loomHome(), 'credentials.json');
}

async function readFile(): Promise<CredentialsFile> {
  try {
    const raw = await fs.readFile(credPath(), 'utf-8');
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (!parsed.profiles) return { version: 1, profiles: {} };
    return parsed;
  } catch {
    return { version: 1, profiles: {} };
  }
}

async function writeFile(data: CredentialsFile): Promise<void> {
  const dir = loomHome();
  await fs.mkdir(dir, { recursive: true });
  const file = credPath();
  await fs.writeFile(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // Tighten perms in case the file pre-existed with looser bits (no-op on Windows).
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* Windows / restricted FS — perms not enforced */
  }
}

/** Normalize an API base URL: strip a trailing slash so cookie keys are stable. */
export function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function saveProfile(p: Omit<StoredProfile, 'savedAt'>): Promise<void> {
  const data = await readFile();
  const key = normalizeApiUrl(p.apiUrl);
  data.profiles[key] = { ...p, apiUrl: key, savedAt: new Date().toISOString() };
  await writeFile(data);
}

export async function loadProfile(apiUrl: string): Promise<StoredProfile | null> {
  const data = await readFile();
  return data.profiles[normalizeApiUrl(apiUrl)] ?? null;
}

export async function clearProfile(apiUrl: string): Promise<boolean> {
  const data = await readFile();
  const key = normalizeApiUrl(apiUrl);
  if (!data.profiles[key]) return false;
  delete data.profiles[key];
  await writeFile(data);
  return true;
}

export function isExpired(p: StoredProfile, skewSecs = 30): boolean {
  return p.expiresAt <= Math.floor(Date.now() / 1000) + skewSecs;
}
