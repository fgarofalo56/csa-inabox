import { describe, it, expect } from 'vitest';
import { bicepStringLiteral } from '../bicep-literal';

describe('bicepStringLiteral', () => {
  it('quotes plain values unchanged', () => {
    expect(bicepStringLiteral('eastus2')).toBe("'eastus2'");
    expect(bicepStringLiteral(42)).toBe("'42'");
    expect(bicepStringLiteral(undefined)).toBe("''");
  });

  it('escapes backslash BEFORE the quote — a trailing \\ cannot re-arm the closing quote', () => {
    expect(bicepStringLiteral('c:\\temp\\')).toBe("'c:\\\\temp\\\\'");
    // Old quote-only escape: 'evil\' + "'" would yield 'evil\' → escaped closing quote.
    const lit = bicepStringLiteral('evil\\');
    expect(lit).toBe("'evil\\\\'");
    expect(lit.endsWith("\\\\'")).toBe(true);
  });

  it('escapes the quote itself', () => {
    expect(bicepStringLiteral("it's")).toBe("'it\\'s'");
  });

  it('escapes ${ so a form value can never become a live Bicep interpolation', () => {
    expect(bicepStringLiteral('${listKeys(x, y)}')).toBe("'\\${listKeys(x, y)}'");
    // A bare $ (not followed by {) is not an interpolation and stays as-is.
    expect(bicepStringLiteral('cost$')).toBe("'cost$'");
  });

  it('encodes newlines/tabs (single-quoted Bicep strings are single-line)', () => {
    expect(bicepStringLiteral('a\nb\tc')).toBe("'a\\nb\\tc'");
  });
});
