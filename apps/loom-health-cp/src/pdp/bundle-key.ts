// Production wiring for PDP bundle signing: the stamp's NON-EXPORTABLE Key Vault key (EC P-256), reached with the
// control plane's managed identity. The key is created by ARM in control-plane.bicep (same as the token signing key:
// ARM creates keys on a private vault with no data-plane role), and its versioned id arrives in
// LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID. Reusing the versioned id means the public key served to deploy-health and the
// key that signs are the same version by construction.

import { DefaultAzureCredential } from '@azure/identity';
import { KeyVaultBundleSigner } from '../auth/signer.js';
import { ConfigError, type Config } from '../config.js';
import type { BundleSigner } from './bundle-sign.js';

/** undefined = signing is off (the variable is unset): publishes answer 503 and the key endpoint answers 503. */
export function bundleSignerFromConfig(cfg: Config): BundleSigner | undefined {
  if (!cfg.pdpSigningKeyId) return undefined;
  const credential = new DefaultAzureCredential({ authorityHost: `https://${cfg.authorityHost}` });
  try {
    return new KeyVaultBundleSigner({
      cloud: cfg.cloud,
      keyId: cfg.pdpSigningKeyId,
      getToken: async (scope) => (await credential.getToken(scope)).token,
    });
  } catch {
    // validateKeyVaultKeyId threw: say which variable, never echo the value.
    throw new ConfigError('LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID must be https://<vault>.<cloud suffix>/keys/<name>/<version>');
  }
}
