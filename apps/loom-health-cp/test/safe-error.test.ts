import { describe, expect, it, vi } from 'vitest';
import { authoredMessage, publicErrorMessage } from '../src/safe-error.js';
import { HttpError } from '../src/http/errors.js';

describe('safe-error', () => {
  it('a non-HttpError with a secret-looking message yields only the literal public message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Breaks if the caught value's message/stack ever reaches the returned string.
    const out = publicErrorMessage(new Error('Password=hunter2 https://cosmos-acct.documents.azure.us'), 'internal error');
    expect(out).toMatch(/^internal error \(ref: [0-9a-f]{8}\)$/);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('cosmos-acct');
    // positive control: the detail is still logged server-side
    expect(String(spy.mock.calls[0]?.[1])).toContain('hunter2');
    spy.mockRestore();
  });

  it('an authored HttpError message passes through unchanged', () => {
    expect(authoredMessage(new HttpError(409, 'conflict', 'stamp already exists'))).toBe('stamp already exists');
  });
});
