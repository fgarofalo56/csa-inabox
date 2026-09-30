/**
 * shortcut-secret-resolver — the ONE way Console code turns a lakehouse-shortcut
 * credential NAME into its value.
 *
 * `getKeyVaultSecret` (lib/azure/shortcut-credentials.ts) resolves any secret
 * name with the Console identity and applies no name policy of its own. Every
 * shortcut read therefore goes through {@link resolveShortcutSecret}, which
 * applies two checks BEFORE any vault call and only then delegates:
 *
 *   1. PURPOSE POLICY — `assertSecretReadAllowed(name, 'shortcut-credential')`
 *      (lib/azure/kv-secret-purpose.ts), the same policy every other credential
 *      read uses. The shortcut purpose owns the `loom-sc-` / `loom-shortcut-`
 *      name-space; platform secrets and other features' minted names are refused.
 *
 *   2. OWNERSHIP — the name must belong to whoever the read is on behalf of:
 *
 *      - `{ kind: 'item', itemId }` — a lakehouse-shortcut ITEM. The item route
 *        mints exactly `loom-shortcut-<itemId>` (through `sanitizeSecretName`),
 *        so the recorded owner is in the name and nothing else is accepted.
 *
 *      - `{ kind: 'principal', upn }` — the lakehouse editor's shortcut registry
 *        (Cosmos `lakehouse-shortcuts`). A `loom-sc-` name is owned by the
 *        principal whose registry row FIRST bound it (`createdBy` of the
 *        earliest row referencing it, across every lakehouse). A name no row has
 *        bound yet is accepted, and the row the caller then writes records them
 *        as its owner. `loom-shortcut-` names belong to shortcut items and are
 *        refused here.
 *
 * Neither check reads the secret, so a refused name never reaches Key Vault.
 * `scripts/ci/check-shortcut-secret-resolver.mjs` fails the build if any other
 * module imports `getKeyVaultSecret` from shortcut-credentials.
 *
 * SCOPE OF THE PRINCIPAL RULE: ownership is recorded at FIRST BIND (the first
 * registry row), not at mint, so a `loom-sc-` name no row references yet is
 * accepted for the signed-in principal presenting it.
 *
 * Errors raised here carry secret NAMES only, never values.
 */
import { getKeyVaultSecret } from './shortcut-credentials';
import { assertSecretReadAllowed, KeyVaultSecretPolicyError } from './kv-secret-purpose';
import { listShortcutSecretBindings, type ShortcutSecretBinding } from './lakehouse-shortcuts';
import { sanitizeSecretName } from './kv-secrets-client';

/** On whose behalf a shortcut credential is being resolved. */
export type ShortcutSecretOwner =
  /** A lakehouse-shortcut item — may read only the credential minted for it. */
  | { kind: 'item'; itemId: string }
  /** A principal acting through the lakehouse shortcut registry. */
  | { kind: 'principal'; upn: string | undefined | null };

/** The item route's minted prefix. Items own it; the registry path may not read it. */
const ITEM_PREFIX = 'loom-shortcut-';

/** Thrown when the named credential does not belong to the requested owner. */
export class ShortcutSecretOwnershipError extends Error {
  readonly status = 403;
  readonly code = 'shortcut_secret_not_owned';
  constructor(public readonly secretName: string, detail: string) {
    super(detail);
    this.name = 'ShortcutSecretOwnershipError';
  }
}

/** True for either refusal this module raises (policy or ownership) — both are 403s, never retried. */
export function isShortcutSecretRefusal(e: unknown): e is KeyVaultSecretPolicyError | ShortcutSecretOwnershipError {
  return e instanceof KeyVaultSecretPolicyError || e instanceof ShortcutSecretOwnershipError;
}

/** The secret name the item route mints for `itemId`, lower-cased for comparison. */
export function itemSecretName(itemId: string): string {
  return sanitizeSecretName(`${ITEM_PREFIX}${itemId}`).toLowerCase();
}

/** The binding that records ownership: the earliest row, ties broken by id so the answer is stable. */
function firstBinding(rows: ShortcutSecretBinding[]): ShortcutSecretBinding | undefined {
  return [...rows].sort((a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)),
  )[0];
}

/**
 * Throw {@link ShortcutSecretOwnershipError} unless `name` belongs to `owner`.
 * Assumes the purpose policy already passed. Makes no vault call.
 */
export async function assertShortcutSecretOwned(name: string, owner: ShortcutSecretOwner): Promise<void> {
  const raw = (name || '').trim();
  const n = raw.toLowerCase();

  if (owner.kind === 'item') {
    const itemId = (owner.itemId || '').trim();
    if (!itemId || n !== itemSecretName(itemId)) {
      throw new ShortcutSecretOwnershipError(
        raw,
        `Key Vault secret '${raw}' was not stored for this shortcut. A shortcut item reads only the credential ` +
          'Loom saved when it was created — re-enter the credential on the shortcut to replace it.',
      );
    }
    return;
  }

  if (n.startsWith(ITEM_PREFIX)) {
    throw new ShortcutSecretOwnershipError(
      raw,
      `Key Vault secret '${raw}' belongs to a lakehouse-shortcut item and cannot be reused here. ` +
        'Save the credential for this shortcut with "Save to Key Vault".',
    );
  }

  const who = (owner.upn || '').trim().toLowerCase();
  if (!who) {
    throw new ShortcutSecretOwnershipError(
      raw,
      `Loom could not identify who is using Key Vault secret '${raw}', so it did not read it. Sign in again and retry.`,
    );
  }

  const first = firstBinding(await listShortcutSecretBindings(n));
  if (!first) return; // not bound yet — the caller's own row will record them as owner
  if (String(first.createdBy || '').trim().toLowerCase() !== who) {
    throw new ShortcutSecretOwnershipError(
      raw,
      `Key Vault secret '${raw}' is already bound to another user's shortcut, so Loom did not read it. ` +
        'Save your own credential for this shortcut with "Save to Key Vault".',
    );
  }
}

/**
 * Policy + ownership WITHOUT reading the value. For a caller about to RECORD a
 * reference to `name` (a registry row) on a path that may not resolve it — a
 * row written without this check would record ownership nobody verified.
 */
export async function assertShortcutSecretUsable(name: string, owner: ShortcutSecretOwner): Promise<void> {
  assertSecretReadAllowed(name, 'shortcut-credential');
  await assertShortcutSecretOwned(name, owner);
}

/**
 * Resolve a lakehouse-shortcut credential by name, on behalf of `owner`.
 * Policy first, ownership second, vault last — a refusal makes no vault call.
 */
export async function resolveShortcutSecret(name: string, owner: ShortcutSecretOwner): Promise<string> {
  await assertShortcutSecretUsable(name, owner);
  return getKeyVaultSecret(name.trim());
}
