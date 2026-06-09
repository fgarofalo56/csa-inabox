/**
 * Folders service layer (F10) — pure Cosmos CRUD for the workspace folder
 * hierarchy, factored out of the user-facing BFF route so BOTH the owner route
 * (`app/api/workspaces/[id]/folders`) and the tenant-admin route
 * (`app/api/admin/workspaces/[id]/folders`) call the SAME validated operations.
 *
 * Pattern mirrors jupyter-server-client.ts: pure service functions, no HTTP,
 * no session — the caller authorizes, this layer just talks to Cosmos. Real
 * Cosmos data-plane (per no-vaporware.md); no mocks, no Fabric dependency
 * (folders are a Loom-native concept backed by the Cosmos `folders` container,
 * PK /workspaceId — see cosmos-client.ts).
 *
 * Cascade semantics on delete match the live owner-route behavior:
 *   - items in the folder reparent to workspace root (folderId → null)
 *   - child folders reparent to workspace root (parent → null)
 *   - then the folder doc is deleted (404 on a missing folder is a no-op)
 */
import crypto from 'node:crypto';
import { foldersContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceFolder, WorkspaceItem } from '@/lib/types/workspace';

/** List every folder in a workspace, alphabetically by name. */
export async function dbListFolders(workspaceId: string): Promise<WorkspaceFolder[]> {
  const c = await foldersContainer();
  const { resources } = await c.items
    .query<WorkspaceFolder>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.name',
      parameters: [{ name: '@w', value: workspaceId }],
    })
    .fetchAll();
  return resources;
}

/** Create a folder. `parent` null/absent = a root folder. */
export async function dbCreateFolder(
  workspaceId: string,
  name: string,
  parent: string | null,
  createdBy: string,
): Promise<WorkspaceFolder> {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('name required');
  const c = await foldersContainer();
  const doc: WorkspaceFolder = {
    id: crypto.randomUUID(),
    workspaceId,
    name: trimmed,
    parent: parent || null,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  const { resource } = await c.items.create(doc);
  return resource as WorkspaceFolder;
}

/** Rename a folder. Throws on a missing folder (caller maps to 404). */
export async function dbRenameFolder(
  workspaceId: string,
  folderId: string,
  name: string,
): Promise<WorkspaceFolder> {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('name required');
  const c = await foldersContainer();
  const { resource } = await c.item(folderId, workspaceId).read<WorkspaceFolder>();
  if (!resource) throw new Error('folder not found');
  const next: WorkspaceFolder = { ...resource, name: trimmed };
  const { resource: saved } = await c.item(folderId, workspaceId).replace(next);
  return saved as WorkspaceFolder;
}

/**
 * Delete a folder, cascading its contents back to the workspace root:
 *   - items whose folderId === folderId  → folderId = null
 *   - child folders whose parent === folderId → parent = null
 * A 404 on the final delete is swallowed (idempotent delete).
 */
export async function dbDeleteFolder(workspaceId: string, folderId: string): Promise<void> {
  // Reparent member items to root (best-effort — never block the delete).
  try {
    const items = await itemsContainer();
    const { resources: members } = await items.items
      .query<WorkspaceItem>(
        {
          query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.folderId = @f',
          parameters: [
            { name: '@w', value: workspaceId },
            { name: '@f', value: folderId },
          ],
        },
        { partitionKey: workspaceId },
      )
      .fetchAll();
    for (const m of members) {
      const next: WorkspaceItem = { ...m, folderId: null, updatedAt: new Date().toISOString() };
      await items.item(m.id, m.workspaceId).replace(next);
    }
  } catch {
    /* best-effort reparent */
  }
  const c = await foldersContainer();
  // Reparent child folders to root.
  try {
    const { resources: childFolders } = await c.items
      .query<WorkspaceFolder>({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.parent = @p',
        parameters: [
          { name: '@w', value: workspaceId },
          { name: '@p', value: folderId },
        ],
      })
      .fetchAll();
    for (const cf of childFolders) {
      await c.item(cf.id, workspaceId).replace({ ...cf, parent: null });
    }
  } catch {
    /* best-effort reparent */
  }
  try {
    await c.item(folderId, workspaceId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

/**
 * Move an item to a folder (folderId) or back to root (null). Validates the
 * target folder exists in the same workspace when non-null. Returns the
 * updated item. Throws 'item not found' / 'folder not found' for the caller
 * to map to the right status.
 */
export async function dbMoveItem(
  workspaceId: string,
  itemId: string,
  folderId: string | null,
): Promise<WorkspaceItem> {
  const items = await itemsContainer();
  const { resource: item } = await items.item(itemId, workspaceId).read<WorkspaceItem>();
  if (!item) throw new Error('item not found');
  if (folderId) {
    const c = await foldersContainer();
    const { resource: folder } = await c.item(folderId, workspaceId).read<WorkspaceFolder>();
    if (!folder) throw new Error('folder not found');
  }
  const next: WorkspaceItem = {
    ...item,
    folderId: folderId || null,
    updatedAt: new Date().toISOString(),
  };
  const { resource: saved } = await items.item(itemId, workspaceId).replace(next);
  return saved as WorkspaceItem;
}
