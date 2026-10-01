/**
 * share-provider-access — may the caller use a Delta Sharing provider's stored
 * activation credential (`loom-dsp-<provider>`) for a lakehouse shortcut?
 *
 * The rule is the one `/api/marketplace/sharing/providers` applies to the
 * provider itself: any signed-in caller may list and use the providers
 * registered on this deployment's bound Databricks workspace hosts. The
 * credential is therefore authorised by PROVIDER — a secret name that maps to
 * no registered provider is refused — not by which user first bound it.
 *
 * Signed-in is established by the calling route (`withSession`); this module
 * answers the provider half.
 */
import { resolveWorkspaceHostnames, listProviders } from './unity-catalog-client';
import { shareProviderSecretName } from './kv-secret-name';

export const SHARE_PROVIDER_SECRET_PREFIX = 'loom-dsp-';

/**
 * The registered provider whose stored credential is `secretName`, or null when
 * none is (including when no Databricks workspace is bound). Compared through
 * {@link shareProviderSecretName}, the same mapping the providers route used
 * to store it.
 */
export async function shareProviderForSecret(secretName: string): Promise<string | null> {
  const n = (secretName || '').toLowerCase();
  if (!n.startsWith(SHARE_PROVIDER_SECRET_PREFIX)) return null;
  let hosts: string[];
  try {
    hosts = await resolveWorkspaceHostnames();
  } catch {
    return null; // no bound workspace: no provider can be registered
  }
  for (const host of hosts) {
    const providers = await listProviders(host);
    const hit = providers.find((p) => shareProviderSecretName(String(p?.name || '')).toLowerCase() === n);
    if (hit) return String(hit.name);
  }
  return null;
}
