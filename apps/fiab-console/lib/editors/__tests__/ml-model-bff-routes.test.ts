/**
 * ml-model BFF route existence + realness test (per .claude/rules/no-vaporware.md).
 *
 * Verifies every ml-model route the editor fetches exists on disk AND wires a
 * real backend: the binding resolver (@/lib/azure/model-binding) + the AML REST
 * client (@/lib/azure/foundry-client). A stub returning `{}` would not match.
 *
 * Also asserts the GET [id] route resolves the BINDING (resolveModelBinding) and
 * does NOT pass the raw route id straight into getModel — the exact 404 bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ML_MODEL_ROOT = resolve(__dirname, '..', '..', '..', 'app', 'api', 'items', 'ml-model');

const REQUIRED_ROUTES: Array<{ sub: string; file: string }> = [
  { sub: '', file: 'route.ts' },
  { sub: '[id]', file: 'route.ts' },
  { sub: '[id]/bind', file: 'route.ts' },
  { sub: '[id]/endpoint', file: 'route.ts' },
  { sub: '[id]/register', file: 'route.ts' },
  { sub: '[id]/stage', file: 'route.ts' },
];

function readRoute(sub: string, file: string): string | null {
  const path = sub ? join(ML_MODEL_ROOT, sub, file) : join(ML_MODEL_ROOT, file);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

describe('ml-model BFF routes — exist + real backend', () => {
  for (const r of REQUIRED_ROUTES) {
    const label = r.sub || '(collection)';
    it(`${label} exists and imports a real backend client`, () => {
      const src = readRoute(r.sub, r.file);
      expect(src, `route file for ${label} should exist`).not.toBeNull();
      const real = /from '@\/lib\/azure\/(foundry-client|model-binding)'/.test(src!);
      expect(real, `${label} should import foundry-client / model-binding`).toBe(true);
      // No empty-stub responses.
      expect(/return NextResponse\.json\(\{\}\)/.test(src!)).toBe(false);
    });
  }

  it('GET [id] resolves the binding (does NOT use the route id as the model name)', () => {
    const src = readRoute('[id]', 'route.ts')!;
    expect(src).toMatch(/resolveModelBinding/);
    // getModel must be called with the bound name, never the raw `id` param.
    expect(/getModel\(\s*id\s*\)/.test(src)).toBe(false);
    expect(src).toMatch(/getModel\(\s*binding\.modelName/);
  });

  it('bind route lists workspaces + models and persists the binding', () => {
    const src = readRoute('[id]/bind', 'route.ts')!;
    expect(src).toMatch(/listMlWorkspaces/);
    expect(src).toMatch(/listModels/);
    expect(src).toMatch(/persistModelBinding/);
  });

  it('register + endpoint routes resolve the binding before acting', () => {
    const reg = readRoute('[id]/register', 'route.ts')!;
    const ep = readRoute('[id]/endpoint', 'route.ts')!;
    expect(reg).toMatch(/resolveModelBinding/);
    expect(reg).toMatch(/registerModelVersion/);
    expect(ep).toMatch(/resolveModelBinding/);
    expect(ep).toMatch(/createOnlineEndpoint/);
    expect(ep).toMatch(/createOnlineDeployment/);
  });

  it('stage route transitions MLflow stages via the real MLflow REST client', () => {
    const src = readRoute('[id]/stage', 'route.ts')!;
    expect(src).toMatch(/resolveModelBinding/);
    // Real MLflow transition-stage backend, not a stub.
    expect(src).toMatch(/transitionModelVersionStage/);
    expect(src).toMatch(/from '@\/lib\/azure\/mlflow-client'/);
    expect(/return NextResponse\.json\(\{\}\)/.test(src)).toBe(false);
  });

  it('register route has a register-from-run (MLflow lineage) branch', () => {
    const src = readRoute('[id]/register', 'route.ts')!;
    expect(src).toMatch(/createMlflowModelVersion/);
    expect(src).toMatch(/runId/);
  });
});
