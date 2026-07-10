/**
 * Vitest specs for the workspace-image store (Power BI-style workspace avatar).
 * Pins the format/size guards + the data-URI parser — the security-relevant
 * logic (raster-only, SVG rejected, 1 MiB cap) — with Cosmos mocked.
 */
import { describe, it, expect, vi } from 'vitest';

const upserted: any[] = [];
vi.mock('../cosmos-client', () => ({
  tenantSettingsContainer: async () => ({
    items: { upsert: async (doc: any) => { upserted.push(doc); return { resource: doc }; } },
    item: () => ({ read: async () => ({ resource: undefined }), delete: async () => {} }),
  }),
}));

describe('workspace-image-store', () => {
  it('accepts a valid PNG and returns metadata', async () => {
    const { putWorkspaceImage } = await import('../workspace-image-store');
    const meta = await putWorkspaceImage('owner-oid', 'ws1', 'image/png', Buffer.from([1, 2, 3]), 'me@x.com');
    expect(meta.contentType).toBe('image/png');
    expect(meta.size).toBe(3);
    expect(meta.updatedBy).toBe('me@x.com');
  });

  it('rejects SVG (stored-XSS vector) with a 400', async () => {
    const { putWorkspaceImage, WorkspaceImageError } = await import('../workspace-image-store');
    await expect(putWorkspaceImage('o', 'ws', 'image/svg+xml', Buffer.from('<svg/>'), 'me'))
      .rejects.toMatchObject({ status: 400 });
    // and it is the typed error
    await putWorkspaceImage('o', 'ws', 'image/svg+xml', Buffer.from('<svg/>'), 'me').catch((e) => {
      expect(e).toBeInstanceOf(WorkspaceImageError);
    });
  });

  it('rejects an over-cap payload with a 400', async () => {
    const { putWorkspaceImage, WORKSPACE_IMAGE_MAX_BYTES } = await import('../workspace-image-store');
    const tooBig = Buffer.alloc(WORKSPACE_IMAGE_MAX_BYTES + 1);
    await expect(putWorkspaceImage('o', 'ws', 'image/png', tooBig, 'me'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects an empty payload', async () => {
    const { putWorkspaceImage } = await import('../workspace-image-store');
    await expect(putWorkspaceImage('o', 'ws', 'image/png', Buffer.alloc(0), 'me'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('parseDataUri decodes a base64 data URI', async () => {
    const { parseDataUri } = await import('../workspace-image-store');
    const png = Buffer.from([137, 80, 78, 71]);
    const uri = `data:image/png;base64,${png.toString('base64')}`;
    const out = parseDataUri(uri);
    expect(out.contentType).toBe('image/png');
    expect(out.bytes.equals(png)).toBe(true);
  });

  it('parseDataUri throws on a malformed URI', async () => {
    const { parseDataUri } = await import('../workspace-image-store');
    expect(() => parseDataUri('not-a-data-uri')).toThrow();
  });
});
