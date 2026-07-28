/**
 * B-U12 regression lock — new-item-dialog token hygiene + activity-catalog
 * dead-field removal.
 *
 * 1. `new-item-dialog.tsx` is on every user's create path and used to carry a
 *    hard-coded px/radius cluster (gap:'12px', borderRadius:'6px',
 *    padding:'12px', gap:'6px', fontSize:'14px', …). web3-ui.md forbids raw
 *    px/hex where a Loom/Fluent token exists. This test asserts the styling
 *    props in the file's `makeStyles` block carry NO raw px value and the file
 *    carries no hex colour, so the cluster cannot silently come back.
 *
 *    Layout TRACK sizes (`maxWidth`, `minWidth`, `minHeight`, grid template
 *    columns) are deliberately NOT covered: Fluent ships no token for an
 *    arbitrary dialog/track dimension. Those are the U11 `TileGrid` drain's
 *    scope, not U12's.
 *
 * 2. `activity-catalog.ts` carried dead `color`/`fg` hex fields on all 43
 *    entries that nothing consumed — a latent dark-on-dark trap if ever wired
 *    (accent colours must go through the item-visual registry /
 *    `readableAccent`, never a raw hex). This test asserts they stay deleted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ACTIVITY_CATALOG } from '../pipeline/activity-catalog';

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIALOG = path.join(APP_ROOT, 'lib', 'components', 'new-item-dialog.tsx');
const CATALOG = path.join(APP_ROOT, 'lib', 'components', 'pipeline', 'activity-catalog.ts');

/** Spacing / sizing / typography props that MUST resolve to a token. */
const TOKENED_PROPS = [
  'gap', 'columnGap', 'rowGap',
  'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'borderRadius', 'fontSize', 'fontWeight',
];

describe('B-U12 — new-item-dialog token hygiene', () => {
  const src = readFileSync(DIALOG, 'utf8');

  it('declares no raw px value on a tokened style prop', () => {
    const re = new RegExp(`\\b(${TOKENED_PROPS.join('|')})\\s*:\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    const offenders: string[] = [];
    for (const m of src.matchAll(re)) {
      // A quoted value is only OK when it is a token interpolation
      // (`${tokens.x} ${tokens.y}`) — anything with a bare px/number is not.
      if (/\d/.test(m[3]) && !m[3].includes('${tokens.')) offenders.push(m[0]);
    }
    expect(offenders, `raw px on tokened props: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('declares no numeric literal on a tokened style prop', () => {
    const re = new RegExp(`\\b(${TOKENED_PROPS.join('|')})\\s*:\\s*(\\d+)(?=\\s*[,}\\n])`, 'g');
    const offenders = [...src.matchAll(re)].map((m) => m[0]);
    expect(offenders, `numeric literals: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('carries no hard-coded hex colour', () => {
    const offenders = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(offenders, `hex colours: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('routes the item-card category caption through a styles class, not an inline color', () => {
    expect(src).toContain('cardCategory');
    expect(src).not.toMatch(/style=\{\{\s*color:/);
  });
});

describe('B-U12 — activity-catalog dead color/fg fields deleted', () => {
  it('no catalog entry carries a color or fg field', () => {
    const withDeadFields = ACTIVITY_CATALOG.filter(
      (d) => 'color' in (d as object) || 'fg' in (d as object),
    ).map((d) => d.key);
    expect(withDeadFields).toEqual([]);
  });

  it('the catalog source carries no hard-coded hex colour', () => {
    const src = readFileSync(CATALOG, 'utf8');
    const offenders = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(offenders, `hex colours: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('still resolves every activity definition (nothing consumed the deleted fields)', () => {
    expect(ACTIVITY_CATALOG.length).toBeGreaterThan(40);
    for (const d of ACTIVITY_CATALOG) {
      expect(d.key, 'every entry keeps its palette key').toBeTruthy();
      expect(typeof d.build(`${d.namePrefix}1`).name).toBe('string');
    }
  });
});
