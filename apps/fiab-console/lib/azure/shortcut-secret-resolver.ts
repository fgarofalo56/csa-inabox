/**
 * shortcut-secret-resolver — the ONE way Console code turns a lakehouse-shortcut
 * credential NAME into its value.
 *
 * `getKeyVaultSecret` (lib/azure/shortcut-credentials.ts) and
 * `getShortcutSecretValue` (lib/azure/kv-secrets-client.ts) read a secret by
 * name with the Console identity. Every shortcut read goes through
 * {@link resolveShortcutSecret}, which applies three checks, in order, BEFORE
 * the value is read, and only then delegates:
 *
 *   1. NAME GRAMMAR — the name must already be a Key Vault secret name,
 *      `^[0-9A-Za-z-]{1,127}$`, exactly as given: surrounding whitespace is
 *      refused, not trimmed, so the name that is checked is the name that is read.
 *
 *   2. PURPOSE POLICY — `assertSecretReadAllowed(name, 'shortcut-credential')`
 *      (lib/azure/kv-secret-purpose.ts): only the shortcut name-spaces Loom mints
 *      (`loom-sc-`, `loom-shortcut-`, `loom-dsp-`); platform secrets and other
 *      features' names are refused.
 *
 *   3. OWNERSHIP — the name must belong to whoever the read is on behalf of:
 *
 *      - `{ kind: 'item', itemId }` — a lakehouse-shortcut ITEM may read only the
 *        `loom-shortcut-<itemId>` name the item route mints for it.
 *
 *      - `{ kind: 'principal', … }` — the lakehouse shortcut registry and the
 *        browse tree:
 *          `loom-sc-…`     the MINT RECORD decides. The credentials route
 *                          records the saving principal (oid, UPN, tenant) and
 *                          the lakehouse as Key Vault secret tags
 *                          (`putShortcutSecret(name, value, owner)`); the
 *                          principal must match, and so must the lakehouse when
 *                          both sides name one. A name with NO record (saved
 *                          before records existed) falls back to the earliest
 *                          registry row that binds it (`createdBy` of that row,
 *                          rows without `createdAt` last); a legacy name that no
 *                          row binds is refused.
 *          `loom-dsp-…`    a Delta Sharing provider's stored activation file —
 *                          authorised by provider (lib/azure/share-provider-access.ts),
 *                          the same rule the providers route applies.
 *          `loom-shortcut-…` belongs to a shortcut item — refused here.
 *        `via: 'row'` marks a read for a STORED row (the Test action resolves as
 *        the row's creator, whoever presses Test); `via: 'request'` marks a name
 *        the caller supplied. Only the wording differs.
 *
 * Checks 1 and 2 make no call at all; check 3 reads metadata (secret tags,
 * registry rows, the provider list) and never the value. A refusal therefore
 * never reads the secret. `scripts/ci/check-shortcut-secret-resolver.mjs` fails
 * the build if any other module imports either raw read.
 *
 * Errors raised here carry secret NAMES only, never values.
 */
import { getKeyVaultSecret } from './shortcut-credentials';
import { assertSecretReadAllowed, KeyVaultSecretPolicyError } from './kv-secret-purpose';
import { listShortcutSecretBindings, type ShortcutSecretBinding } from './lakehouse-shortcuts';
import { getShortcutSecretOwnerRecord, getShortcutSecretValue, type ShortcutSecretOwnerRecord } from './kv-secrets-client';
import { isValidKeyVaultSecretName, sanitizeSecretName } from './kv-secret-name';
import { shareProviderForSecret, SHARE_PROVIDER_SECRET_PREFIX } from './share-provider-access';

/** On whose behalf a shortcut credential is being resolved. */
export type ShortcutSecretOwner =
  /** A lakehouse-shortcut item — may read only the credential minted for it. */
  | { kind: 'item'; itemId: string }
  /** A principal acting through the lakehouse shortcut registry or browse tree. */
  | {
      kind: 'principal';
      oid?: string | null;
      upn?: string | null;
      /** The lakehouse the read is for, when known (the registry partition key). */
      lakehouseId?: string | null;
      /** `request`: the caller supplied the name. `row`: a stored row's creator (Test). */
      via: 'request' | 'row';
      /** The shortcut's target type, when known. Picks the guidance a refusal gives. */
      targetType?: string | null;
    };

/** Which vault read the resolver delegates to once the checks pass. */
export interface ResolveShortcutSecretOptions {
  /** `default`: `getKeyVaultSecret`. `shortcut`: the shortcut vault (`getShortcutSecretValue`). */
  vault?: 'default' | 'shortcut';
}

/** The item route's minted prefix. Items own it; the registry path may not read it. */
const ITEM_PREFIX = 'loom-shortcut-';
/** The credentials route's minted prefix. */
const REGISTRY_PREFIX = 'loom-sc-';

/** What the user can do about a refused registry credential. */
const SAVE_HINT = 'Use Save to Key Vault in the shortcut wizard to save the credential.';
/** What the user can do about a refused credential on an existing row. */
const ROW_HINT = 'Delete the shortcut and re-create it with a credential saved via Save to Key Vault in the shortcut wizard.';
/**
 * Delta Sharing has no Save to Key Vault in the shortcut wizard. Its credential
 * is the one Loom stores when a provider is added under Data shares, so the
 * guidance points there — to actions that exist.
 */
const SHARE_PATH = 'Data shares → Shared with me → Explore & query → select the table → Create lakehouse shortcut';
const DS_SAVE_HINT =
  `Saving a Delta Sharing credential file from the shortcut wizard is not available. Use ${SHARE_PATH}, ` +
  "or enter a registered provider's credential name (loom-dsp-<provider>).";
const DS_ROW_HINT = `Delete the shortcut and re-create it from ${SHARE_PATH}.`;
/** A loom-dsp- name whose provider is no longer registered. */
const READD_HINT = 'Re-add the provider under Data shares → Add provider, then retry.';
/** Naming an arbitrary Key Vault secret in the wizard is not supported yet. */
const TYPED_NAME_NOTE = 'Naming any other Key Vault secret here is not supported yet (#4854).';

function isDeltaSharing(owner: ShortcutSecretOwner): boolean {
  return owner.kind === 'principal' && lower(owner.targetType) === 'delta_sharing';
}
const saveHint = (owner: ShortcutSecretOwner) => (isDeltaSharing(owner) ? DS_SAVE_HINT : SAVE_HINT);
const rowHint = (owner: ShortcutSecretOwner) => (isDeltaSharing(owner) ? DS_ROW_HINT : ROW_HINT);
const isRow = (owner: ShortcutSecretOwner) => owner.kind === 'principal' && owner.via === 'row';

/** Thrown when the named credential does not belong to the requested owner. */
export class ShortcutSecretOwnershipError extends Error {
  readonly status = 403;
  readonly code = 'shortcut_secret_not_owned';
  constructor(public readonly secretName: string, detail: string) {
    super(detail);
    this.name = 'ShortcutSecretOwnershipError';
  }
}

/** Thrown when the name is not, exactly, a Key Vault secret name. */
export class ShortcutSecretNameError extends Error {
  readonly status = 400;
  readonly code = 'shortcut_secret_name_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'ShortcutSecretNameError';
  }
}

/** True for any refusal this module raises (name, policy or ownership) — never retried. */
export function isShortcutSecretRefusal(
  e: unknown,
): e is KeyVaultSecretPolicyError | ShortcutSecretOwnershipError | ShortcutSecretNameError {
  return (
    e instanceof KeyVaultSecretPolicyError ||
    e instanceof ShortcutSecretOwnershipError ||
    e instanceof ShortcutSecretNameError
  );
}

/** The secret name the item route mints for `itemId`, lower-cased for comparison. */
export function itemSecretName(itemId: string): string {
  return sanitizeSecretName(`${ITEM_PREFIX}${itemId}`).toLowerCase();
}

/**
 * The binding that records ownership for a legacy name: the earliest row. Rows
 * with no `createdAt` sort LAST (they cannot prove they came first); ties break
 * by id so the answer is stable.
 */
export function firstBinding(rows: ShortcutSecretBinding[]): ShortcutSecretBinding | undefined {
  return [...rows].sort((a, b) => {
    const ca = String(a.createdAt || '');
    const cb = String(b.createdAt || '');
    if (!ca !== !cb) return ca ? -1 : 1;
    return ca.localeCompare(cb) || String(a.id).localeCompare(String(b.id));
  })[0];
}

const lower = (v: string | null | undefined) => String(v || '').trim().toLowerCase();

/** Does `who` match the recorded principal? oid when both sides carry one, else UPN. */
function samePrincipal(
  recorded: { oid?: string | null; upn?: string | null },
  who: { oid?: string | null; upn?: string | null },
): boolean {
  const ro = lower(recorded.oid);
  const wo = lower(who.oid);
  if (ro && wo) return ro === wo;
  const ru = lower(recorded.upn);
  const wu = lower(who.upn);
  return !!ru && !!wu && ru === wu;
}

/**
 * Refuse with guidance for how the name arrived. A caller-supplied name gets
 * `request` + the save hint for the target type; a stored row (Test) gets
 * `row` (or `request`) + the row hint. `hint` / `requestHint` override the
 * default hint where a refusal has a more specific remedy.
 */
function refuse(
  name: string,
  owner: ShortcutSecretOwner,
  text: { request: string; row?: string; hint?: string; requestHint?: string },
): never {
  const msg = isRow(owner)
    ? `Test uses the credential of the shortcut's owner. ${text.row ?? text.request} ${text.hint ?? rowHint(owner)}`
    : `${text.request} ${text.requestHint ?? text.hint ?? saveHint(owner)}`;
  throw new ShortcutSecretOwnershipError(name, msg.trim());
}

/** 1 + 2: grammar, then purpose policy. No call of any kind. */
function assertNameAndPolicy(name: unknown, owner: ShortcutSecretOwner): asserts name is string {
  if (!isValidKeyVaultSecretName(name)) {
    throw new ShortcutSecretNameError(
      'The Key Vault secret name is not valid: it must be 1-127 letters, digits or hyphens, with no spaces. ' +
        (isRow(owner) ? rowHint(owner) : saveHint(owner)),
    );
  }
  try {
    assertSecretReadAllowed(name, 'shortcut-credential');
  } catch (e) {
    if (!(e instanceof KeyVaultSecretPolicyError)) throw e;
    const named = isDeltaSharing(owner)
      ? `named ${REGISTRY_PREFIX}… or ${SHARE_PROVIDER_SECRET_PREFIX}…`
      : `named ${REGISTRY_PREFIX}…`;
    const detail = owner.kind === 'item'
      ? `Key Vault secret '${name}' is not the credential Loom saved for this shortcut. Re-enter the credential on the shortcut to replace it.`
      : owner.via === 'row'
        ? `Test uses the credential of the shortcut's owner. Its stored credential '${name}' is not a shortcut credential Loom saved (those are ${named}). ${rowHint(owner)}`
        : `Key Vault secret '${name}' is not a shortcut credential Loom saved (those are ${named}). ${TYPED_NAME_NOTE} ${saveHint(owner)}`;
    throw new KeyVaultSecretPolicyError(name, 'shortcut-credential', detail);
  }
}

/** 3: ownership. Reads metadata only (tags, registry rows, provider list). */
async function assertShortcutSecretOwned(name: string, owner: ShortcutSecretOwner): Promise<void> {
  const n = name.toLowerCase();

  if (owner.kind === 'item') {
    const itemId = (owner.itemId || '').trim();
    if (!itemId || n !== itemSecretName(itemId)) {
      throw new ShortcutSecretOwnershipError(
        name,
        `Key Vault secret '${name}' was not saved for this shortcut. A shortcut item reads only the credential ` +
          'Loom saved when it was created — re-enter the credential on the shortcut to replace it.',
      );
    }
    return;
  }

  if (n.startsWith(ITEM_PREFIX)) {
    refuse(name, owner, { request: `Key Vault secret '${name}' belongs to a lakehouse-shortcut item and cannot be reused here.` });
  }

  if (n.startsWith(SHARE_PROVIDER_SECRET_PREFIX)) {
    if (!(await shareProviderForSecret(n))) {
      refuse(name, owner, {
        request: `Key Vault secret '${name}' does not belong to a data share provider registered on this deployment.`,
        row: `Its stored credential '${name}' does not belong to a data share provider registered on this deployment.`,
        hint: READD_HINT,
      });
    }
    return;
  }

  // loom-sc-: the mint record decides; a legacy name falls back to the registry.
  const who = { oid: owner.oid, upn: owner.upn };
  if (!lower(who.oid) && !lower(who.upn)) {
    refuse(name, owner, {
      request: `Loom could not identify who is using Key Vault secret '${name}', so it did not read it.`,
      requestHint: 'Sign in again and retry.',
      row: `This shortcut has no recorded owner, so Loom did not use its credential '${name}'.`,
    });
  }

  const { exists, owner: record } = await getShortcutSecretOwnerRecord(name);
  if (!exists) {
    refuse(name, owner, {
      request: `Key Vault secret '${name}' was not found.`,
      row: `Its stored credential '${name}' was not found in Key Vault.`,
    });
  }

  if (record) {
    if (!samePrincipal(record, who)) {
      refuse(name, owner, {
        request: `Key Vault secret '${name}' was saved by another user, so Loom did not read it.`,
        row: `Its stored credential '${name}' was saved by another user, so Loom did not use it.`,
      });
    }
    const recLh = (record.lakehouseId || '').trim();
    const reqLh = (owner.lakehouseId || '').trim();
    if (recLh && reqLh && recLh !== reqLh) {
      refuse(name, owner, {
        request: `Key Vault secret '${name}' was saved for a different lakehouse, so Loom did not read it.`,
        row: `Its stored credential '${name}' was saved for a different lakehouse, so Loom did not use it.`,
      });
    }
    return;
  }

  // Legacy: no mint record. The earliest registry row that binds the name records its owner.
  const first = firstBinding(await listShortcutSecretBindings(n));
  if (!first) {
    refuse(name, owner, {
      request: `Key Vault secret '${name}' has no recorded owner, so Loom did not read it.`,
      row: `Its stored credential '${name}' has no recorded owner, so Loom did not use it.`,
    });
  }
  if (!samePrincipal({ oid: first.createdByOid, upn: first.createdBy }, who)) {
    refuse(name, owner, {
      request: `Key Vault secret '${name}' is bound to another user's shortcut, so Loom did not read it.`,
      row: `Its stored credential '${name}' is bound to another user's shortcut, so Loom did not use it.`,
    });
  }
}

/**
 * Grammar, policy and ownership WITHOUT reading the value. For a caller about
 * to RECORD a reference to `name` (a registry row) on a path that may not
 * resolve it — a row written without this check would bind a credential nobody
 * verified.
 */
export async function assertShortcutSecretUsable(name: unknown, owner: ShortcutSecretOwner): Promise<void> {
  assertNameAndPolicy(name, owner);
  await assertShortcutSecretOwned(name, owner);
}

/**
 * Resolve a lakehouse-shortcut credential by name, on behalf of `owner`.
 * Grammar, policy, ownership, then the vault — a refusal never reads the value.
 */
export async function resolveShortcutSecret(
  name: unknown,
  owner: ShortcutSecretOwner,
  opts: ResolveShortcutSecretOptions = {},
): Promise<string> {
  assertNameAndPolicy(name, owner);
  await assertShortcutSecretOwned(name, owner);
  return opts.vault === 'shortcut'
    ? getShortcutSecretValue(name, 'shortcut-credential')
    : getKeyVaultSecret(name);
}

export type { ShortcutSecretOwnerRecord };
