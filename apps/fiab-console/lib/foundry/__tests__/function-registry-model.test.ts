/**
 * WS-4.2 — functions-on-objects registry model + verdict interpretation.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeRegisteredFunction, normalizeRegisteredFunctions, resolveFunction,
  functionVersions, functionNames, compareVersions, isFunctionName, isFunctionVersion,
  type RegisteredFunction,
} from '@/lib/foundry/function-registry-model';
import { interpretVerdict } from '@/lib/azure/loom-function-runtime';

describe('function-registry-model — normalization', () => {
  it('requires a valid name + version', () => {
    expect(normalizeRegisteredFunction({ name: '1bad', version: '1' })).toBeNull();
    expect(normalizeRegisteredFunction({ name: 'ok', version: 'bad version!' })).toBeNull();
    expect(normalizeRegisteredFunction({ name: 'ok', version: '1.0.0' })).toMatchObject({ name: 'ok', version: '1.0.0', runtime: 'udf', purpose: 'general' });
  });
  it('defaults functionPath to the name and coerces params', () => {
    const fn = normalizeRegisteredFunction({ name: 'score', version: '1', params: [{ name: 'x', type: 'number' }, { name: 'bad!', type: 'string' }] });
    expect(fn?.functionPath).toBe('score');
    expect(fn?.params).toHaveLength(1);
  });
  it('only keeps an https base url override', () => {
    expect(normalizeRegisteredFunction({ name: 'f', version: '1', runtime: 'azure-function', baseUrlOverride: 'http://insecure' })?.baseUrlOverride).toBeUndefined();
    expect(normalizeRegisteredFunction({ name: 'f', version: '1', runtime: 'azure-function', baseUrlOverride: 'https://ok.azurewebsites.net' })?.baseUrlOverride).toBe('https://ok.azurewebsites.net');
  });
});

describe('function-registry-model — versioning', () => {
  const fns: RegisteredFunction[] = normalizeRegisteredFunctions([
    { name: 'validate', version: '1.0.0', runtime: 'udf', purpose: 'validation', createdAt: '2026-01-01' },
    { name: 'validate', version: '2.1.0', runtime: 'udf', purpose: 'validation', createdAt: '2026-02-01' },
    { name: 'validate', version: '1.10.0', runtime: 'udf', purpose: 'validation', createdAt: '2026-03-01' },
    { name: 'score', version: '1', runtime: 'udf', purpose: 'derived' },
  ]);
  it('sorts numeric segments naturally (1.10 > 1.2)', () => {
    expect(compareVersions('1.10.0', '1.2.0')).toBeGreaterThan(0);
  });
  it('lists names + versions newest first', () => {
    expect(functionNames(fns)).toEqual(['score', 'validate']);
    expect(functionVersions(fns, 'validate').map((f) => f.version)).toEqual(['2.1.0', '1.10.0', '1.0.0']);
  });
  it('resolves latest when unpinned and the exact version when pinned', () => {
    expect(resolveFunction(fns, 'validate')?.version).toBe('2.1.0');
    expect(resolveFunction(fns, 'validate', '1.0.0')?.version).toBe('1.0.0');
    expect(resolveFunction(fns, 'validate', '9.9.9')).toBeNull();
    expect(resolveFunction(fns, 'missing')).toBeNull();
  });
  it('guards identifiers', () => {
    expect(isFunctionName('goodName')).toBe(true);
    expect(isFunctionName('9bad')).toBe(false);
    expect(isFunctionVersion('1.2.3-rc1')).toBe(true);
    expect(isFunctionVersion('has space')).toBe(false);
  });
});

describe('interpretVerdict — validation function return shapes', () => {
  it('accepts a canonical verdict', () => {
    expect(interpretVerdict({ valid: true })).toEqual({ valid: true });
    expect(interpretVerdict({ valid: false, message: 'over limit' })).toEqual({ valid: false, message: 'over limit' });
  });
  it('accepts a BFF-envelope verdict', () => {
    expect(interpretVerdict({ ok: false, error: 'bad' })).toEqual({ valid: false, message: 'bad' });
  });
  it('accepts a bare boolean', () => {
    expect(interpretVerdict(true)).toEqual({ valid: true });
  });
  it('fails closed on a malformed return', () => {
    expect(interpretVerdict('nonsense').valid).toBe(false);
    expect(interpretVerdict(null).valid).toBe(false);
  });
});
