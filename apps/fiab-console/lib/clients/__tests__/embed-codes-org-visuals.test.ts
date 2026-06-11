/**
 * Vitest specs for the F22 (embed codes) + F23 (org visuals) clients.
 *
 * Verifies — against fakes for the Blob + Cosmos backends — that:
 *   - the surface is gated on LOOM_ORG_VISUALS_URL (honest config gate).
 *   - createEmbedCode writes a REAL manifest blob, mints a SAS, persists active.
 *   - revokeEmbedCode DELETES the backing blob + flips status to revoked.
 *   - refreshExpiringSas re-mints only codes within the refresh window.
 *   - uploadOrgVisual stores the bundle bytes + writes enabled=false metadata.
 *   - toggleOrgVisual / deleteOrgVisual round-trip + remove the blob.
 * No Microsoft Fabric / Power BI API is touched on any path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Fakes for the adls-client (Blob) backend ------------------------------
const uploadCalls: any[] = [];
const deleteCalls: any[] = [];
let sasCounter = 0;

vi.mock('../../azure/adls-client', () => ({
  uploadBlob: vi.fn(async (container: string, path: string, body: Buffer, contentType: string) => {
    uploadCalls.push({ container, path, size: body.length, contentType });
    return { ok: true, size: body.length, etag: 'etag', url: `https://acct.blob.core.windows.net/${container}/${path}` };
  }),
  deletePath: vi.fn(async (container: string, path: string) => {
    deleteCalls.push({ container, path });
    return { ok: true };
  }),
  generateReadSasUrl: vi.fn(async (container: string, blobPath: string, ttlHours: number) => {
    sasCounter += 1;
    return {
      url: `https://acct.blob.core.windows.net/${container}/${blobPath}?sig=fake${sasCounter}`,
      expiresAt: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
    };
  }),
}));

// --- Fakes for the Cosmos backend ------------------------------------------
const embedDocs = new Map<string, any>();
const visualDocs = new Map<string, any>();

function fakeContainer(store: Map<string, any>) {
  return {
    items: {
      upsert: async (doc: any) => { store.set(doc.id, doc); return { resource: doc }; },
      query: () => ({ fetchAll: async () => ({ resources: Array.from(store.values()) }) }),
    },
    item: (id: string, _pk: string) => ({
      read: async () => ({ resource: store.get(id) }),
      replace: async (doc: any) => { store.set(doc.id, doc); return { resource: doc }; },
      delete: async () => { store.delete(id); return {}; },
    }),
  };
}

vi.mock('../../azure/cosmos-client', () => ({
  embedCodesContainer: async () => fakeContainer(embedDocs),
  orgVisualsContainer: async () => fakeContainer(visualDocs),
}));

import {
  createEmbedCode, revokeEmbedCode, listEmbedCodes, refreshExpiringSas,
  isConfigured, orgVisualsAccount, NotConfiguredError,
} from '../embed-codes-client';
import {
  uploadOrgVisual, toggleOrgVisual, deleteOrgVisual, listOrgVisuals,
} from '../org-visuals-client';

const TENANT = 'tenant-1';
const WHO = 'admin@contoso.com';

beforeEach(() => {
  embedDocs.clear();
  visualDocs.clear();
  uploadCalls.length = 0;
  deleteCalls.length = 0;
  sasCounter = 0;
  process.env.LOOM_ORG_VISUALS_URL = 'https://loomlake.blob.core.windows.net/org-visuals';
});

describe('config gate', () => {
  it('isConfigured reflects LOOM_ORG_VISUALS_URL', () => {
    expect(isConfigured()).toBe(true);
    delete process.env.LOOM_ORG_VISUALS_URL;
    expect(isConfigured()).toBe(false);
  });

  it('orgVisualsAccount parses the account, throws NotConfiguredError when unset', () => {
    expect(orgVisualsAccount()).toBe('loomlake');
    delete process.env.LOOM_ORG_VISUALS_URL;
    expect(() => orgVisualsAccount()).toThrow(NotConfiguredError);
  });
});

describe('embed codes', () => {
  it('createEmbedCode writes a real manifest blob, mints a SAS, persists active', async () => {
    const code = await createEmbedCode(TENANT, WHO, 'Quarterly report');
    expect(code.status).toBe('active');
    expect(code.report).toBe('Quarterly report');
    expect(code.signedUrl).toContain('?sig=fake');
    expect(code.blobPath).toContain(`embed-manifests/${TENANT}/`);
    // a real manifest blob was uploaded to org-visuals
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].container).toBe('org-visuals');
    expect(uploadCalls[0].contentType).toBe('application/json');
    // persisted + listable
    const list = await listEmbedCodes(TENANT);
    expect(list.map((c) => c.id)).toContain(code.id);
  });

  it('revokeEmbedCode deletes the backing blob + flips status', async () => {
    const code = await createEmbedCode(TENANT, WHO, 'R');
    const revoked = await revokeEmbedCode(TENANT, code.id, WHO);
    expect(revoked.status).toBe('revoked');
    expect(revoked.signedUrl).toBe('');
    expect(revoked.revokedBy).toBe(WHO);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({ container: 'org-visuals', path: code.blobPath });
  });

  it('refreshExpiringSas re-mints only codes near expiry', async () => {
    const fresh = await createEmbedCode(TENANT, WHO, 'fresh'); // expires in 7d
    // Hand-craft a near-expiry active code.
    const stale = { ...fresh, id: 'stale', signedUrl: 'old', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    embedDocs.set('stale', stale);
    const out = await refreshExpiringSas(TENANT, [fresh, stale as any]);
    const outStale = out.find((c) => c.id === 'stale')!;
    const outFresh = out.find((c) => c.id === fresh.id)!;
    expect(outStale.signedUrl).toContain('?sig=fake'); // re-minted
    expect(outFresh.signedUrl).toBe(fresh.signedUrl);   // untouched
  });
});

describe('org visuals', () => {
  it('uploadOrgVisual stores bytes + writes enabled=false metadata', async () => {
    const body = Buffer.from('PK\x03\x04 fake pbiviz bundle');
    const v = await uploadOrgVisual(TENANT, WHO, 'Bar chart', 'BarChart.pbiviz', '1.0.0', body);
    expect(v.enabled).toBe(false);
    expect(v.version).toBe('1.0.0');
    expect(v.size).toBe(body.length);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].container).toBe('org-visuals');
    expect(uploadCalls[0].path).toContain(`visuals/${TENANT}/`);
    const list = await listOrgVisuals(TENANT);
    expect(list.map((x) => x.id)).toContain(v.id);
  });

  it('uploadOrgVisual persists optional description + icon (Fabric parity)', async () => {
    const body = Buffer.from('PK\x03\x04 fake');
    const iconDataUri = 'data:image/png;base64,aGVsbG8=';
    const v = await uploadOrgVisual(TENANT, WHO, 'Bar', 'b.pbiviz', '2.1.0', body, {
      description: 'A custom bar chart',
      iconDataUri,
    });
    expect(v.description).toBe('A custom bar chart');
    expect(v.iconDataUri).toBe(iconDataUri);
    const [stored] = await listOrgVisuals(TENANT);
    expect(stored.description).toBe('A custom bar chart');
    expect(stored.iconDataUri).toBe(iconDataUri);
  });

  it('uploadOrgVisual omits description/icon keys when not provided', async () => {
    const v = await uploadOrgVisual(TENANT, WHO, 'Bare', 'bare.pbiviz', '1.0.0', Buffer.from('x'));
    expect(v.description).toBeUndefined();
    expect(v.iconDataUri).toBeUndefined();
  });

  it('toggleOrgVisual enables tenant-wide', async () => {
    const v = await uploadOrgVisual(TENANT, WHO, 'Bar', 'b.pbiviz', '1.0.0', Buffer.from('x'));
    const on = await toggleOrgVisual(TENANT, v.id, true, WHO);
    expect(on.enabled).toBe(true);
    expect(on.enabledBy).toBe(WHO);
  });

  it('deleteOrgVisual removes blob + metadata', async () => {
    const v = await uploadOrgVisual(TENANT, WHO, 'Bar', 'b.pbiviz', '1.0.0', Buffer.from('x'));
    await deleteOrgVisual(TENANT, v.id);
    expect(deleteCalls.some((d) => d.path === v.blobPath)).toBe(true);
    const list = await listOrgVisuals(TENANT);
    expect(list.map((x) => x.id)).not.toContain(v.id);
  });
});
