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
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeoMapEditor } from '../geo-editors';
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
});

/**
 * Source guard. A `j.ok` read within 12 lines after a cosmos-items GET/PATCH
 * fetch is the exact defect shape; only the explicitly-false form
 * (`j?.ok === false`, which correctly ignores `undefined`) and the `!== false`
 * form are permitted.
 */
describe('cosmos-items envelope — source guard (#3878)', () => {
  const FILES = [
    'geo-editors.tsx',
    'graph-editors.tsx',
    'data-product-editors.tsx',
    join('apim-editors', 'data-product-editor.tsx'),
  ];

  /** A `j.ok` read that treats `undefined` as a failure. */
  const TRUTHY_OK = /(?:^|[^!=<>])\b(?:!)?j\??\.ok\b(?!\s*(?:===|!==))/;
  /** A fetch at the item-scoped cosmos-items route (the BARE ones). */
  const COSMOS_ITEM_FETCH = /\/api\/cosmos-items\/\$\{[^}]*\}\/\$\{|\/api\/cosmos-items\/[a-z-]+\/\$\{/;
  /**
   * Comments are not code. This guard's own explanatory comments quote the
   * defective expression verbatim, so scanning raw lines would make the guard
   * fail on its own documentation — a guard that cannot survive being described
   * is not measuring the source.
   */
  const isComment = (l: string) => /^\s*(?:\/\/|\/\*|\*)/.test(l);

  for (const rel of FILES) {
    it(`${rel} has no truthy j.ok read near a cosmos-items item fetch`, () => {
      const lines = readFileSync(join(EDITORS_DIR, rel), 'utf8').split(/\r?\n/);
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (isComment(lines[i]) || !COSMOS_ITEM_FETCH.test(lines[i])) continue;
        for (let k = i + 1; k <= Math.min(i + 20, lines.length - 1); k++) {
          if (!isComment(lines[k]) && TRUTHY_OK.test(lines[k])) offenders.push(`${rel}:${k + 1}: ${lines[k].trim()}`);
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }

  it('the guard actually detects the pre-fix shape (positive control)', () => {
    const preFix = [
      "const r = await clientFetch(`/api/cosmos-items/${slug}/${id}`);",
      'const j = await r.json();',
      'if (j?.ok && j.item?.state) { setState(j.item.state); }',
    ];
    let hit = false;
    for (let i = 0; i < preFix.length; i++) {
      if (!COSMOS_ITEM_FETCH.test(preFix[i])) continue;
      for (let k = i + 1; k < preFix.length; k++) if (TRUTHY_OK.test(preFix[k])) hit = true;
    }
    expect(hit, 'the guard would not have caught the defect it exists for').toBe(true);
  });

  it('the guard permits the CORRECT explicitly-false forms (negative control)', () => {
    expect(TRUTHY_OK.test('if (!r.ok || j?.ok === false) { setError(...); }')).toBe(false);
    expect(TRUTHY_OK.test('const ok = r.ok && j?.ok !== false;')).toBe(false);
  });
});
