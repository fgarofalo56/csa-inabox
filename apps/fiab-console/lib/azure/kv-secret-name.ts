/**
 * Key Vault secret NAME grammar — pure, dependency-free, safe to import from
 * client components as well as server code.
 *
 * Key Vault accepts secret names of 1–127 characters from `[0-9A-Za-z-]`
 * (https://learn.microsoft.com/azure/key-vault/general/about-keys-secrets-certificates#objects-identifiers-and-versioning).
 */

/** The complete Key Vault secret-name grammar. */
export const KV_SECRET_NAME_RE = /^[0-9A-Za-z-]{1,127}$/;

/** True when `name` is, exactly and without trimming, a valid Key Vault secret name. */
export function isValidKeyVaultSecretName(name: unknown): name is string {
  return typeof name === 'string' && KV_SECRET_NAME_RE.test(name);
}

/** Map any string onto the grammar (1-127 chars of [0-9a-zA-Z-]). */
export function sanitizeSecretName(raw: string): string {
  return (raw || '').replace(/[^0-9a-zA-Z-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 127) || 'loom-secret';
}

/**
 * The Key Vault secret name Loom stores a Delta Sharing provider's activation
 * credential under (`app/api/marketplace/sharing/providers/route.ts` saves it
 * through `putKeyVaultSecret`, which applies {@link sanitizeSecretName}).
 * One definition, so a caller that REFERS to the secret computes the same name
 * the route stored.
 */
export function shareProviderSecretName(providerName: string): string {
  return sanitizeSecretName(`loom-dsp-${providerName}`);
}
