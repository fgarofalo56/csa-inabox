import { describe, it, expect } from 'vitest';
import { buildAksEnvCommand } from '../aks-arm-client';

const base = {
  deployment: 'loom-console',
  namespace: 'default',
  secretName: 'loom-console-env-config',
};

describe('aks-arm-client buildAksEnvCommand (env-config AKS write path)', () => {
  it('emits a kubectl set env step for plain vars targeting the deployment + namespace', () => {
    const cmd = buildAksEnvCommand({
      ...base,
      changes: { LOOM_LOG_LEVEL: 'debug', LOOM_FEATURE_X: 'on' },
      secrets: {},
    });
    expect(cmd).toContain('kubectl set env -n default deployment/loom-console');
    expect(cmd).toContain("LOOM_LOG_LEVEL='debug'");
    expect(cmd).toContain("LOOM_FEATURE_X='on'");
    // No secret machinery when there are no secret keys.
    expect(cmd).not.toContain('kind: Secret');
    expect(cmd).not.toContain('--from=secret');
  });

  it('routes secret-typed vars through a stdin Secret manifest, never argv', () => {
    const cmd = buildAksEnvCommand({
      ...base,
      changes: {},
      secrets: { SESSION_SECRET: 'top-secret-value' },
    });
    // The value lives only inside the heredoc Secret manifest (stdin), and the
    // deployment references it via --from=secret (secretKeyRef), not plain env.
    expect(cmd).toContain('kind: Secret');
    expect(cmd).toContain('name: loom-console-env-config');
    expect(cmd).toContain('LOOM_SECRET_EOF');
    expect(cmd).toContain('--from=secret/loom-console-env-config');
    // The secret value must NOT appear as a `kubectl set env KEY=value` argv pair.
    expect(cmd).not.toContain("SESSION_SECRET='top-secret-value' ");
    expect(cmd).toContain('top-secret-value'); // present, but only in the manifest stringData
  });

  it('combines plain + secret changes into one rolling update with a bounded rollout check', () => {
    const cmd = buildAksEnvCommand({
      ...base,
      changes: { LOOM_LOG_LEVEL: 'info' },
      secrets: { LOOM_COSMOS_KEY: 'abc123' },
    });
    expect(cmd.startsWith('set -e')).toBe(true);
    expect(cmd).toContain('kubectl apply -n default -f -');
    expect(cmd).toContain('kubectl set env -n default deployment/loom-console --from=secret/loom-console-env-config');
    expect(cmd).toContain("kubectl set env -n default deployment/loom-console LOOM_LOG_LEVEL='info'");
    expect(cmd).toContain('kubectl rollout status -n default deployment/loom-console --timeout=10s || true');
  });

  it('shell-escapes single quotes in values (no command injection)', () => {
    const cmd = buildAksEnvCommand({
      ...base,
      changes: { LOOM_NOTE: "a'b" },
      secrets: {},
    });
    // A single quote is closed, escaped (\'), then reopened: 'a'\''b'
    expect(cmd).toContain(`LOOM_NOTE='a'\\''b'`);
    // No raw unescaped quote sequence that would break out of the literal.
    expect(cmd).not.toContain(`LOOM_NOTE='a'b'`);
  });
});
