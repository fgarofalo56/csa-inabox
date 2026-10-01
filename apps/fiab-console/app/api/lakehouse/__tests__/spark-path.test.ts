/**
 * Input validation at the lakehouse path boundaries:
 *
 *   - `pathSegments` refuses control characters (and says so in its 400 text).
 *   - `sparkGlobRefusal` refuses the characters a Spark reader treats as a
 *     pattern; the character set is read from `SPARK_GLOB_CHARS_RE` itself.
 *   - `sparkAbfssFor` names the given account on the active cloud's DFS host.
 *   - `boundAccountOf` reads the account out of a resolved abfss binding.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/azure/adls-client', async () => {
  const ce: any = await vi.importActual('@/lib/azure/cloud-endpoints');
  return {
    pathToHttpsUrl: (c: string, p: string) => `${ce.dfsUrl('primacct')}/${c}/${p}`,
    pathToHttpsUrlFor: (a: string, c: string, p: string) => `${ce.dfsUrl(a)}/${c}/${p.replace(/^\/+/, '')}`,
  };
});

import { SPARK_GLOB_CHARS_RE, sparkGlobRefusal, sparkAbfssFor } from '../_lib/spark-path';
import { pathSegments, hasPathControlChar, invalidPathMessage, boundAccountOf } from '../_lib/item-scope';

describe('pathSegments — control characters', () => {
  it.each([['LF', '\n'], ['CR', '\r'], ['TAB', '\t'], ['NUL', '\0'], ['DEL', '\x7f'], ['US', '\x1f']])(
    'refuses a path holding %s',
    (_label, ch) => {
      // Breaks if the refusal narrows back to NUL only (LF/CR/TAB/DEL/US pass).
      expect(pathSegments(`a/b${ch}c/t.parquet`)).toBeNull();
      expect(hasPathControlChar(`b${ch}c`)).toBe(true);
    },
  );

  it('keeps accepting printable names, including a space and non-ASCII', () => {
    // Positive arm: breaks if the check refuses everything above 0x1f too.
    expect(pathSegments('a/b c/ü-x/t.parquet')).toEqual(['a', 'b c', 'ü-x', 't.parquet']);
    expect(hasPathControlChar('b c ü ~')).toBe(false);
  });

  it('names the control-character rule in the refusal text', () => {
    expect(invalidPathMessage('a\nb')).toMatch(/control character/);
    // A different refusal keeps the generic text.
    expect(invalidPathMessage('../a')).not.toMatch(/control character/);
    expect(invalidPathMessage('../a')).toMatch(/"\." or "\.\." segments/);
  });
});

describe('sparkGlobRefusal', () => {
  // Lifted from the source, not transcribed: every char the regex matches.
  const chars = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i))
    .filter((c) => SPARK_GLOB_CHARS_RE.test(c));

  it('the pattern covers exactly the Spark glob set', () => {
    // Breaks if a character is dropped from (or added to) the refused set.
    expect(chars.sort()).toEqual(['*', '?', '[', '\\', ']', '{', '}'].sort());
  });

  it.each(['{', '}', '[', ']', '*', '?', '\\'])('refuses %s', (c) => {
    expect(sparkGlobRefusal(`lakehouses/S--lh/Files/a${c}b.parquet`)).toMatch(/wildcard/);
  });

  it('accepts a literal path', () => {
    expect(sparkGlobRefusal('lakehouses/S--lh/Files/a b(1)-x_y.parquet')).toBeNull();
  });
});

describe('sparkAbfssFor', () => {
  it('names the given account on the commercial DFS host', () => {
    expect(sparkAbfssFor('extacct', 'landing', 'lh/Files/t.parquet'))
      .toEqual({ ok: true, abfss: 'abfss://landing@extacct.dfs.core.windows.net/lh/Files/t.parquet' });
  });

  it('names the GCC-High DFS host when LOOM_CLOUD is gcc-high', () => {
    const prev = process.env.LOOM_CLOUD;
    process.env.LOOM_CLOUD = 'gcc-high';
    try {
      // Breaks if the suffix is hard-coded to `.dfs.core.windows.net`.
      expect(sparkAbfssFor('govacct', 'landing', 'lh/Files/t.parquet'))
        .toEqual({ ok: true, abfss: 'abfss://landing@govacct.dfs.core.usgovcloudapi.net/lh/Files/t.parquet' });
    } finally {
      if (prev === undefined) delete process.env.LOOM_CLOUD; else process.env.LOOM_CLOUD = prev;
    }
  });

  it('falls back to the primary account only when no account is given', () => {
    expect(sparkAbfssFor(null, 'landing', 'x/t.parquet'))
      .toEqual({ ok: true, abfss: 'abfss://landing@primacct.dfs.core.windows.net/x/t.parquet' });
  });

  it('refuses a glob character before building anything (400)', () => {
    expect(sparkAbfssFor('extacct', 'landing', 'lh/{a,b}/t.parquet')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('boundAccountOf', () => {
  it('reads the account from a commercial and a GCC-High binding', () => {
    expect(boundAccountOf('abfss://landing@extacct.dfs.core.windows.net/lakehouses/S--lh')).toBe('extacct');
    expect(boundAccountOf('abfss://landing@GovAcct1.dfs.core.usgovcloudapi.net/x')).toBe('govacct1');
  });

  it('returns null for a binding with no readable account', () => {
    expect(boundAccountOf('https://extacct.dfs.core.windows.net/landing/x')).toBeNull();
    expect(boundAccountOf('abfss://landing@ab.dfs.core.windows.net/x')).toBeNull(); // 2 chars: too short
    expect(boundAccountOf('')).toBeNull();
  });
});
