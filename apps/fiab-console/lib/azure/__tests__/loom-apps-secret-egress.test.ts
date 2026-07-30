/**
 * Loom Apps — a Key Vault credential may not be aimed by persisted item state.
 *
 * TWO DEFECTS THESE TESTS PIN
 *
 * 1. `resolveRemoteHeadSha` (the redeploy-on-push poller) composes
 *    {@link tokenizedGitUrl}, which embeds the item's Key Vault git PAT IN THE
 *    URL, and then fetches it. The provider allow-list lived inside `buildApp` —
 *    a different function — so the poller was never covered, while its
 *    `gitSource` argument is read back from persisted `state.appRuntime`
 *    (a `.loomapp` import wrote it verbatim). A PAT therefore went to whatever
 *    host that state named. The allow-list is now module-level and enforced at
 *    every credentialed path, including inside `tokenizedGitUrl` itself.
 *
 * 2. `buildAcaAppBody` mapped an app's `env[].secretRef` straight to an ACA
 *    Key Vault secret reference resolved with the platform UAMI — into a
 *    container whose image the same user built from their own source. So
 *    `secretRef: 'loom-msal-client-secret'` printed the MSAL client secret
 *    into an attacker-authored app. The name-space policy now refuses it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  tokenizedGitUrl,
  isAllowedGitSource,
  assertAllowedGitSource,
  resolveRemoteHeadSha,
  LoomAppsError,
} from '../loom-apps-client';
import { buildAcaAppBody, LoomAppSpecError } from '../loom-apps-runtime-templates';

const PAT = 'ghp_REAL_CORPORATE_PAT';

/** Hosts an attacker would point a persisted gitSource at. */
const HOSTILE = [
  'https://attacker.example/org/repo',
  'https://github.com.attacker.example/org/repo',
  'https://attacker.example/github.com/org/repo',
  'https://x-access-token:tok@attacker.example/o/r',
  'https://github.com@attacker.example/o/r',
  'http://github.com/org/repo',
  'https://raw.githubusercontent.com/o/r',
  'http://169.254.169.254/metadata/identity/oauth2/token',
  'file:///etc/passwd',
];

describe('ATTACK: the credentialed git poll path follows persisted item state', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const gitSource of HOSTILE) {
    it(`refuses to poll ${gitSource} and never puts the PAT on the wire`, async () => {
      await expect(resolveRemoteHeadSha(gitSource, PAT)).rejects.toThrow(LoomAppsError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('refuses even without a token — the host allow-list is not conditional', async () => {
    await expect(resolveRemoteHeadSha('https://attacker.example/o/r')).rejects.toThrow(LoomAppsError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still polls an approved provider, with the PAT, exactly as before', async () => {
    fetchSpy.mockResolvedValue(new Response(
      `0000${'a'.repeat(40)} HEAD\0multi_ack\n003f${'a'.repeat(40)} refs/heads/main`,
      { status: 200 },
    ));
    const sha = await resolveRemoteHeadSha('https://github.com/org/repo#main', PAT);
    expect(sha).toBe('a'.repeat(40));
    expect(String(fetchSpy.mock.calls[0][0]))
      .toBe(`https://x-access-token:${PAT}@github.com/org/repo.git/info/refs?service=git-upload-pack`);
  });
});

describe('tokenizedGitUrl refuses to embed a PAT in an unapproved URL', () => {
  for (const gitUrl of HOSTILE) {
    it(`refuses ${gitUrl}`, () => {
      expect(() => tokenizedGitUrl(gitUrl, PAT)).toThrow(LoomAppsError);
    });
  }
  it('accepts every supported provider', () => {
    expect(tokenizedGitUrl('https://github.com/o/r', 't')).toContain('x-access-token:t@github.com');
    expect(tokenizedGitUrl('https://gitlab.com/g/p', 't')).toContain('oauth2:t@gitlab.com');
    expect(tokenizedGitUrl('https://bitbucket.org/g/p', 't')).toContain('x-token-auth:t@bitbucket.org');
    expect(tokenizedGitUrl('https://dev.azure.com/o/p/_git/r', 't')).toContain('pat:t@dev.azure.com');
    expect(tokenizedGitUrl('https://contoso.visualstudio.com/p/_git/r', 't')).toContain('pat:t@contoso.visualstudio.com');
  });
});

describe('isAllowedGitSource / assertAllowedGitSource (the persistence guard)', () => {
  it('rejects every hostile source', () => {
    for (const g of HOSTILE) expect(isAllowedGitSource(g)).toBe(false);
  });
  it('accepts approved providers', () => {
    expect(isAllowedGitSource('https://github.com/org/repo#main:app')).toBe(true);
    expect(isAllowedGitSource('https://dev.azure.com/org/proj/_git/repo')).toBe(true);
  });
  it('throws an honest 400 with actionable text', () => {
    expect(() => assertAllowedGitSource('https://attacker.example/o/r')).toThrow(/github\.com/);
    try { assertAllowedGitSource('https://attacker.example/o/r'); } catch (e: any) { expect(e.status).toBe(400); }
  });
});

describe('ATTACK: an app env binding names a platform Key Vault secret', () => {
  const base = {
    name: 'loom-app-x',
    environmentId: '/subscriptions/s/managedEnvironments/cae',
    image: 'acr.azurecr.io/loom-app-x:1',
    targetPort: 8000,
    location: 'eastus',
    uamiId: '/subscriptions/s/userAssignedIdentities/uami',
    keyVaultUri: 'https://loomkv.vault.azure.net',
  };

  it.each([
    'loom-msal-client-secret',
    'loom-internal-token',
    'loom-github-mcp-pat',
    'loom-udf-host-key',
  ])('refuses to mount the platform secret %s into a user container', (secretRef) => {
    expect(() => buildAcaAppBody({ ...base, env: [{ name: 'APP_X', secretRef }] }))
      .toThrow(LoomAppSpecError);
  });

  it.each([
    'loom-conn-6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    'loom-app-git-deadbeef',
    'loom-git-pat-ws1',
  ])('refuses to mount another feature\'s credential %s', (secretRef) => {
    expect(() => buildAcaAppBody({ ...base, env: [{ name: 'APP_X', secretRef }] }))
      .toThrow(LoomAppSpecError);
  });

  it('the error names the offending secret AND the env var, so the UI can say why', () => {
    try {
      buildAcaAppBody({ ...base, env: [{ name: 'APP_X', secretRef: 'loom-msal-client-secret' }] });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('APP_X');
      expect(e.message).toContain('loom-msal-client-secret');
    }
  });

  it('still mounts a legitimate app secret', () => {
    const body: any = buildAcaAppBody({ ...base, env: [{ name: 'APP_API_KEY', secretRef: 'contoso-app-api-key' }] });
    const secrets = body.properties.configuration.secrets;
    expect(secrets).toHaveLength(1);
    expect(secrets[0].keyVaultUrl).toBe('https://loomkv.vault.azure.net/secrets/contoso-app-api-key');
    const env = body.properties.template.containers[0].env;
    expect(env.find((e: any) => e.name === 'APP_API_KEY').secretRef).toBe('kv-contoso-app-api-key');
  });
});
