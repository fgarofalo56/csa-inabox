/**
 * aca-managed-identity — a tiny custom {@link TokenCredential} that talks the
 * Azure Container Apps (ACA) managed-identity endpoint DIRECTLY, bypassing
 * `@azure/identity`'s MSAL-based `ManagedIdentityCredential`.
 *
 * ## Why this exists (root cause, proven empirically in the live ACA container)
 *
 * Every server-side Azure call from the console was failing with:
 *
 *   `ChainedTokenCredential authentication failed … AuthenticationRequiredError:
 *    Response had no "expiresOn" property`
 *
 * The RAW ACA managed-identity endpoint WORKS perfectly when called directly:
 *
 *   GET ${IDENTITY_ENDPOINT}?resource=<resource>&api-version=2019-08-01&client_id=${AZURE_CLIENT_ID}
 *   header: X-IDENTITY-HEADER: ${IDENTITY_HEADER}
 *
 * returns HTTP 200 with JSON fields:
 *   { access_token, expires_on (Unix-seconds STRING), resource, token_type, client_id }
 *
 * Critically, `expires_in` is ABSENT and `expires_on` is a Unix-SECONDS string.
 * `@azure/identity` 4.13.x's MSAL-based `ManagedIdentityCredential` cannot parse
 * this response shape and throws "Response had no expiresOn property" — which
 * breaks EVERY server feature (activity history, cost, Defender, connections,
 * provisioning probes, …).
 *
 * This is NOT a config/RBAC/SDK-version problem (the UAMI is correctly attached,
 * the clientId is correct, the SDK is current). The fix is to BYPASS the broken
 * MSAL MI path with this credential, which performs the proven raw call and maps
 * `expires_on` (Unix seconds) → `expiresOnTimestamp` (ms) that `@azure/core-auth`
 * expects.
 *
 * ## Behaviour
 *
 * - Resolves the ACA endpoint from `IDENTITY_ENDPOINT` / `IDENTITY_HEADER`
 *   (also accepts the legacy App Service `MSI_ENDPOINT` / `MSI_SECRET`). If
 *   neither is present (local dev), `getToken` throws `CredentialUnavailableError`
 *   so a wrapping `ChainedTokenCredential` falls through to the next credential
 *   (typically `DefaultAzureCredential`).
 * - Converts the requested scope → resource: the first scope, with a trailing
 *   `/.default` stripped (e.g. `https://management.azure.com/.default` →
 *   `https://management.azure.com/`).
 * - Uses the repo's `fetchWithTimeout` (NOT bare `fetch`) so the metadata call
 *   inherits the standard server-side deadline (no-bare-server-fetch guard).
 *
 * CLOUD-INVARIANT: this is pure transport behaviour against the local
 * instance-metadata endpoint. It touches none of the sovereign endpoint logic;
 * the scope/resource it is asked for already carries the cloud-correct host.
 */

import {
  ChainedTokenCredential,
  CredentialUnavailableError,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
// `@azure/identity` re-exports these from `@azure/core-auth`; importing them
// from here avoids a direct `@azure/core-auth` dependency (which is not hoisted
// for tsc resolution in this workspace).
import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/identity';
import { fetchWithTimeout } from './fetch-with-timeout';

/** ACA / App Service managed-identity metadata API version that returns the
 *  `expires_on` (Unix-seconds) shape the raw endpoint speaks. */
const MI_API_VERSION = '2019-08-01';

/** Resolve the UAMI client id the console runs as, from the same env the rest
 *  of the clients read. Empty → system-assigned (omit `client_id`). */
function defaultClientId(): string | undefined {
  return process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID || undefined;
}

/** Resolve the ACA/App-Service MI endpoint + header from env. Returns null when
 *  not running under a managed identity (e.g. local dev). */
function resolveEndpoint(): { endpoint: string; header: string } | null {
  const endpoint = process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT;
  const header = process.env.IDENTITY_HEADER || process.env.MSI_SECRET;
  if (!endpoint || !header) return null;
  return { endpoint, header };
}

/** Scope → resource: take the first scope and strip a trailing `/.default`. */
function scopeToResource(scopes: string | string[]): string {
  const first = Array.isArray(scopes) ? scopes[0] : scopes;
  if (!first) throw new Error('AcaManagedIdentityCredential: getToken called with no scope');
  return first.replace(/\/\.default$/, '');
}

/**
 * A {@link TokenCredential} that fetches tokens straight from the ACA
 * managed-identity endpoint using the proven `2019-08-01` + `X-IDENTITY-HEADER`
 * call, and maps the `expires_on` (Unix-seconds) response into the
 * `expiresOnTimestamp` (ms) shape `@azure/core-auth` expects.
 */
export class AcaManagedIdentityCredential implements TokenCredential {
  private readonly clientId?: string;

  constructor(options?: { clientId?: string }) {
    this.clientId = options?.clientId;
  }

  async getToken(
    scopes: string | string[],
    _options?: GetTokenOptions,
  ): Promise<AccessToken> {
    const resolved = resolveEndpoint();
    if (!resolved) {
      // Not under a managed identity — let the chain fall through to the next
      // credential (DefaultAzureCredential for local dev).
      throw new CredentialUnavailableError(
        'AcaManagedIdentityCredential: IDENTITY_ENDPOINT/IDENTITY_HEADER (or MSI_ENDPOINT/MSI_SECRET) not set; not running under a managed identity.',
      );
    }

    const { endpoint, header } = resolved;
    const resource = scopeToResource(scopes);
    const clientId = this.clientId ?? defaultClientId();

    const params = new URLSearchParams({
      'api-version': MI_API_VERSION,
      resource,
    });
    if (clientId) params.set('client_id', clientId);
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`;

    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        // Primary header the ACA MI endpoint requires; Metadata:true is a
        // belt-and-suspenders for the App Service / IMDS variants.
        'X-IDENTITY-HEADER': header,
        Metadata: 'true',
      },
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(
        `AcaManagedIdentityCredential: managed-identity endpoint returned ${res.status}: ${body.slice(0, 300)}`,
      );
    }

    let json: {
      access_token?: string;
      expires_on?: string | number;
      token_type?: string;
    };
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(
        `AcaManagedIdentityCredential: managed-identity endpoint returned non-JSON body: ${body.slice(0, 300)}`,
      );
    }

    if (!json.access_token) {
      throw new Error(
        `AcaManagedIdentityCredential: managed-identity response missing access_token: ${body.slice(0, 300)}`,
      );
    }

    // `expires_on` is Unix SECONDS (string or number) → core-auth wants ms.
    const expiresOnSeconds = Number(json.expires_on);
    const expiresOnTimestamp = Number.isFinite(expiresOnSeconds)
      ? expiresOnSeconds * 1000
      : Date.now() + 60 * 60 * 1000; // defensive: 1h if the field is ever absent

    return { token: json.access_token, expiresOnTimestamp };
  }
}

/** Factory: a fresh {@link AcaManagedIdentityCredential}, optional explicit UAMI clientId. */
export function loomManagedIdentity(clientId?: string): AcaManagedIdentityCredential {
  return new AcaManagedIdentityCredential(clientId ? { clientId } : undefined);
}

/**
 * Shared server credential chain for the console:
 *   1. {@link AcaManagedIdentityCredential} — the PROVEN raw ACA MI path (first
 *      so it wins in production and the @azure/identity MSI parse bug is never hit).
 *   2. `ManagedIdentityCredential` — the SDK MI path, in case Aca is ever
 *      unavailable but the SDK can still mint a token.
 *   3. `DefaultAzureCredential` — local dev (az login / VS Code / env).
 *
 * Clients that maintain their own per-module credential can switch to this, but
 * the minimal fix simply prepends `AcaManagedIdentityCredential` to each
 * existing chain (see callers).
 */
const uami = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
export const loomServerCredential: ChainedTokenCredential = new ChainedTokenCredential(
  new AcaManagedIdentityCredential(uami ? { clientId: uami } : undefined),
  new ManagedIdentityCredential(uami ? { clientId: uami } : undefined),
  new DefaultAzureCredential(),
);
