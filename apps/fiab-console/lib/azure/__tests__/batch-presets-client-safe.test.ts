import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VM_SIZE_PRESETS, AUTOSCALE_PRESETS, autoScaleFormulaFor, classifyBatchGate } from '../batch-presets';

/**
 * Regression guard for the Batch pool page crash ("ManagedIdentityCredential is
 * not supported in the browser"): the batch-pool editor is a client component and
 * imports these presets/helpers, so this module MUST stay credential-free. If any
 * server-only import creeps back in, the whole batch-client credential lands in
 * the browser bundle and the page crashes at render again.
 */
describe('batch-presets is client-safe (no server-only imports)', () => {
  it('has no @azure/identity / *-credential import in its source', () => {
    const src = readFileSync(join(__dirname, '..', 'batch-presets.ts'), 'utf8');
    // strip block + line comments so the docstring mentioning the class doesn't trip this
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/from\s+['"]@azure\/identity['"]/);
    expect(code).not.toMatch(/from\s+['"]@\/lib\/azure\/aca-managed-identity['"]/);
    expect(code).not.toMatch(/\bimport\b/); // pure data/functions — expect zero imports
  });

  it('exports the presets + pure helpers the editor needs', () => {
    expect(VM_SIZE_PRESETS.length).toBeGreaterThan(0);
    expect(AUTOSCALE_PRESETS.length).toBeGreaterThan(0);
    expect(autoScaleFormulaFor('queue-driven')).toContain('$TargetDedicatedNodes');
    expect(classifyBatchGate(403, { error: 'forbidden' }).kind).toBe('forbidden');
    expect(classifyBatchGate(503, {}).kind).toBe('not_configured');
  });
});
