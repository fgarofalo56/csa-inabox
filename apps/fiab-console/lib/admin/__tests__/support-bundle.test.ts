/** DIAG1 — support-bundle scrubber + env-posture masking (the secret-safety core). */
import { describe, expect, it } from 'vitest';
import {
  scrubSecrets, scrubDeep, buildEnvPosture, envVarKeysOf, assembleSupportBundle,
  supportBundleFilename, SUPPORT_BUNDLE_SCHEMA,
} from '../support-bundle';

const REDACT = '***REDACTED***';

describe('scrubSecrets', () => {
  it('redacts a JWT / access token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123SIGNATURExyz';
    const out = scrubSecrets(`authtoken=${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACT);
  });

  it('redacts a Bearer token but keeps the scheme', () => {
    const out = scrubSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).toContain('Bearer');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('redacts storage AccountKey and SAS sig', () => {
    const cs = 'DefaultEndpointsProtocol=https;AccountName=loom;AccountKey=Zm9vYmFyYmF6c2VjcmV0a2V5;EndpointSuffix=core.windows.net';
    const out = scrubSecrets(cs);
    expect(out).toContain('AccountName=loom'); // non-secret kept
    expect(out).toContain('AccountKey=' + REDACT);
    expect(out).not.toContain('Zm9vYmFyYmF6c2VjcmV0a2V5');

    const sas = 'https://loom.blob.core.windows.net/c/b?sv=2023-01-01&sig=SECRETsignature123&se=2026';
    expect(scrubSecrets(sas)).not.toContain('SECRETsignature123');
  });

  it('redacts a key=value where the key name implies a secret', () => {
    expect(scrubSecrets('LOOM_MSAL_CLIENT_SECRET=Abc123~verysecretvalue')).not.toContain('Abc123~verysecretvalue');
    expect(scrubSecrets('"apiKey":"sk-1234567890abcdef"')).not.toContain('sk-1234567890abcdef');
    expect(scrubSecrets('password=hunter2hunter2')).not.toContain('hunter2hunter2');
  });

  it('does NOT redact safe diagnostic values (SHA, GUID, ISO ts)', () => {
    const safe = 'sha=1a2b3c4d5e6f revision=loom-console--rev-202 at=2026-07-23T12:00:00.000Z id=8c1a2b3c-0000-1111-2222-333344445555';
    expect(scrubSecrets(safe)).toBe(safe);
  });

  it('is idempotent', () => {
    const once = scrubSecrets('token=abcdefghijklmnop1234');
    expect(scrubSecrets(once)).toBe(once);
  });
});

describe('scrubDeep', () => {
  it('scrubs nested string values but preserves keys', () => {
    const input = {
      note: 'saw ClientSecret=leakedSecretValue123 in a log',
      probes: [{ name: 'cosmos', error: 'Bearer eyJleakedTokenABCDEFGHIJ.payloadpart.signaturepart' }],
      count: 3,
    };
    const out = scrubDeep(input);
    expect(JSON.stringify(out)).not.toContain('leakedSecretValue123');
    expect(JSON.stringify(out)).not.toContain('eyJleakedTokenABCDEFGHIJ');
    expect(out.count).toBe(3);
    expect(out.probes[0].name).toBe('cosmos'); // key + safe value intact
  });
});

describe('buildEnvPosture / envVarKeysOf', () => {
  it('flattens required + anyOf var names', () => {
    expect(envVarKeysOf({ required: ['A'], anyOf: [['B', 'C']] }).sort()).toEqual(['A', 'B', 'C']);
  });

  it('masks secret env values but passes plain ones through', () => {
    const specs = [{ required: ['LOOM_COSMOS_ENDPOINT', 'LOOM_MSAL_CLIENT_SECRET'] }];
    const env = {
      LOOM_COSMOS_ENDPOINT: 'https://loom.documents.azure.com:443/',
      LOOM_MSAL_CLIENT_SECRET: 'Abc123~thisisasecret',
    };
    const posture = buildEnvPosture(specs, env);
    const secret = posture.find((p) => p.key === 'LOOM_MSAL_CLIENT_SECRET')!;
    const plain = posture.find((p) => p.key === 'LOOM_COSMOS_ENDPOINT')!;
    expect(secret.present).toBe(true);
    expect(secret.value).toBe('***'); // never the raw secret
    expect(secret.value).not.toContain('thisisasecret');
    expect(plain.value).toBe('https://loom.documents.azure.com:443/');
  });

  it('marks an absent var not-present with an empty value', () => {
    const posture = buildEnvPosture([{ required: ['LOOM_NOT_SET'] }], {});
    expect(posture[0]).toEqual({ key: 'LOOM_NOT_SET', present: false, value: '' });
  });
});

describe('assembleSupportBundle', () => {
  const now = new Date('2026-07-23T12:00:00.000Z');
  const base = {
    now, generatedBy: 'admin@example.com',
    version: { version: '0.75.0', sha: 'deadbeefcafe', cloud: 'Commercial' },
    gates: [
      { id: 'svc-a', status: 'configured', missing: [] },
      { id: 'svc-b', status: 'blocked', missing: ['LOOM_B'] },
      { id: 'svc-c', status: 'cloud-unavailable', missing: [] },
    ],
    env: buildEnvPosture([{ required: ['LOOM_MSAL_CLIENT_SECRET'] }], { LOOM_MSAL_CLIENT_SECRET: 'topsecret~value' }),
    probes: [{ name: 'cosmos-reachable', ok: true, ms: 42 }],
    recentAudit: [{ at: now.toISOString(), who: 'admin', kind: 'runtime-flag.set', target: 'slo1-slo-tab' }],
    notes: [],
  };

  it('summarizes gate states and stamps the schema', () => {
    const b = assembleSupportBundle(base);
    expect(b.schema).toBe(SUPPORT_BUNDLE_SCHEMA);
    expect(b.gateSummary).toEqual({ total: 3, configured: 1, blocked: 1, cloudUnavailable: 1 });
  });

  it('emits ZERO secrets even when one is seeded into a free-text note', () => {
    const b = assembleSupportBundle({
      ...base,
      notes: ['leaked ClientSecret=SUPERsecretLEAK999 during triage'],
    });
    const json = JSON.stringify(b);
    expect(json).not.toContain('SUPERsecretLEAK999');
    expect(json).not.toContain('topsecret~value'); // env masked at source
  });

  it('builds a filesystem-safe download filename', () => {
    expect(supportBundleFilename(now, 'deadbeefcafe')).toBe('loom-support-bundle-2026-07-23T12-00-00-000Z-deadbeef.json');
  });
});
