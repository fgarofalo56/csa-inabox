/**
 * Power Platform AUTH + TRANSPORT — the single dual-identity chokepoint shared
 * by `powerplatform-client.ts` and `copilot-studio-client.ts`.
 *
 * WHY THIS MODULE EXISTS (two reasons, both structural).
 *
 * 1. THE POLICY MUST BE IDENTICAL IN BOTH CLIENTS. They call the same three
 *    surfaces (BAP admin, Power Apps / Flow management, Dataverse Web API) with
 *    the same principals, and they had already drifted once — badly: each read a
 *    DIFFERENT env var for the BAP host, and only one of them was wired by
 *    bicep, so the entire Copilot Studio family was silently pinned to the
 *    Commercial host in every sovereign boundary. Two copies of an auth policy
 *    is the same defect waiting to happen again, so there is now exactly one.
 *
 * 2. NEITHER IDENTITY ALONE CAN SERVE THESE CLIENTS.
 *
 *    - Only a LICENSED USER can author Power Automate flows: "APIs related to
 *      Flow are supported for service principal authentication in situations
 *      where a license isn't required, as it isn't possible to assign licenses
 *      to service principal identities in Microsoft Entra ID."
 *      (learn.microsoft.com/power-platform/admin/powerplatform-api-create-service-principal
 *       #limitations-of-service-principals). And a UAMI-issued token is never a
 *      valid Dataverse Application User — which is what every Copilot Studio
 *      agent / topic / action / knowledge source is stored as.
 *    - Only the registered MANAGEMENT APPLICATION can use the BAP *admin* scope
 *      (`/scopes/admin/...`). An ordinary signed-in user is not a Power Platform
 *      administrator, so a user token 403s there while the SP succeeds.
 *
 *    A "user token first, SP only when no user token could be MINTED" design
 *    therefore REGRESSES the admin control plane: once a user token mints
 *    successfully, every admin listing 403s and the SP is never tried. That is
 *    the difference between "Power Platform works" and "the environment list is
 *    empty" — the reported symptom.
 *
 *    So: try the user, and on 401/403 RETRY the same request as the service
 *    principal. Both legs are pre-existing behaviors, so this can only ever turn
 *    a failure into a success:
 *      - no signed-in user / kill switch / mint failure -> SP only (prior path);
 *      - user allowed                                   -> user (correct licensing + RBAC);
 *      - user denied, SP allowed                        -> SP (prior path).
 *
 *    The bodies sent are always JSON strings, so re-issuing the request is safe.
 *    Kill switch: LOOM_POWERPLATFORM_USER_PASSTHROUGH=false -> pure SP behavior.
 *
 * Azure-native throughout; no Fabric / Power BI dependency (no-fabric-dependency.md).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential,
  ClientSecretCredential, type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { powerPlatformEndpoints, assertPowerPlatformAvailable } from '@/lib/azure/cloud-endpoints';

// ---------------------------------------------------------------------------
// Cloud-aware endpoint accessors (single source of truth)
// ---------------------------------------------------------------------------
//
// These were module-level `process.env` reads in each client that only
// understood the Commercial hosts unless an operator set every var by hand.
// Lazily evaluated (functions, not consts) so a runtime env change and unit
// tests both take effect.

export function bapBase(): string { return powerPlatformEndpoints().bapBase; }
export function bapScope(): string { return powerPlatformEndpoints().bapScope; }
export function powerAppsScope(): string { return powerPlatformEndpoints().powerAppsScope; }
export function flowScope(): string { return powerPlatformEndpoints().flowScope; }

/** Throws an honest, named remediation when this cloud has no known host. */
export function powerAppsBase(): string {
  assertPowerPlatformAvailable('powerapps');
  return powerPlatformEndpoints().powerAppsBase as string;
}
export function flowBase(): string {
  assertPowerPlatformAvailable('flow');
  return powerPlatformEndpoints().flowBase as string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

// UAMI credential — used for BAP / Power Apps / Flow control-plane calls.
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const uamiCredential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
    new AcaManagedIdentityCredential(),
    new ManagedIdentityCredential({ clientId: uamiClientId }),
    new DefaultAzureCredential(),
  )
  : new DefaultAzureCredential();

// Dataverse credential — UAMIs aren't valid Dataverse Application Users
// (Microsoft platform restriction), so we use a confidential SP for any
// `<org>.crm.dynamics.com/.default` scope. The SP must be registered as a
// Dataverse Application User (System Administrator) on every env Loom reads —
// which the day-one bootstrap does for the MSAL Web App SP
// (scripts/csa-loom/dataverse-add-appuser.sh, run from the post-deploy
// workflow). So by DEFAULT we reuse that SAME MSAL app + secret here (no gate,
// works day-one): LOOM_DATAVERSE_CLIENT_ID/_SECRET are honored when set (a
// dedicated Dataverse app), otherwise we fall back to LOOM_MSAL_CLIENT_ID /
// LOOM_MSAL_CLIENT_SECRET (the registered app-user).
//
// Sharing this resolution is itself a bug fix: copilot-studio-client used to
// read ONLY the dedicated LOOM_DATAVERSE_* pair, so any estate that set just the
// MSAL vars left it with NO Dataverse credential and every Copilot Studio call
// fell through to the UAMI — which Dataverse rejects.
// See docs/fiab/dataverse-app-user.md.
const dataverseClientId =
  process.env.LOOM_DATAVERSE_CLIENT_ID || process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const dataverseClientSecret =
  process.env.LOOM_DATAVERSE_CLIENT_SECRET || process.env.LOOM_MSAL_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;
const dataverseTenantId = process.env.LOOM_DATAVERSE_TENANT_ID || process.env.AZURE_TENANT_ID;
const dataverseCredential: TokenCredential | null =
  (dataverseClientId && dataverseClientSecret && dataverseTenantId)
    ? new ClientSecretCredential(dataverseTenantId, dataverseClientId, dataverseClientSecret)
    : null;

/** True for a `<org>.crm[N].dynamics.com/.default` (Dataverse Web API) scope. */
export function isDataverseScope(scope: string): boolean {
  return /\.crm[0-9]*\.dynamics\.com\/\.default$/.test(scope);
}

// ---------------------------------------------------------------------------
// Dual-identity transport
// ---------------------------------------------------------------------------

/** Which identity produced the token an outbound call actually used. */
export type PpCallIdentity = 'user' | 'sp';

export interface PpFetchResult {
  res: Response;
  /** The identity whose token produced `res`. */
  identity: PpCallIdentity;
  /**
   * Whether a delegated USER token was attempted at all.
   *
   * This — NOT `identity` — is the right discriminator for remediation copy:
   * after a retry `identity` is 'sp', so keying off it would report an SP-only
   * denial even though the signed-in user was refused first, sending the
   * operator to fix the wrong grant.
   */
  triedUser: boolean;
}

export interface PpFetchOptions {
  /**
   * Wrap a token-acquisition failure in the CALLER's error type, so
   * `PowerPlatformError` / `CopilotStudioError` semantics (and the BFF routes'
   * `instanceof` status mapping) are preserved exactly.
   */
  tokenError: (message: string) => Error;
}

/**
 * Acquire the SERVICE-PRINCIPAL bearer token for a Power Platform REST call.
 *
 * Dataverse-scoped tokens go through the confidential SP when configured;
 * everything else uses the Console UAMI. Falling back to the UAMI for a
 * Dataverse scope surfaces a 403 with "user is not a member of the
 * organization" — which is actionable, unlike a silent empty result.
 */
export async function getPowerPlatformSpToken(scope: string, opts: PpFetchOptions): Promise<string> {
  const cred = (isDataverseScope(scope) && dataverseCredential) ? dataverseCredential : uamiCredential;
  const t = await cred.getToken(scope);
  if (!t?.token) throw opts.tokenError(`Failed to acquire AAD token for ${scope}`);
  return t.token;
}

function withBearer(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
  };
}

/**
 * Issue a Power Platform / Dataverse REST call under DUAL IDENTITY. See the
 * file header for why both principals are required and why the retry (rather
 * than a mint-only fallback) is the correct shape.
 */
export async function powerPlatformFetch(
  url: string,
  scope: string,
  init: RequestInit,
  opts: PpFetchOptions,
): Promise<PpFetchResult> {
  const { tryUserTokenForPowerPlatform } = await import('@/lib/auth/obo');
  const userToken = await tryUserTokenForPowerPlatform(scope);
  if (userToken) {
    const res = await fetchWithTimeout(url, withBearer(init, userToken));
    if (res.status !== 401 && res.status !== 403) return { res, identity: 'user', triedUser: true };
    // The delegated identity is not authorized for this surface — retry as the
    // service principal before surfacing the denial.
    let spToken: string | null = null;
    try { spToken = await getPowerPlatformSpToken(scope, opts); } catch { spToken = null; }
    if (!spToken) return { res, identity: 'user', triedUser: true };
    return { res: await fetchWithTimeout(url, withBearer(init, spToken)), identity: 'sp', triedUser: true };
  }
  return {
    res: await fetchWithTimeout(url, withBearer(init, await getPowerPlatformSpToken(scope, opts))),
    identity: 'sp',
    triedUser: false,
  };
}

/**
 * Remediation copy for a 401/403, naming the principal(s) actually refused.
 * `triedUser` comes straight from {@link PpFetchResult}.
 */
export function ppAuthHint(triedUser: boolean): string {
  return triedUser
    ? 'Both identities were refused: your signed-in account, then the Console service principal. '
      + 'Confirm your account has a Power Platform licence and a role on this environment, AND that the '
      + 'Console SP is registered as a Power Platform management application (New-PowerAppManagementApp) '
      + 'and — for Dataverse — added as an Application User with the System Administrator role.'
    : 'Confirm the Console UAMI SP is added to the "Service principals can use Power Platform APIs" allow '
      + 'group in Power Platform admin centre, and (for Dataverse) added as an Application User in the '
      + 'target environment with the System Administrator role.';
}
