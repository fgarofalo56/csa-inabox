import { describe, it, expect } from 'vitest';
import {
  daysToExpiry,
  bandFor,
  mergeInventory,
  shouldAlert,
  alertingItems,
  nextState,
  buildAlertMessage,
  issueTitle,
  missingConfig,
  parseTrackedSecrets,
  parseWarnDays,
  type TrackedCredential,
} from './expiry-core';

const NOW = Date.parse('2026-07-22T00:00:00Z');
const iso = (daysFromNow: number) => new Date(NOW + daysFromNow * 86_400_000).toISOString();

describe('threshold math', () => {
  it('computes whole days to expiry (floor, negative when expired)', () => {
    expect(daysToExpiry(NOW, iso(45))).toBe(45);
    expect(daysToExpiry(NOW, iso(0.5))).toBe(0);
    expect(daysToExpiry(NOW, iso(-2))).toBe(-2);
    expect(daysToExpiry(NOW, null)).toBeNull();
    expect(daysToExpiry(NOW, 'not-a-date')).toBeNull();
  });

  it('bands at the 60/30/7 boundaries', () => {
    expect(bandFor(null)).toBe('no-expiry');
    expect(bandFor(-1)).toBe('expired');
    expect(bandFor(0)).toBe('critical');
    expect(bandFor(7)).toBe('critical');
    expect(bandFor(8)).toBe('warn30');
    expect(bandFor(30)).toBe('warn30');
    expect(bandFor(31)).toBe('warn60');
    expect(bandFor(60)).toBe('warn60');
    expect(bandFor(61)).toBe('ok');
  });

  it('honors a custom outer warn threshold (LOOM_SECRET_EXPIRY_WARN_DAYS)', () => {
    expect(bandFor(75, 90)).toBe('warn60');
    expect(bandFor(91, 90)).toBe('ok');
    // The outer threshold can never dip below the fixed 30-day band.
    expect(bandFor(25, 10)).toBe('warn30');
  });

  it('parses warn-days defensively', () => {
    expect(parseWarnDays('60')).toBe(60);
    expect(parseWarnDays('90')).toBe(90);
    expect(parseWarnDays(undefined)).toBe(60);
    expect(parseWarnDays('nope')).toBe(60);
    expect(parseWarnDays('-5')).toBe(60);
  });
});

describe('inventory merge', () => {
  it('merges Graph credentials + KV secrets, sorted worst-first', () => {
    const items = mergeInventory({
      appId: 'app-1',
      appDisplayName: 'CSA Loom Console',
      appCreds: [
        { keyId: 'k1', displayName: 'rbac', startDateTime: iso(-700), endDateTime: iso(5) },
        { keyId: 'k2', startDateTime: iso(-10), endDateTime: iso(720) },
      ],
      kvSecrets: [
        { name: 'loom-msal-client-secret', updated: Math.floor((NOW - 10 * 86_400_000) / 1000) },
        { name: 'synthetic-login-secret', exp: Math.floor((NOW + 20 * 86_400_000) / 1000) },
        { name: 'missing-one', notFound: true },
      ],
      nowMs: NOW,
      msalKvSecretName: 'loom-msal-client-secret',
    });
    expect(items.map((i) => i.id)).toEqual([
      'entra-app:k1',            // critical, 5d
      'kv:synthetic-login-secret', // warn30, 20d
      'entra-app:k2',            // ok
      'kv:loom-msal-client-secret', // no-expiry (KV copy in sync)
      'kv:missing-one',          // no-expiry (not found)
    ]);
    expect(items[0].band).toBe('critical');
    expect(items[0].daysToExpiry).toBe(5);
    expect(items[1].band).toBe('warn30');
    const missing = items.find((i) => i.id === 'kv:missing-one')!;
    expect(missing.detail).toMatch(/not been provisioned/i);
  });

  it('flags MSAL KV drift when the app credential is newer than the vault copy', () => {
    const items = mergeInventory({
      appCreds: [{ keyId: 'kNew', startDateTime: iso(-1), endDateTime: iso(729) }],
      kvSecrets: [{ name: 'loom-msal-client-secret', updated: Math.floor((NOW - 30 * 86_400_000) / 1000) }],
      nowMs: NOW,
      msalKvSecretName: 'loom-msal-client-secret',
    });
    const kv = items.find((i) => i.id === 'kv:loom-msal-client-secret')!;
    expect(kv.drift).toBe(true);
    expect(kv.band).toBe('critical');
    expect(kv.detail).toMatch(/DRIFT/);
  });

  it('does NOT flag drift inside the 15-minute rotation slack', () => {
    const items = mergeInventory({
      appCreds: [{ keyId: 'k', startDateTime: new Date(NOW).toISOString(), endDateTime: iso(730) }],
      kvSecrets: [{ name: 'loom-msal-client-secret', updated: Math.floor((NOW - 5 * 60_000) / 1000) }],
      nowMs: NOW,
      msalKvSecretName: 'loom-msal-client-secret',
    });
    expect(items.find((i) => i.id === 'kv:loom-msal-client-secret')!.drift).toBeUndefined();
  });

  it('surfaces vault read errors honestly instead of dropping the row', () => {
    const items = mergeInventory({
      appCreds: [],
      kvSecrets: [{ name: 's1', error: '403 (Key Vault Secrets User role missing)' }],
      nowMs: NOW,
    });
    expect(items[0].detail).toMatch(/403/);
    expect(items[0].band).toBe('no-expiry');
  });
});

describe('alert band transitions', () => {
  it('alerts only on escalation, never on repeat or de-escalation', () => {
    expect(shouldAlert(undefined, 'warn60')).toBe(true);
    expect(shouldAlert('ok', 'warn30')).toBe(true);
    expect(shouldAlert('warn60', 'warn30')).toBe(true);
    expect(shouldAlert('warn30', 'critical')).toBe(true);
    expect(shouldAlert('critical', 'expired')).toBe(true);
    expect(shouldAlert('warn60', 'warn60')).toBe(false);
    expect(shouldAlert('critical', 'warn30')).toBe(false);
    expect(shouldAlert(undefined, 'ok')).toBe(false);
    expect(shouldAlert(undefined, 'no-expiry')).toBe(false);
  });

  it('selects escalated items and folds the next state', () => {
    const items: TrackedCredential[] = [
      { id: 'a', source: 'entra-app', label: 'A', expiresAt: iso(5), daysToExpiry: 5, band: 'critical' },
      { id: 'b', source: 'key-vault', label: 'B', expiresAt: iso(50), daysToExpiry: 50, band: 'warn60' },
      { id: 'c', source: 'key-vault', label: 'C', expiresAt: null, daysToExpiry: null, band: 'no-expiry' },
    ];
    const firing = alertingItems(items, { b: { band: 'warn60', alertedAt: '2026-07-21T00:00:00Z' } });
    expect(firing.map((i) => i.id)).toEqual(['a']); // b unchanged, c never alerts
    const st = nextState(items, '2026-07-22T00:00:00Z');
    expect(Object.keys(st).sort()).toEqual(['a', 'b']);
    expect(st.a.band).toBe('critical');
  });

  it('builds the alert message + stable dedup issue title', () => {
    const item: TrackedCredential = {
      id: 'entra-app:k1', source: 'entra-app', label: 'CSA Loom Console — client secret rbac',
      expiresAt: iso(5), daysToExpiry: 5, band: 'critical',
    };
    const { subject, body } = buildAlertMessage([item], 60);
    expect(subject).toContain('1 credential below threshold');
    expect(subject).toContain('critical');
    expect(body).toContain('5 days to expiry');
    expect(body).toContain('secret-rotation.md');
    expect(issueTitle(item)).toBe('secret-expiry: CSA Loom Console — client secret rbac — critical');
  });
});

describe('config gates', () => {
  it('is fatal only when BOTH inventory sources are missing', () => {
    expect(missingConfig({}).fatal.length).toBeGreaterThan(0);
    expect(missingConfig({ LOOM_MSAL_CLIENT_ID: 'x' }).fatal).toEqual([]);
    expect(missingConfig({ LOOM_KEY_VAULT_URI: 'https://v.vault.azure.net/' }).fatal).toEqual([]);
    expect(missingConfig({ LOOM_MSAL_CLIENT_ID: 'x' }).keyVault).toEqual(['LOOM_KEY_VAULT_URI']);
    expect(missingConfig({ LOOM_MSAL_CLIENT_ID: 'x' }).alerting).toEqual(['LOOM_ALERT_ACTION_GROUP_ID']);
  });

  it('parses the tracked-secret list (trim, dedupe, drop empties)', () => {
    expect(parseTrackedSecrets(' a, b ,a,,')).toEqual(['a', 'b']);
    expect(parseTrackedSecrets(undefined)).toEqual([]);
  });
});
