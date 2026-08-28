/**
 * LOOM BRAIN W10 — MARKDOWN ENCODING FOR THE STEP-SUMMARY SINK.
 *
 * CodeQL `js/incomplete-sanitization` (HIGH) on `report.ts`:
 *
 *     detail.replace(/\|/g, '\\|')   // "does not escape backslash characters"
 *
 * ── WHY THAT WAS GENUINELY BROKEN, NOT A FALSE POSITIVE ──────────────────
 *     input   a\|b
 *     the `|` becomes `\|`            ->  a  \  \|  b
 *     result  a\\|b
 *     GFM     `\\` is an ESCAPED BACKSLASH, so the `|` after it is UNESCAPED,
 *             splits the cell, and the table structure breaks.
 *
 * And it did nothing about NEWLINES, which end the table ROW — an ARM error
 * body is routinely multi-line, so the table broke on ordinary input too.
 *
 * ── WHY THE TEXT IS ATTACKER-INFLUENCED ──────────────────────────────────
 * `ProbeFailure.detail` is a verbatim Azure Resource Graph / ARM response body,
 * and resource ids and detector subjects are Azure resource names and tag
 * values. Anyone who can name a resource in a scanned subscription can choose
 * bytes that reach this sink. Real, not theoretical.
 *
 * ── THE FIX IS STRUCTURAL, NOT "ALSO ESCAPE BACKSLASH" ───────────────────
 * 1. ENTITY-ENCODE rather than backslash-escape, so there is no escape
 *    character to re-escape and the whole defect class cannot recur.
 * 2. Put UNBOUNDED text in a FENCED BLOCK, where nothing is interpreted and
 *    nothing needs escaping at all.
 *
 * Every payload below goes red against the original one-liner.
 */

import { describe, expect, it } from 'vitest';
import { mdFence, mdParagraph, mdTableCell, renderStepSummary } from '../report';
import { runBrainScan } from '../scan';
import { InMemoryFindingStore, InMemoryGraphHistoryWriter, StaticGraphSource } from '../ports';
import type { ProbeFailure } from '../model';
import {
  CLOUD,
  ESTATE,
  StubProbe,
  buildFixtureGraph,
  probeOf,
  reading,
} from './fixtures';

/**
 * Everything OUTSIDE a fenced block.
 *
 * Content inside a fence is not interpreted by any markdown renderer, so an
 * assertion that greps the raw document for an injected heading or table row
 * would fire on text that is provably inert — the test would be measuring the
 * wrong thing and would push the fix in the wrong direction (toward stripping
 * evidence out of the report).
 *
 * The property that actually matters is: nothing the payload contains becomes
 * STRUCTURE in the interpreted part of the document. So the fenced regions are
 * removed first, and the assertions run on the remainder.
 */
function outsideFences(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const m = /^(`{3,})/.exec(line.trim());
    if (fence === null && m) {
      fence = m[1];
      continue;
    }
    if (fence !== null) {
      // A closing fence must be AT LEAST as long as the opening one.
      if (m && m[1].length >= fence.length) fence = null;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** The hostile corpus. Each entry names the property it attacks. */
const PAYLOADS: readonly { readonly name: string; readonly value: string }[] = [
  { name: 'a bare pipe', value: 'a|b' },
  { name: 'a bare BACKSLASH', value: 'a\\b' },
  { name: 'THE CODEQL PAYLOAD: backslash immediately before a pipe', value: 'a\\|b' },
  { name: 'the escape character the old code introduced', value: 'a\\\\|b' },
  { name: 'a run of backslashes then a pipe', value: 'a\\\\\\\\|b' },
  { name: 'an LF — ends the table ROW, not the cell', value: 'line one\nline two' },
  { name: 'a CRLF', value: 'line one\r\nline two' },
  { name: 'a bare CR', value: 'line one\rline two' },
  { name: 'a row break forged with pipes and a newline', value: 'x |\n| INJECTED | ROW |' },
  { name: 'a markdown heading on its own line', value: 'ok\n## INJECTED HEADING' },
  { name: 'a fence that would close an enclosing block', value: 'ok\n```\nescaped' },
  { name: 'an HTML entity that must not be double-encoded', value: '&amp; &#124;' },
  { name: 'raw HTML', value: '<img src=x onerror=alert(1)>' },
  { name: 'a backtick code span', value: 'a `code` b' },
  // ── INLINE constructs (review of #4014, second pass) ──────────────────────
  // The original corpus was entirely BLOCK-level — forged rows, forged headings,
  // fences. `mdParagraph` neutralised nothing and passed every one of them,
  // because collapsing newlines genuinely does kill block-level constructs. An
  // inline link needs no line start, and none of the payloads above contained
  // one. link-live=true / img-live=true, measured in the rendered summary.
  {
    name: 'AN INLINE LINK — needs no line start, so newline-collapsing misses it',
    value: '[click here for the report](https://evil.example/steal)',
  },
  {
    name: 'AN INLINE IMAGE — an unauthenticated outbound GET from whoever opens the run',
    value: '![](https://evil.example/pixel.gif)',
  },
  {
    name: 'a reference-style link definition',
    value: 'see [the report][r]\n\n[r]: https://evil.example/steal',
  },
  { name: 'an angle autolink', value: '<https://evil.example/steal>' },
  { name: 'an inline link hidden mid-sentence', value: 'ARM said [ok](https://evil.example) and' },
  { name: 'everything at once', value: 'a\\|b\n## H\n```\n<b>&amp;</b>|end' },
];

/** Every character that can OPEN a markdown construct, block or inline. */
const STRUCTURAL = /[\\|<>`[\]()\r\n]/;

describe('mdTableCell — the cell cannot be broken out of', () => {
  it.each(PAYLOADS.map((p) => [p.name, p.value] as const))(
    'contains no raw pipe or newline after encoding: %s',
    (_name, value) => {
      const cell = mdTableCell(value);
      // A raw `|` splits the cell; a raw newline ends the row. Neither may
      // survive, whatever the input.
      expect(cell).not.toMatch(/\|/);
      expect(cell).not.toMatch(/[\r\n]/);
    },
  );

  it('encodes the AMPERSAND FIRST, so its own output is not double-encoded', () => {
    // If `|` were encoded before `&`, the `&` of `&#124;` would then be
    // encoded to `&amp;#124;` and the cell would render the entity literally.
    expect(mdTableCell('|')).toBe('&#124;');
    expect(mdTableCell('&')).toBe('&amp;');
    expect(mdTableCell('&|')).toBe('&amp;&#124;');
  });

  it('encodes a BACKSLASH — the exact gap CodeQL named', () => {
    expect(mdTableCell('\\')).toBe('&#92;');
    // and the payload that broke the original: no raw pipe, no raw backslash.
    expect(mdTableCell('a\\|b')).toBe('a&#92;&#124;b');
  });

  it('CONTROL: the ORIGINAL one-liner fails this corpus', () => {
    // Without this the suite could not distinguish the fix from the bug. This is
    // the shipped code, reproduced, and it must be shown to be broken.
    //
    // ── THIS LINE IS A DELIBERATE NEGATIVE CONTROL (review S6 on #4014) ─────
    // CodeQL flags the next line `js/incomplete-sanitization` — "does not escape
    // backslash characters" — and it is RIGHT: that is the entire point. This is
    // the DEFECT, quoted verbatim so the corpus below can prove it broken. The
    // fixed encoder is `mdTableCell`, asserted two tests above.
    //
    // Deleting the control instead would be worse — it is the only thing that
    // distinguishes the fix from the bug. And leaving the alert standing would
    // be worse still: a permanent HIGH in a public repository's alert list is
    // how an alert list stops being read, which is the failure mode this whole
    // lane exists to prevent, one surface over.
    //
    // ── WHAT ACTUALLY RETIRES THE ALERT, AND IT IS NOT THE MARKER BELOW ────
    // An earlier revision of this comment asserted the alert "is annotated AND
    // dismissed". The annotation was real; the dismissal had not happened, and
    // the marker alone would never have produced it — a claim stated as fact
    // that the code had not established, which is the R7 violation this whole
    // PR is about, committed inside the fix for it.
    //
    // MEASURED: `.github/workflows/codeql.yml` runs NO suppression-consuming
    // step. Its only `query-filters:` entry EXCLUDES a query from the set that
    // RUNS, which is a different mechanism and does not read these markers. So
    // on GitHub this comment does not retire anything by itself — alert 993 was
    // raised 2026-08-25 and was still `open` after the marker was added.
    //
    // The authoritative disposition is therefore an API dismissal carrying this
    // reasoning: alert 993 is dismissed as `used in tests` (2026-08-28). That is
    // the same conclusion #3985 reached for `scripts/measure/measure.mjs`, whose
    // marker carries the identical caveat — see that file for the precedent.
    //
    // The marker stays: it is placed per the CodeQL convention (the line BEFORE
    // the alert), it becomes load-bearing if the workflow ever gains a
    // suppression-consuming step, and the reasoning belongs next to the code
    // either way. It is documentation, not a control.
    // codeql[js/incomplete-sanitization]
    const original = (s: string) => s.replace(/\|/g, '\\|');
    const broken = PAYLOADS.filter((p) => {
      const out = original(p.value);
      // A `\\|` sequence leaves the pipe unescaped in GFM; a newline ends the row.
      return /\\\\\|/.test(out) || /[\r\n]/.test(out);
    });
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.map((b) => b.name)).toContain(
      'THE CODEQL PAYLOAD: backslash immediately before a pipe',
    );
  });

  it('leaves ordinary text untouched', () => {
    expect(mdTableCell('AuthorizationFailed: no Reader on the subscription')).toBe(
      'AuthorizationFailed: no Reader on the subscription',
    );
  });
});

describe('mdParagraph — no construct can be injected, BLOCK or INLINE', () => {
  it.each(PAYLOADS.map((p) => [p.name, p.value] as const))(
    'collapses every line break: %s',
    (_name, value) => {
      expect(mdParagraph(value)).not.toMatch(/[\r\n]/);
    },
  );

  it.each(PAYLOADS.map((p) => [p.name, p.value] as const))(
    'leaves NO structural character raw: %s',
    (_name, value) => {
      // The assertion the original suite was missing. Newline-collapsing alone
      // satisfied every block-level payload and left `[`, `]`, `(`, `)` — and so
      // an inline link — completely untouched.
      expect(mdParagraph(value)).not.toMatch(STRUCTURAL);
    },
  );

  it('a heading payload cannot start a line, so it cannot be a heading', () => {
    const out = mdParagraph('ok\n## INJECTED HEADING');
    expect(out).toBe('ok ## INJECTED HEADING');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('AN INLINE LINK IS DEAD — the measured defect', () => {
    // Before: `mdParagraph` returned this verbatim and the summary rendered a
    // live link with the Brain's authority behind it.
    const out = mdParagraph('[click here for the report](https://evil.example/steal)');
    expect(out).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    expect(out).toBe(
      '&#91;click here for the report&#93;&#40;https://evil.example/steal&#41;',
    );
  });

  it('AN INLINE IMAGE IS DEAD — no unauthenticated outbound GET', () => {
    const out = mdParagraph('![](https://evil.example/pixel.gif)');
    expect(out).not.toMatch(/!\[[^\]]*\]\([^)]*\)/);
  });

  it('CONTROL: the ORIGINAL newline-only implementation fails the inline payloads', () => {
    // Without this the suite cannot tell the fix from the bug. This is the
    // shipped code, reproduced, and it must be shown to be broken.
    const original = (s: string) => s.replace(/\r\n|\r|\n/g, ' ').trim();
    const inlineLink = '[click here for the report](https://evil.example/steal)';
    expect(original(inlineLink)).toMatch(/\[[^\]]*\]\([^)]*\)/);
    expect(mdParagraph(inlineLink)).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    // And it passed the ENTIRE original block-level corpus, which is why the
    // gap survived a review that tried a forged row and a forged heading.
    const blockOnly = PAYLOADS.filter((p) => !p.name.startsWith('A'));
    expect(blockOnly.every((p) => !/[\r\n]/.test(original(p.value)))).toBe(true);
  });

  it('EVIDENCE IS NOT LOST — the entities decode back to the original text', () => {
    // An encoder that dropped the payload would pass every assertion above and
    // destroy the verbatim failure R7 exists to preserve.
    const raw = 'ARM said [ok](https://evil.example) & <b>failed</b> | 500';
    const decoded = mdParagraph(raw)
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(decoded).toBe(raw);
  });

  it('an ampersand is encoded FIRST here too, so output is not double-encoded', () => {
    expect(mdParagraph('&')).toBe('&amp;');
    expect(mdParagraph('&[')).toBe('&amp;&#91;');
  });

  it('emphasis is deliberately LEFT ALONE — cosmetic, and cannot carry a destination', () => {
    expect(mdParagraph('a *b* _c_ ~d~')).toBe('a *b* _c_ ~d~');
  });

  it('HONEST LIMIT, STATED: a bare URL still autolinks', () => {
    // Not encodable without mangling the URL, which would destroy the evidence.
    // Materially weaker: an autolink's visible text IS its destination, so it
    // cannot lie about where it goes. This asserts the limit rather than hiding
    // it, so a future reader does not mistake it for an oversight.
    expect(mdParagraph('see https://evil.example/steal')).toBe('see https://evil.example/steal');
  });
});

describe('mdTableCell — the SAME inline gap, closed by the SAME encoder', () => {
  it.each(PAYLOADS.map((p) => [p.name, p.value] as const))(
    'leaves NO structural character raw: %s',
    (_name, value) => {
      // The cell corpus tested forged ROWS and HEADINGS, so an inline link in a
      // cell was never exercised and was equally live. One shared encoder now
      // serves both, because two copies of this would drift.
      expect(mdTableCell(value)).not.toMatch(STRUCTURAL);
    },
  );

  it('an inline link in a CELL is dead', () => {
    expect(mdTableCell('[a](b)')).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
  });

  it('mdTableCell and mdParagraph agree on every payload but the trim', () => {
    // The drift check. If they ever diverge, one of them is weaker and nothing
    // else in this file would say which.
    for (const { value } of PAYLOADS) {
      expect(mdTableCell(value).trim()).toBe(mdParagraph(value));
    }
  });
});

describe('mdFence — the block cannot be closed from inside', () => {
  it('uses a fence LONGER than the longest backtick run in the content', () => {
    const [open, , close] = mdFence('a ``` b');
    expect(open.length).toBeGreaterThan(3);
    expect(open).toBe(close);
    expect(open).toBe('`'.repeat(4));
  });

  it('handles a very long run', () => {
    const [open] = mdFence('a `````` b');
    expect(open).toBe('`'.repeat(7));
  });

  it('defaults to three backticks when the content has none', () => {
    expect(mdFence('plain')[0]).toBe('```');
  });

  it.each(PAYLOADS.map((p) => [p.name, p.value] as const))(
    'the content never contains a run as long as the fence: %s',
    (_name, value) => {
      const [open, body] = mdFence(value);
      const runs = [...body.matchAll(/`+/g)].map((m) => m[0].length);
      const longest = runs.length > 0 ? Math.max(...runs) : 0;
      expect(longest).toBeLessThan(open.length);
    },
  );
});

describe('renderStepSummary — end to end with a hostile probe failure', () => {
  const hostile = (detail: string, target = 'ok'): ProbeFailure => ({
    stage: 'discovery',
    target,
    classification: 'arm-error',
    httpStatus: 500,
    detail,
  });

  async function summaryFor(f: ProbeFailure) {
    const outcome = await runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-1',
      probe: new StubProbe(probeOf([], [f])),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['configured'], []),
      history: new InMemoryGraphHistoryWriter(),
      findings: new InMemoryFindingStore(),
      source: 'test',
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    });
    return renderStepSummary(outcome);
  }

  it.each(PAYLOADS.map((p) => [p.name, p.value] as const))(
    'the table keeps exactly one data row: %s',
    async (_name, value) => {
      const md = outsideFences(await summaryFor(hostile(value, value)));
      const header = md.indexOf('| # | stage | class | http |');
      expect(header).toBeGreaterThan(-1);
      const table = md.slice(header).split('\n');
      const dataRows = table
        .slice(2)
        .filter((l) => l.startsWith('|'))
        .filter((l) => l.trim() !== '');
      // One failure in, exactly one row out. A forged `|` + newline would add
      // rows here — that is the structural break, made observable.
      expect(dataRows).toHaveLength(1);
      expect(dataRows[0]).toContain('| 1 |');
    },
  );

  it('a forged table row does NOT appear as a row in the INTERPRETED document', async () => {
    const md = outsideFences(await summaryFor(hostile('x |\n| INJECTED | ROW |')));
    expect(md).not.toMatch(/^\| INJECTED \| ROW \|$/m);
  });

  it('a forged heading does NOT appear as a heading in the INTERPRETED document', async () => {
    const md = outsideFences(await summaryFor(hostile('ok\n## INJECTED HEADING')));
    expect(md).not.toMatch(/^## INJECTED HEADING$/m);
  });

  it('THE MEASURED DEFECT: no LIVE LINK survives into the interpreted document', async () => {
    // Measured before the fix, through this exact path: link-live=true.
    // `v.message` embeds `ProbeFailure.detail` verbatim, `mdParagraph` renders it,
    // and `mdParagraph` neutralised nothing at all.
    const md = outsideFences(
      await summaryFor(hostile('[click here for the report](https://evil.example/steal)')),
    );
    expect(md).not.toMatch(/\[click here for the report\]\(https:\/\/evil\.example\/steal\)/);
    // And no inline link of ANY shape, so the assertion is not keyed to this
    // one spelling — a guard keyed to the unsafe SPELLING is not a guard.
    expect(md).not.toMatch(/\[[^\]\n]*\]\([^)\n]*\)/);
  });

  it('THE MEASURED DEFECT: no LIVE IMAGE survives — no outbound GET on open', async () => {
    // img-live=true before the fix. An image in a run summary is an
    // unauthenticated GET from whoever opens it: a read receipt on the alert.
    const md = outsideFences(await summaryFor(hostile('![](https://evil.example/pixel.gif)')));
    expect(md).not.toMatch(/!\[[^\]\n]*\]\([^)\n]*\)/);
  });

  it('the payload is still PRESENT, entity-encoded — evidence, not deletion', async () => {
    const md = outsideFences(
      await summaryFor(hostile('[click here for the report](https://evil.example/steal)')),
    );
    expect(md).toContain('click here for the report');
    expect(md).toContain('evil.example/steal');
    expect(md).toContain('&#91;');
  });

  it('the unbounded fields are still PRESENT — encoding must not lose evidence', async () => {
    // A "fix" that dropped the detail would pass every assertion above and
    // destroy the thing R7 exists to preserve: the verbatim failure.
    const md = await summaryFor(hostile('AuthorizationFailed at 2026', '/subscriptions/x/y'));
    expect(md).toContain('AuthorizationFailed at 2026');
    expect(md).toContain('/subscriptions/x/y');
  });

  it('a fence-closing payload cannot escape the fenced block', async () => {
    const md = await summaryFor(hostile('ok\n```\nESCAPED CONTENT'));
    // The payload's own 3-backtick run must NOT be able to close the block, so
    // the opening fence is longer than 3, and the fences pair up.
    const opens = md.split('\n').filter((l) => /^`{4,}$/.test(l.trim()));
    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(opens.length % 2).toBe(0);

    // The payload text ALSO appears in the verdict paragraph, because
    // `v.message` embeds `detail` verbatim — and that is fine, which is exactly
    // why the assertion is about STRUCTURE and not about the text. In the
    // interpreted region no line may begin a fence: `mdParagraph` collapsed the
    // newlines, so the payload's backticks are mid-line and inert.
    const interpreted = outsideFences(md).split('\n');
    expect(interpreted.filter((l) => /^\s*`{3,}/.test(l))).toHaveLength(0);
    expect(interpreted.filter((l) => /^\s*ESCAPED CONTENT\s*$/.test(l))).toHaveLength(0);
  });
});

describe('renderStepSummary — the PAUSED table with a hostile resource id', () => {
  it('keeps one row per observation', async () => {
    const outcome = await runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-1',
      probe: new StubProbe(probeOf([reading('a|b\n| FORGED | ROW | x |', 'Stopped')])),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['configured'], []),
      history: new InMemoryGraphHistoryWriter(),
      findings: new InMemoryFindingStore(),
      source: 'test',
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    });
    const md = renderStepSummary(outcome);
    expect(md).not.toMatch(/^\| FORGED \| ROW \| x \|$/m);
    const header = md.indexOf('| state | resource | api-version |');
    const rows = md
      .slice(header)
      .split('\n')
      .slice(2)
      .filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(1);
  });
});
