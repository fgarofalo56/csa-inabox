/**
 * Registry coverage test — the AI Foundry / APIM / Copilot Studio sweep
 * MUST keep every editor in this family registered. If a refactor drops
 * an entry by accident the test catches it before merge.
 *
 * The registry uses next/dynamic which can't be evaluated in a node-env
 * vitest run, so we assert by reading the registry source as text and
 * checking each slug appears as a key. This is intentionally surface-
 * level — registry import edge cases (renamed exports, missing component
 * functions) are caught by the Playwright E2E suite.
 *
 * Source of truth: apps/fiab-console/lib/editors/registry.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_TYPES = [
  // APIM
  'apim-api',
  'apim-product',
  'apim-policy',
  'data-product',
  // AI Foundry
  'ai-foundry-hub',
  'ai-foundry-project',
  'prompt-flow',
  'evaluation',
  'content-safety',
  'tracing',
  'ai-search-index',
  'compute',
  'dataset',
  // Copilot Studio
  'copilot-studio-agent',
  'copilot-studio-knowledge',
  'copilot-studio-topic',
  'copilot-studio-action',
  'copilot-studio-channel',
  'copilot-studio-analytics',
  'copilot-template-library',
];

describe('AI Foundry / APIM / Copilot Studio editor registry coverage', () => {
  const registryPath = resolve(__dirname, '..', 'lib', 'editors', 'registry.ts');
  const registrySrc = readFileSync(registryPath, 'utf-8');

  for (const slug of REQUIRED_TYPES) {
    it(`registers '${slug}'`, () => {
      const re = new RegExp(`['"\`]${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]\\s*:\\s*reg\\(`);
      expect(re.test(registrySrc), `editor slug '${slug}' missing from registry.ts`).toBe(true);
    });
  }
});
