/**
 * MIRROR_SOURCES — unit coverage for the mirror wizard's source catalog.
 *
 * Locks the Fabric Build 2026 #19 addition: Google BigQuery + Oracle are
 * selectable sources, each backed by a generic-sql / connection-string Loom
 * Connection (Key Vault-stored credential) so the wizard can hold the
 * BigQuery service-account key or the Oracle sync-user secret. A pure import of
 * the exported const (no React render) keeps this test off the jsdom render path.
 */
import { describe, it, expect } from 'vitest';
import { MIRROR_SOURCES } from '../mirror-source-wizard';

describe('MIRROR_SOURCES', () => {
  it('includes Google BigQuery and Oracle source cards', () => {
    const ids = MIRROR_SOURCES.map((s) => s.id);
    expect(ids).toContain('GoogleBigQuery');
    expect(ids).toContain('Oracle');
  });

  it('backs BigQuery + Oracle with credential-capable connection types', () => {
    for (const id of ['GoogleBigQuery', 'Oracle']) {
      const src = MIRROR_SOURCES.find((s) => s.id === id)!;
      expect(src).toBeDefined();
      // A Key Vault-backed connection-string (service-account key / sync-user
      // secret) must be an offered connection type for both.
      expect(src.connTypes).toContain('connection-string');
      expect(src.connTypes).toContain('generic-sql');
      expect(src.name.length).toBeGreaterThan(0);
      expect(src.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('keeps every source id unique', () => {
    const ids = MIRROR_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
