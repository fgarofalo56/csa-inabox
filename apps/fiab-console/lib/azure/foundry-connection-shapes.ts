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

import { trimSlashes, trimTrailingSlashes } from '@/lib/util/trim';

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
  /**
   * The `AzureBackedField` kind that DISCOVERS this category's target endpoint,
   * where one exists (#3518). Present ⇒ the dialog renders a picker instead of
   * a free-text box; absent ⇒ the endpoint is genuinely not enumerable and the
   * Input stays.
   *
   * Every kind here projects the endpoint from ARM (`properties.endpoint`,
   * `properties.primaryEndpoints.blob`), so the sovereign host comes back WITH
   * the row and is right in every boundary (`cloud-parity.md`).
   *
   * `CognitiveSearch` deliberately has NO kind. An Azure AI Search service does
   * not carry its endpoint as an ARM property — the URL is
   * `https://<name>.<search-suffix>` — and the suffix is boundary-dependent
   * (`getSearchSuffix()`: `search.windows.net` vs `search.azure.us`)  cloud-endpoint-literal-ok:
   * naming BOTH suffixes side by side IS the note; there is no composed
   * endpoint on this line to make boundary-aware. That
   * helper resolves `LOOM_CLOUD`, which is not a `NEXT_PUBLIC_` variable and so
   * reads as `undefined` in the browser, meaning a client-side composition
   * would emit the COMMERCIAL host on a Gov estate. A wrong endpoint is worse
   * than a typed one, so this row keeps its Input until the value can be
   * derived where the boundary is actually known.
   */
  kind?: string;
  /**
   * TRUE when the target this row declares is CONTAINER-scoped, i.e. the
   * account endpoint alone is not the whole value.
   *
   * This exists because the row and its picker disagreed (blocking review,
   * 2026-09-07). `AzureBlob`'s `targetPlaceholder` has always been
   * `https://<account>.blob.core.windows.net/<container>`, but  cloud-endpoint-literal-ok:
   * this quotes the row's own declared placeholder verbatim (line below), which
   * is the contradiction being described — rewriting it would erase the defect.
   * `storage-blob-endpoint` projects `properties.primaryEndpoints.blob` — the
   * ACCOUNT endpoint, no container — so the default path (pick from the list,
   * create) emitted a target missing the segment this same file says is part
   * of it. Every other storage surface in this wave cascades a
   * `BlobContainerPicker` off the picked account; this one did not.
   *
   * Declaring it here rather than special-casing the category in the editor
   * keeps "does this target need a container" in the one place the target
   * shape is defined, and lets the composition be unit-tested with no live
   * workspace ({@link composeBlobTarget}).
   */
  containerScoped?: boolean;
  /** Auth modes valid for this category (first is the default). */
  authModes: ConnectionAuthMode[];
}[] = [
  { value: 'AzureOpenAI', label: 'Azure OpenAI', targetPlaceholder: 'https://<name>.openai.azure.com', kind: 'aoaiEndpoint', authModes: ['AAD', 'ApiKey'] },
  { value: 'CognitiveSearch', label: 'Azure AI Search', targetPlaceholder: 'https://<name>.search.windows.net', authModes: ['AAD', 'ApiKey'] },
  { value: 'AIServices', label: 'Azure AI Services', targetPlaceholder: 'https://<name>.cognitiveservices.azure.com', kind: 'aoaiEndpoint', authModes: ['AAD', 'ApiKey'] },
  { value: 'AzureBlob', label: 'Azure Blob storage', targetPlaceholder: 'https://<account>.blob.core.windows.net/<container>', kind: 'storage-blob-endpoint', containerScoped: true, authModes: ['AAD'] },
  { value: 'ApiKey', label: 'Custom (API key)', targetPlaceholder: 'https://<endpoint>', authModes: ['ApiKey'] },
  { value: 'CustomKeys', label: 'Custom (multiple keys)', targetPlaceholder: 'https://<endpoint>', authModes: ['CustomKeys'] },
];

/**
 * ── THE CONTAINER-SCOPED TARGET, COMPOSED NOT TYPED ─────────────────────────
 * `storage-blob-endpoint` returns the ACCOUNT endpoint from ARM — which is what
 * makes the sovereign host right in every boundary, since the suffix comes back
 * WITH the row rather than being composed in a browser that cannot read
 * `LOOM_CLOUD`. The container half is then chosen from a `BlobContainerPicker`
 * and joined here.
 *
 * Split out as a pure function on purpose: the defect this fixes was a
 * contradiction INSIDE the repo (the row's declared `targetPlaceholder` versus
 * what its `kind` could emit), so the receipt for it is a unit test over these
 * two functions, not a live Foundry workspace.
 *
 * Exactly one slash between the two halves, no trailing slash, and an empty
 * container yields the endpoint unchanged so a half-filled form does not
 * produce `https://acct.blob…net/`.
 *
 * `path` is the OPTIONAL remainder below the container. The form never
 * produces one — the picker chooses a container — but a target stored by the
 * REST API or by an older client can carry `…/bronze/raw/2026`, and dropping
 * that on an edit would silently repoint the connection. It is carried so the
 * round trip `compose(split(t)) === t` holds for those too (re-review
 * 2026-09-07, nit 4). An empty container with a non-empty path is a shape
 * nothing can produce, so the path is dropped rather than joined onto the
 * account.
 */
export function composeBlobTarget(accountEndpoint: string, container: string, path = ''): string {
  const base = trimTrailingSlashes((accountEndpoint || '').trim());
  const c = trimSlashes((container || '').trim());
  const p = trimSlashes((path || '').trim());
  if (!base) return '';
  if (!c) return base;
  return p ? `${base}/${c}/${p}` : `${base}/${c}`;
}

/**
 * The inverse, for prefilling the EDIT dialog from a stored target.
 *
 * The FIRST path segment is the container — that is what an `AzureBlob`
 * connection is scoped to and what `BlobContainerPicker` can match against the
 * account's real containers. Everything below it is returned separately as
 * `path`: folding `bronze/raw/2026` into `container` handed the picker a
 * "container name" containing slashes, which matches nothing it lists and which
 * `composeBlobTarget` would then re-emit as though the user had chosen it
 * (re-review 2026-09-07, nit 4). A target with no path yields an empty container
 * and an empty path (which the picker renders as "choose one"), never a guess.
 */
export function splitBlobTarget(target: string): { accountEndpoint: string; container: string; path: string } {
  const raw = (target || '').trim();
  const m = /^(https?:\/\/[^/]+)(?:\/(.*))?$/i.exec(raw);
  if (!m) return { accountEndpoint: raw, container: '', path: '' };
  const rest = trimSlashes(m[2] || '');
  if (!rest) return { accountEndpoint: m[1], container: '', path: '' };
  const slash = rest.indexOf('/');
  return slash === -1
    ? { accountEndpoint: m[1], container: rest, path: '' }
    : { accountEndpoint: m[1], container: rest.slice(0, slash), path: trimSlashes(rest.slice(slash + 1)) };
}

/**
 * The storage ACCOUNT name out of a blob endpoint —
 * `https://acct.blob.<storage-suffix>/` → `acct`. `BlobContainerPicker` takes
 * an ARM id or a bare account name, and neither is what the edit dialog holds
 * when it is prefilled from a stored target, so this bridges the two.
 * Returns '' when the host is not a blob endpoint.
 */
export function blobAccountFromEndpoint(accountEndpoint: string): string {
  const m = /^https?:\/\/([a-z0-9]+)\.blob\./i.exec((accountEndpoint || '').trim());
  return (m?.[1] || '').toLowerCase();
}

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
