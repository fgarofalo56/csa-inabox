/**
 * MIRROR_SOURCES — unit coverage for the mirror wizard's source catalog.
 *
 * Locks the Fabric Build 2026 #19 addition: Google BigQuery + Oracle are
 * selectable sources, each backed by a Loom Connection of its OWN type whose
 * credential lives in Key Vault. A pure import of the exported const (no React
 * render) keeps this test off the jsdom render path.
 *
 * UPDATED: this file previously asserted `connTypes` contained
 * `'connection-string'`. That was never a ConnectionType — it is an AUTH
 * METHOD, and the source declared it as `'connection-string' as string`, a cast
 * that only compiles *because* the value is not a ConnectionType. The assertion
 * therefore encoded the defect: a source whose only "connection type" is an auth
 * method can never match a real connection, which is why "New connection" from a
 * Snowflake/BigQuery/Oracle mirror dead-ended. The contract asserted now is the
 * corrected one — every declared connType must be a REAL ConnectionType.
 */
import { describe, it, expect } from 'vitest';
import { MIRROR_SOURCES } from '../mirror-source-wizard';
import { CONNECTION_TYPES } from '@/lib/azure/connectable-types';

describe('MIRROR_SOURCES', () => {
  it('includes Google BigQuery and Oracle source cards', () => {
    const ids = MIRROR_SOURCES.map((s) => s.id);
    expect(ids).toContain('GoogleBigQuery');
    expect(ids).toContain('Oracle');
  });

  it('backs BigQuery + Oracle with their own real connection types', () => {
    const expected: Record<string, string> = { GoogleBigQuery: 'bigquery', Oracle: 'oracle' };
    for (const id of ['GoogleBigQuery', 'Oracle']) {
      const src = MIRROR_SOURCES.find((s) => s.id === id)!;
      expect(src).toBeDefined();
      expect(src.connTypes).toContain(expected[id]);
      expect(src.name.length).toBeGreaterThan(0);
      expect(src.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('declares only REAL ConnectionTypes — never an auth method', () => {
    // The regression guard for the original defect. `'connection-string'`,
    // `'sql-password'` and friends are AuthMethods; a source that names one here
    // silently offers the user no connection at all.
    const bogus: string[] = [];
    for (const src of MIRROR_SOURCES) {
      for (const t of src.connTypes) {
        if (!(CONNECTION_TYPES as string[]).includes(t)) bogus.push(`${src.id}: ${t}`);
      }
    }
    expect(bogus, `not a ConnectionType: ${bogus.join(' | ')}`).toEqual([]);
  });

  it('keeps every source id unique', () => {
    const ids = MIRROR_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

