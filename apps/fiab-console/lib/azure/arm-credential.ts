/**
 * arm-credential — the SHARED user-assigned managed-identity credential chain
 * for every server-side ARM / Azure-management / data-plane call from the
 * console BFF.
 *
 * ## Why this exists (the ACA managed-identity token bug)
 *
 * On Azure Container Apps the stock `@azure/identity`
 * `ManagedIdentityCredential` / `DefaultAzureCredential` CANNOT parse the ACA
 * managed-identity token: the ACA metadata endpoint returns `expires_on` as a
 * Unix-SECONDS value with no `expires_in`, and MSAL throws
 * `"Response had no expiresOn property"`. The token never materialises, so the
 * Azure call fails — Resource Graph rejects it, ARM 401s, data-plane calls
 * 401 — which surfaced as misleading "no resources / Unknown / no access"
 * gates across many "Add existing / discover / enumerate" flows.
 *
 * {@link AcaManagedIdentityCredential} performs the proven raw `2019-08-01` +
 * `X-IDENTITY-HEADER` call and maps `expires_on` (seconds) →
 * `expiresOnTimestamp` (ms). It MUST be the FIRST link in any UAMI credential
 * chain so it wins in production and the broken MSAL MI path is never hit. On
 * local dev it throws `CredentialUnavailableError` (no `IDENTITY_ENDPOINT`),
 * so the chain falls through to `DefaultAzureCredential` (az / VS Code login).
 *
 * This mirrors `lib/azure/adls-client.ts` exactly. Use `uamiArmCredential()`
 * anywhere you previously wrote `new ManagedIdentityCredential(...)` /
 * `new DefaultAzureCredential()` for a UAMI/ARM/data-plane token.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

/**
 * The ACA-first UAMI credential chain. Reads the UAMI client id from
 * `LOOM_UAMI_CLIENT_ID` (falling back to `AZURE_CLIENT_ID`); when neither is
 * set the credentials run system-assigned. Identical in shape to the chain in
 * `adls-client.ts`:
 *
 *   1. {@link AcaManagedIdentityCredential} — proven raw ACA MI path (FIRST).
 *   2. `ManagedIdentityCredential`          — SDK MI path.
 *   3. `DefaultAzureCredential`             — local dev (az / VS Code / env).
 */
export function uamiArmCredential(): ChainedTokenCredential {
  const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  return new ChainedTokenCredential(
    new AcaManagedIdentityCredential(),
    new ManagedIdentityCredential(uamiClientId ? { clientId: uamiClientId } : {}),
    new DefaultAzureCredential(),
  );
}
