/**
 * #3528 + #3167 — the UAT graders' own contract.
 *
 * These specs run against the live estate, so nothing in CI executes them. That
 * is exactly why the LOGIC inside them needs its own assertions: both defects
 * this file covers were live for weeks precisely because the code that decides
 * whether a UAT run is red was itself unmeasured.
 *
 *  #3528 — `use-case-apps-uat.uat.ts` collected `consoleErrors` from
 *          `captureFailures` and every `expect()` in the file ignored them,
 *          while its header promised the editor "renders without a crash or
 *          console error". A React hydration failure (#418) on /apps/[id] —
 *          which leaves the Fluent workspace Dropdown mounted but click-dead —
 *          therefore produced a green run.
 *  #3167 — `catalog-uat.uat.ts` waited a fixed 2.5s for hydration while
 *          `deep-functional-uat.uat.ts` polled to 12s. The 20 F-grades filed
 *          against the catalog were that 9.5-second gap, not 20 broken editors.
 *
 * The source-text assertions at the bottom are drift guards, not style checks:
 * each names a specific way the fix silently comes undone.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  REAUTH_BEACONS, isReauthGate, isHydrationError,
  realConsoleErrors, reauthGatedErrors, formatConsoleErrors,
} from '../e2e/_lib/console-error-filters';

const E2E = path.resolve(__dirname, '..', 'e2e');
const read = (rel: string) => fs.readFileSync(path.join(E2E, rel), 'utf8');

/** Verbatim shapes `captureFailures` records, from the live-run transcripts. */
const HYDRATION_418 = '[EXCEPTION] Minified React error #418; visit https://react.dev/errors/418 @ https://csa-loom.limitlessdata.ai/apps/x:1';
const REAUTH_401 = 'Failed to load resource: the server responded with a status of 401 () @ https://csa-loom.limitlessdata.ai/api/auth/refresh:0';
const RUM_401 = 'Failed to load resource: the server responded with a status of 401 () @ https://csa-loom.limitlessdata.ai/api/telemetry/rum:0';
const REAL_500 = 'Failed to load resource: the server responded with a status of 500 () @ https://csa-loom.limitlessdata.ai/api/apps/x/install:0';
const SIGNIN_401 = 'Failed to load resource: the server responded with a status of 401 () @ https://csa-loom.limitlessdata.ai/api/items/lakehouse/abc:0';

describe('isReauthGate (#3528)', () => {
  it('suppresses a 401 on the two known background beacons', () => {
    expect(isReauthGate(REAUTH_401)).toBe(true);
    expect(isReauthGate(RUM_401)).toBe(true);
  });

  it('does NOT suppress a 401 anywhere else — the sign-in outage must stay red', () => {
    // A blanket "ignore 401s" would hide #2191 (AADSTS7000215), which is the
    // failure the journeys exist to catch. This is the load-bearing negative.
    expect(isReauthGate(SIGNIN_401)).toBe(false);
  });

  it('does NOT suppress a non-401 on a beacon path', () => {
    expect(isReauthGate(REAUTH_401.replace('401', '503'))).toBe(false);
  });

  it('names exactly the two beacons — widening this list needs a deliberate edit', () => {
    expect(REAUTH_BEACONS).toEqual(['/api/auth/refresh', '/api/telemetry/rum']);
  });
});

describe('isHydrationError (#3528)', () => {
  it('matches the MINIFIED #418 the production console actually prints', () => {
    // Production React prints only the minified form. A matcher written against
    // the friendly dev prose would never fire on the deployed estate — which is
    // the whole failure mode here.
    expect(isHydrationError(HYDRATION_418)).toBe(true);
  });

  it('matches the sibling hydration codes and the dev-build prose', () => {
    expect(isHydrationError('Minified React error #423')).toBe(true);
    expect(isHydrationError('Minified React error #425')).toBe(true);
    expect(isHydrationError('Warning: Text content did not match. Hydration failed')).toBe(true);
  });

  it('does not fire on an unrelated React error or a plain 500', () => {
    expect(isHydrationError('Minified React error #310')).toBe(false);
    expect(isHydrationError(REAL_500)).toBe(false);
  });
});

describe('the assertion population (#3528)', () => {
  const CAPTURED = [REAUTH_401, HYDRATION_418, RUM_401, REAL_500];

  it('leaves the hydration error and the 500 in the failing set', () => {
    const real = realConsoleErrors(CAPTURED);
    expect(real).toEqual([HYDRATION_418, REAL_500]);
    expect(real.filter(isHydrationError)).toEqual([HYDRATION_418]);
  });

  it('reports the gated beacons rather than dropping them', () => {
    expect(reauthGatedErrors(CAPTURED)).toEqual([REAUTH_401, RUM_401]);
  });

  it('formats the FULL list, untruncated, tagging each class', () => {
    const out = formatConsoleErrors(CAPTURED);
    // Truncating evidence you already collected is a self-inflicted unknown —
    // on 2026-08-09 a two-day-red journey's only record was cut mid-error.
    for (const e of CAPTURED) expect(out).toContain(e);
    expect(out).toContain('(reauth-gated)');
    expect(out).toContain('(HYDRATION)');
  });

  it('says "(none)" rather than an empty string for a clean run', () => {
    expect(formatConsoleErrors([])).toBe('(none)');
  });
});

describe('use-case-apps-uat asserts what it collects (#3528)', () => {
  const src = read('use-case-apps-uat.uat.ts');

  it('asserts on the console errors it captures', () => {
    expect(src).toMatch(/expect\(\s*realErrors,/);
    expect(src).toMatch(/toHaveLength\(0\)/);
  });

  it('names a hydration regression separately, so it self-identifies', () => {
    expect(src).toContain('hydrationErrors');
    expect(src).toContain('isHydrationError');
  });

  it('uses the SHARED filter rather than re-declaring one', () => {
    expect(src).toContain("from './_lib/uat'");
    expect(src).toContain('realConsoleErrors');
    // A local re-declaration is how the two specs drifted in the first place.
    expect(src).not.toMatch(/const\s+isReauthGate\s*=/);
  });
});

describe('both catalog graders share ONE readiness helper (#3167)', () => {
  const catalog = read('catalog-uat.uat.ts');
  const deep = read('deep-functional-uat.uat.ts');

  it('catalog-uat no longer guesses a fixed hydration duration', () => {
    // THE regression this guard exists for: the 2.5s wait against the sibling's
    // 12s poll is the entire 26-F-grade disagreement.
    expect(catalog).not.toContain('waitForTimeout(2500)');
  });

  it('both import waitForEditorInteractive from the same module', () => {
    for (const [name, src] of [['catalog-uat', catalog], ['deep-functional', deep]] as const) {
      expect(src, `${name} must import the shared readiness helper`)
        .toContain("from './_lib/editor-readiness'");
      expect(src, `${name} must call the shared readiness helper`)
        .toContain('waitForEditorInteractive(page, t0)');
    }
  });

  it('neither spec re-implements the poll inline', () => {
    for (const [name, src] of [['catalog-uat', catalog], ['deep-functional', deep]] as const) {
      expect(src, `${name} re-implements the readiness poll instead of importing it`)
        .not.toMatch(/locator\('main button'\)\s*\.first\(\)\s*\.waitFor/);
    }
  });

  it('catalog-uat records ttiMs as a CSV column, in header order', () => {
    // "TTI > 2.5s on 26 editors" was the real finding and it was unreportable
    // because no per-slug number was ever written down.
    expect(catalog).toContain('ttiMs');
    const header = catalog.match(/const CSV_HEADER = '([^']+)'/)?.[1];
    expect(header, 'CSV_HEADER not found').toBeTruthy();
    const cols = header!.split(',');
    expect(cols).toContain('ttiMs');
    // The row builder must emit the columns in the header's order or every
    // downstream parse silently shifts by one.
    const rowBody = catalog.match(/function csvRow\(v: ItemVerdict\): string \{([\s\S]*?)\n\}/)?.[1];
    expect(rowBody, 'csvRow not found').toBeTruthy();
    const emitted = Array.from(rowBody!.matchAll(/v\.(\w+)/g)).map((m) => m[1]);
    expect(emitted).toEqual(cols);
  });
});
