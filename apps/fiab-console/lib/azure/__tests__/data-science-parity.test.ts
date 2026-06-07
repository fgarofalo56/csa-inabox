/**
 * Data Science parity-doc + bicep-sync validation (per .claude/rules/ui-parity.md
 * and .claude/rules/no-vaporware.md).
 *
 * Asserts:
 *  1. docs/fiab/parity/data-science-notebook.md has ZERO ❌ (missing) rows and no
 *     "stub"/"coming soon" banners — every coverage row is ✅ built or ⚠️ honest-gate.
 *  2. The ml-experiment BFF routes the parity doc claims exist on disk and import a
 *     real backend (mlflow-client / foundry-client) — not an empty stub.
 *  3. The bicep sync the doc + workload claim is actually present:
 *       - ai-foundry.bicep grants the Console UAMI AzureML Data Scientist on the hub
 *       - admin-plane/main.bicep wires LOOM_AML_WORKSPACE / LOOM_AML_RG
 *       - commercial-full.bicepparam enables agentFoundryEnabled (AOAI for AI Functions)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CONSOLE_ROOT = resolve(__dirname, '..', '..', '..');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

function read(...parts: string[]): string {
  return readFileSync(resolve(...parts), 'utf-8');
}

describe('data-science parity doc — zero missing / stub rows', () => {
  const doc = read(REPO_ROOT, 'docs', 'fiab', 'parity', 'data-science-notebook.md');

  it('contains no ❌ (MISSING) coverage rows', () => {
    // The glyph is allowed in prose ("Zero ❌"); a MISSING row is a table line
    // (starts with "|") whose status cell is ❌. Assert no such row exists.
    const missingRows = doc
      .split('\n')
      .filter((l) => l.trimStart().startsWith('|') && l.includes('❌'));
    expect(missingRows).toEqual([]);
  });

  it('declares zero ❌ explicitly', () => {
    expect(doc).toMatch(/Zero ❌/);
  });

  it('has no stub / coming-soon / deferred banners', () => {
    expect(doc).not.toMatch(/coming soon/i);
    expect(doc).not.toMatch(/\bstub banner/i);
    expect(doc).not.toMatch(/deferred to v\d/i);
  });

  it('covers the ml-model, ml-experiment, MLflow, and AI Functions surfaces', () => {
    expect(doc).toMatch(/ML Model/);
    expect(doc).toMatch(/ML Experiment/);
    expect(doc).toMatch(/MLflow runs/);
    expect(doc).toMatch(/AI Functions/);
  });

  it('documents the Azure-native, no-Fabric default path', () => {
    expect(doc).toMatch(/no-fabric-dependency/);
    expect(doc).toMatch(/LOOM_DEFAULT_FABRIC_WORKSPACE/);
  });
});

describe('ml-experiment BFF routes — exist + real backend', () => {
  const EXP_ROOT = join(CONSOLE_ROOT, 'app', 'api', 'items', 'ml-experiment');
  const ROUTES = [
    'route.ts',
    join('[id]', 'route.ts'),
    join('[id]', 'runs', 'route.ts'),
    join('submit', 'route.ts'),
    join('[id]', 'register', 'route.ts'),
  ];

  for (const r of ROUTES) {
    it(`${r} exists`, () => {
      expect(existsSync(join(EXP_ROOT, r)), `${r} should exist`).toBe(true);
    });
  }

  it('list route wires foundry-client listJobs (real ARM REST)', () => {
    const src = readFileSync(join(EXP_ROOT, 'route.ts'), 'utf-8');
    expect(src).toMatch(/listJobs/);
    expect(/return NextResponse\.json\(\[\]\)/.test(src)).toBe(false);
  });

  it('runs route wires mlflow-client (searchRuns) — real AML MLflow tracking', () => {
    const src = readFileSync(join(EXP_ROOT, '[id]', 'runs', 'route.ts'), 'utf-8');
    expect(src).toMatch(/mlflow-client|searchRuns/);
  });
});

describe('data-science bicep sync — role grant + env + AOAI', () => {
  it('ai-foundry.bicep grants the Console UAMI AzureML Data Scientist on the hub', () => {
    const src = read(
      REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'ai-foundry.bicep',
    );
    expect(src).toMatch(/hubConsoleDataScientist/);
    expect(src).toMatch(/scope: foundryHub/);
    // bound to the Console UAMI principal, role = AzureML Data Scientist
    expect(src).toMatch(/principalId: consolePrincipalId/);
    expect(src).toMatch(/f6c7c914-8db3-469d-8ca1-694a8f32e121/);
  });

  it('admin-plane/main.bicep wires LOOM_AML_WORKSPACE / LOOM_AML_RG env vars', () => {
    const src = read(
      REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'main.bicep',
    );
    expect(src).toMatch(/name: 'LOOM_AML_WORKSPACE'/);
    expect(src).toMatch(/name: 'LOOM_AML_RG'/);
    expect(src).toMatch(/param loomAmlWorkspace string/);
  });

  it('top-level main.bicep threads agentFoundryEnabled + AML params to adminPlane', () => {
    const src = read(REPO_ROOT, 'platform', 'fiab', 'bicep', 'main.bicep');
    expect(src).toMatch(/param agentFoundryEnabled bool/);
    expect(src).toMatch(/agentFoundryEnabled: agentFoundryEnabled/);
    expect(src).toMatch(/loomAmlWorkspace: loomAmlWorkspace/);
  });

  it('commercial-full.bicepparam enables agentFoundryEnabled (AOAI for AI Functions)', () => {
    const src = read(
      REPO_ROOT, 'platform', 'fiab', 'bicep', 'params', 'commercial-full.bicepparam',
    );
    expect(src).toMatch(/param agentFoundryEnabled = true/);
  });
});
