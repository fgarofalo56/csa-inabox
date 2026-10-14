/**
 * token.mjs — acquire an Entra token from the already-logged-in az session, and
 * refuse to proceed unless that session is in the requested boundary.
 *
 * The token is returned to the caller in memory only. It is never printed,
 * never in argv, never written to a file or the step summary. Every string that
 * leaves the process goes through scrub().
 */
import { spawnSync } from 'node:child_process';
import { classifyCloud } from './contract.mjs';

/** shell:false + args array; returns {status, stdout, stderr, error}. */
export function defaultSpawn(cmd, args) {
  const r = spawnSync(cmd, args, { shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

/** Replace every occurrence of each secret in text. Secrets under 8 chars are not scrubbed (would mangle). */
export function scrub(text, secrets) {
  let s = String(text ?? '');
  for (const sec of secrets) {
    if (typeof sec === 'string' && sec.length >= 8) s = s.split(sec).join('[REDACTED]');
  }
  return s;
}

/**
 * Console- or az-supplied text is untrusted. Strip CR/LF (so it cannot start a
 * new log line) and break every `::` (so it cannot become a workflow command).
 */
export function sanitizeLine(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/::/g, ': :');
}

/** Read the active cloud. Never mutates anything. */
export function readActiveCloud(spawn = defaultSpawn) {
  const r = spawn('az', ['account', 'show', '--output', 'json']);
  if (r.error || r.status !== 0) {
    return { environmentName: null, error: `az account show failed (exit ${r.status ?? 'none'})` };
  }
  try {
    const j = JSON.parse(r.stdout);
    return { environmentName: typeof j?.environmentName === 'string' ? j.environmentName : null, error: null };
  } catch {
    return { environmentName: null, error: 'az account show did not return JSON' };
  }
}

/** Fail-closed boundary guard. Runs before ANY token or network call. */
export function assertBoundary(boundary, spawn = defaultSpawn) {
  const { environmentName, error } = readActiveCloud(spawn);
  const v = classifyCloud(boundary, environmentName);
  if (v.ok) return { ok: true, reason: null };
  return { ok: false, reason: error ? `${v.reason} (${error})` : v.reason };
}

/** Returns {ok, token, reason}. The token exists only in the return value. */
export function acquireToken(audience, spawn = defaultSpawn) {
  if (typeof audience !== 'string' || audience.trim() === '') {
    return { ok: false, token: null, reason: 'CSA_LOOM_CONSOLE_AUDIENCE is not set' };
  }
  const r = spawn('az', ['account', 'get-access-token', '--resource', audience, '--output', 'json']);
  if (r.error || r.status !== 0) {
    return { ok: false, token: null, reason: `az account get-access-token failed (exit ${r.status ?? 'none'})` };
  }
  try {
    const t = JSON.parse(r.stdout)?.accessToken;
    if (typeof t !== 'string' || t.length === 0) return { ok: false, token: null, reason: 'az returned no accessToken' };
    return { ok: true, token: t, reason: null };
  } catch {
    return { ok: false, token: null, reason: 'az get-access-token did not return JSON' };
  }
}
