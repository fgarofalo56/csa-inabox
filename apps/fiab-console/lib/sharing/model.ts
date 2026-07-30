/**
 * Loom Sharing — the domain model (LU-9).
 *
 * Loom is the AUTHORITY for what is shared and who may see it. The OSS Delta
 * Sharing reference server (`loom-sharing`) is a data-plane engine: it reads
 * Delta logs and signs short-lived file URLs. It has exactly one authorization
 * primitive — a single global bearer token — so it cannot scope a caller to a
 * subset of shares (verified against upstream ServerConfig.scala on the v0.7.8
 * tag apps/loom-sharing/Dockerfile pins).
 *
 * That split drives the whole design:
 *
 *   discovery + authorization   Loom (this model + Cosmos, enforced in the BFF)
 *   Delta log + file URLs       the reference server, reached ONLY by the BFF
 *
 * Everything in this file is PURE — no Cosmos, no fetch — so the rules that
 * decide who can read what are unit-testable without a backend.
 */

/** A single Delta table published through a share. */
export interface SharedTable {
  /** Schema (the middle level of share.schema.table). */
  schema: string;
  /** Table name as the recipient sees it. */
  name: string;
  /** ADLS Gen2 Delta table root, e.g. abfss://lake@st.dfs.core.usgovcloudapi.net/gold/revenue. */
  location: string;
  /** Stable protocol id for the table (a UUID). Recipients cache against it. */
  id: string;
  /** Share history (CDF) as well as the current snapshot. */
  historyShared?: boolean;
}

/** An outbound share — the unit a recipient is granted. */
export interface LoomShare {
  /** Share name; also the Cosmos document id. */
  id: string;
  /** Owning Loom tenant (Cosmos partition key). */
  tenantId: string;
  comment?: string;
  tables: SharedTable[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A recipient — an EXTERNAL consumer, identified by Entra principals rather
 * than by a long-lived bearer profile.
 *
 * Upstream open Delta Sharing hands the recipient a `.share` profile file
 * containing a non-expiring bearer token. Loom does not: a file that is both
 * the identity and the credential, mailed to another organisation, cannot be
 * revoked without rotating it for everyone and leaves no per-caller audit
 * trail. Loom recipients present an Entra token instead (a guest/B2B user, or a
 * service principal from a federated tenant granted access to the sharing API),
 * which expires on its own, is revocable in Entra, and carries an auditable
 * principal id.
 */
export interface LoomRecipient {
  /** Recipient name; also the Cosmos document id. */
  id: string;
  /** Owning Loom tenant (Cosmos partition key). */
  tenantId: string;
  /**
   * Entra principals that ARE this recipient — object ids (`oid`) of guest
   * users, and/or application ids (`appid`) of service principals. Compared
   * case-insensitively. A token whose principal is in no recipient's list is
   * authenticated but not a recipient, and gets 403.
   */
  principalIds: string[];
  /** Share names this recipient may see. Nothing else is visible to it. */
  shares: string[];
  comment?: string;
  /** Soft kill-switch: keeps the audit trail but stops all access immediately. */
  disabled?: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Names travel into a YAML config and a URL path. Keep them boring. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

export function isValidSharingName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * THE canonical form of a share or recipient name — the single function that
 * decides identity on this surface.
 *
 * Share and recipient names are CASE-INSENSITIVE identifiers: `Sales` and
 * `sales` name the same share, so exactly one of them may exist. That has to be
 * true in both directions or it is worthless:
 *
 *   at COMPARISON  every authorization decision, grant, revoke and cascade
 *                  compares canonical forms (see recipientCanAccessShare);
 *   at STORAGE     the Cosmos document id and the stored name are canonical
 *                  (see store.shareDocId / upsertShare), and a document whose
 *                  stored name is NOT canonical is refused on the way out.
 *
 * Round 4 of this change's review found the version where only the first half
 * held. `recipientCanAccessShare` lower-cased both sides while the document id
 * was `share:${name}` verbatim — and Cosmos ids are case-sensitive. So a share
 * literally named `Share-A` could coexist with `share-a`, a recipient granted
 * `share-a` was authorized for the string `Share-A`, and the subsequent point
 * read returned the OTHER share's record — a cross-recipient read on the one
 * endpoint whose purpose is moving data outside the boundary. The same
 * divergence silently broke revoke and delete-cascade, which compared with
 * case-sensitive `Array#includes` against a grant list the data plane read
 * case-insensitively: a revocation typed in the wrong case did nothing at all.
 *
 * Anything that puts a share or recipient name into a key, a comparison, or a
 * document id goes through here. There is deliberately no second spelling of
 * this rule for the two sides to drift apart on.
 */
export function canonicalSharingName(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase();
}

/** Is this exactly the stored form? Used to refuse a legacy or hand-inserted
 *  document rather than serve a record whose identity we cannot vouch for. */
export function isCanonicalSharingName(name: string | null | undefined): boolean {
  const raw = String(name ?? '');
  return raw.length > 0 && raw === canonicalSharingName(raw);
}

/** Do these two names refer to the same share / recipient? */
export function sameSharingName(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalSharingName(a);
  return !!ca && ca === canonicalSharingName(b);
}

/** Entra ids are GUIDs; anything else is a typo or an injection attempt. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidPrincipalId(id: string): boolean {
  return GUID_RE.test(id.trim());
}

/** Only ADLS Gen2 Delta roots may be published — the same lake the lakehouse
 *  item type writes. A `file:`/`s3a:`/`wasbs:` location would either escape the
 *  boundary or point the server at a store the estate does not control. */
export function isValidShareLocation(location: string): boolean {
  return /^abfss:\/\/[^@/\s]+@[^/\s]+\/\S*$/.test(location.trim());
}

/**
 * THE authorization decision. A recipient reaches a share only when the share
 * is named in its own grant list — never by knowing the share's name, never
 * because it exists, never because the recipient can reach the server.
 *
 * Disabled recipients lose access immediately without losing their record.
 */
export function recipientCanAccessShare(recipient: LoomRecipient | null | undefined, share: string): boolean {
  if (!recipient || recipient.disabled) return false;
  // Canonical on BOTH sides, via the same function the document id is built
  // from — see canonicalSharingName. The two cannot drift.
  const want = canonicalSharingName(share);
  if (!want) return false;
  return (recipient.shares || []).some((s) => canonicalSharingName(s) === want);
}

/** The shares a recipient may see, in a stable order. */
export function visibleShares(recipient: LoomRecipient | null | undefined, all: LoomShare[]): LoomShare[] {
  if (!recipient || recipient.disabled) return [];
  return all.filter((s) => recipientCanAccessShare(recipient, s.id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** Match an authenticated principal to a recipient. Case-insensitive because
 *  Entra emits GUIDs in mixed case across token versions. */
export function matchRecipientByPrincipal(
  recipients: LoomRecipient[],
  principalIds: Array<string | undefined>,
): LoomRecipient | null {
  const wanted = principalIds.filter(Boolean).map((p) => String(p).toLowerCase());
  if (!wanted.length) return null;
  for (const r of recipients) {
    if (r.disabled) continue;
    if ((r.principalIds || []).some((p) => wanted.includes(String(p).toLowerCase()))) return r;
  }
  return null;
}

// ── Data-plane target resolution — NOT IN THIS PR ────────────────────
//
// `DATA_PLANE_RESOURCES` / `findSharedTable` / `upstreamTablePath` /
// `safeUpstreamQuery` resolve a recipient request to an upstream path on the
// reference server. They exist only for the recipient-facing proxy, which was
// split out of this change — see the follow-up PR referenced in
// docs/fiab/security/loom-sharing-threat-model.md. Nothing in the control plane
// proxies anything, so they are not carried here: an unreferenced path-builder
// for a server no caller can reach is the kind of thing that gets re-wired by
// accident.

// ── Reference-server manifest rendering ────────────────────────────────────

/** YAML double-quoted scalar. The values are validated above, but a config
 *  generator that cannot be trusted with a quote character is a config
 *  generator that will eventually emit a broken (or hostile) server config. */
function yamlString(v: string): string {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render the `shares:` block of delta-sharing-server.yaml from the Loom share
 * records. This is the ONLY thing the reference server learns about sharing —
 * note that recipients and grants are deliberately absent: the server cannot
 * enforce them, so telling it about them would imply a protection that does not
 * exist.
 *
 * The output is base64-encoded into `LOOM_SHARING_SHARES_B64` on the Container
 * App (loom-sharing-app.bicep `sharesManifestB64`).
 */
export function renderSharesManifest(shares: LoomShare[]): string {
  const usable = shares.filter((s) => (s.tables || []).length > 0);
  if (!usable.length) return 'shares: []\n';

  const lines: string[] = ['shares:'];
  for (const share of [...usable].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`- name: ${yamlString(share.id)}`);
    lines.push('  schemas:');
    // Group tables by schema — the protocol's middle namespace level.
    const bySchema = new Map<string, SharedTable[]>();
    for (const t of share.tables) {
      const list = bySchema.get(t.schema) || [];
      list.push(t);
      bySchema.set(t.schema, list);
    }
    for (const schema of [...bySchema.keys()].sort()) {
      lines.push(`  - name: ${yamlString(schema)}`);
      lines.push('    tables:');
      for (const t of (bySchema.get(schema) || []).sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`    - name: ${yamlString(t.name)}`);
        lines.push(`      location: ${yamlString(t.location)}`);
        lines.push(`      id: ${yamlString(t.id)}`);
        if (t.historyShared) lines.push('      historyShared: true');
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Protocol-shaped view of a share (what a recipient's client expects). */
export function toProtocolShare(share: LoomShare): { name: string; id: string } {
  return { name: share.id, id: share.id };
}

/** Distinct schemas in a share, protocol-shaped. */
export function toProtocolSchemas(share: LoomShare): Array<{ name: string; share: string }> {
  const names = [...new Set((share.tables || []).map((t) => t.schema))].sort();
  return names.map((name) => ({ name, share: share.id }));
}

/** Tables in a share (optionally one schema), protocol-shaped. */
export function toProtocolTables(
  share: LoomShare,
  schema?: string,
): Array<{ name: string; schema: string; share: string; id: string }> {
  return (share.tables || [])
    .filter((t) => !schema || t.schema === schema)
    .sort((a, b) => (a.schema + a.name).localeCompare(b.schema + b.name))
    .map((t) => ({ name: t.name, schema: t.schema, share: share.id, id: t.id }));
}
