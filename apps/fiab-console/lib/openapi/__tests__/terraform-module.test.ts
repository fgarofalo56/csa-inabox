import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiSpec } from '../spec';

// tools/terraform lives at the repo root, four levels up from this test dir.
const TF_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', 'tools', 'terraform');

function read(rel: string): string {
  return fs.readFileSync(path.join(TF_ROOT, rel), 'utf8');
}

/** A minimal HCL sanity check: braces + brackets balance (parse smoke test). */
function bracesBalance(src: string): boolean {
  let curly = 0;
  let square = 0;
  for (const ch of src) {
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    if (curly < 0 || square < 0) return false;
  }
  return curly === 0 && square === 0;
}

describe('Terraform module (BR-TERRAFORM)', () => {
  const files = [
    'modules/loom-workspace/main.tf',
    'modules/loom-workspace/variables.tf',
    'modules/loom-workspace/outputs.tf',
    'modules/loom-workspace/versions.tf',
    'modules/loom-item/main.tf',
    'modules/loom-item/variables.tf',
    'modules/loom-item/outputs.tf',
    'modules/loom-item/versions.tf',
    'examples/workspace-and-item/main.tf',
    'examples/workspace-and-item/variables.tf',
    'examples/workspace-and-item/outputs.tf',
  ];

  it('every .tf file exists and parses (balanced braces)', () => {
    for (const f of files) {
      const src = read(f);
      expect(src.length, `${f} is empty`).toBeGreaterThan(0);
      expect(bracesBalance(src), `${f} has unbalanced braces/brackets`).toBe(true);
    }
  });

  it('modules declare the restapi provider requirement', () => {
    for (const m of ['loom-workspace', 'loom-item']) {
      const v = read(`modules/${m}/versions.tf`);
      expect(v).toContain('Mastercard/restapi');
      expect(v).toContain('required_providers');
    }
  });

  it('the example wires both modules + configures the provider with a bearer token', () => {
    const main = read('examples/workspace-and-item/main.tf');
    expect(main).toContain('module "workspace"');
    expect(main).toContain('module "lakehouse"');
    expect(main).toContain('source = "../../modules/loom-workspace"');
    expect(main).toContain('source = "../../modules/loom-item"');
    expect(main).toContain('provider "restapi"');
    expect(main).toContain('Bearer ${var.loom_token}');
    // The item is created in the workspace the workspace module returns.
    expect(main).toContain('module.workspace.id');
  });

  it('the workspace module targets the real workspace routes', () => {
    const main = read('modules/loom-workspace/main.tf');
    expect(main).toContain('/api/workspaces');
    expect(main).toContain('create_method = "POST"');
    expect(main).toContain('update_method = "PATCH"');
  });

  it('the item module uses the create vs read/update/delete path split', () => {
    const main = read('modules/loom-item/main.tf');
    expect(main).toContain('create_path');
    expect(main).toContain('/api/workspaces/${var.workspace_id}/items');
    expect(main).toContain('/api/cosmos-items/${var.item_type}');
  });

  it('module variables stay in sync with the OpenAPI create schemas', () => {
    const spec = buildOpenApiSpec('');
    const schemas = (spec.components as any).schemas;

    // Workspace: every required CreateWorkspace field is a module variable.
    const wsVars = read('modules/loom-workspace/variables.tf');
    for (const field of schemas.CreateWorkspace.required as string[]) {
      expect(wsVars, `loom-workspace missing var ${field}`).toContain(`variable "${field}"`);
    }

    // Item: CreateItem uses itemType/displayName; the module exposes them as
    // item_type / display_name (snake_case) — assert those are present.
    const itemVars = read('modules/loom-item/variables.tf');
    expect(itemVars).toContain('variable "item_type"');
    expect(itemVars).toContain('variable "display_name"');
    expect(itemVars).toContain('variable "workspace_id"');
  });

  it('the committed OpenAPI snapshot matches the live spec', () => {
    const snapshotPath = path.join(TF_ROOT, 'openapi.snapshot.json');
    expect(fs.existsSync(snapshotPath), 'run `node tools/terraform/generate-schemas.mjs`').toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const live = buildOpenApiSpec('');
    // Compare the stable structural surface (paths + schema names), not volatile
    // ordering — a drift here means the generator must be re-run.
    expect(Object.keys(snapshot.paths).sort()).toEqual(Object.keys(live.paths).sort());
    expect(Object.keys(snapshot.components.schemas).sort()).toEqual(
      Object.keys((live.components as any).schemas).sort(),
    );
  });
});
