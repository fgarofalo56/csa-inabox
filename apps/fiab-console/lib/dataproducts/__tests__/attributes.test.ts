import { describe, it, expect } from 'vitest';
import {
  UPDATE_FREQUENCIES,
  isUpdateFrequency,
  sanitizeExternalLinks,
} from '../attributes';

describe('UPDATE_FREQUENCIES', () => {
  it('exposes the seven portal-visible frequency labels in order', () => {
    expect([...UPDATE_FREQUENCIES]).toEqual([
      'Daily', 'Weekly', 'Monthly', 'Quarterly', 'Annually', 'Ad hoc', 'Real-time',
    ]);
  });
});

describe('isUpdateFrequency', () => {
  it('accepts every supported value', () => {
    for (const f of UPDATE_FREQUENCIES) expect(isUpdateFrequency(f)).toBe(true);
  });
  it('rejects unsupported / non-string values', () => {
    expect(isUpdateFrequency('Yearly')).toBe(false); // REST member, not a portal label
    expect(isUpdateFrequency('')).toBe(false);
    expect(isUpdateFrequency(null)).toBe(false);
    expect(isUpdateFrequency(3)).toBe(false);
  });
});

describe('sanitizeExternalLinks', () => {
  it('normalises a valid array, trimming and keeping optional assetId', () => {
    const out = sanitizeExternalLinks([
      { label: '  Terms  ', url: 'https://contoso.gov/terms', assetId: ' abc ' },
      { label: 'Docs', url: 'https://contoso.gov/docs' },
    ]);
    expect(out).toEqual([
      { label: 'Terms', url: 'https://contoso.gov/terms', assetId: 'abc' },
      { label: 'Docs', url: 'https://contoso.gov/docs' },
    ]);
  });

  it('drops a blank assetId rather than persisting it', () => {
    const out = sanitizeExternalLinks([{ label: 'X', url: 'https://x.gov', assetId: '   ' }]);
    expect(out).toEqual([{ label: 'X', url: 'https://x.gov' }]);
  });

  it('accepts the empty array', () => {
    expect(sanitizeExternalLinks([])).toEqual([]);
  });

  it('returns null for non-array input', () => {
    expect(sanitizeExternalLinks({})).toBeNull();
    expect(sanitizeExternalLinks(null)).toBeNull();
    expect(sanitizeExternalLinks('nope')).toBeNull();
  });

  it('returns null when a required field is missing or the URL is invalid', () => {
    expect(sanitizeExternalLinks([{ label: '', url: 'https://x.gov' }])).toBeNull();
    expect(sanitizeExternalLinks([{ label: 'X', url: '' }])).toBeNull();
    expect(sanitizeExternalLinks([{ label: 'X', url: 'not-a-url' }])).toBeNull();
    expect(sanitizeExternalLinks(['nope'])).toBeNull();
  });
});
