import { describe, it, expect } from 'vitest';
import {
  buildDefinitionPath,
  buildItemDirPath,
  parseLoomRef,
  slugForName,
  isDefinitionFile,
  DEFINITION_SUFFIX,
  LoomPathError,
} from '../src/fs/definition-uri';

describe('slugForName', () => {
  it('produces a url-safe slug and falls back to "item"', () => {
    expect(slugForName('My Notebook!')).toBe('my-notebook');
    expect(slugForName('  ')).toBe('item');
    expect(slugForName('a/b:c')).toBe('a-b-c');
  });
});

describe('buildDefinitionPath / parseLoomRef round-trip', () => {
  it('builds a 4-segment file path and parses it back', () => {
    const path = buildDefinitionPath({
      deploymentId: 'dep-1',
      itemType: 'notebook',
      itemId: 'id-123',
      displayName: 'Sales NB',
    });
    expect(path).toMatch(/^\/dep-1\/notebook\/id-123\/sales-nb\.definition\.json$/);
    const ref = parseLoomRef(path);
    expect(ref.deploymentId).toBe('dep-1');
    expect(ref.itemType).toBe('notebook');
    expect(ref.itemId).toBe('id-123');
    expect(ref.filename).toBe('sales-nb.definition.json');
    expect(isDefinitionFile(ref.filename!)).toBe(true);
  });

  it('encodes segments that contain reserved characters', () => {
    const path = buildDefinitionPath({ deploymentId: 'a b', itemType: 't/x', itemId: 'i#1', displayName: 'n' });
    const ref = parseLoomRef(path);
    expect(ref.deploymentId).toBe('a b');
    expect(ref.itemType).toBe('t/x');
    expect(ref.itemId).toBe('i#1');
  });

  it('parses a 3-segment item directory (no filename)', () => {
    const dir = buildItemDirPath({ deploymentId: 'dep-1', itemType: 'notebook', itemId: 'id-1' });
    const ref = parseLoomRef(dir);
    expect(ref.filename).toBeUndefined();
    expect(ref.itemId).toBe('id-1');
  });

  it('throws on an unsupported depth', () => {
    expect(() => parseLoomRef('/a/b')).toThrow(LoomPathError);
    expect(() => parseLoomRef('/a/b/c/d/e')).toThrow(LoomPathError);
  });

  it('DEFINITION_SUFFIX is the canonical suffix', () => {
    expect(DEFINITION_SUFFIX).toBe('.definition.json');
  });
});
