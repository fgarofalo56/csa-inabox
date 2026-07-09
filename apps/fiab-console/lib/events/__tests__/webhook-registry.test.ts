import { describe, it, expect } from 'vitest';
import {
  validateRegistrationInput,
  generateWebhookSecret,
  redactHook,
  type WebhookRegistration,
} from '../webhook-registry';

describe('validateRegistrationInput', () => {
  const base = { name: 'Ops', url: 'https://example.com/h', events: ['item.created'] };

  it('accepts a well-formed registration', () => {
    const v = validateRegistrationInput(base);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.name).toBe('Ops');
      expect(v.events).toEqual(['item.created']);
      expect(v.enabled).toBe(true); // default-ON
    }
  });

  it('requires a name', () => {
    expect(validateRegistrationInput({ ...base, name: '  ' })).toMatchObject({ ok: false });
  });

  it('requires https', () => {
    expect(validateRegistrationInput({ ...base, url: 'http://example.com/h' })).toMatchObject({ ok: false });
    expect(validateRegistrationInput({ ...base, url: 'not-a-url' })).toMatchObject({ ok: false });
  });

  it('rejects loopback / link-local / IMDS hosts (SSRF guard)', () => {
    for (const url of [
      'https://localhost/h',
      'https://127.0.0.1/h',
      'https://169.254.169.254/metadata',
      'https://foo.local/h',
    ]) {
      expect(validateRegistrationInput({ ...base, url })).toMatchObject({ ok: false });
    }
  });

  it('requires at least one valid event type and drops unknown ones', () => {
    expect(validateRegistrationInput({ ...base, events: [] })).toMatchObject({ ok: false });
    expect(validateRegistrationInput({ ...base, events: ['bogus'] })).toMatchObject({ ok: false });
    const v = validateRegistrationInput({ ...base, events: ['item.created', 'bogus', 'item.created'] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.events).toEqual(['item.created']); // deduped + filtered
  });

  it('collapses a wildcard selection to ["*"]', () => {
    const v = validateRegistrationInput({ ...base, events: ['*', 'item.created'] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.events).toEqual(['*']);
  });

  it('honours an explicit enabled:false (opt-out)', () => {
    const v = validateRegistrationInput({ ...base, enabled: false });
    if (v.ok) expect(v.enabled).toBe(false);
  });
});

describe('secret handling', () => {
  it('generates a strong base64url secret', () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThanOrEqual(40);
    expect(generateWebhookSecret()).not.toBe(s); // random
  });

  it('redactHook removes the secret and exposes only secretSet', () => {
    const hook: WebhookRegistration = {
      id: 'h1', tenantId: 't1', name: 'n', url: 'https://x/h',
      secret: 'topsecret', events: ['item.created'], enabled: true,
      createdAt: 'now', createdBy: 'me', updatedAt: 'now',
    };
    const view = redactHook(hook);
    expect((view as any).secret).toBeUndefined();
    expect(view.secretSet).toBe(true);
    expect(view.name).toBe('n');
  });
});
