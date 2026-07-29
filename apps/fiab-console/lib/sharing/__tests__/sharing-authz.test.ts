/**
 * LU-9 — Loom Sharing: the authorization rules that keep one recipient out of
 * another recipient's data.
 *
 * The pure model is tested directly; the recipient resolver is exercised with a
 * REAL RS256 keypair (locally generated, JWK injected via the test hook) so the
 * signature / issuer / audience / expiry checks all run the production code
 * path with no network.
 *
 * Every test here is written to FAIL if the corresponding protection is removed
 * — notably `recipientCanAccessShare`, which is the single function standing
 * between recipient A and recipient B's tables.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
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

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJwt(payload: Record<string, unknown>, key = privateKey): string {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), key);
  return `${h}.${p}.${b64url(sig)}`;
}
function tokenFor(oid: string, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: `https://sts.windows.net/${TENANT}/`,
    aud: `api://${CLIENT_ID}`,
    // `scp` makes this an ACCESS token AND carries the pinned scope. An ID token
    // for the same app carries the same iss/aud and no scp/roles — see the
    // id-token tests below.
    scp: 'DeltaSharing.Read',
    oid, tid: TENANT, exp: now + 3600, nbf: now - 60,
    ...over,
  });
}

vi.mock('@/lib/sharing/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  return {
    ...actual,
    listRecipients: vi.fn(async () => [recipientA, recipientB]),
  };
});

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID', 'LOOM_MSAL_CLIENT_ID',
  'LOOM_SHARING_AUDIENCE', 'LOOM_SHARING_SCOPE', 'LOOM_SHARING_URL', 'LOOM_SHARING_ENABLED', 'AZURE_CLOUD'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_SHARING_URL = 'https://loom-sharing.internal';
  // Credential pin: the Console's own App ID URI is only an acceptable audience
  // when a scope/app role is ALSO pinned — see the 'credential pin' block below.
  process.env.LOOM_SHARING_SCOPE = 'DeltaSharing.Read';
  const { __setEntraJwksForTest } = await import('@/lib/azure/entra-bearer-verify');
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  __setEntraJwksForTest([{ ...jwk, kid: 'test-kid' } as never]);
});

afterEach(async () => {
  const { __setEntraJwksForTest } = await import('@/lib/azure/entra-bearer-verify');
  __setEntraJwksForTest(null);
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('authenticateRecipient', () => {
  it('resolves a valid token to the right recipient', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.recipient.id).toBe('agency-a');
  });

  it('401s a token signed by someone else (forged signature)', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const now = Math.floor(Date.now() / 1000);
    const forged = signJwt({
      iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${CLIENT_ID}`,
      oid: OID_A, exp: now + 3600,
    }, stranger.privateKey);
    const res = await authenticateRecipient(`Bearer ${forged}`);
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('401s a token from a FOREIGN tenant even with a valid signature', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A, { iss: 'https://sts.windows.net/00000000-0000-0000-0000-000000000000/' })}`);
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('401s a token minted for a DIFFERENT audience (another app in the tenant)', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A, { aud: 'api://some-other-app' })}`);
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('401s an expired token', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const now = Math.floor(Date.now() / 1000);
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A, { exp: now - 3600 })}`);
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('403s (not 401) a valid token whose principal is not a registered recipient', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor('cccccccc-cccc-cccc-cccc-cccccccccccc')}`);
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('503s (never 401) when the estate tenant is not configured — our problem, not the caller\'s', async () => {
    delete process.env.LOOM_ENTRA_TENANT_ID;
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`);
    expect(res).toMatchObject({ ok: false, status: 503 });
  });

  it('503s when the sharing server is not deployed, without inspecting the token', async () => {
    delete process.env.LOOM_SHARING_URL;
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient('Bearer whatever');
    expect(res).toMatchObject({ ok: false, status: 503 });
  });
});

// ── ATTACK: an ID token is not an authorization to export data ─────────────
//
// Regression for the shipped defect: the audience list defaulted to the
// Console's OWN app registration and the verifier checked no token type, so an
// ID token minted during an ordinary interactive Console sign-in — same iss,
// same aud, same signature chain — satisfied the "pinned audience" and reached
// the data-export endpoint.
describe('token TYPE is checked, not just the audience', () => {
  const RECIPIENT_ID_TOKEN = { scp: undefined, roles: undefined } as Record<string, unknown>;

  it('401s an ID TOKEN for a REGISTERED recipient principal (no scp / no roles)', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const now = Math.floor(Date.now() / 1000);
    // Exactly what Entra mints for an interactive sign-in to the Console:
    // valid signature, estate issuer, Console audience, the recipient's own oid.
    const idToken = signJwt({
      iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${CLIENT_ID}`,
      oid: OID_A, tid: TENANT, exp: now + 3600, nbf: now - 60,
      ...RECIPIENT_ID_TOKEN,
    });
    const res = await authenticateRecipient(`Bearer ${idToken}`);
    expect(res).toMatchObject({ ok: false, status: 401 });
    // It must NOT resolve to the recipient — a 403 here would still mean the
    // token authenticated.
    expect(res.ok).toBe(false);
  });

  it('401s an interactive ID token carrying a nonce', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A, { nonce: 'abc123' })}`);
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('401s a token whose audience is the BARE client id (the ID-token audience shape)', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A, { aud: CLIENT_ID })}`);
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts an app-only access token (roles, no scp) for a registered recipient', async () => {
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(
      `Bearer ${tokenFor(OID_A, { scp: undefined, roles: ['DeltaSharing.Read'] })}`,
    );
    expect(res.ok).toBe(true);
  });

  it('401s when LOOM_SHARING_SCOPE is set and the token does not carry it', async () => {
    process.env.LOOM_SHARING_SCOPE = 'Sharing.Export';
    const { authenticateRecipient } = await import('../recipient-auth');
    // The token carries DeltaSharing.Read, not the pinned Sharing.Export.
    expect(await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`)).toMatchObject({ ok: false, status: 401 });
    const good = await authenticateRecipient(`Bearer ${tokenFor(OID_A, { scp: 'Sharing.Export' })}`);
    expect(good.ok).toBe(true);
  });
});

// ── ATTACK: the audience pin must actually pin THIS api ───────────────────
//
// Round 2 closed the ID-token half of the audience problem (bare client id
// rejected, access token required) and left this half open: with only
// api://<clientId> accepted and no scope pinned, EVERY access token minted for
// the Console's own API is a valid recipient credential. The audience then
// isolates nothing, and the recipient-principal lookup is the sole control on
// the path that moves data outside the boundary.
describe('the recipient credential must be pinned to this API', () => {
  it('503s (never serves) when neither a dedicated audience nor a scope is pinned', async () => {
    delete process.env.LOOM_SHARING_SCOPE;
    delete process.env.LOOM_SHARING_AUDIENCE;
    const { authenticateRecipient } = await import('../recipient-auth');
    // A token that is valid in every other respect — right tenant, right
    // signature, right recipient oid, an access token for api://<clientId>.
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`);
    expect(res).toMatchObject({ ok: false, status: 503, reason: 'audience-unpinned' });
    expect(res.ok).toBe(false);
  });

  it('the 503 names the remediation to the OPERATOR only, never to the caller', async () => {
    delete process.env.LOOM_SHARING_SCOPE;
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`) as {
      ok: false; error: string; hint?: string; operatorHint?: string;
    };
    expect(`${res.error} ${res.hint || ''}`).not.toContain('LOOM_SHARING');
    expect(res.operatorHint || '').toContain('LOOM_SHARING_AUDIENCE');
    expect(res.operatorHint || '').toContain('LOOM_SHARING_SCOPE');
  });

  it('restating the DEFAULT as an explicit audience does not satisfy the pin', async () => {
    // api://<the Console's own clientId> is the weak configuration spelled
    // longhand. A check a caller can satisfy by restating the default is not a
    // check, so this must still be 503 — not a way to opt out of the pin.
    delete process.env.LOOM_SHARING_SCOPE;
    process.env.LOOM_SHARING_AUDIENCE = `api://${CLIENT_ID}`;
    const { authenticateRecipient } = await import('../recipient-auth');
    expect(await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`))
      .toMatchObject({ ok: false, status: 503, reason: 'audience-unpinned' });
    // The bare client id likewise.
    process.env.LOOM_SHARING_AUDIENCE = CLIENT_ID;
    expect(await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`))
      .toMatchObject({ ok: false, status: 503, reason: 'audience-unpinned' });
  });

  it('a DEDICATED audience satisfies the pin with no scope set, and REPLACES the fallback', async () => {
    delete process.env.LOOM_SHARING_SCOPE;
    process.env.LOOM_SHARING_AUDIENCE = 'api://loom-sharing-recipients';
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(
      `Bearer ${tokenFor(OID_A, { aud: 'api://loom-sharing-recipients' })}`,
    );
    expect(res.ok).toBe(true);
    // THE point of standing up a dedicated registration: the Console's own API
    // audience must stop being a data-plane credential. If it were merely ADDED
    // to the list, the operator would have done the right thing and gained
    // nothing.
    expect(await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('a migration can list BOTH audiences explicitly — but then needs a scope pin', async () => {
    delete process.env.LOOM_SHARING_SCOPE;
    process.env.LOOM_SHARING_AUDIENCE = `api://loom-sharing-recipients,api://${CLIENT_ID}`;
    const { authenticateRecipient } = await import('../recipient-auth');
    // Listing the Console's own registration re-opens the hole, so the pin is
    // not satisfied by the dedicated entry sitting next to it.
    expect(await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`))
      .toMatchObject({ ok: false, status: 503, reason: 'audience-unpinned' });
    process.env.LOOM_SHARING_SCOPE = 'DeltaSharing.Read';
    expect((await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`)).ok).toBe(true);
    expect((await authenticateRecipient(
      `Bearer ${tokenFor(OID_A, { aud: 'api://loom-sharing-recipients' })}`,
    )).ok).toBe(true);
  });

  it('a pinned SCOPE satisfies the pin on the Console audience', async () => {
    delete process.env.LOOM_SHARING_AUDIENCE;
    process.env.LOOM_SHARING_SCOPE = 'DeltaSharing.Read';
    const { authenticateRecipient } = await import('../recipient-auth');
    expect((await authenticateRecipient(`Bearer ${tokenFor(OID_A)}`)).ok).toBe(true);
    // A Console API token WITHOUT that scope — an ordinary signed-in user's
    // access token — is refused, which is the whole point of the pin.
    expect(await authenticateRecipient(`Bearer ${tokenFor(OID_A, { scp: 'user_impersonation' })}`))
      .toMatchObject({ ok: false, status: 401 });
  });
});

// ── ATTACK: an unauthenticated caller learns nothing about the estate ──────
describe('configuration state is never returned to an unauthenticated caller', () => {
  it('401s a caller with NO credential even when the estate is unconfigured, and returns no hint', async () => {
    delete process.env.LOOM_SHARING_URL;
    delete process.env.LOOM_ENTRA_TENANT_ID;
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient(null);
    // Authenticate FIRST: no credential is the caller's problem, and answering
    // 503-with-remediation here is what leaked the wiring.
    expect(res).toMatchObject({ ok: false, status: 401 });
    expect((res as { hint?: string }).hint).toBeUndefined();
    expect((res as { operatorHint?: string }).operatorHint).toBeUndefined();
  });

  it('keeps bicep paths and env var names OUT of the caller-safe fields on a 503', async () => {
    delete process.env.LOOM_SHARING_URL;
    const { authenticateRecipient } = await import('../recipient-auth');
    const res = await authenticateRecipient('Bearer not-a-real-token') as {
      ok: false; error: string; hint?: string; operatorHint?: string;
    };
    expect(res.ok).toBe(false);
    const callerVisible = `${res.error} ${res.hint || ''}`;
    for (const leak of ['bicep', 'LOOM_SHARING_URL', 'LOOM_ENTRA_TENANT_ID', 'Key Vault', 'docs/fiab']) {
      expect(callerVisible).not.toContain(leak);
    }
    // The remediation still exists — for the OPERATOR, via the log.
    expect(res.operatorHint || '').toContain('LOOM_SHARING_URL');
  });
});

describe('assertShareAccess', () => {
  it('returns null (allow) for a granted share', async () => {
    const { assertShareAccess } = await import('../recipient-auth');
    expect(assertShareAccess(recipientA, 'share-a')).toBeNull();
  });

  it('returns a 403 for another recipient\'s share', async () => {
    const { assertShareAccess } = await import('../recipient-auth');
    expect(assertShareAccess(recipientA, 'share-b')).toMatchObject({ ok: false, status: 403 });
  });

  it('gives the SAME answer for a non-existent share as for an ungranted one', async () => {
    const { assertShareAccess } = await import('../recipient-auth');
    const ungranted = assertShareAccess(recipientA, 'share-b');
    const missing = assertShareAccess(recipientA, 'no-such-share');
    // A distinguishable response would let a recipient enumerate the estate's
    // whole share namespace one 404-vs-403 at a time.
    expect(missing).toMatchObject({ status: 403 });
    expect((missing as { error: string }).error.replace('no-such-share', 'X'))
      .toBe((ungranted as { error: string }).error.replace('share-b', 'X'));
  });
});
