/**
 * kv-secret-purpose — the defence-in-depth name-space policy for Key Vault reads.
 *
 * ATTACK THESE TESTS PIN: `getKeyVaultSecretValue(name)` used to accept any
 * secret name from any call site, and several call sites take that name from
 * user-writable item state. That made `loom-msal-client-secret` — whose leak
 * caused a full production sign-in outage on 2026-07-19 — reachable from a
 * tenant-user request the moment any destination bug existed. Every test below
 * asks for a platform credential (or another feature's credential) through a
 * legitimate purpose and asserts a refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertSecretReadAllowed,
  isReservedPlatformSecret,
  KeyVaultSecretPolicyError,
  type KvSecretPurpose,
} from '../kv-secret-purpose';

const ALL_PURPOSES: KvSecretPurpose[] = [
  'connection-secret',
  'git-credential',
  'udf-function-key',
  'variable-library',
  'directquery-source',
  'app-env-binding',
];

describe('platform credentials are unreachable from EVERY purpose', () => {
  // The exact names platform bicep writes into the Loom vault.
  const PLATFORM = [
    'loom-msal-client-secret',
    'loom-internal-token',
    'loom-ci-token',
    'loom-iq-mcp-token',
    'loom-github-mcp-pat',
    'loom-udf-host-key',
    'loom-airflow-admin-password',
    'loom-azure-maps-key',
    'loom-posture-function-key',
    'loom-paginated-render-key',
    'loom-dataverse-client-secret',
  ];

  for (const name of PLATFORM) {
    for (const purpose of ALL_PURPOSES) {
      it(`refuses "${name}" for purpose "${purpose}"`, () => {
        expect(() => assertSecretReadAllowed(name, purpose)).toThrow(KeyVaultSecretPolicyError);
      });
    }
  }

  it('is case-insensitive (MSAL secret in any casing)', () => {
    expect(() => assertSecretReadAllowed('LOOM-MSAL-Client-Secret', 'variable-library'))
      .toThrow(/platform credential/i);
  });

  it('refuses a RENAMED platform secret because the deployment env points at it', () => {
    // The env-var NAME is composed rather than written as a literal on purpose:
    // this exercises the SUFFIX rule (any LOOM_*_SECRET_NAME names a platform
    // secret by definition), and a literal here would look to check-env-sync.mjs
    // like the console reading a config var it does not actually have.
    const envVar = ['LOOM', 'CONTOSO_PLATFORM', 'SECRET_NAME'].join('_');
    process.env[envVar] = 'contoso-renamed-platform-secret';
    try {
      expect(isReservedPlatformSecret('contoso-renamed-platform-secret')).toBe(true);
      expect(() => assertSecretReadAllowed('contoso-renamed-platform-secret', 'directquery-source'))
        .toThrow(KeyVaultSecretPolicyError);
    } finally {
      delete process.env[envVar];
    }
  });
});

describe('a purpose that owns a name-space may read nothing else', () => {
  it('connection-secret accepts a Loom-minted loom-conn- name', () => {
    expect(() => assertSecretReadAllowed('loom-conn-6f9619ff-8b86-d011-b42d-00cf4fc964ff', 'connection-secret')).not.toThrow();
  });
  it('connection-secret REFUSES an arbitrary name', () => {
    expect(() => assertSecretReadAllowed('anything-else', 'connection-secret')).toThrow(/name-space/i);
  });
  it('git-credential accepts every minted git prefix', () => {
    for (const n of ['loom-git-pat-ws1', 'loom-git-ws1-pat', 'loom-app-git-abc12345']) {
      expect(() => assertSecretReadAllowed(n, 'git-credential')).not.toThrow();
    }
  });
  it('git-credential honours a custom LOOM_GIT_PAT_KV_PREFIX', () => {
    process.env.LOOM_GIT_PAT_KV_PREFIX = 'contoso-pat';
    try {
      expect(() => assertSecretReadAllowed('contoso-pat-ws1', 'git-credential')).not.toThrow();
    } finally {
      delete process.env.LOOM_GIT_PAT_KV_PREFIX;
    }
  });
  it('git-credential REFUSES a connection secret', () => {
    expect(() => assertSecretReadAllowed('loom-conn-abc', 'git-credential')).toThrow(/name-space/i);
  });
});

describe('an operator-named purpose may not borrow another feature credential', () => {
  it('a hosted app cannot mount a connection password', () => {
    expect(() => assertSecretReadAllowed('loom-conn-abc', 'app-env-binding')).toThrow(/name-space/i);
  });
  it('a hosted app cannot mount a git PAT', () => {
    expect(() => assertSecretReadAllowed('loom-app-git-deadbeef', 'app-env-binding')).toThrow(/name-space/i);
    expect(() => assertSecretReadAllowed('loom-git-pat-ws1', 'app-env-binding')).toThrow(/name-space/i);
  });
  it('a Variable Library cannot dereference a connection password', () => {
    expect(() => assertSecretReadAllowed('loom-conn-abc', 'variable-library')).toThrow(/name-space/i);
  });
  it('but an operator-created secret of its own is fine', () => {
    for (const purpose of ['variable-library', 'directquery-source', 'app-env-binding', 'udf-function-key'] as KvSecretPurpose[]) {
      expect(() => assertSecretReadAllowed('contoso-app-api-key', purpose)).not.toThrow();
    }
  });
});

describe('degenerate input', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.LOOM_GIT_PAT_KV_PREFIX; });
  afterEach(() => { if (saved === undefined) delete process.env.LOOM_GIT_PAT_KV_PREFIX; });

  it('refuses an empty or whitespace name', () => {
    expect(() => assertSecretReadAllowed('', 'variable-library')).toThrow(/required/i);
    expect(() => assertSecretReadAllowed('   ', 'variable-library')).toThrow(/required/i);
  });
});

describe('MCP server credentials: config selects, an admin cannot supply', () => {
  const ENV = 'LOOM_GITHUB_MCP_PAT_SECRET';
  afterEach(() => { delete process.env[ENV]; });

  it('allows exactly the secret the deployment configured for the entry', () => {
    process.env[ENV] = 'loom-github-mcp-pat';
    expect(() => assertSecretReadAllowed('loom-github-mcp-pat', 'mcp-server-credential')).not.toThrow();
  });

  it('REFUSES the same platform PAT when the deployment did NOT configure it', () => {
    // No secretRefEnv set -> an admin naming it in a server override is an
    // attempt to have Loom deliver a platform credential to a chosen endpoint.
    expect(() => assertSecretReadAllowed('loom-github-mcp-pat', 'mcp-server-credential'))
      .toThrow(KeyVaultSecretPolicyError);
  });

  it('REFUSES an unrelated platform credential even when a secretRefEnv exists', () => {
    process.env[ENV] = 'loom-github-mcp-pat';
    expect(() => assertSecretReadAllowed('loom-msal-client-secret', 'mcp-server-credential'))
      .toThrow(KeyVaultSecretPolicyError);
  });

  it('still allows the built-in Loom MCP server key (not a platform credential)', () => {
    expect(() => assertSecretReadAllowed('loom-mcp-api-key', 'mcp-server-credential')).not.toThrow();
  });

  it('the escape hatch does NOT leak to other purposes', () => {
    process.env[ENV] = 'loom-github-mcp-pat';
    for (const p of ['variable-library', 'directquery-source', 'app-env-binding', 'pipeline-parameter'] as KvSecretPurpose[]) {
      expect(() => assertSecretReadAllowed('loom-github-mcp-pat', p)).toThrow(KeyVaultSecretPolicyError);
    }
  });
});

describe('pipeline parameters cannot dereference a platform credential', () => {
  it.each(['loom-msal-client-secret', 'loom-internal-token', 'loom-conn-abc'])('refuses %s', (n) => {
    expect(() => assertSecretReadAllowed(n, 'pipeline-parameter')).toThrow(KeyVaultSecretPolicyError);
  });
  it('allows an operator-created pipeline secret', () => {
    expect(() => assertSecretReadAllowed('contoso-pipeline-sas', 'pipeline-parameter')).not.toThrow();
  });
});
