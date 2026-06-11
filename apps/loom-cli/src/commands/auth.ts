/**
 * `loom auth` — login / logout / status.
 *
 * login (default device-code): mints a real Loom session via
 *   POST /api/auth/cli-session and stores the loom_session cookie 0600.
 * login --service-principal: non-interactive client-credentials (CI).
 * logout: clears the stored session for the API URL.
 * status: shows the current session + verifies it against /api/auth/me.
 */
import { anonContext, requireAuth, CliError } from './context.js';
import { resolveApiUrl, resolveTenant, resolveOutput, setDefaultApiUrl, type GlobalOptions } from '../config.js';
import { saveProfile, clearProfile, loadProfile, isExpired } from '../credentials.js';
import { flagBool, flagStr, type ParsedArgs } from '../args.js';
import { printResult } from '../output.js';

function envOr(flag: string | undefined, ...envNames: string[]): string | undefined {
  if (flag) return flag;
  for (const e of envNames) if (process.env[e]) return process.env[e];
  return undefined;
}

export async function runAuth(sub: string, args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  switch (sub) {
    case 'login':
      return login(args, opts);
    case 'logout':
      return logout(opts);
    case 'status':
      return status(opts);
    default:
      throw new CliError(`Unknown auth subcommand "${sub}". Use: login | logout | status`);
  }
}

async function login(args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  const { client, apiUrl } = await anonContext(opts);
  const tenant = resolveTenant(opts);
  const isSp =
    flagBool(args.flags, 'service-principal') ||
    !!envOr(flagStr(args.flags, 'client-id'), 'LOOM_SP_CLIENT_ID', 'AZURE_CLIENT_ID');

  let session;
  if (isSp) {
    const clientId = envOr(flagStr(args.flags, 'client-id'), 'LOOM_SP_CLIENT_ID', 'AZURE_CLIENT_ID');
    const clientSecret = envOr(flagStr(args.flags, 'client-secret'), 'LOOM_SP_CLIENT_SECRET', 'AZURE_CLIENT_SECRET');
    const tenantId = envOr(flagStr(args.flags, 'tenant-id'), 'LOOM_SP_TENANT_ID', 'AZURE_TENANT_ID') || tenant;
    if (!clientId || !clientSecret) {
      throw new CliError(
        'Service-principal login needs --client-id and --client-secret ' +
          '(or LOOM_SP_CLIENT_ID / LOOM_SP_CLIENT_SECRET env vars).',
      );
    }
    process.stderr.write(`Signing in to ${apiUrl} as service principal ${clientId}...\n`);
    session = await client.loginServicePrincipal({ clientId, clientSecret, tenantId });
  } else {
    session = await client.loginDeviceCode((p) => {
      // The message from Entra already contains the URL + code; print verbatim.
      process.stderr.write(`\n${p.message}\n\n`);
      process.stderr.write(`  Verification URL : ${p.verificationUri}\n`);
      process.stderr.write(`  Code             : ${p.userCode}\n\n`);
      process.stderr.write('Waiting for you to complete sign-in in the browser...\n');
    }, tenant);
  }

  await saveProfile({
    apiUrl,
    cookie: session.cookie,
    expiresAt: session.expiresAt,
    claims: session.claims,
  });
  await setDefaultApiUrl(apiUrl);
  const who = session.claims?.upn || session.claims?.name || session.claims?.oid || 'session';
  process.stderr.write(`Signed in as ${who}. Session stored for ${apiUrl}.\n`);
}

async function logout(opts: GlobalOptions): Promise<void> {
  const apiUrl = await resolveApiUrl(opts);
  if (!apiUrl) throw new CliError('No API URL to log out from. Pass --api-url or set LOOM_API_URL.');
  const cleared = await clearProfile(apiUrl);
  process.stderr.write(cleared ? `Signed out of ${apiUrl}.\n` : `No stored session for ${apiUrl}.\n`);
}

async function status(opts: GlobalOptions): Promise<void> {
  const apiUrl = await resolveApiUrl(opts);
  if (!apiUrl) throw new CliError('No API URL configured. Pass --api-url or set LOOM_API_URL.');
  const profile = await loadProfile(apiUrl);
  if (!profile) {
    throw new CliError(`Not signed in to ${apiUrl}. Run: loom auth login --api-url ${apiUrl}`);
  }
  const expired = isExpired(profile);
  let live: { ok: boolean; upn?: string } = { ok: false };
  if (!expired) {
    try {
      const { client } = await requireAuth(opts);
      live = await client.me();
    } catch {
      live = { ok: false };
    }
  }
  printResult(
    {
      apiUrl,
      signedInAs: profile.claims?.upn || profile.claims?.name || profile.claims?.oid,
      expiresAt: new Date(profile.expiresAt * 1000).toISOString(),
      expired,
      verifiedLive: live.ok,
    },
    resolveOutput(opts),
  );
}
