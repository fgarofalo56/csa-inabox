/**
 * Pure request/field shaping for Azure AI Foundry workspace CONNECTIONS —
 * NO server imports (no `@azure/identity`, no fetch).
 *
 * Split out of `foundry-connections-client.ts` (server-only) so the `'use client'`
 * Foundry hub editor's typed connection create-dialog and the data-plane client
 * share the exact same wire shaping — and so the secret-handling contract is
 * unit-testable without a live workspace or a credential.
 *
 * Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/ai-foundry/how-to/develop/connections-add
 *   https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/workspaces/connections
 */

/** Connection categories the typed create-dialog offers (portal parity subset). */
export type ConnectionCategory =
  | 'AzureOpenAI'
  | 'CognitiveSearch'
  | 'AIServices'
  | 'AzureBlob'
  | 'ApiKey'
  | 'CustomKeys';

/** Auth modes the create-dialog offers. `AAD` = workspace managed identity (no secret). */
export type ConnectionAuthMode = 'AAD' | 'ApiKey' | 'CustomKeys';

/** Category picker rows — drive the credential-field set in the dialog. */
export const CONNECTION_CATEGORIES: {
  value: ConnectionCategory;
  label: string;
  /** Placeholder for the endpoint/target field. */
  targetPlaceholder: string;
  /** Auth modes valid for this category (first is the default). */
  authModes: ConnectionAuthMode[];
}[] = [
  { value: 'AzureOpenAI', label: 'Azure OpenAI', targetPlaceholder: 'https://<name>.openai.azure.com', authModes: ['AAD', 'ApiKey'] },
  { value: 'CognitiveSearch', label: 'Azure AI Search', targetPlaceholder: 'https://<name>.search.windows.net', authModes: ['AAD', 'ApiKey'] },
  { value: 'AIServices', label: 'Azure AI Services', targetPlaceholder: 'https://<name>.cognitiveservices.azure.com', authModes: ['AAD', 'ApiKey'] },
  { value: 'AzureBlob', label: 'Azure Blob storage', targetPlaceholder: 'https://<account>.blob.core.windows.net/<container>', authModes: ['AAD'] },
  { value: 'ApiKey', label: 'Custom (API key)', targetPlaceholder: 'https://<endpoint>', authModes: ['ApiKey'] },
  { value: 'CustomKeys', label: 'Custom (multiple keys)', targetPlaceholder: 'https://<endpoint>', authModes: ['CustomKeys'] },
];

export interface CreateConnectionInput {
  name: string;
  category: ConnectionCategory;
  /** Endpoint / account URL the connection targets (e.g. the AOAI or Search endpoint). */
  target: string;
  /** `AAD` (default, managed-identity, no secret) or a key-based mode. */
  authMode?: ConnectionAuthMode;
  /**
   * For `ApiKey` — a Key Vault secret IDENTIFIER (never a raw key):
   * `https://<vault>.vault.azure.net/secrets/<name>[/<version>]`.
   */
  keyVaultSecretUri?: string;
  /**
   * For `CustomKeys` — a map of logical key name → Key Vault secret identifier.
   * Every value must be a KV secret URI (raw values are rejected).
   */
  customKeyVaultRefs?: Record<string, string>;
  /** Share the connection with everyone in the hub (default true, matching the portal). */
  isSharedToAll?: boolean;
  metadata?: Record<string, string>;
}

/** True when `s` is an Azure Key Vault secret identifier URI (all clouds). */
export function isKeyVaultSecretUri(s: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)\/secrets\/[^/\s]+(\/[^/\s]+)?\/?$/i.test(
    (s || '').trim(),
  );
}

export class RawSecretRejectedError extends Error {
  readonly code = 'raw_secret_rejected';
  constructor(field: string) {
    super(
      `Refusing to send a raw secret for "${field}". Provide a Key Vault secret identifier ` +
        `(https://<vault>.vault.azure.net/secrets/<name>) instead — Loom never puts a plaintext ` +
        `secret in a connection request body (Gov secret-handling).`,
    );
    this.name = 'RawSecretRejectedError';
  }
}

/**
 * Build the ARM request body for a workspace connection. PURE + exported so the
 * secret-handling contract is unit-testable without a live workspace. Throws
 * {@link RawSecretRejectedError} if a key-based mode is given a value that is
 * NOT a Key Vault secret identifier — this is what guarantees "no raw secret in
 * the request body".
 */
export function buildConnectionBody(input: CreateConnectionInput): any {
  const authMode: ConnectionAuthMode = input.authMode || 'AAD';
  const props: any = {
    category: input.category,
    target: (input.target || '').trim(),
    isSharedToAll: input.isSharedToAll !== false,
  };
  if (input.metadata && Object.keys(input.metadata).length) props.metadata = { ...input.metadata };

  if (authMode === 'AAD') {
    // Microsoft Entra ID — the workspace managed identity authenticates. No secret.
    props.authType = 'AAD';
  } else if (authMode === 'ApiKey') {
    const uri = (input.keyVaultSecretUri || '').trim();
    if (!isKeyVaultSecretUri(uri)) throw new RawSecretRejectedError('keyVaultSecretUri');
    props.authType = 'ApiKey';
    // The credential is carried as a Key Vault reference, never a plaintext key.
    props.credentials = { key: uri };
    props.metadata = { ...(props.metadata || {}), keyVaultSecretUri: uri, credentialKind: 'keyVaultReference' };
  } else {
    // CustomKeys — every value must be a KV reference.
    const refs = input.customKeyVaultRefs || {};
    const entries = Object.entries(refs);
    if (!entries.length) throw new RawSecretRejectedError('customKeyVaultRefs');
    for (const [k, v] of entries) {
      if (!isKeyVaultSecretUri(v)) throw new RawSecretRejectedError(`customKeyVaultRefs.${k}`);
    }
    props.authType = 'CustomKeys';
    props.credentials = { keys: Object.fromEntries(entries) };
    props.metadata = { ...(props.metadata || {}), credentialKind: 'keyVaultReference' };
  }
  return { properties: props };
}

/** Validate a connection name (2–63 chars: letters, digits, _ . -). */
export function isValidConnectionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/.test((name || '').trim());
}

/**
 * Map a workspace connection's persisted `authType` (returned by GET) back to
 * the {@link ConnectionAuthMode} the edit-dialog uses to prefill its auth
 * picker. Anything not recognised (SAS, AccountKey, etc.) falls back to `AAD`
 * so the edit dialog always renders a valid, secret-free default.
 */
export function authTypeToMode(authType?: string | null): ConnectionAuthMode {
  switch ((authType || '').trim()) {
    case 'ApiKey':
      return 'ApiKey';
    case 'CustomKeys':
      return 'CustomKeys';
    default:
      return 'AAD';
  }
}

/**
 * Editing an existing connection is the SAME create-or-update PUT as
 * {@link buildConnectionBody} — the ARM connections REST has no distinct PATCH;
 * a PUT replaces the connection's properties. `category` is immutable in the
 * portal, so callers pass the existing category through unchanged. This alias
 * exists purely to name the intent at edit call-sites (and to keep the
 * secret-handling contract — a raw secret still throws
 * {@link RawSecretRejectedError}).
 */
export function buildConnectionUpdateBody(input: CreateConnectionInput): any {
  return buildConnectionBody(input);
}
