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
import { MIRROR_SOURCES, SOURCE_SYNC_NOTE, syncModeOptions } from '../mirror-source-wizard';
import { CONNECTION_TYPES } from '@/lib/azure/connectable-types';
import { MIRROR_SOURCE_CONN_TYPES, MIRROR_SOURCE_LABEL } from '@/lib/azure/mirror-source-compat';


/**
 * The wizard catalog and the server-side refusal MUST agree about what backs
 * what. They are one source of truth by construction (MIRROR_SOURCES reads its
 * `connTypes` / `name` from mirror-source-compat), and this asserts nobody has
 * re-inlined a literal — which is how the picker could start offering a pairing
 * the BFF then refuses, or worse, stop refusing one it should.
 */
describe('the wizard catalog does not drift from the compatibility map', () => {
  it('every source card reads its connTypes from the shared map', () => {
    for (const src of MIRROR_SOURCES) {
      expect(src.connTypes, `${src.id} connTypes drifted from mirror-source-compat`)
        .toEqual(MIRROR_SOURCE_CONN_TYPES[src.id]);
    }
  });

  it('every source card reads its display name from the shared map', () => {
    for (const src of MIRROR_SOURCES) {
      expect(src.name, `${src.id} name drifted from mirror-source-compat`)
        .toBe(MIRROR_SOURCE_LABEL[src.id]);
    }
  });

  it('covers every id the compatibility map knows about', () => {
    expect(MIRROR_SOURCES.map((s) => s.id).sort())
      .toEqual(Object.keys(MIRROR_SOURCE_CONN_TYPES).sort());
  });
});


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

/**
 * The ADF Copy backend must not claim change capture it does not have.
 *
 * An independent mutation test (M10) replaced the honest Snowflake note with a
 * CDC claim and NOTHING went red. Separately, the mode dropdown labelled the
 * DEFAULT option "Incremental (changed rows since last sync)" while the note
 * directly below it said "delete-then-copy full refresh" — a contradiction on
 * one screen, with the misleading half pre-selected.
 */
describe('sync-mode honesty on the ADF Copy backend', () => {
  it('the Snowflake note states full refresh, never row-level CDC', () => {
    const note = SOURCE_SYNC_NOTE.Snowflake;
    expect(note, 'the Snowflake sync note went missing').toBeTruthy();
    expect(note).toMatch(/full refresh|delete-then-copy/i);
    expect(note).not.toMatch(/\bchange data capture\b/i);
    expect(note).not.toMatch(/changed rows since last sync/i);
  });

  it('Snowflake mode LABELS promise a full reload, not changed rows', () => {
    const labels = syncModeOptions('Snowflake').map((o) => o.name).join(' | ');
    expect(labels).not.toMatch(/changed rows since last sync/i);
    expect(labels).toMatch(/full reload/i);
  });

  it('but the SQL family KEEPS its changed-rows label, which is true there', () => {
    // The fix must not flatten every source to the weakest claim: SQL Change
    // Tracking genuinely does ship only the rows that changed.
    const labels = syncModeOptions('AzureSqlDatabase').map((o) => o.name).join(' | ');
    expect(labels).toMatch(/changed rows since last sync/i);
  });

  it('offers the same three mode ids for every source', () => {
    for (const src of ['Snowflake', 'AzureSqlDatabase', 'CosmosDb', 'Oracle']) {
      expect(syncModeOptions(src).map((o) => o.id).sort())
        .toEqual(['continuous', 'incremental', 'snapshot']);
    }
  });
});


