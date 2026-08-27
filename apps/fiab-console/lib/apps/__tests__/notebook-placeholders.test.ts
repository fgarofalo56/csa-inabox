/**
 * Unit tests for the deployment-placeholder substituter
 * (lib/apps/notebook-placeholders.ts).
 *
 * `{{SYNAPSE_DEDICATED_POOL}}` was added for #4093: the Casino Analytics
 * notebooks read the warehouse through the Synapse dedicated-pool Spark
 * connector, which needs the pool's DATABASE name in a three-part
 * `db.schema.table` argument. A Spark session has no LOOM_* env of its own, so
 * if this substitution does not happen the notebook cannot resolve the pool and
 * the user is left doing the binding by hand — an `auto-bind-by-default.md`
 * violation. These tests pin that it happens, that it is honest when it cannot,
 * and that the two tokens resolve INDEPENDENTLY (an unset ADLS account must not
 * suppress a pool name that is set — the bug the previous single-value
 * early-return would have introduced).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  substituteNotebookPlaceholders,
  substituteCellsPlaceholders,
  knownPlaceholderNames,
  resolveAdlsAccount,
  resolveSynapseDedicatedPool,
  PLACEHOLDER_TOKENS,
} from '../notebook-placeholders';

const ENV_KEYS = ['LOOM_ADLS_ACCOUNT', 'LOOM_SYNAPSE_DEDICATED_POOL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('token registry', () => {
  it('knows both deployment tokens and nothing silently extra', () => {
    expect(knownPlaceholderNames().sort()).toEqual(
      ['ADLS_ACCOUNT', 'SYNAPSE_DEDICATED_POOL'],
    );
  });

  it('each token maps to the env var the deploy actually sets', () => {
    const byToken = Object.fromEntries(PLACEHOLDER_TOKENS.map((t) => [t.token, t.envVar]));
    expect(byToken['{{ADLS_ACCOUNT}}']).toBe('LOOM_ADLS_ACCOUNT');
    // admin-plane/main.bicep wires LOOM_SYNAPSE_DEDICATED_POOL onto loom-console.
    expect(byToken['{{SYNAPSE_DEDICATED_POOL}}']).toBe('LOOM_SYNAPSE_DEDICATED_POOL');
  });

  it('resolvers read (and trim) their env var', () => {
    process.env.LOOM_ADLS_ACCOUNT = '  stloomdata  ';
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = ' loompool ';
    expect(resolveAdlsAccount()).toBe('stloomdata');
    expect(resolveSynapseDedicatedPool()).toBe('loompool');
  });
});

describe('{{SYNAPSE_DEDICATED_POOL}} — the #4093 token', () => {
  const CELL = 'df = spark.read.synapsesql("{{SYNAPSE_DEDICATED_POOL}}.casino.fact_session")';

  it('resolves to the deployment pool so the three-part name is valid', () => {
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
    expect(substituteNotebookPlaceholders(CELL)).toBe(
      'df = spark.read.synapsesql("loompool.casino.fact_session")',
    );
  });

  it('tolerates inner whitespace in the token', () => {
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
    expect(substituteNotebookPlaceholders('x = "{{ SYNAPSE_DEDICATED_POOL }}"')).toBe(
      'x = "loompool"',
    );
  });

  it('leaves the token INTACT when unset (honest gate, never a guess)', () => {
    expect(substituteNotebookPlaceholders(CELL)).toBe(CELL);
    expect(substituteNotebookPlaceholders(CELL)).toContain('{{SYNAPSE_DEDICATED_POOL}}');
  });

  it('replaces EVERY occurrence, not just the first', () => {
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
    const two = '"{{SYNAPSE_DEDICATED_POOL}}.casino.a" "{{SYNAPSE_DEDICATED_POOL}}.casino.b"';
    expect(substituteNotebookPlaceholders(two)).toBe('"loompool.casino.a" "loompool.casino.b"');
  });
});

describe('{{ADLS_ACCOUNT}} — pre-existing behaviour is unchanged', () => {
  const CELL = 'p = "abfss://landing@{{ADLS_ACCOUNT}}.dfs.core.windows.net/"';

  it('resolves from LOOM_ADLS_ACCOUNT', () => {
    process.env.LOOM_ADLS_ACCOUNT = 'stloomdata';
    expect(substituteNotebookPlaceholders(CELL)).toBe(
      'p = "abfss://landing@stloomdata.dfs.core.windows.net/"',
    );
  });

  it('honours an explicit override argument over the env', () => {
    process.env.LOOM_ADLS_ACCOUNT = 'fromenv';
    expect(substituteNotebookPlaceholders(CELL, 'explicit')).toContain('@explicit.dfs');
  });

  it('an explicit EMPTY override leaves the token intact', () => {
    process.env.LOOM_ADLS_ACCOUNT = 'fromenv';
    expect(substituteNotebookPlaceholders(CELL, '')).toBe(CELL);
  });

  it('leaves the token intact when unset', () => {
    expect(substituteNotebookPlaceholders(CELL)).toBe(CELL);
  });
});

describe('tokens resolve INDEPENDENTLY', () => {
  const CELL =
    'a = "{{ADLS_ACCOUNT}}"\nb = "{{SYNAPSE_DEDICATED_POOL}}"';

  it('an unset ADLS account does not suppress a pool name that IS set', () => {
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
    const out = substituteNotebookPlaceholders(CELL);
    expect(out).toContain('b = "loompool"');
    expect(out).toContain('a = "{{ADLS_ACCOUNT}}"');
  });

  it('an unset pool does not suppress an ADLS account that IS set', () => {
    process.env.LOOM_ADLS_ACCOUNT = 'stloomdata';
    const out = substituteNotebookPlaceholders(CELL);
    expect(out).toContain('a = "stloomdata"');
    expect(out).toContain('b = "{{SYNAPSE_DEDICATED_POOL}}"');
  });

  it('both resolve when both are set', () => {
    process.env.LOOM_ADLS_ACCOUNT = 'stloomdata';
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
    expect(substituteNotebookPlaceholders(CELL)).toBe('a = "stloomdata"\nb = "loompool"');
  });
});

describe('substituteCellsPlaceholders — the install path', () => {
  it('substitutes across cells and preserves every other field', () => {
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
    const cells = [
      { id: 'a', type: 'code', lang: 'pyspark', source: 'x = "{{SYNAPSE_DEDICATED_POOL}}"' },
      { id: 'b', type: 'markdown', source: '# heading' },
    ];
    const out = substituteCellsPlaceholders(cells);
    expect(out[0].source).toBe('x = "loompool"');
    expect(out[0].lang).toBe('pyspark');
    expect(out[1]).toBe(cells[1]); // untouched cells keep their reference
  });

  it('returns the SAME array reference when nothing needs changing', () => {
    const cells = [{ id: 'a', type: 'code', source: 'no placeholders here' }];
    expect(substituteCellsPlaceholders(cells)).toBe(cells);
  });

  it('returns the same reference when a token is present but unresolvable', () => {
    const cells = [{ id: 'a', type: 'code', source: 'x = "{{SYNAPSE_DEDICATED_POOL}}"' }];
    expect(substituteCellsPlaceholders(cells)).toBe(cells);
  });

  it('handles empty / non-array input without throwing', () => {
    expect(substituteCellsPlaceholders([])).toEqual([]);
    expect(substituteCellsPlaceholders(undefined as any)).toBeUndefined();
  });
});
