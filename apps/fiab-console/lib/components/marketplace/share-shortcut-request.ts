/**
 * The request body the Data shares "Shortcut into lakehouse" dialog posts to
 * POST /api/lakehouse/shortcuts. Pure, so the route test posts EXACTLY what the
 * dialog sends (share-explorer.tsx).
 *
 * The credential is the provider's stored activation file. Its Key Vault name is
 * computed with `shareProviderSecretName` — the same mapping the providers route
 * used to store it — so a provider name with characters Key Vault does not allow
 * (e.g. `acme_corp`) refers to the secret that actually exists (`loom-dsp-acme-corp`).
 */
import { shareProviderSecretName } from '@/lib/azure/kv-secret-name';

export interface ShareShortcutRequestArgs {
  lakehouseId: string;
  /** Shortcut name typed in the dialog (may be empty — the table name is used). */
  name: string;
  providerName: string;
  shareName: string;
  schema: string;
  table: string;
}

export function buildShareShortcutRequest(a: ShareShortcutRequestArgs) {
  return {
    lakehouseId: a.lakehouseId,
    name: (a.name.trim() || a.table).replace(/[^A-Za-z0-9 _.-]/g, '_'),
    kind: 'tables' as const,
    targetType: 'delta_sharing' as const,
    targetUri: `delta-sharing://${a.shareName}/${a.schema}/${a.table}`,
    credentialRef: { kind: 'deltaSharing' as const, keyVaultSecret: shareProviderSecretName(a.providerName) },
    format: 'delta' as const,
  };
}
