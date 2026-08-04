import { describe, it, expect } from 'vitest';
import {
  parseDeployments,
  normalizeUrl,
  deploymentIdFromUrl,
  cloudLabel,
} from '../src/config/deployments';

describe('parseDeployments', () => {
  it('returns [] for non-array input', () => {
    expect(parseDeployments(undefined)).toEqual([]);
    expect(parseDeployments(null)).toEqual([]);
    expect(parseDeployments('nope')).toEqual([]);
    expect(parseDeployments({})).toEqual([]);
  });

  it('parses a valid entry and defaults name + cloud', () => {
    const out = parseDeployments([{ apiUrl: 'https://csa-loom.example.com' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      apiUrl: 'https://csa-loom.example.com',
      name: 'csa-loom.example.com',
      cloud: 'commercial',
    });
    expect(out[0].id).toBe('csa-loom.example.com');
  });

  it('normalizes a trailing slash on apiUrl', () => {
    const out = parseDeployments([{ apiUrl: 'https://x.example.com///' }]);
    expect(out[0].apiUrl).toBe('https://x.example.com');
  });

  it('honors explicit id/name/cloud', () => {
    const out = parseDeployments([
      { id: 'gov1', name: 'Gov', apiUrl: 'https://gov.example.us', cloud: 'gcc-high' },
    ]);
    expect(out[0]).toMatchObject({ id: 'gov1', name: 'Gov', cloud: 'gcc-high' });
  });

  it('skips entries without a valid http(s) apiUrl', () => {
    const out = parseDeployments([
      { name: 'no url' },
      { apiUrl: '' },
      { apiUrl: 'ftp://nope.example.com' },
      { apiUrl: 'not a url' },
      { apiUrl: 'https://good.example.com' },
    ]);
    expect(out.map((d) => d.apiUrl)).toEqual(['https://good.example.com']);
  });

  it('de-duplicates by id (first wins)', () => {
    const out = parseDeployments([
      { apiUrl: 'https://dup.example.com', name: 'First' },
      { apiUrl: 'https://dup.example.com', name: 'Second' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('First');
  });

  it('keeps a Commercial and a Government deployment side by side', () => {
    const out = parseDeployments([
      { name: 'Commercial', apiUrl: 'https://loom.example.com', cloud: 'commercial' },
      { name: 'Gov', apiUrl: 'https://loom.example.us', cloud: 'gov' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.cloud)).toEqual(['commercial', 'gov']);
  });

  it('normalizes cloud aliases and unknown → commercial', () => {
    const out = parseDeployments([
      { apiUrl: 'https://a.example.com', cloud: 'government' },
      { apiUrl: 'https://b.example.com', cloud: 'PUBLIC' },
      { apiUrl: 'https://c.example.com', cloud: 'martian' },
    ]);
    expect(out.map((d) => d.cloud)).toEqual(['gov', 'commercial', 'commercial']);
  });
});

describe('normalizeUrl', () => {
  it('strips trailing slashes only', () => {
    expect(normalizeUrl('https://x/')).toBe('https://x');
    expect(normalizeUrl('https://x///')).toBe('https://x');
    expect(normalizeUrl('https://x')).toBe('https://x');
    expect(normalizeUrl('https://x/a')).toBe('https://x/a');
  });
});

describe('deploymentIdFromUrl', () => {
  it('slugs host (+ first path segment)', () => {
    expect(deploymentIdFromUrl('https://loom.example.com')).toBe('loom.example.com');
    expect(deploymentIdFromUrl('https://fd.azurefd.net/loom')).toBe('fd.azurefd.net-loom');
  });
});

describe('cloudLabel', () => {
  it('maps every cloud to a human label', () => {
    expect(cloudLabel('commercial')).toBe('Commercial');
    expect(cloudLabel('gov')).toBe('Government');
    expect(cloudLabel('gcc')).toBe('GCC');
    expect(cloudLabel('gcc-high')).toBe('GCC High');
    expect(cloudLabel('il5')).toBe('IL5');
  });
});
