/**
 * Unit tests for the remote built-in MCP inline-config resolver
 * (effectiveRemoteState) — the env + per-tenant admin-override merge that lets a
 * tenant admin ENABLE + CONFIGURE each opt-in remote server from the admin UI.
 *
 * Pure function (reads process.env only) — no Cosmos, no React — so it runs under
 * the plain vitest node harness. Locks the invariants that keep the feature safe
 * under the DEFAULT-ON posture (operator directive 2026-07-08 — "everything
 * enabled by default, opt-OUT not opt-in"; no-vaporware / no-fabric-dependency):
 *   1. Default-ON: a defaultOn server's enable state defaults to ON with no
 *      override — but it is only `configured` (advertised to the Copilot) once its
 *      real endpoint / shared OBO client / Key Vault secret is present. A
 *      default-on-but-unwired server stays gated and is NEVER folded in.
 *   2. Admin opt-OUT wins: an `enabled:false` override BEATS defaultOn.
 *   3. A deployment env force-on always wins (envForced), and OBO servers still
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
  'LOOM_AZURE_ARM_MCP_ENABLED',
  'LOOM_AZURE_ARM_MCP_ENDPOINT',
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

describe('effectiveRemoteState — default-ON posture (opt-out, honestly gated)', () => {
  it('a default-on entra-obo server is ENABLED by default but still gated without the shared OBO client', () => {
    // No LOOM_MSAL_CLIENT_ID (cleared in beforeEach): on by default, but inert.
    const e = entry('ms-foundry');
    expect(e.defaultOn).toBe(true);
    const s = effectiveRemoteState(e, undefined);
    expect(s.enabled).toBe(true); // default-ON — no admin action needed
    expect(s.configured).toBe(false); // …but honestly gated (missing OBO client)
    expect(s.missing).toContain('LOOM_MSAL_CLIENT_ID');
    expect(s.envForced).toBe(false);
  });

  it('a default-on entra-obo server goes live with no override once the shared OBO client is present', () => {
    // ms-foundry has a GA default endpoint, so the OBO client alone makes it live.
    process.env.LOOM_MSAL_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
    const e = entry('ms-foundry');
    const s = effectiveRemoteState(e, undefined);
    expect(s.enabled).toBe(true);
    expect(s.configured).toBe(true); // opt-out default-on, no admin action
    expect(s.missing).toEqual([]);
  });

  it('admin opt-OUT (enabled:false) BEATS defaultOn', () => {
    process.env.LOOM_MSAL_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
    const e = entry('ms-foundry');
    // Would otherwise be live (previous test); the explicit opt-out wins.
    const s = effectiveRemoteState(e, { enabled: false });
    expect(s.enabled).toBe(false);
    expect(s.configured).toBe(false);
  });

  it('a default-on-but-unwired server is NOT folded into the Copilot tool list', () => {
    // azure-arm is defaultOn but has no default endpoint (self-host required).
    // decorateMcpServers() folds a synthetic row in only when
    // `e.defaultOn && effectiveRemoteState(e, ov).configured` — this proves
    // defaultOn ALONE never advertises an un-wired server.
    process.env.LOOM_MSAL_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
    const e = entry('azure-arm');
    expect(e.defaultOn).toBe(true);
    const s = effectiveRemoteState(e, undefined);
    expect(s.configured).toBe(false); // no endpoint → gated
    expect(s.missing).toContain(e.endpointEnv);
    const foldedIn = e.defaultOn && s.configured; // the exact fold predicate
    expect(foldedIn).toBe(false);
  });

  it('Microsoft Learn is env-forced on (default-on, no auth)', () => {
    const e = entry('ms-learn');
    const s = effectiveRemoteState(e, undefined);
    expect(s.configured).toBe(true);
    expect(s.envForced).toBe(true);
    // A deployment env force-on cannot be disabled by an admin override.
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
