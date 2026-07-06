/**
 * Unit tests for the remote built-in MCP inline-config resolver
 * (effectiveRemoteState) — the env + per-tenant admin-override merge that lets a
 * tenant admin ENABLE + CONFIGURE each opt-in remote server from the admin UI.
 *
 * Pure function (reads process.env only) — no Cosmos, no React — so it runs under
 * the plain vitest node harness. Locks the two invariants that keep the feature
 * safe (no-vaporware / no-fabric-dependency):
 *   1. No override ⇒ identical to the descriptor's env-only `configured()`.
 *   2. Overrides are ADDITIVE: they enable a server the deployment env left off,
 *      but a deployment env force-on always wins (envForced) and OBO servers still
 *      require the shared confidential client (an honest `missing` entry).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { effectiveRemoteState, msRemoteMcp } from '../catalog';

// The env vars the resolver + descriptors read. Saved/cleared per test so the
// host environment can't leak in, then restored.
const TOUCHED = [
  'LOOM_MSAL_CLIENT_ID',
  'LOOM_MS_LEARN_MCP_ENABLED',
  'LOOM_FOUNDRY_MCP_ENABLED',
  'LOOM_FOUNDRY_MCP_ENDPOINT',
  'LOOM_M365_MCP_ENABLED',
  'LOOM_M365_MCP_ENDPOINT',
  'LOOM_GITHUB_MCP_PAT_SECRET',
  'LOOM_GITHUB_MCP_ENABLED',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function entry(id: string) {
  const e = msRemoteMcp(id);
  if (!e) throw new Error(`missing catalog entry ${id}`);
  return e;
}

describe('effectiveRemoteState — no override matches env-only configured()', () => {
  it('entra-obo server stays gated when the deployment env left it off', () => {
    const e = entry('ms-foundry');
    const s = effectiveRemoteState(e, undefined);
    expect(s.configured).toBe(false);
    expect(s.configured).toBe(e.configured());
    expect(s.envForced).toBe(false);
  });

  it('Microsoft Learn is env-forced on (default-on, no auth)', () => {
    const e = entry('ms-learn');
    const s = effectiveRemoteState(e, undefined);
    expect(s.configured).toBe(true);
    expect(s.envForced).toBe(true);
    // Additive: an admin override cannot disable a deployment env force-on.
    const disabled = effectiveRemoteState(e, { enabled: false });
    expect(disabled.configured).toBe(true);
    expect(disabled.envForced).toBe(true);
  });
});

describe('effectiveRemoteState — overrides are additive', () => {
  it('enables an entra-obo server with a resolved endpoint + the shared OBO client', () => {
    process.env.LOOM_MSAL_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
    const e = entry('ms-foundry'); // has a default endpoint
    const s = effectiveRemoteState(e, { enabled: true });
    expect(s.enabled).toBe(true);
    expect(s.configured).toBe(true);
    expect(s.source).toBe('admin');
  });

  it('an entra-obo server still honestly gates on the shared OBO client', () => {
    // No LOOM_MSAL_CLIENT_ID — enabling it is not enough to go live.
    const e = entry('ms-foundry');
    const s = effectiveRemoteState(e, { enabled: true });
    expect(s.configured).toBe(false);
    expect(s.missing).toContain('LOOM_MSAL_CLIENT_ID');
  });

  it('a not-yet-GA server requires the inline endpoint', () => {
    process.env.LOOM_MSAL_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
    const e = entry('m365'); // defaultEndpoint '' → needs an endpoint
    const gated = effectiveRemoteState(e, { enabled: true });
    expect(gated.configured).toBe(false);
    expect(gated.missing).toContain(e.endpointEnv);
    const live = effectiveRemoteState(e, { enabled: true, endpoint: 'https://m365.example.gov/mcp' });
    expect(live.configured).toBe(true);
    expect(live.endpoint).toBe('https://m365.example.gov/mcp');
  });

  it('enables the key-vault (GitHub) server via an inline secret name', () => {
    const e = entry('github');
    expect(effectiveRemoteState(e, undefined).configured).toBe(false);
    const s = effectiveRemoteState(e, { secretName: 'github-mcp-pat' });
    expect(s.configured).toBe(true);
    expect(s.secretName).toBe('github-mcp-pat');
    expect(s.source).toBe('admin');
  });
});
