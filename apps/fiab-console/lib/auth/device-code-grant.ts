/**
 * OAuth 2.0 device-authorization grant (RFC 8628) for `POST /api/auth/cli-session`,
 * run as a CONFIDENTIAL client (#4805).
 *
 * WHY THIS IS NOT MSAL's `PublicClientApplication.acquireTokenByDeviceCode`.
 * The grant runs server-side, inside the Console BFF, which holds the Console app
 * registration's client secret. MSAL-node's device-code client never sends a
 * client credential (its token-request builder has no secret/assertion step), so
 * it only works against an app registration with "Allow public client flows"
 * (`isFallbackPublicClient=true`). The Console app registration is deliberately
 * NOT that: both provisioning paths (scripts/csa-loom/bootstrap-msal-app-reg.sh and
 * modules/admin-plane/entra-app-registration.bicep) force
 * `isFallbackPublicClient=false`, because setting it true made Entra refuse the
 * browser sign-in's client secret with AADSTS700025 on 2026-06-17. So the two
 * requirements could not both hold, every device-code redemption was answered
 * AADSTS7000218 (`invalid_client`: "must contain client_assertion or
 * client_secret"), and MSAL reported it as the opaque
 * `post_request_failed ... invalid_client`, having DISCARDED the AADSTS code.
 *
 * The fix is to authenticate the redemption with the credential the Console
 * already holds, which Entra accepts for a confidential client. No app-registration
 * change is needed and the browser path is untouched.
 *
 * WHAT THIS MODULE ALSO OWNS: turning Entra's refusal into a TRUE, specific
 * message. `classifyEntraTokenError` keys on the numeric AADSTS code Entra
 * returns in `error_codes`, never on prose, and says only what that code
 * establishes. An unrecognised code is reported AS unrecognised, with Entra's own
 * first line, rather than guessed at.
 *
 * Tokens, device codes and the client secret are never logged or returned by any
 * failure path here. The user code is returned only on the prompt, which is its
 * purpose.
 */

import { getAuthority, msalClientId, msalClientSecret } from '@/lib/auth/msal';

/** The device-code prompt the human acts on. */
export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}

/** Who signed in, derived exactly as the browser callback derives it. */
export interface DeviceCodeIdentity {
  /** Home-tenant object id — `client_info.uid`, i.e. MSAL's `homeAccountId` first segment. */
  oid: string;
  tid?: string;
  name?: string;
  /** preferred_username → upn → email, '' when none — the same order and default MSAL's `AccountInfo.username` uses. */
  username: string;
}

/** A classified failure. `message` is safe to show the user and to log. */
export interface DeviceCodeFailure {
  /** Stable machine code, streamed as the NDJSON line's `code`. */
  code: string;
  /** e.g. `AADSTS7000218` when Entra supplied one. */
  aadsts?: string;
  /** The OAuth `error` field, e.g. `invalid_client`. */
  entraError?: string;
  /** Entra's correlation id, for a support ticket. Not a secret. */
  correlationId?: string;
  /** True when the fix is a deployment/app-registration change, false when it is the user's to act on. */
  deploymentFault: boolean;
  message: string;
}

export class DeviceCodeGrantError extends Error {
  constructor(public readonly failure: DeviceCodeFailure) {
    super(failure.message);
    this.name = 'DeviceCodeGrantError';
  }
}

/** The body Entra returns on a token-endpoint refusal (RFC 6749 §5.2 + Entra extensions). */
export interface EntraTokenErrorBody {
  error?: string;
  error_description?: string;
  error_codes?: number[];
  correlation_id?: string;
}

export interface DeviceCodeGrantDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Polled before every token request; true stops the grant (client went away). */
  isCancelled?: () => boolean;
}

export interface DeviceCodeGrantOptions extends DeviceCodeGrantDeps {
  scopes: string[];
  /** Tenant override from the request body; default `AZURE_TENANT_ID`. */
  tenantId?: string;
  onPrompt: (p: DeviceCodePrompt) => void;
}

/** A tenant id or verified domain — the only shapes that belong in an authority path. */
const TENANT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export function isValidTenantSegment(t: string): boolean {
  return TENANT_RE.test(t);
}

const ROTATE_HINT =
  'Mint a replacement with scripts/csa-loom/bootstrap-msal-app-reg.sh --rotate ' +
  '(docs/fiab/runbooks/secret-rotation.md section 2.2b), which stores it in Key Vault and rolls the Console onto it.';
const RENEW_HINT =
  'Re-run the post-deploy bootstrap (.github/workflows/csa-loom-post-deploy-bootstrap.yml): it mints a replacement ' +
  'when the recorded credential is expired or inside its renewal window, stores it in Key Vault and rolls the Console onto it.';

/** First line of Entra's `error_description` (drops the Trace/Correlation/Timestamp tail), bounded. */
function firstLine(desc: string | undefined): string {
  if (!desc) return '';
  return desc.split(/\r?\n/)[0].trim().slice(0, 300);
}

/**
 * Classify a token-endpoint refusal. Keys on `error_codes` first (the numeric
 * AADSTS code — the only field that pins the cause), then on the OAuth `error`
 * for the RFC 8628 terminal states that carry no deployment meaning.
 */
export function classifyEntraTokenError(
  body: EntraTokenErrorBody,
  ctx: { clientId: string; tenant: string; secretPresented: boolean },
): DeviceCodeFailure {
  const num = Array.isArray(body.error_codes) && body.error_codes.length > 0 ? body.error_codes[0] : undefined;
  const aadsts = num !== undefined ? `AADSTS${num}` : undefined;
  const said = firstLine(body.error_description);
  const base = { aadsts, entraError: body.error, correlationId: body.correlation_id };
  const app = `the Console app registration (${ctx.clientId})`;

  switch (num) {
    case 7000218:
      return {
        ...base,
        code: 'client_credential_missing',
        deploymentFault: true,
        message: ctx.secretPresented
          ? `Entra refused device-code sign-in with AADSTS7000218 (no client credential) although the Console sent its client secret for ${app}. Loom does not know why Entra did not see it; Entra said: "${said}".`
          : `Device-code sign-in needs ${app} to authenticate with its client secret (AADSTS7000218), and this Console has none: neither LOOM_MSAL_CLIENT_SECRET nor AZURE_CLIENT_SECRET is set. Re-run the post-deploy bootstrap (.github/workflows/csa-loom-post-deploy-bootstrap.yml), which stores loom-msal-client-secret in Key Vault and wires it onto the Console.`,
      };
    case 7000215:
      return {
        ...base,
        code: 'client_secret_invalid',
        deploymentFault: true,
        message: `Entra rejected the Console's client secret for ${app} (AADSTS7000215: invalid client secret). The secret the Console presents does not match any credential on the app registration. ${ROTATE_HINT}`,
      };
    case 7000222:
      return {
        ...base,
        code: 'client_secret_expired',
        deploymentFault: true,
        message: `The Console's client secret for ${app} has expired (AADSTS7000222). ${RENEW_HINT}`,
      };
    case 700025:
      return {
        ...base,
        code: 'app_is_public_client',
        deploymentFault: true,
        message: `Entra treats ${app} as a PUBLIC client (AADSTS700025), so it refused the Console's client secret. The Console is a confidential web app: set isFallbackPublicClient=false (the post-deploy bootstrap does). Do not enable public client flows to fix device-code sign-in; that breaks browser sign-in the same way.`,
      };
    case 700016:
      return {
        ...base,
        code: 'app_not_found',
        deploymentFault: true,
        message: `Entra has no app ${ctx.clientId} in tenant ${ctx.tenant} (AADSTS700016). LOOM_MSAL_CLIENT_ID and the tenant the sign-in targets disagree with the app registration.`,
      };
    case 90002:
    case 900023:
      return {
        ...base,
        code: 'tenant_not_found',
        deploymentFault: true,
        message: `Entra does not recognise tenant "${ctx.tenant}" (${aadsts}). Check AZURE_TENANT_ID on the Console, or the --tenant you passed.`,
      };
    case 65001:
      return {
        ...base,
        code: 'consent_required',
        deploymentFault: true,
        message: `${app} has not been granted consent for the sign-in scopes (AADSTS65001). A tenant admin grants it once: az ad app permission admin-consent --id ${ctx.clientId}.`,
      };
    case 53003:
      return {
        ...base,
        code: 'conditional_access_blocked',
        deploymentFault: false,
        message: `A Conditional Access policy blocked this sign-in (AADSTS53003). Ask your tenant admin which policy applies to device-code sign-in; Entra said: "${said}".`,
      };
    default:
      break;
  }

  // RFC 8628 §3.5 terminal states — the user's to act on, not the deployment's.
  switch (body.error) {
    case 'authorization_declined':
      return { ...base, code: 'authorization_declined', deploymentFault: false, message: 'The sign-in was declined at the verification page. Run the sign-in again and approve it.' };
    case 'expired_token':
      return { ...base, code: 'device_code_expired', deploymentFault: false, message: 'The device code expired before the sign-in was completed. Run the sign-in again and enter the new code promptly.' };
    case 'bad_verification_code':
      return { ...base, code: 'bad_verification_code', deploymentFault: false, message: 'Entra did not recognise the device code. Run the sign-in again.' };
    default:
      break;
  }

  // NOT CLASSIFIED — said so, with Entra's own words, rather than guessed.
  const what = aadsts ?? body.error ?? 'an unrecognised error';
  return {
    ...base,
    code: 'entra_token_error',
    deploymentFault: false,
    message: `Entra refused the device-code sign-in with ${what}, which Loom does not classify. Entra said: "${said || '(no description)'}"${body.correlation_id ? ` (correlation id ${body.correlation_id})` : ''}.`,
  };
}

function decodeSegment(seg: string | undefined): Record<string, unknown> {
  if (!seg) return {};
  try {
    return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

/**
 * The signed-in identity from a successful token response. The id token came
 * straight from Entra's token endpoint over TLS in answer to our own
 * client-authenticated request (OIDC Core §3.1.3.7 permits skipping signature
 * validation there), so only its audience is checked.
 *
 * `oid` is `client_info.uid` — what MSAL's `homeAccountId` carries, and so what
 * the browser callback and the previous MSAL-based branch stamped. For a guest
 * that is the HOME-tenant object id, not the resource tenant's `oid` claim.
 */
export function identityFromTokenResponse(
  tok: { id_token?: string; client_info?: string },
  clientId: string,
): DeviceCodeIdentity {
  const idc = decodeSegment(tok.id_token?.split('.')[1]);
  const ci = decodeSegment(tok.client_info);
  if (!tok.id_token || Object.keys(idc).length === 0) {
    throw new DeviceCodeGrantError({ code: 'no_token', deploymentFault: false, message: 'Entra completed the device-code sign-in but returned no readable id token.' });
  }
  if (idc.aud !== clientId) {
    throw new DeviceCodeGrantError({
      code: 'id_token_audience_mismatch',
      deploymentFault: true,
      message: `Entra returned an id token for audience "${String(idc.aud)}", not this Console's app registration (${clientId}). Refusing to mint a session from it.`,
    });
  }
  const oid = (ci.uid as string) || (idc.oid as string) || '';
  if (!oid) {
    throw new DeviceCodeGrantError({ code: 'no_token', deploymentFault: false, message: 'Entra completed the device-code sign-in but the response names no user object id.' });
  }
  const username = (idc.preferred_username as string) || (idc.upn as string) || (idc.email as string) || '';
  return {
    oid,
    tid: (idc.tid as string) || (ci.utid as string) || undefined,
    name: (idc.name as string) || undefined,
    username,
  };
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    throw new DeviceCodeGrantError({
      code: 'entra_unreachable',
      deploymentFault: true,
      message: `The Console could not reach Entra at ${host} (${e instanceof Error ? e.name : 'network error'}). This is a network failure, not an Entra verdict on the sign-in; check the Console's outbound access to the login host.`,
    });
  }
  const text = await res.text().catch(() => '');
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: null };
  }
}

/**
 * Run the whole grant: request a device code, surface the prompt, poll until the
 * user completes (or declines, or the code expires), and return the identity.
 * Every failure is a `DeviceCodeGrantError` carrying a classified failure.
 */
export async function runDeviceCodeGrant(opts: DeviceCodeGrantOptions): Promise<DeviceCodeIdentity> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const clientId = msalClientId();
  const secret = msalClientSecret();
  const tenant = opts.tenantId || process.env.AZURE_TENANT_ID || 'organizations';
  const authority = getAuthority(tenant);
  const scope = opts.scopes.join(' ');

  const dc = await postForm(fetchImpl, `${authority}/oauth2/v2.0/devicecode`, { client_id: clientId, scope });
  if (!dc.body || dc.status !== 200 || typeof dc.body.device_code !== 'string') {
    if (dc.body && (dc.body.error || dc.body.error_codes)) {
      throw new DeviceCodeGrantError(classifyEntraTokenError(dc.body as EntraTokenErrorBody, { clientId, tenant, secretPresented: false }));
    }
    throw new DeviceCodeGrantError({
      code: 'entra_bad_response',
      deploymentFault: true,
      message: `Entra's device-code endpoint answered HTTP ${dc.status} without a device code or an error Loom can read.`,
    });
  }
  const deviceCode = dc.body.device_code as string;
  const expiresIn = Number(dc.body.expires_in) || 900;
  let intervalMs = (Number(dc.body.interval) || 5) * 1000;
  opts.onPrompt({
    userCode: String(dc.body.user_code ?? ''),
    verificationUri: String(dc.body.verification_uri ?? ''),
    message: String(dc.body.message ?? ''),
    expiresIn,
  });

  const deadline = now() + expiresIn * 1000;
  const form: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
    scope,
    client_info: '1',
  };
  // THE FIX (#4805): a confidential client authenticates its redemption.
  if (secret) form.client_secret = secret;

  for (;;) {
    if (opts.isCancelled?.()) {
      throw new DeviceCodeGrantError({ code: 'cancelled', deploymentFault: false, message: 'The sign-in was cancelled by the client before it completed.' });
    }
    if (now() >= deadline) {
      throw new DeviceCodeGrantError({ code: 'device_code_expired', deploymentFault: false, message: 'The device code expired before the sign-in was completed. Run the sign-in again and enter the new code promptly.' });
    }
    const tok = await postForm(fetchImpl, `${authority}/oauth2/v2.0/token`, form);
    if (tok.status === 200 && tok.body && typeof tok.body.id_token === 'string') {
      return identityFromTokenResponse(tok.body as { id_token?: string; client_info?: string }, clientId);
    }
    const err = (tok.body ?? {}) as EntraTokenErrorBody;
    if (err.error === 'authorization_pending') {
      await sleep(intervalMs);
      continue;
    }
    if (err.error === 'slow_down') {
      intervalMs += 5000; // RFC 8628 §3.5
      await sleep(intervalMs);
      continue;
    }
    if (!tok.body) {
      throw new DeviceCodeGrantError({
        code: 'entra_bad_response',
        deploymentFault: true,
        message: `Entra's token endpoint answered HTTP ${tok.status} with a body Loom could not read.`,
      });
    }
    throw new DeviceCodeGrantError(classifyEntraTokenError(err, { clientId, tenant, secretPresented: Boolean(secret) }));
  }
}
