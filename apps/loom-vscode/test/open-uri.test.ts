import { describe, it, expect } from 'vitest';
import { parseOpenUri, buildOpenUri, hostOf, EXTENSION_ID } from '../src/uri/open-uri';

describe('parseOpenUri', () => {
  it('parses an /open link with deployment id + type + id', () => {
    const t = parseOpenUri('/open', 'deployment=dep-1&type=notebook&id=abc123');
    expect(t).toEqual({ itemType: 'notebook', itemId: 'abc123', deploymentId: 'dep-1' });
  });

  it('treats a deployment=<https url> as an apiUrl to match by host', () => {
    const t = parseOpenUri('/open', 'deployment=https://csa-loom.example.com/&type=lakehouse&id=lh1');
    expect(t?.apiUrl).toBe('https://csa-loom.example.com');
    expect(t?.deploymentId).toBeUndefined();
    expect(t?.itemType).toBe('lakehouse');
  });

  it('ignores a non-/open path (never opens the wrong thing)', () => {
    expect(parseOpenUri('/other', 'type=notebook&id=abc')).toBeUndefined();
    expect(parseOpenUri('/', 'type=notebook&id=abc')).toBeUndefined();
  });

  it('requires BOTH type and id (mutation-proof: drop the guard → this goes RED)', () => {
    expect(parseOpenUri('/open', 'type=notebook')).toBeUndefined();
    expect(parseOpenUri('/open', 'id=abc')).toBeUndefined();
    expect(parseOpenUri('/open', '')).toBeUndefined();
  });

  it('tolerates a trailing slash on the path', () => {
    expect(parseOpenUri('/open/', 'type=notebook&id=abc')).toEqual({ itemType: 'notebook', itemId: 'abc' });
  });
});

describe('buildOpenUri ↔ parseOpenUri round-trip', () => {
  it('round-trips a deployment-id target', () => {
    const uri = buildOpenUri({ itemType: 'report', itemId: 'r-9', deploymentId: 'gov-1' });
    expect(uri.startsWith(`vscode://${EXTENSION_ID}/open?`)).toBe(true);
    const q = uri.split('?')[1];
    expect(parseOpenUri('/open', q)).toEqual({ itemType: 'report', itemId: 'r-9', deploymentId: 'gov-1' });
  });

  it('emits an apiUrl target under the deployment param', () => {
    const uri = buildOpenUri({ itemType: 'notebook', itemId: 'n1', apiUrl: 'https://h.example.com' });
    const q = uri.split('?')[1];
    const parsed = parseOpenUri('/open', q);
    expect(parsed?.apiUrl).toBe('https://h.example.com');
  });
});

describe('hostOf', () => {
  it('lower-cases the host and tolerates junk', () => {
    expect(hostOf('https://CSA-Loom.Example.com/x')).toBe('csa-loom.example.com');
    expect(hostOf('not a url')).toBe('');
  });
});
