/**
 * Command context: resolves the API URL + an authenticated LoomClient from the
 * stored session, applying honest gates when unconfigured or unauthenticated.
 */
import { LoomClient } from '../client.js';
import { resolveApiUrl, resolveOutput, API_URL_HELP, type GlobalOptions, type OutputFormat } from '../config.js';
import { loadProfile, isExpired } from '../credentials.js';
import { CliError } from '../errors.js';

export { CliError };

export interface AuthedContext {
  client: LoomClient;
  apiUrl: string;
  output: OutputFormat;
}

/** Build a client authenticated with the stored session (errors with a gate). */
export async function requireAuth(opts: GlobalOptions): Promise<AuthedContext> {
  const apiUrl = await resolveApiUrl(opts);
  if (!apiUrl) throw new CliError(API_URL_HELP);
  const profile = await loadProfile(apiUrl);
  if (!profile) {
    throw new CliError(`Not signed in to ${apiUrl}. Run: loom auth login --api-url ${apiUrl}`);
  }
  if (isExpired(profile)) {
    throw new CliError(`Session for ${apiUrl} has expired. Run: loom auth login --api-url ${apiUrl}`);
  }
  return { client: new LoomClient(apiUrl, profile.cookie), apiUrl, output: resolveOutput(opts) };
}

/** Build an unauthenticated client (auth commands that mint a session). */
export async function anonContext(opts: GlobalOptions): Promise<{ client: LoomClient; apiUrl: string; output: OutputFormat }> {
  const apiUrl = await resolveApiUrl(opts);
  if (!apiUrl) throw new CliError(API_URL_HELP);
  return { client: new LoomClient(apiUrl), apiUrl, output: resolveOutput(opts) };
}
