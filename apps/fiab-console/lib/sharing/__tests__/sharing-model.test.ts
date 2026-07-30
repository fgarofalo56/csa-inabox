/**
 * LU-9 — Loom Sharing: the PURE authorization + validation model.
 *
 * `recipientCanAccessShare` is the single function standing between recipient A
 * and recipient B's tables, so every test here is written to FAIL if the
 * corresponding protection is removed.
 *
 * The recipient RESOLVER (`authenticateRecipient`, the Entra token type / audience
 * pin, the unauthenticated-disclosure rules) lived in this file until the
 * recipient-facing data plane was split out of this change; those tests moved with
 * it. See docs/fiab/security/loom-sharing-threat-model.md for the follow-up PR.
 *
 * Name canonicalisation — the round-4 cross-recipient read — has its own spec:
 * ./name-collision.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recipientCanAccessShare,
  matchRecipientByPrincipal,
  visibleShares,
  renderSharesManifest,
  isValidShareLocation,
  isValidPrincipalId,
  isValidSharingName,
  type LoomRecipient,
  type LoomShare,
} from '../model';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OID_A = '99999999-8888-7777-6666-555555555555';
const OID_B = '12121212-3434-5656-7878-909090909090';

const recipientA: LoomRecipient = {
  id: 'agency-a', tenantId: TENANT, principalIds: [OID_A], shares: ['share-a'],
};
const recipientB: LoomRecipient = {
  id: 'agency-b', tenantId: TENANT, principalIds: [OID_B], shares: ['share-b'],
};
const shares: LoomShare[] = [
  { id: 'share-a', tenantId: TENANT, tables: [{ schema: 'gold', name: 't1', location: 'abfss://lake@st.dfs.core.usgovcloudapi.net/gold/t1', id: 'id-1' }] },
  { id: 'share-b', tenantId: TENANT, tables: [{ schema: 'gold', name: 't2', location: 'abfss://lake@st.dfs.core.usgovcloudapi.net/gold/t2', id: 'id-2' }] },
];

describe('share authorization (the cross-recipient boundary)', () => {
  it('grants a recipient only the shares named in ITS OWN grant list', () => {
    expect(recipientCanAccessShare(recipientA, 'share-a')).toBe(true);
    expect(recipientCanAccessShare(recipientB, 'share-b')).toBe(true);
  });

  it('REFUSES recipient A the share granted to recipient B', () => {
    // The failure that matters: A knows B's share name (they are guessable) and
    // asks for it directly.
    expect(recipientCanAccessShare(recipientA, 'share-b')).toBe(false);
    expect(recipientCanAccessShare(recipientB, 'share-a')).toBe(false);
  });

  it('refuses a share that exists but is granted to nobody', () => {
    const ungranted: LoomShare = { id: 'share-secret', tenantId: TENANT, tables: [] };
    expect(recipientCanAccessShare(recipientA, ungranted.id)).toBe(false);
    expect(recipientCanAccessShare(recipientB, ungranted.id)).toBe(false);
  });

  it('a disabled recipient loses access to shares it still lists', () => {
    const killed: LoomRecipient = { ...recipientA, disabled: true };
    expect(killed.shares).toContain('share-a'); // the grant record survives…
    expect(recipientCanAccessShare(killed, 'share-a')).toBe(false); // …access does not
  });

  it('does not treat an empty / undefined share name as a wildcard', () => {
    expect(recipientCanAccessShare(recipientA, '')).toBe(false);
    expect(recipientCanAccessShare(recipientA, undefined as unknown as string)).toBe(false);
  });

  it('visibleShares lists ONLY the caller\'s shares, never the whole catalog', () => {
    expect(visibleShares(recipientA, shares).map((s) => s.id)).toEqual(['share-a']);
    expect(visibleShares(recipientB, shares).map((s) => s.id)).toEqual(['share-b']);
    expect(visibleShares({ ...recipientA, disabled: true }, shares)).toEqual([]);
  });
});

describe('principal → recipient matching', () => {
  it('matches on object id regardless of GUID casing', () => {
    expect(matchRecipientByPrincipal([recipientA, recipientB], [OID_B.toUpperCase()])?.id).toBe('agency-b');
  });

  it('returns null for a principal that belongs to no recipient', () => {
    expect(matchRecipientByPrincipal([recipientA, recipientB], ['deadbeef-0000-0000-0000-000000000000'])).toBeNull();
  });

  it('never matches a DISABLED recipient (so a kill-switch really kills)', () => {
    expect(matchRecipientByPrincipal([{ ...recipientA, disabled: true }], [OID_A])).toBeNull();
  });

  it('ignores empty principals rather than matching a recipient with no ids', () => {
    const emptyRec: LoomRecipient = { id: 'empty', tenantId: TENANT, principalIds: [], shares: ['share-a'] };
    expect(matchRecipientByPrincipal([emptyRec], [undefined, ''])).toBeNull();
  });
});

describe('input validation', () => {
  it('rejects share locations outside ADLS Gen2', () => {
    expect(isValidShareLocation('abfss://lake@st.dfs.core.windows.net/gold/t')).toBe(true);
    // A local path or an S3 bucket would take the server outside the boundary.
    expect(isValidShareLocation('file:///etc/passwd')).toBe(false);
    expect(isValidShareLocation('s3a://bucket/path')).toBe(false);
    expect(isValidShareLocation('abfss://no-account-part')).toBe(false);
  });

  it('rejects names that would break out of the YAML config or the URL path', () => {
    expect(isValidSharingName('fin-quarterly_2026')).toBe(true);
    expect(isValidSharingName('a"\nshares: []')).toBe(false);
    expect(isValidSharingName('../../etc')).toBe(false);
    expect(isValidSharingName('')).toBe(false);
  });

  it('rejects a non-GUID principal', () => {
    expect(isValidPrincipalId(OID_A)).toBe(true);
    expect(isValidPrincipalId('someone@example.gov')).toBe(false);
  });
});

describe('reference-server manifest rendering', () => {
  it('renders shares grouped by schema with locations and ids', () => {
    const yaml = renderSharesManifest(shares);
    expect(yaml).toContain('- name: "share-a"');
    expect(yaml).toContain('    - name: "t1"');
    expect(yaml).toContain('      location: "abfss://lake@st.dfs.core.usgovcloudapi.net/gold/t1"');
    expect(yaml).toContain('      id: "id-1"');
  });

  it('NEVER writes recipients or grants into the server config', () => {
    // The server cannot enforce them; emitting them would imply a protection
    // that does not exist and would leak the recipient list into a config file.
    const yaml = renderSharesManifest(shares);
    expect(yaml).not.toContain('agency-a');
    expect(yaml).not.toContain('recipient');
  });

  it('renders an empty list (not a broken document) when nothing is published', () => {
    expect(renderSharesManifest([])).toBe('shares: []\n');
    // A share with no tables cannot be rendered as a valid entry either.
    expect(renderSharesManifest([{ id: 'empty', tenantId: TENANT, tables: [] }])).toBe('shares: []\n');
  });

  it('escapes a quote in a name instead of emitting a broken/injected config', () => {
    const evil: LoomShare[] = [{
      id: 'ok', tenantId: TENANT,
      tables: [{ schema: 'gold', name: 'a"b', location: 'abfss://l@s.dfs.core.windows.net/p', id: 'x' }],
    }];
    expect(renderSharesManifest(evil)).toContain('- name: "a\\"b"');
  });
});

// ── Recipient resolution over a real signed token ──────────────────────────
