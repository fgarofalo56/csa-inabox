/**
 * Unit tests for the client-safe AI-functions registry (G2).
 *
 * Asserts the registry stays 1:1 with the server AI_FN_NAMES (all nine
 * functions), the option-need metadata is right, and the schema-extract prompt
 * builder emits a well-formed multi-field contract.
 */
import { describe, it, expect } from 'vitest';
import { AI_FN_NAMES } from '../ai-functions-client';
import {
  AI_FN_META, AI_FN_KEYS, aiFnMeta, isAiFnKey, buildSchemaExtractPrompt,
} from '../ai-functions-registry';

describe('ai-functions registry', () => {
  it('covers exactly the nine server functions, in the same set', () => {
    expect(AI_FN_KEYS.length).toBe(9);
    expect([...AI_FN_KEYS].sort()).toEqual([...AI_FN_NAMES].sort());
  });

  it('marks classify/extract/translate/similarity with their needed options', () => {
    expect(aiFnMeta('classify')?.needs?.labels).toBe(true);
    expect(aiFnMeta('extract')?.needs?.fields).toBe(true);
    expect(aiFnMeta('translate')?.needs?.targetLang).toBe(true);
    expect(aiFnMeta('similarity')?.needs?.compareTo).toBe(true);
  });

  it('flags the vision-capable functions', () => {
    const vision = AI_FN_META.filter((m) => m.supportsVision).map((m) => m.key).sort();
    expect(vision).toEqual(['classify', 'extract', 'summarize']);
  });

  it('classes embed + similarity as embeddings functions', () => {
    expect(aiFnMeta('embed')?.category).toBe('embed');
    expect(aiFnMeta('similarity')?.category).toBe('embed');
  });

  it('validates keys', () => {
    expect(isAiFnKey('summarize')).toBe(true);
    expect(isAiFnKey('nope')).toBe(false);
  });

  it('builds a multi-field schema-extract prompt', () => {
    const prompt = buildSchemaExtractPrompt([
      { field: 'company', type: 'string', prompt: 'the vendor name' },
      { field: 'amount', type: 'number', prompt: 'the total' },
    ]);
    expect(prompt).toContain('"company" (string): the vendor name');
    expect(prompt).toContain('"amount" (number): the total');
    expect(prompt).toContain('valid JSON');
  });
});
