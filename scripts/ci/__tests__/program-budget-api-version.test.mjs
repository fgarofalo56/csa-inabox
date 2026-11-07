// Gov run 42325936769: `loom-program-budget` failed InvalidResourceType - the
// Microsoft.Consumption 'Budgets' type does not exist at api version 2024-08-01 in
// Azure Government (supported there: ...2023-05-01, 2023-11-01, 2026-06-01).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'platform/fiab/bicep/modules/admin-plane/program-budget.bicep'), 'utf8');

// The API versions the Gov RP listed as supported for Microsoft.Consumption/budgets (run 42325936769).
const GOV_SUPPORTED = ['2023-03-01', '2023-05-01', '2023-11-01', '2026-06-01'];

test('program-budget declares a Microsoft.Consumption/budgets api version Azure Government supports', () => {
  const m = SRC.match(/resource\s+\w+\s+'Microsoft\.Consumption\/budgets@([0-9-]+)'/);
  assert.ok(m, 'no Microsoft.Consumption/budgets resource found in program-budget.bicep');
  // Breaks on 2024-08-01 (the value that failed in Gov), and on any other version not in the Gov list.
  assert.ok(GOV_SUPPORTED.includes(m[1]), `api version ${m[1]} is not in the Gov-supported list ${GOV_SUPPORTED.join(', ')}`);
});
