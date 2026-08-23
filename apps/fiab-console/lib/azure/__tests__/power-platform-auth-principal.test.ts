/**
 * #3688 — the Power Platform remediation copy must name the principal that was
 * ACTUALLY refused (deploy-integrity R7).
 *
 * THE DEFECT. `ppAuthHint` took only `triedUser`, so every 401/403 message said
 * "the Console UAMI SP". That is wrong on every Dataverse call: when a Dataverse
 * confidential SP is configured, the principal on the wire is the DATAVERSE app
 * registration (LOOM_DATAVERSE_CLIENT_ID, falling back to LOOM_MSAL_CLIENT_ID),
 * not the UAMI. Meanwhile three sibling messages in powerplatform-client.ts
 * (createColumn / createTable / createFlow) name "The Dataverse SP
 * (LOOM_DATAVERSE_CLIENT_ID)" correctly — so the same estate handed the operator
 * two contradictory instructions and a 50% chance of granting the wrong SP. The
 * error would not change, and nothing would tell them they had gone the wrong way.
 *
 * THERE IS A THIRD STATE, and it is the one that actually blocks the family: a
 * Dataverse scope with NO Dataverse SP configured falls through to the UAMI —
 * which Microsoft does not accept as a Dataverse Application User under ANY
 * grant. The old copy's advice ("add the Console UAMI SP to the allow group") is
 * not merely imprecise there, it is unachievable.
 *
 * TEST SHAPE — the headline assertion is ANTI-DRIFT, not copy-checking. The
 * obvious narrow fix is to give the hint its own regex over the scope string.
 * That passes any test that only feeds scopes, and it silently disagrees with
 * the transport in exactly the third state above. So the tests below mint a REAL
 * token through `getPowerPlatformSpToken` with the two credential classes
 * returning DISTINGUISHABLE tokens, and assert the principal the hint claims
 * matches the credential that actually produced the token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const UAMI_TOKEN = 'token-from-managed-identity';
const DATAVERSE_SP_TOKEN = 'token-from-client-secret-credential';

// Two DISTINGUISHABLE credential classes. This is what lets a test tell which
// credential the transport really selected, rather than trusting a label.
vi.mock('@azure/identity', () => {
  class UamiCred {
    async getToken() { return { token: UAMI_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  class SecretCred {
    async getToken() { return { token: DATAVERSE_SP_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return {
    DefaultAzureCredential: UamiCred,
    ManagedIdentityCredential: UamiCred,
    ChainedTokenCredential: UamiCred,
    ClientSecretCredential: SecretCred,
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class {
    async getToken() { return { token: UAMI_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  },
}));

const DATAVERSE_SCOPE = 'https://contoso.crm.dynamics.com/.default';
const DATAVERSE_SCOPE_NUMBERED = 'https://contoso.crm4.dynamics.com/.default';
const CONTROL_PLANE_SCOPE = 'https://api.bap.microsoft.com/.default';

const TOKEN_OPTS = { tokenError: (m: string) => new Error(m) };

/** The exact directive the old copy emitted — the one that sent operators to
 *  grant the wrong application. It must not appear on a Dataverse path. */
const OLD_WRONG_DIRECTIVE =
  'Confirm the Console UAMI SP is added to the "Service principals can use Power Platform APIs" allow';

const SAVED = { ...process.env };
beforeEach(() => {
  vi.resetModules();
  delete process.env.LOOM_DATAVERSE_CLIENT_ID;
  delete process.env.LOOM_DATAVERSE_CLIENT_SECRET;
  delete process.env.LOOM_DATAVERSE_TENANT_ID;
  delete process.env.LOOM_MSAL_CLIENT_ID;
  delete process.env.LOOM_MSAL_CLIENT_SECRET;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.AZURE_TENANT_ID;
  process.env.LOOM_UAMI_CLIENT_ID = 'uami-1';
});
afterEach(() => { process.env = { ...SAVED }; vi.restoreAllMocks(); });

/** Configure a fully-formed Dataverse confidential SP. */
function withDataverseSp() {
  process.env.LOOM_DATAVERSE_CLIENT_ID = 'dataverse-app-id';
  process.env.LOOM_DATAVERSE_CLIENT_SECRET = 'dataverse-secret';
  process.env.LOOM_DATAVERSE_TENANT_ID = 'tenant-id';
}

describe('#3688 — ppSpPrincipalForScope reports the credential the transport REALLY uses', () => {
  it('dataverse scope + configured SP → dataverse-app, and the SP token is on the wire', async () => {
    withDataverseSp();
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE)).toBe('dataverse-app');
    // ANTI-DRIFT: the label must match the credential that actually minted.
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE, TOKEN_OPTS)).resolves.toBe(DATAVERSE_SP_TOKEN);
  });

  it('dataverse scope + NO SP configured → uami-no-dataverse-cred, and the UAMI token is on the wire', async () => {
    // THE NARROW-BYPASS KILLER. A hint that re-derives the principal from its own
    // regex on the scope string reports "dataverse-app" here — while the wire
    // carries the UAMI token. This case is the ONLY one that separates the two
    // implementations, and it is the state that actually blocks the family.
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE)).toBe('uami-no-dataverse-cred');
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE, TOKEN_OPTS)).resolves.toBe(UAMI_TOKEN);
  });

  it('control-plane scope → console-uami, and the UAMI token is on the wire', async () => {
    withDataverseSp(); // configured, but irrelevant to a non-Dataverse scope
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(CONTROL_PLANE_SCOPE)).toBe('console-uami');
    await expect(m.getPowerPlatformSpToken(CONTROL_PLANE_SCOPE, TOKEN_OPTS)).resolves.toBe(UAMI_TOKEN);
  });

  it('honours the LOOM_MSAL_* fallback pair — the day-one registered app user', async () => {
    process.env.LOOM_MSAL_CLIENT_ID = 'msal-app-id';
    process.env.LOOM_MSAL_CLIENT_SECRET = 'msal-secret';
    process.env.AZURE_TENANT_ID = 'tenant-id';
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE)).toBe('dataverse-app');
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE, TOKEN_OPTS)).resolves.toBe(DATAVERSE_SP_TOKEN);
  });

  it('classifies the numbered crm<N> host the same way (crm4.dynamics.com)', async () => {
    withDataverseSp();
    const m = await import('../power-platform-auth');
    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE_NUMBERED)).toBe('dataverse-app');
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE_NUMBERED, TOKEN_OPTS))
      .resolves.toBe(DATAVERSE_SP_TOKEN);
  });
});

describe('#3688 — the hint names the right application, on every path', () => {
  it('POPULATION: all three principal states are reachable and produce DISTINCT copy', async () => {
    // A guard that scans an empty set is green and blind. Prove the three
    // branches are all reachable from real configuration and none collide.
    const seen = new Map<string, string>();

    {
      withDataverseSp();
      vi.resetModules();
      const m = await import('../power-platform-auth');
      seen.set(m.ppSpPrincipalForScope(DATAVERSE_SCOPE), m.ppAuthHint(false, DATAVERSE_SCOPE));
      seen.set(m.ppSpPrincipalForScope(CONTROL_PLANE_SCOPE), m.ppAuthHint(false, CONTROL_PLANE_SCOPE));
    }
    {
      delete process.env.LOOM_DATAVERSE_CLIENT_ID;
      delete process.env.LOOM_DATAVERSE_CLIENT_SECRET;
      delete process.env.LOOM_DATAVERSE_TENANT_ID;
      vi.resetModules();
      const m = await import('../power-platform-auth');
      seen.set(m.ppSpPrincipalForScope(DATAVERSE_SCOPE), m.ppAuthHint(false, DATAVERSE_SCOPE));
    }

    expect([...seen.keys()].sort()).toEqual(['console-uami', 'dataverse-app', 'uami-no-dataverse-cred']);
    expect(new Set(seen.values()).size).toBe(3);
  });

  it('Dataverse: names the Dataverse app and does NOT emit the old UAMI directive', async () => {
    withDataverseSp();
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint(false, DATAVERSE_SCOPE);

    expect(hint).toContain('LOOM_DATAVERSE_CLIENT_ID');
    expect(hint).toMatch(/Application User/);
    expect(hint).toMatch(/NOT the Console UAMI/);
    // THE REGRESSION: this exact directive is what sent operators to grant the
    // wrong application on a Dataverse denial.
    expect(hint).not.toContain(OLD_WRONG_DIRECTIVE);
  });

  it('Dataverse with no SP: says the UAMI can NEVER work, instead of asking for a grant', async () => {
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint(false, DATAVERSE_SCOPE);

    expect(hint).toMatch(/No Dataverse service principal is configured/);
    expect(hint).toMatch(/does not accept .* under ANY role or allow-group grant/);
    expect(hint).toMatch(/Granting the UAMI will not help/);
    expect(hint).not.toContain(OLD_WRONG_DIRECTIVE);
  });

  it('control plane: still names the Console UAMI + the allow group (this path was correct)', async () => {
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint(false, CONTROL_PLANE_SCOPE);

    expect(hint).toContain('LOOM_UAMI_CLIENT_ID');
    expect(hint).toMatch(/Service principals can use Power Platform APIs/);
    expect(hint).toMatch(/New-PowerAppManagementApp/);
    // Must NOT claim a Dataverse Application User is the fix for a BAP denial.
    expect(hint).not.toMatch(/Dataverse application registration/);
  });

  it('keeps the both-refused preamble on every principal (the existing contract)', async () => {
    withDataverseSp();
    const { ppAuthHint } = await import('../power-platform-auth');
    for (const scope of [DATAVERSE_SCOPE, CONTROL_PLANE_SCOPE]) {
      const hint = ppAuthHint(true, scope);
      expect(hint).toContain('Both identities were refused');
      expect(hint).toMatch(/Power Platform licence/);
    }
    // …and only when a user token was actually attempted.
    expect(ppAuthHint(false, CONTROL_PLANE_SCOPE)).not.toContain('Both identities were refused');
  });
});
