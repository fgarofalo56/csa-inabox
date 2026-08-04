/**
 * AML control-plane api-version — the constant, and the ban on re-introducing a
 * literal (readiness 97→100).
 *
 * THE BUG THIS EXISTS TO CATCH
 * ---------------------------
 * `lib/admin/health-probes.ts` `probeAml()` hand-wrote `?api-version=2024-09-01`
 * while `lib/azure/aml-client.ts` used `2024-10-01`. `2024-09-01` is not a
 * version ARM publishes for `Microsoft.MachineLearningServices/workspaces` — the
 * real list goes … 2024-04-01, 2024-07-01-preview, 2024-10-01,
 * 2024-10-01-preview, 2025-01-01-preview … (2025-09-01 exists, which is the
 * likely origin of the typo). ARM answered the probe's GET with a 400, the
 * probe's catch classified any non-401/403/404 as `warn`, and
 * `lib/admin/readiness.ts` maps `warn` → capability state `'partial'`. That one
 * token was the entire reason `/admin/readiness` reported "1 partial".
 *
 * WHY THE EXISTING TEST DID NOT CATCH IT
 * --------------------------------------
 * `lib/admin/__tests__/health-depth-probes.test.ts` asserts `probe-aml` passes,
 * but it MOCKS `armGet` — so the mock answered 200 to a URL real ARM rejects.
 * The fixture modelled the code instead of the dependency, which is the guard
 * class this repo keeps re-finding. A mocked-transport test therefore CANNOT
 * verify an api-version; the only things that can are (a) pinning the constant
 * against ARM's published set and (b) proving no caller carries its own literal.
 * Both are asserted below, by reading the real source text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AML_ARM_API_VERSION } from '../resolve-aml-target';

const LIB = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(LIB, rel), 'utf8');

/**
 * Every api-version ARM itself reports for
 * `Microsoft.MachineLearningServices/workspaces`.
 *
 * NOT copied from a doc page — read back from LIVE Commercial ARM on
 * 2026-08-04, which is the only source that cannot be stale or paraphrased:
 *
 *   az rest --method get --url \
 *     "https://management.azure.com/<workspace>?api-version=2024-09-01"
 *   -> 400 NoRegisteredProviderFound: "No registered resource provider found
 *      for location 'centralus' and API version '2024-09-01' for type
 *      'workspaces'. The supported api-versions are '… 2024-04-01,
 *      2024-07-01-preview, 2024-10-01-preview, 2024-10-01, 2025-01-01-preview,
 *      … 2026-05-15-preview'."
 *
 *   same URL with ?api-version=2024-10-01
 *   -> 200, properties.provisioningState = "Succeeded"
 *
 * That error IS the bug: a 400 is neither 401/403 nor 404, so `probeAml`'s
 * catch classified it `warn`, and readiness.ts maps `warn` to `'partial'`.
 *
 * Deliberately an ALLOWLIST of real versions rather than a denylist containing
 * the one known-bad value: a denylist would pass for `2024-08-01`,
 * `2024-11-01`, or any other plausible-looking string ARM also rejects.
 */
const ARM_PUBLISHED_WORKSPACE_API_VERSIONS = new Set([
  '2019-11-01', '2020-03-01', '2023-04-01', '2023-04-01-preview',
  '2023-06-01-preview', '2023-08-01-preview', '2023-10-01',
  '2024-01-01-preview', '2024-04-01', '2024-04-01-preview',
  '2024-07-01-preview', '2024-10-01', '2024-10-01-preview',
  '2025-01-01-preview', '2025-04-01', '2025-04-01-preview', '2025-06-01',
  '2025-07-01-preview', '2025-09-01', '2025-10-01-preview', '2025-12-01',
  '2026-01-15-preview', '2026-03-01', '2026-03-15-preview', '2026-05-01',
  '2026-05-15-preview',
]);

describe('AML_ARM_API_VERSION', () => {
  it('is a version ARM actually publishes for MachineLearningServices/workspaces', () => {
    // The original bug in one assertion: '2024-09-01' is not in this set.
    expect(ARM_PUBLISHED_WORKSPACE_API_VERSIONS.has(AML_ARM_API_VERSION)).toBe(true);
  });

  it('is a stable GA version, not a preview', () => {
    expect(AML_ARM_API_VERSION).not.toMatch(/-preview$/);
  });

  it('matches the shape ARM accepts', () => {
    expect(AML_ARM_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('no caller re-introduces its own MachineLearningServices api-version literal', () => {
  // The drift is only impossible while every caller reads the constant. If a
  // future edit pastes a literal back into either file, this fails — which is
  // exactly what did not happen when probeAml() was first written.
  const CALLERS = ['admin/health-probes.ts', 'azure/aml-client.ts'];

  for (const rel of CALLERS) {
    it(`${rel} builds AML ARM URLs from AML_ARM_API_VERSION, not a literal`, () => {
      const src = read(rel);

      // Find every `api-version=<literal>` (an inline literal, not `${...}`)
      // that sits on a line also mentioning AML/MachineLearningServices.
      const offenders: string[] = [];
      for (const line of src.split('\n')) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue; // prose
        if (!/aml|machinelearningservices/i.test(line)) continue;
        const m = line.match(/api-version=(\d{4}-\d{2}-\d{2}[a-z-]*)/i);
        if (m) offenders.push(m[0]);
      }
      expect(offenders).toEqual([]);
    });
  }

  it('aml-client.ts derives ML_API from the shared constant', () => {
    const src = read('azure/aml-client.ts');
    expect(src).toMatch(/const ML_API = AML_ARM_API_VERSION;/);
  });

  it('health-probes.ts probeAml interpolates the shared constant', () => {
    const src = read('admin/health-probes.ts');
    expect(src).toMatch(/api-version=\$\{AML_ARM_API_VERSION\}/);
  });
});
