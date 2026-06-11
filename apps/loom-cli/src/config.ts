/**
 * Runtime config resolution. Precedence (highest first):
 *   1. explicit flags (--api-url, --output)
 *   2. environment (LOOM_API_URL, LOOM_OUTPUT)
 *   3. stored default (last successful login's apiUrl)
 *
 * No value is invented — if the API URL can't be resolved the caller errors
 * with the exact env var / flag to set (no-vaporware: honest gate, never a
 * hard-coded host).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loomHome, normalizeApiUrl } from './credentials.js';

export type OutputFormat = 'table' | 'json' | 'yaml';

export interface GlobalOptions {
  apiUrl?: string;
  output?: OutputFormat;
  tenant?: string;
}

const SETTINGS = 'settings.json';

interface Settings {
  defaultApiUrl?: string;
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(path.join(loomHome(), SETTINGS), 'utf-8')) as Settings;
  } catch {
    return {};
  }
}

export async function setDefaultApiUrl(url: string): Promise<void> {
  const dir = loomHome();
  await fs.mkdir(dir, { recursive: true });
  const cur = await readSettings();
  cur.defaultApiUrl = normalizeApiUrl(url);
  await fs.writeFile(path.join(dir, SETTINGS), JSON.stringify(cur, null, 2), 'utf-8');
}

/** Resolve the API base URL or return null (caller prints the honest gate). */
export async function resolveApiUrl(opts: GlobalOptions): Promise<string | null> {
  const fromFlagOrEnv = opts.apiUrl || process.env.LOOM_API_URL;
  if (fromFlagOrEnv) return normalizeApiUrl(fromFlagOrEnv);
  const s = await readSettings();
  return s.defaultApiUrl ? normalizeApiUrl(s.defaultApiUrl) : null;
}

export function resolveOutput(opts: GlobalOptions): OutputFormat {
  const raw = (opts.output || process.env.LOOM_OUTPUT || 'table').toLowerCase();
  if (raw === 'json' || raw === 'yaml' || raw === 'table') return raw;
  return 'table';
}

export function resolveTenant(opts: GlobalOptions): string | undefined {
  return opts.tenant || process.env.LOOM_TENANT || undefined;
}

export const API_URL_HELP =
  'No Loom API URL configured. Pass --api-url <https://...>, set LOOM_API_URL, ' +
  'or run `loom auth login --api-url <https://...>` to store a default.';
