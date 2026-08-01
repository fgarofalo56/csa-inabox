/**
 * logSafe — the log-forging defence (CodeQL js/log-injection).
 *
 * The attack these tests pin: a request-derived value containing a newline is
 * interpolated into a log line, so the tail of the value renders as its own,
 * attacker-authored record. That poisons incident review and any line-parsing
 * alert rule.
 */
import { describe, it, expect } from 'vitest';
import { logSafe } from '../log-safe';

describe('logSafe', () => {
  it('defeats the forged-record attack (the reason this exists)', () => {
    // An attacker sends ?error=<this> hoping the second line reads as a real,
    // separate log record claiming the admin authenticated.
    const forged = 'benign\n[auth/callback] AAD ok user=attacker@evil.test admin=true';
    const out = logSafe(forged);
    expect(out).not.toContain('\n');
    expect(out.split('\n')).toHaveLength(1);
    // The text is still READABLE (we neutralize framing, we do not redact) —
    // an opaque log would be a dishonest log.
    expect(out).toContain('attacker@evil.test');
  });

  it('strips CR, LF, tab and other C0 controls', () => {
    expect(logSafe('a\r\nb')).toBe('a b');
    expect(logSafe('a\tb')).toBe('a b');
    expect(logSafe('a\u0000b')).toBe('a b');
    expect(logSafe('a\u007fb')).toBe('a b');
  });

  it('collapses a control RUN to one space (no silent token merge)', () => {
    // "a\n\n\nb" must not become "ab" — that would fuse two distinct tokens
    // into one word and mislead a reader.
    expect(logSafe('a\n\n\nb')).toBe('a b');
  });

  it('leaves an ordinary value untouched', () => {
    expect(logSafe('invalid_grant')).toBe('invalid_grant');
    expect(logSafe('AADSTS50011: redirect mismatch')).toBe('AADSTS50011: redirect mismatch');
  });

  it('bounds length so one field cannot flood a line', () => {
    const out = logSafe('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(201); // 200 + the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns a string for every input (callers never need a guard)', () => {
    expect(logSafe(null)).toBe('');
    expect(logSafe(undefined)).toBe('');
    expect(logSafe(42)).toBe('42');
    expect(logSafe(false)).toBe('false');
  });
});
