/**
 * External (cross-tenant) data sharing — PURE decision logic (no @azure/* deps).
 *
 * Fabric parity: Fabric "External Data Sharing" lets you share a lakehouse /
 * table subset in-place to ANOTHER Entra tenant, read-only, with an expiry. Loom
 * reproduces the SAME capability with the Azure-native cross-tenant mechanism —
 * an Entra B2B guest + a scoped ADLS grant on just the shared path — and NO
 * dependency on a real Fabric tenant (.claude/rules/no-fabric-dependency.md).
 *
 * This module holds the parts that must be unit-tested directly:
 *   • validateExternalShare  — foreign UPN/domain + path + expiry validation
 *   • nextShareState         — the pending → accepted → revoked/expired machine
 *   • deriveAclGrantPlan     — WHICH paths get WHICH POSIX bits so the guest can
 *                              read ONLY the shared subset (leaf = r-x; every
 *                              ancestor directory = --x traverse-only) — the
 *                              "scoped grant on just the shared path" guarantee.
 *   • isExpired              — expiry evaluation
 */

// ────────────────────────────────────────────────────────────────────────────
// Share record + lifecycle
// ────────────────────────────────────────────────────────────────────────────

export type ExternalShareState = 'pending' | 'accepted' | 'revoked' | 'expired';

export type ExternalShareAction = 'accept' | 'revoke' | 'expire';

/**
 * The lifecycle state machine. A share is created `pending` (B2B invite sent,
 * grant applied); the guest `accept`s it (redeems the invite) → `accepted`; the
 * owner may `revoke` at any time (grant removed) → `revoked`; the expiry sweep
 * `expire`s it → `expired`. `revoked`/`expired` are terminal. Returns the new
 * state, or null when the transition is not allowed (so callers can 409).
 */
export function nextShareState(
  current: ExternalShareState,
  action: ExternalShareAction,
): ExternalShareState | null {
  switch (action) {
    case 'accept':
      // Only a pending share can be accepted; accepting again is a no-op error.
      return current === 'pending' ? 'accepted' : null;
    case 'revoke':
      // Anything not already terminal can be revoked (revoking removes the grant).
      return current === 'pending' || current === 'accepted' ? 'revoked' : null;
    case 'expire':
      // Expiry only applies to a live (pending/accepted) share.
      return current === 'pending' || current === 'accepted' ? 'expired' : null;
    default:
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

export interface ExternalShareInput {
  /** Source Loom item id being shared. */
  sourceItemId?: string;
  /** ADLS container the item's data lives in (e.g. 'bronze'). */
  container?: string;
  /** Path within the container to share — the subset (folder/table). */
  sharedPath?: string;
  /** Foreign guest — a full UPN (user@contoso.com) OR a bare domain (contoso.com). */
  targetUpnOrDomain?: string;
  /** ISO8601 expiry — REQUIRED (external shares must expire). */
  expiry?: string;
  /** Now (ISO) — injected for deterministic tests; defaults to Date.now(). */
  now?: string;
}

export interface ExternalShareValidation {
  ok: boolean;
  error?: string;
  /** Parsed foreign tenant domain (lower-cased) when ok. */
  targetDomain?: string;
  /** True when the target is a full UPN (invite a specific user) vs a domain. */
  targetIsUpn?: boolean;
}

// A conservative email/UPN check + a domain check. External sharing is
// read-only cross-tenant, so we only accept a real foreign UPN or domain.
const UPN_RE = /^[^@\s]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export function validateExternalShare(input: ExternalShareInput): ExternalShareValidation {
  const raw = (input.targetUpnOrDomain || '').trim().toLowerCase();
  if (!raw) return { ok: false, error: 'Enter the external guest UPN (user@contoso.com) or their tenant domain (contoso.com).' };

  let targetDomain: string;
  let targetIsUpn: boolean;
  if (raw.includes('@')) {
    if (!UPN_RE.test(raw)) return { ok: false, error: `"${raw}" is not a valid external UPN (expected user@domain.tld).` };
    targetDomain = raw.split('@')[1];
    targetIsUpn = true;
  } else {
    if (!DOMAIN_RE.test(raw)) return { ok: false, error: `"${raw}" is not a valid tenant domain (expected domain.tld).` };
    targetDomain = raw;
    targetIsUpn = false;
  }

  if (!input.sharedPath || !input.sharedPath.trim()) {
    return { ok: false, error: 'Choose the folder / table subset to share.' };
  }
  if (!input.container || !input.container.trim()) {
    return { ok: false, error: 'This item has no resolved ADLS container — external sharing needs a storage-backed item (lakehouse / dataset).' };
  }
  // Reject path traversal / absolute escapes in the shared subset.
  const p = input.sharedPath.trim().replace(/^\/+/, '');
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, error: 'The shared path may not contain "." or ".." segments.' };
  }

  if (!input.expiry) return { ok: false, error: 'Set an expiry — external shares must expire.' };
  const exp = Date.parse(input.expiry);
  if (Number.isNaN(exp)) return { ok: false, error: 'Expiry is not a valid date.' };
  const now = input.now ? Date.parse(input.now) : Date.now();
  if (exp <= now) return { ok: false, error: 'Expiry must be in the future.' };

  return { ok: true, targetDomain, targetIsUpn };
}

/** True when the share's expiry has passed relative to `now` (default: real now). */
export function isExpired(share: { expiry?: string; state?: ExternalShareState }, now: number = Date.now()): boolean {
  if (!share.expiry) return false;
  if (share.state === 'revoked') return false; // already terminal for a different reason
  const exp = Date.parse(share.expiry);
  return !Number.isNaN(exp) && exp <= now;
}

// ────────────────────────────────────────────────────────────────────────────
// Scoped-grant derivation — the heart of "just the shared path"
// ────────────────────────────────────────────────────────────────────────────

export interface AclGrantStep {
  /** Container-relative directory path ('' = container root). */
  path: string;
  /** POSIX bits to grant the guest on this path. */
  permissions: { read: boolean; write: boolean; execute: boolean };
  /** Whether this is the shared LEAF (read) vs a traverse-only ANCESTOR. */
  leaf: boolean;
}

/**
 * Derive the exact set of POSIX ACL entries that grant a guest read on ONLY the
 * shared subset. In ADLS Gen2 a principal can read a directory it has r-x on,
 * BUT it must also have --x (traverse) on every ANCESTOR directory to reach it.
 * A container-wide RBAC grant would over-share; instead we grant:
 *   • the shared leaf path           → r-x   (read + traverse; +default scope so
 *                                             files created later inherit read)
 *   • every ancestor directory       → --x   (traverse only — NOT read; the
 *                                             guest cannot list/read siblings)
 * This yields access scoped to exactly the shared path — the guest can read the
 * shared folder/table and nothing else in the container. Pure + deterministic.
 */
export function deriveAclGrantPlan(sharedPath: string): AclGrantStep[] {
  const clean = (sharedPath || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = clean ? clean.split('/').filter(Boolean) : [];
  const steps: AclGrantStep[] = [];
  // Ancestors (including the container root '') get traverse-only (--x).
  // Build cumulative ancestor paths: '', seg0, seg0/seg1, … up to the parent.
  const ancestors: string[] = [''];
  for (let i = 0; i < segments.length - 1; i++) {
    ancestors.push(segments.slice(0, i + 1).join('/'));
  }
  // De-dup while preserving order (root only once).
  const seen = new Set<string>();
  for (const a of ancestors) {
    if (seen.has(a)) continue;
    seen.add(a);
    steps.push({ path: a, permissions: { read: false, write: false, execute: true }, leaf: false });
  }
  // The leaf shared path gets read + traverse.
  const leaf = segments.join('/');
  steps.push({ path: leaf, permissions: { read: true, write: false, execute: true }, leaf: true });
  return steps;
}
