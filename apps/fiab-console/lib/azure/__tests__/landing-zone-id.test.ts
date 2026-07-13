/**
 * Pins the landing-zone id codec used in the attach routes' [id] path segment:
 * `hub` passes through readable; a `${sub}/${rg}` id round-trips through the
 * base64url encode/decode (so `/` never rides raw in a path segment).
 */
import { describe, it, expect } from 'vitest';
import { encodeLandingZoneId, decodeLandingZoneId } from '../landing-zone-id';

describe('landing-zone-id codec', () => {
  it('passes `hub` through unencoded', () => {
    expect(encodeLandingZoneId('hub')).toBe('hub');
    expect(decodeLandingZoneId('hub')).toBe('hub');
  });

  it('round-trips a sub/rg id via base64url', () => {
    const id = 'sub-123/rg-csa-loom-dlz-finance-eastus2';
    const enc = encodeLandingZoneId(id);
    expect(enc).not.toContain('/');
    expect(decodeLandingZoneId(enc)).toBe(id);
  });

  it('decodes a URL-encoded raw sub/rg id too', () => {
    const id = 'sub-1/rg-1';
    expect(decodeLandingZoneId(encodeURIComponent(id))).toBe(id);
  });

  it('matches the client-side base64url encoding (btoa path)', () => {
    const id = 'sub-1/rg-1';
    const clientB64url = btoa(unescape(encodeURIComponent(id)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeLandingZoneId(clientB64url)).toBe(id);
  });
});
