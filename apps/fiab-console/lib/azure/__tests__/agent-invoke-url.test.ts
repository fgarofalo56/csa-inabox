/**
 * DBX-2 compose-back: `resolveAgentInvokeUrl` is the SSRF guard for the hosted
 * `agent` data-agent source. It must only accept https URLs on an Azure
 * Container Apps managed host (parsed hostname, never a substring match) and
 * always normalise to `<origin>/invoke`.
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentInvokeUrl } from '../data-agent-client';

describe('resolveAgentInvokeUrl', () => {
  it('accepts an ACA Commercial host and normalises to /invoke', () => {
    expect(resolveAgentInvokeUrl('https://app-abc.bluehill-1234.eastus.azurecontainerapps.io'))
      .toBe('https://app-abc.bluehill-1234.eastus.azurecontainerapps.io/invoke');
  });
  it('accepts an ACA Gov host', () => {
    expect(resolveAgentInvokeUrl('https://a.b.usgovvirginia.azurecontainerapps.us/health'))
      .toBe('https://a.b.usgovvirginia.azurecontainerapps.us/invoke');
  });
  it('rejects http (non-TLS)', () => {
    expect(resolveAgentInvokeUrl('http://app.x.azurecontainerapps.io')).toBeNull();
  });
  it('rejects a non-ACA host', () => {
    expect(resolveAgentInvokeUrl('https://evil.example.com')).toBeNull();
  });
  it('rejects a look-alike host that only contains the suffix as a substring', () => {
    // hostname is attacker.com — the ACA suffix is only in the path, not the host.
    expect(resolveAgentInvokeUrl('https://attacker.com/.azurecontainerapps.io')).toBeNull();
    // subdomain spoof: suffix appears mid-host, not at the end.
    expect(resolveAgentInvokeUrl('https://app.azurecontainerapps.io.evil.com')).toBeNull();
  });
  it('rejects empty / malformed input', () => {
    expect(resolveAgentInvokeUrl('')).toBeNull();
    expect(resolveAgentInvokeUrl(undefined)).toBeNull();
    expect(resolveAgentInvokeUrl('not a url')).toBeNull();
  });
});
