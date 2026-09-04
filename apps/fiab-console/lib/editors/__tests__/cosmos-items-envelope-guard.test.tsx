/**
 * #3878 — cosmos-items response-envelope contract.
 *
 * TWO envelope conventions are interleaved under `/api/`:
 *
 *   `/api/cosmos-items/<type>`          POST  → `{ ok: true, item }`   (WRAPPED)
 *   `/api/cosmos-items/<type>/<id>`     GET   → the item document       (BARE)
 *   `/api/cosmos-items/<type>/<id>`     PATCH → the updated resource    (BARE)
 *   `/api/cosmos-items/<type>/<id>`     DELETE→ `{ ok: true }`          (wrapped)
 *
 * Seven client reads judged a BARE response by `j.ok`, which is `undefined`
 * there. `undefined` is falsy, so every one of them took the failure branch on
 * a call that had SUCCEEDED: a saved geo-map opened blank ('absent'), a
 * successful PATCH raised an error banner and left the editor dirty, and
 * `classifyHealth` on the data-product component grid was unreachable — every
 * component rendered 'unknown'.
 *
 * The route envelope is NOT changed: four readers plus `use-item-doc-state`
 * already read the bare shape correctly, so moving the routes would break the
 * code that is right. The CLIENTS are moved onto the bare contract.
 *
 * Part 1 exercises the behaviour through the real editors against the real
 * (bare) response shape. Part 2 is a source guard: no truthy `j.ok` read may
 * reappear within 20 lines of a cosmos-items GET/PATCH.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeoMapEditor } from '../geo-editors';
import { DataProductInstanceEditor } from '../data-product-editors';
import { makeItem, installFetchMock } from './test-helpers';

const EDITORS_DIR = join(process.cwd(), 'lib', 'editors');

describe('cosmos-items envelope — editors read the BARE document (#3878)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders saved state from a BARE GET response instead of falling to absent', async () => {
    installFetchMock({
      // Exactly what `NextResponse.json(access.item)` puts on the wire.
      '/api/cosmos-items/geo-map/': () => ({
        id: 'gm-1',
        workspaceId: 'ws-1',
        itemType: 'geo-map',
        displayName: 'Field sites',
        state: {
          style: 'satellite',
          overlayGeoJson: JSON.stringify({
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.35, 47.62] }, properties: {} },
              { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.4, 47.7] }, properties: {} },
              { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.2, 47.5] }, properties: {} },
            ],
          }),
        },
        createdBy: 'u', createdAt: '', updatedAt: '2026-09-01T00:00:00.000Z',
      }),
    });
    render(<GeoMapEditor item={makeItem('geo-map', 'Geo map')} id="gm-1" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    // The saved overlay must reach the canvas. Pre-fix the bare doc produced
    // load='absent': the editor rendered the empty default over three real
    // stored features, and the next save would have written that emptiness back.
    await waitFor(
      () => expect(document.body.textContent || '').toMatch(/Map render \(3 features/),
      { timeout: 5000 },
    );
    expect(document.body.textContent || '', 'a successful bare read rendered as an error')
      .not.toMatch(/could not be read/i);
  });

  /**
   * The SECOND of the four covered files, exercised through its real UI rather
   * than through the source regex (review of PR #4316: three of the four files
   * the guard covers had no behavioural test, so the regex was their only
   * protection — and a regex keyed to an identifier is one rename from blind).
   *
   * The defect: `refreshHealth` judged the cosmos-items GET by `j.ok`, which is
   * `undefined` on the bare document, so `classifyHealth` was UNREACHABLE and
   * every component in the grid rendered the 'Unknown' badge no matter how
   * fresh it was. This test reads the rendered badge, so any read of the
   * envelope that treats `undefined` as failure fails it — whatever the
   * identifier is called.
   */
  it('renders real component health from a BARE cosmos-items GET instead of Unknown', async () => {
    const fresh = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    installFetchMock({
      // The instance route is the WRAPPED envelope — deliberately the opposite
      // convention to the cosmos-items route below, which is the whole reason
      // #3878 happened.
      '/api/items/data-product-instance/': () => ({
        ok: true,
        item: {
          id: 'dpi-1', itemType: 'data-product-instance', displayName: 'Sales product',
          state: { template: 'sales', components: [{ slug: 'lakehouse', itemId: 'lh-1', displayName: 'Bronze lakehouse' }] },
        },
      }),
      // Exactly what `NextResponse.json(access.item)` puts on the wire: no `ok`.
      '/api/cosmos-items/': () => ({
        id: 'lh-1', itemType: 'lakehouse', displayName: 'Bronze lakehouse', updatedAt: fresh,
      }),
    });
    render(<DataProductInstanceEditor item={makeItem('data-product-instance', 'Data product instance')} id="dpi-1" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    // The component row must exist before health can be read for it.
    await waitFor(() => expect(screen.getByText('Bronze lakehouse')).toBeInTheDocument(), { timeout: 5000 });

    fireEvent.click(screen.getByText('Check health'));

    await waitFor(() => expect(screen.getByText('OK')).toBeInTheDocument(), { timeout: 5000 });
    expect(
      screen.queryByText('Unknown'),
      'a fresh component read from a successful bare GET rendered as Unknown — classifyHealth was unreachable',
    ).toBeNull();
  });
});

/**
 * Source guard. Any TRUTHY read of the parsed response body's `ok` within 20
 * lines after a cosmos-items GET/PATCH fetch is the exact defect shape; only
 * the explicitly-false forms (`=== false`, `!== false`, which correctly ignore
 * `undefined`) are permitted.
 *
 * KEYED TO THE SHAPE, NOT THE SPELLING (review of PR #4316). The first version
 * of this guard matched the literal text `j.ok` / `j?.ok`, so it was blind to
 * the same defect written with any other identifier. MEASURED by the reviewer:
 * replacing `next[c.itemId] = (r.ok && j?.ok !== false)` in
 * data-product-editors.tsx with
 *
 *     const { ok: envOk } = (j ?? {}) as any;
 *     next[c.itemId] = envOk;
 *
 * restores the #3878 defect exactly (`undefined` is falsy, so every component
 * renders 'unknown') and the suite still passed 7/7. A regex that a rename
 * defeats is not a guard for the three files that have no behavioural test.
 *
 * So the guard now RESOLVES the body binding from the source instead of
 * assuming it is called `j`:
 *   1. the body identifier comes from `const <NAME> = await <resp>.json()`;
 *   2. any alias destructured out of that body (`const { ok: envOk } = body`,
 *      `const { ok } = body`) is tracked as an envelope-ok alias;
 *   3. a truthy read of `<BODY>.ok`, `<BODY>?.ok`, `<BODY>['ok']` OR of any
 *      tracked alias is an offence, whatever it is named.
 */
describe('cosmos-items envelope — source guard (#3878)', () => {
  const FILES = [
    'geo-editors.tsx',
    'graph-editors.tsx',
    'data-product-editors.tsx',
    join('apim-editors', 'data-product-editor.tsx'),
  ];

  /** A fetch at the item-scoped cosmos-items route (the BARE ones). */
  const COSMOS_ITEM_FETCH = /\/api\/cosmos-items\/\$\{[^}]*\}\/\$\{|\/api\/cosmos-items\/[a-z-]+\/\$\{/;
  /**
   * Comments are not code. This guard's own explanatory comments quote the
   * defective expression verbatim, so scanning raw lines would make the guard
   * fail on its own documentation — a guard that cannot survive being described
   * is not measuring the source.
   */
  const isComment = (l: string) => /^\s*(?:\/\/|\/\*|\*)/.test(l);

  /** `const j = await r.json()` → the identifier the parsed body is bound to. */
  const BODY_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[\w$.?]+\.json\s*\(/;
  /**
   * `const { ok: envOk } = <expr>` / `const { ok } = <expr>` → the identifier
   * the envelope's `ok` is aliased to. Captures the destructure so the read of
   * the alias downstream can be judged by the same rule as a direct read.
   */
  const OK_DESTRUCTURE = /\b(?:const|let|var)\s*\{[^}]*\bok\b\s*(?::\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=\s*(.+)$/;

  /** Escape an identifier for embedding in a RegExp. */
  const rx = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Is `line` a truthy (i.e. not-explicitly-`false`-compared) read of `expr`?
   * `expr` is already a regex-safe fragment such as `j\??\.ok` or `envOk`.
   *
   * The trailing boundary is `(?![\w$])`, NOT `\b`: a bracket read ends in `]`,
   * and `\b` after a non-word character requires a word character next, so
   * `body['ok'])` would not have matched at all.
   */
  const truthyRead = (line: string, expr: string) =>
    new RegExp(`(?:^|[^!=<>.\\w$])(?:!)?${expr}(?![\\w$])(?!\\s*(?:===|!==))`).test(line);

  /**
   * Scan a window of lines and return every offending read. Exported shape so
   * the positive controls exercise the SAME code the file scan does — a control
   * that re-implements the rule proves nothing about the rule that ran.
   */
  function offencesIn(lines: string[], rel = '<inline>'): string[] {
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (isComment(lines[i]) || !COSMOS_ITEM_FETCH.test(lines[i])) continue;
      // Bodies bound in this window, plus the conventional `j` so a read that
      // precedes (or omits) an explicit binding is still judged.
      const bodies = new Set<string>(['j']);
      const okAliases = new Set<string>();
      const end = Math.min(i + 20, lines.length - 1);
      for (let k = i + 1; k <= end; k++) {
        const line = lines[k];
        if (isComment(line)) continue;
        const bind = BODY_BINDING.exec(line);
        if (bind) bodies.add(bind[1]);
        const de = OK_DESTRUCTURE.exec(line);
        if (de && Array.from(bodies).some((b) => new RegExp(`\\b${rx(b)}\\b`).test(de[2]))) {
          // `const { ok } = body` with no rename aliases to `ok` itself.
          okAliases.add(de[1] || 'ok');
          continue; // the destructure itself is not the read
        }
        for (const b of bodies) {
          if (
            truthyRead(line, `${rx(b)}\\??\\.ok`) ||
            truthyRead(line, `${rx(b)}\\??\\[['"]ok['"]\\]`)
          ) {
            offenders.push(`${rel}:${k + 1}: ${line.trim()}`);
            break;
          }
        }
        for (const alias of okAliases) {
          if (truthyRead(line, rx(alias))) { offenders.push(`${rel}:${k + 1}: ${line.trim()}`); break; }
        }
      }
    }
    return offenders;
  }

  for (const rel of FILES) {
    it(`${rel} has no truthy envelope-ok read near a cosmos-items item fetch`, () => {
      const lines = readFileSync(join(EDITORS_DIR, rel), 'utf8').split(/\r?\n/);
      const offenders = offencesIn(lines, rel);
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }

  it('detects the pre-fix shape (positive control)', () => {
    expect(offencesIn([
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const j = await r.json();',
      'if (j?.ok && j.item?.state) { setState(j.item.state); }',
    ])).toHaveLength(1);
  });

  /**
   * The evasion the reviewer MEASURED against the first guard: same defect,
   * different identifier. This is the control that the spelling-keyed regex
   * could not pass.
   */
  it('detects the same defect DESTRUCTURED under another name (positive control)', () => {
    expect(offencesIn([
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const j = await r.json();',
      'const { ok: envOk } = (j ?? {}) as any;',
      'next[c.itemId] = envOk;',
    ])).toHaveLength(1);
  });

  it('detects it under a renamed BODY binding (positive control)', () => {
    expect(offencesIn([
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const payload = await r.json();',
      'if (payload.ok) { setState(payload.item.state); }',
    ])).toHaveLength(1);
  });

  it('detects a bracket-access read (positive control)', () => {
    expect(offencesIn([
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const body = await r.json();',
      "if (body['ok']) { setState(body.item.state); }",
    ])).toHaveLength(1);
  });

  it('permits the CORRECT explicitly-false forms, direct and aliased (negative control)', () => {
    expect(offencesIn([
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const j = await r.json();',
      'if (!r.ok || j?.ok === false) { setError(String(j?.error)); return; }',
      'const okFlag = r.ok && j?.ok !== false;',
    ])).toEqual([]);
    expect(offencesIn([
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const j = await r.json();',
      'const { ok: envOk } = (j ?? {}) as any;',
      'if (envOk === false) { setError("failed"); return; }',
    ])).toEqual([]);
    // `r.ok` is the HTTP status, not the envelope — it must stay readable.
    expect(offencesIn([
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const j = await r.json();',
      'if (!r.ok) { setError(`HTTP ${r.status}`); return; }',
    ])).toEqual([]);
  });
});
