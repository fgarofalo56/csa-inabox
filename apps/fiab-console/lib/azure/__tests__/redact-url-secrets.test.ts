/**
 * redactUrlSecrets — the value of a secret query parameter is replaced, and
 * nothing else is (GHSA-66f6-7xvq-8qxw / S4).
 *
 * WHAT MAKES THESE FAIL (assertion-design.md): each fixture embeds a unique
 * token that MUST NOT survive, paired with a positive that a non-secret part of
 * the same string DOES survive — so a redactor that stripped everything, or
 * nothing, fails one arm or the other.
 */
import { describe, it, expect } from 'vitest';
import { redactUrlSecrets } from '../redact-url-secrets';

describe('redactUrlSecrets', () => {
  it('redacts a function code and a SAS signature, keeping the rest of the URL', () => {
    const s = redactUrlSecrets('https://f.azurewebsites.net/api/alert?code=SECRET-code-9&x=1');
    expect(s).not.toContain('SECRET-code-9');
    expect(s).toContain('code=REDACTED');
    expect(s).toContain('x=1');                      // a non-secret param is untouched
    expect(s).toContain('/api/alert');               // the path is untouched

    const la = redactUrlSecrets('POST failed: https://l.logic.azure.com/…/invoke?sig=SIG-abc123&sp=%2Ftriggers');
    expect(la).not.toContain('SIG-abc123');
    expect(la).toContain('sig=REDACTED');
    expect(la).toContain('POST failed:');            // surrounding prose is untouched
  });

  it('does NOT touch an ARM error code (JSON `"code": "..."`, not a query)', () => {
    const s = redactUrlSecrets('{"error":{"code":"AuthorizationFailed","message":"no rights"}}');
    expect(s).toContain('AuthorizationFailed');       // breaks if the redactor matched `code` too broadly
  });
});
