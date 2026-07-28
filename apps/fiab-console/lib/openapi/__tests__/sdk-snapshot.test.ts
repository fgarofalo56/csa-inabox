import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiSpec } from '../spec';

/**
 * B-N19b — pin `sdk/openapi.json` to `buildOpenApiSpec('')`.
 *
 * `sdk/openapi.json` is the artifact BOTH first-party SDKs are generated from:
 * the `csa-loom` Python client (`sdk/python/csa-loom`) and the Go Terraform
 * provider (`sdk/terraform-provider-loom`). If the API contract changes and the
 * snapshot is not re-dumped, those SDKs silently ship a stale surface.
 *
 * This assertion makes that impossible to merge: any edit to `spec.ts` that is
 * not followed by `node sdk/scripts/dump-openapi.mjs` fails the console test
 * suite — the gate developers already run — not just the SDK CI lane.
 */

// lib/openapi/__tests__ -> lib/openapi -> lib -> apps/fiab-console -> apps -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SNAPSHOT = path.join(REPO_ROOT, 'sdk', 'openapi.json');

describe('sdk/openapi.json snapshot (B-N19b)', () => {
  it('exists — the SDK generators read it', () => {
    expect(fs.existsSync(SNAPSHOT), `${SNAPSHOT} is missing; run: node sdk/scripts/dump-openapi.mjs`).toBe(true);
  });

  it('is byte-identical to buildOpenApiSpec("")', () => {
    const expected = JSON.stringify(buildOpenApiSpec(''), null, 2) + '\n';
    // `.gitattributes` pins sdk/** to LF; normalising here keeps the assertion
    // about the CONTRACT rather than about a checkout's line endings.
    const actual = fs.readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n');
    expect(
      actual,
      'The API contract changed but sdk/openapi.json was not re-dumped, so the Python SDK and the ' +
        'Terraform provider are generated from a stale document.\n' +
        'Fix: node sdk/scripts/dump-openapi.mjs && python sdk/python/csa-loom/scripts/generate_client.py',
    ).toBe(expected);
  });

  it('carries the relative server entry so the snapshot is cloud-agnostic', () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    // A Commercial host baked in here would make every generated Government
    // client wrong — the same defect class the cloud-endpoint-literal ratchet guards.
    expect(snapshot.servers[0].url).toBe('/');
  });

  it('every operation the Terraform provider declares still exists in the document', () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const endpointsGo = fs.readFileSync(
      path.join(REPO_ROOT, 'sdk', 'terraform-provider-loom', 'internal', 'client', 'endpoints.go'),
      'utf8',
    );

    const declared = [...endpointsGo.matchAll(/OperationID:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);

    const documented = new Set<string>();
    for (const item of Object.values(snapshot.paths as Record<string, Record<string, unknown>>)) {
      for (const [verb, op] of Object.entries(item)) {
        if (verb === 'parameters') continue;
        const operationId = (op as { operationId?: string } | null)?.operationId;
        if (operationId) documented.add(operationId);
      }
    }

    for (const operationId of declared) {
      expect(documented.has(operationId), `terraform-provider-loom calls ${operationId}, which the API no longer documents`).toBe(
        true,
      );
    }
  });
});
