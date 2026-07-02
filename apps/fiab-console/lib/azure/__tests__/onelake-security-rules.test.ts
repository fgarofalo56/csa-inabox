import { describe, it, expect } from 'vitest';
import {
  ROLE_NAME_RE,
  isValidRolePath,
  allowedPermissions,
  roleDocId,
  isValidRlsPredicate,
  isValidColumnList,
} from '../onelake-security-rules';

describe('onelake-security-client validation helpers (F7)', () => {
  it('ROLE_NAME_RE matches Fabric data-access role naming rules', () => {
    expect(ROLE_NAME_RE.test('SalesReaders')).toBe(true);
    expect(ROLE_NAME_RE.test('Role1')).toBe(true);
    expect(ROLE_NAME_RE.test('DefaultReader')).toBe(true);
    // must start with a letter
    expect(ROLE_NAME_RE.test('1Role')).toBe(false);
    // no spaces / punctuation
    expect(ROLE_NAME_RE.test('Sales Readers')).toBe(false);
    expect(ROLE_NAME_RE.test('sales-readers')).toBe(false);
    expect(ROLE_NAME_RE.test('')).toBe(false);
    // max 128 chars
    expect(ROLE_NAME_RE.test('A' + 'b'.repeat(127))).toBe(true);
    expect(ROLE_NAME_RE.test('A' + 'b'.repeat(128))).toBe(false);
  });

  it('isValidRolePath accepts * and /Tables//Files paths only', () => {
    expect(isValidRolePath('*')).toBe(true);
    expect(isValidRolePath('/Tables/sales')).toBe(true);
    expect(isValidRolePath('/Files/raw/2026')).toBe(true);
    expect(isValidRolePath('/Tables')).toBe(true);
    expect(isValidRolePath('/Other/x')).toBe(false);
    expect(isValidRolePath('Tables/sales')).toBe(false);
    expect(isValidRolePath('')).toBe(false);
  });

  it('allowedPermissions restricts mirrored items to Read', () => {
    expect(allowedPermissions('lakehouse')).toEqual(['Read', 'ReadWrite']);
    expect(allowedPermissions('mirrored-database')).toEqual(['Read']);
    expect(allowedPermissions('mirrored-catalog')).toEqual(['Read']);
  });

  it('roleDocId is deterministic + case-insensitive on the role name', () => {
    expect(roleDocId('lh1', 'SalesReaders')).toBe('lh1:salesreaders');
    expect(roleDocId('lh1', 'salesreaders')).toBe('lh1:salesreaders');
    expect(roleDocId('gold', 'DefaultReader')).toBe('gold:defaultreader');
  });

  it('isValidRlsPredicate accepts a safe WHERE subset', () => {
    expect(isValidRlsPredicate("region = 'west'").ok).toBe(true);
    expect(isValidRlsPredicate("region = USER_NAME() AND amount > 100").ok).toBe(true);
    expect(isValidRlsPredicate("dept IN ('a','b') OR (tier = 1)").ok).toBe(true);
  });

  it('isValidRlsPredicate rejects injection / DDL / terminators / comments', () => {
    expect(isValidRlsPredicate("1=1; DROP TABLE sales").ok).toBe(false);   // terminator + DDL
    expect(isValidRlsPredicate("region='x' -- comment").ok).toBe(false);    // comment
    expect(isValidRlsPredicate("region='x' /* c */").ok).toBe(false);       // block comment
    expect(isValidRlsPredicate("EXEC xp_cmdshell 'dir'").ok).toBe(false);   // exec
    expect(isValidRlsPredicate("col = 0x41").ok).toBe(true);                // hex-ish digits ok
    expect(isValidRlsPredicate("(a = 1").ok).toBe(false);                   // unbalanced parens
    expect(isValidRlsPredicate("name = 'oops").ok).toBe(false);             // unbalanced quote
    expect(isValidRlsPredicate("").ok).toBe(false);                         // empty
  });

  it('isValidColumnList accepts safe identifiers + rejects bad ones', () => {
    expect(isValidColumnList(['region', 'amount', '[Order Id]']).ok).toBe(true);
    expect(isValidColumnList([]).ok).toBe(false);                            // empty
    expect(isValidColumnList(['region', "evil; DROP"]).ok).toBe(false);      // injection
    expect(isValidColumnList(['1col']).ok).toBe(false);                      // bad start
  });
});
