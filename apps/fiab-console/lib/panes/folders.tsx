'use client';

/**
 * FoldersPane (F10) — self-contained, reusable workspace folder tree.
 *
 * Extracted from app/workspaces/[id]/page.tsx so the nested folder hierarchy
 * (create / rename / move / delete + HTML5 drag-and-drop of items between
 * folders) can be embedded anywhere — the workspace page, an admin drawer, or
 * the task-flows surface. Folders are Loom-native (Cosmos `folders` container,
 * PK /workspaceId via the BFF) — no Fabric dependency.
 *
 * Backend: every control calls a real BFF route in lib/api/workspaces.ts
 * (listFolders / createFolder / renameFolder / deleteFolder / patchWorkspaceItem
 * / deleteWorkspaceItem) → Cosmos. No mocks (per no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body1, Button, Caption1, Spinner, Badge, Checkbox,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Input, Field, Dropdown, Option,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  FolderAdd20Regular, Folder20Filled,
  FolderArrowRight20Regular, Delete20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import {
  listItems,
  listFolders, createFolder, renameFolder, deleteFolder,
  patchWorkspaceItem, deleteWorkspaceItem,
  type WorkspaceItem, type WorkspaceFolder,
} from '@/lib/api/workspaces';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { getItemTypeIcon } from '@/lib/components/item-type-icon';

const useStyles = makeStyles({
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
  spacer: { flex: 1 },
  treeShell: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '8px',
    minHeight: '240px',
  },
  rootDrop: {
    padding: '4px 8px', borderRadius: '4px', fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed transparent`,
  },
  rootDropActive: {
    border: `1px dashed ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2Hover,
    color: tokens.colorBrandForeground1,
  },
  itemRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  badge: { marginLeft: '6px' },
  empty: {
    padding: '32px', textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: '12px', lineHeight: 1.6,
  },
  treeItemDragOver: {
    outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px', borderRadius: '4px',
  },
  bulkBar: { backgroundColor: tokens.colorNeutralBackground2, borderRadius: '6px', padding: '6px 10px' },
});

const TREE_EXPANDED_KEY = (wsId: string) => `loom.workspaces.${wsId}.tree-expanded.v1`;

interface FolderNode {
  folder: WorkspaceFolder | null; // null = root
  childFolders: FolderNode[];
  childItems: WorkspaceItem[];
}

function buildTree(folders: WorkspaceFolder[], items: WorkspaceItem[]): FolderNode {
  const byId = new Map<string, FolderNode>();
  const root: FolderNode = { folder: null, childFolders: [], childItems: [] };
  for (const f of folders) byId.set(f.id, { folder: f, childFolders: [], childItems: [] });
  for (const f of folders) {
    const node = byId.get(f.id)!;
    if (f.parent && byId.has(f.parent)) byId.get(f.parent)!.childFolders.push(node);
    else root.childFolders.push(node);
  }
  for (const it of items) {
    const fid = it.folderId || null;
    const target = fid && byId.has(fid) ? byId.get(fid)! : root;
    target.childItems.push(it);
  }
  const sortNode = (n: FolderNode) => {
    n.childFolders.sort((a, b) => (a.folder?.name ?? '').localeCompare(b.folder?.name ?? ''));
    n.childItems.sort((a, b) => a.displayName.localeCompare(b.displayName));
    n.childFolders.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function countDescendants(n: FolderNode): number {
  let c = n.childItems.length + n.childFolders.length;
  for (const cf of n.childFolders) c += countDescendants(cf);
  return c;
}

function readExpanded(wsId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(TREE_EXPANDED_KEY(wsId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s) => typeof s === 'string'));
  } catch { return new Set(); }
}
function writeExpanded(wsId: string, ids: Set<string>) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(TREE_EXPANDED_KEY(wsId), JSON.stringify(Array.from(ids))); }
  catch { /* quota — non-fatal */ }
}

export interface FoldersPaneProps {
  workspaceId: string;
}

export function FoldersPane({ workspaceId }: FoldersPaneProps): JSX.Element {
  const s = useStyles();
  const router = useRouter();
  const qc = useQueryClient();

  const itemsQ = useQuery<WorkspaceItem[]>({
    queryKey: ['items', workspaceId],
    queryFn: () => listItems(workspaceId),
  });
  const foldersQ = useQuery<WorkspaceFolder[]>({
    queryKey: ['folders', workspaceId],
    queryFn: () => listFolders(workspaceId),
  });

  const items = itemsQ.data ?? [];
  const folders = foldersQ.data ?? [];
  const tree = useMemo(() => buildTree(folders, items), [folders, items]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => { setExpanded(readExpanded(workspaceId)); }, [workspaceId]);
  const setExpandedAndPersist = useCallback((next: Set<string>) => {
    setExpanded(next); writeExpanded(workspaceId, next);
  }, [workspaceId]);
  const toggleExpanded = useCallback((id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedAndPersist(next);
  }, [expanded, setExpandedAndPersist]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['items', workspaceId] });
    void qc.invalidateQueries({ queryKey: ['folders', workspaceId] });
  }, [qc, workspaceId]);

  async function onCreateFolder(name: string, parent: string | null) {
    setBusy(true); setError(null);
    try { await createFolder(workspaceId, { name, parent }); refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function onRenameFolder(folderId: string, name: string) {
    setBusy(true); setError(null);
    try { await renameFolder(workspaceId, folderId, name); refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function onDeleteFolder(folderId: string) {
    setBusy(true); setError(null);
    try { await deleteFolder(workspaceId, folderId); refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function onMoveItem(itemId: string, folderId: string | null) {
    setBusy(true); setError(null);
    try { await patchWorkspaceItem(workspaceId, itemId, { folderId }); refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function onRenameItem(itemId: string, displayName: string) {
    setBusy(true); setError(null);
    try { await patchWorkspaceItem(workspaceId, itemId, { displayName }); refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function onDeleteItem(itemId: string) {
    setBusy(true); setError(null);
    try { await deleteWorkspaceItem(workspaceId, itemId); refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  // ---- dialogs ----------------------------------------------------------
  const [folderDialog, setFolderDialog] = useState<
    | { mode: 'create'; parent: string | null }
    | { mode: 'rename'; folderId: string; current: string }
    | null
  >(null);
  const [folderDialogName, setFolderDialogName] = useState('');
  const [confirmFolderDelete, setConfirmFolderDelete] = useState<WorkspaceFolder | null>(null);
  const [renameItem, setRenameItem] = useState<WorkspaceItem | null>(null);
  const [renameItemName, setRenameItemName] = useState('');
  const [confirmItemDelete, setConfirmItemDelete] = useState<WorkspaceItem | null>(null);
  const [moveItem, setMoveItem] = useState<WorkspaceItem | null>(null);

  // ---- multi-select + bulk actions --------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoveTarget, setBulkMoveTarget] = useState<string>('');
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const toggleSel = useCallback((id: string) => setSelected((prev) => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next;
  }), []);
  const clearSel = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => setSelected(new Set(items.map((i) => i.id))), [items]);
  const bulkMove = useCallback(async () => {
    setBulkBusy(true); setError(null);
    try {
      for (const id of selected) await patchWorkspaceItem(workspaceId, id, { folderId: bulkMoveTarget || null });
      setBulkMoveOpen(false); clearSel(); refresh();
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBulkBusy(false); }
  }, [selected, bulkMoveTarget, workspaceId, clearSel, refresh]);
  const bulkDelete = useCallback(async () => {
    setBulkBusy(true); setError(null);
    try {
      for (const id of selected) await deleteWorkspaceItem(workspaceId, id);
      setBulkDeleteOpen(false); clearSel(); refresh();
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBulkBusy(false); }
  }, [selected, workspaceId, clearSel, refresh]);
  const openSelected = useCallback(() => {
    for (const id of selected) {
      const it = items.find((x) => x.id === id);
      if (it) window.open(`/items/${it.itemType}/${it.id}`, '_blank', 'noopener');
    }
  }, [selected, items]);

  function openCreateFolder(parent: string | null) { setFolderDialog({ mode: 'create', parent }); setFolderDialogName(''); }
  function openRenameFolder(f: WorkspaceFolder) { setFolderDialog({ mode: 'rename', folderId: f.id, current: f.name }); setFolderDialogName(f.name); }
  async function submitFolderDialog() {
    if (!folderDialog) return;
    const n = folderDialogName.trim();
    if (!n) return;
    if (folderDialog.mode === 'create') await onCreateFolder(n, folderDialog.parent);
    else await onRenameFolder(folderDialog.folderId, n);
    setFolderDialog(null);
  }
  function openRenameItem(it: WorkspaceItem) { setRenameItem(it); setRenameItemName(it.displayName); }
  async function submitRenameItem() {
    if (!renameItem) return;
    const n = renameItemName.trim();
    if (!n) return;
    await onRenameItem(renameItem.id, n);
    setRenameItem(null);
  }

  // ---- drag and drop ----------------------------------------------------
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | 'root' | null>(null);
  function onItemDragStart(e: React.DragEvent, itemId: string) {
    e.dataTransfer.setData('text/plain', `item:${itemId}`);
    e.dataTransfer.effectAllowed = 'move';
    setDragItemId(itemId);
  }
  function onFolderDragOver(e: React.DragEvent, folderId: string | 'root') {
    if (!dragItemId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(folderId);
  }
  function onFolderDragLeave(folderId: string | 'root') {
    setDropTarget((cur) => (cur === folderId ? null : cur));
  }
  async function onFolderDrop(e: React.DragEvent, folderId: string | null) {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/plain');
    setDropTarget(null);
    if (!data?.startsWith('item:')) { setDragItemId(null); return; }
    const itemId = data.slice('item:'.length);
    setDragItemId(null);
    const it = items.find((i) => i.id === itemId);
    if (!it) return;
    if ((it.folderId || null) === folderId) return;
    await onMoveItem(itemId, folderId);
  }

  // ---- renderers --------------------------------------------------------
  function renderItem(it: WorkspaceItem) {
    const meta = findItemType(it.itemType);
    const icon = getItemTypeIcon(it.itemType, meta?.category);
    return (
      <Menu key={it.id} openOnContext>
        <MenuTrigger disableButtonEnhancement>
          <TreeItem itemType="leaf" value={`item:${it.id}`}>
            <TreeItemLayout
              iconBefore={icon}
              onClick={() => router.push(`/items/${it.itemType}/${it.id}`)}
              {...{ draggable: true, onDragStart: (e: React.DragEvent) => onItemDragStart(e, it.id) } as any}
            >
              <span className={s.itemRow}>
                <Checkbox
                  checked={selected.has(it.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSel(it.id)}
                  aria-label={`Select ${it.displayName}`}
                />
                <span>{it.displayName}</span>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  {meta?.displayName ?? it.itemType.replace(/-/g, ' ')}
                </Caption1>
              </span>
            </TreeItemLayout>
          </TreeItem>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => router.push(`/items/${it.itemType}/${it.id}`)}>Open</MenuItem>
            <MenuItem onClick={() => setMoveItem(it)}>Move to folder…</MenuItem>
            <MenuItem onClick={() => openRenameItem(it)}>Rename</MenuItem>
            <MenuItem onClick={() => setConfirmItemDelete(it)}>Delete</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }

  function renderFolder(node: FolderNode) {
    if (!node.folder) return null;
    const f = node.folder;
    const count = countDescendants(node);
    const isExpanded = expanded.has(f.id);
    const isDropTarget = dropTarget === f.id;
    return (
      <Menu key={f.id} openOnContext>
        <MenuTrigger disableButtonEnhancement>
          <TreeItem
            itemType="branch"
            value={`folder:${f.id}`}
            open={isExpanded}
            onOpenChange={(_e, d) => {
              const next = new Set(expanded);
              if (d.open) next.add(f.id); else next.delete(f.id);
              setExpandedAndPersist(next);
            }}
          >
            <TreeItemLayout
              iconBefore={<Folder20Filled style={{ color: 'var(--loom-accent-gold)' }} />}
              className={isDropTarget ? s.treeItemDragOver : undefined}
              {...{
                onDragOver: (e: React.DragEvent) => onFolderDragOver(e, f.id),
                onDragLeave: () => onFolderDragLeave(f.id),
                onDrop: (e: React.DragEvent) => onFolderDrop(e, f.id),
              } as any}
            >
              <span className={s.itemRow}>
                <span>{f.name}</span>
                <Badge appearance="tint" color="informative" size="small" className={s.badge}>{count}</Badge>
              </span>
            </TreeItemLayout>
            {isExpanded && (
              <Tree>
                {node.childFolders.map(renderFolder)}
                {node.childItems.map(renderItem)}
                {count === 0 && (
                  <TreeItem itemType="leaf" value={`folder:${f.id}:empty`}>
                    <TreeItemLayout>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>(empty)</Caption1>
                    </TreeItemLayout>
                  </TreeItem>
                )}
              </Tree>
            )}
          </TreeItem>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => toggleExpanded(f.id)}>{isExpanded ? 'Collapse' : 'Expand'}</MenuItem>
            <MenuItem onClick={() => openCreateFolder(f.id)}>New subfolder…</MenuItem>
            <MenuItem onClick={() => openRenameFolder(f)}>Rename</MenuItem>
            <MenuItem onClick={() => setConfirmFolderDelete(f)}>Delete</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }

  const totalItems = items.length;
  const rootDropActive = dropTarget === 'root';
  const loading = itemsQ.isLoading || foldersQ.isLoading;

  return (
    <div>
      {loading && <Spinner label="Loading items…" />}
      {itemsQ.error && (
        <MessageBar intent="error"><MessageBarBody>Failed to load items: {(itemsQ.error as Error).message}</MessageBarBody></MessageBar>
      )}
      {foldersQ.error && (
        <MessageBar intent="warning"><MessageBarBody>Folders unavailable: {(foldersQ.error as Error).message}</MessageBarBody></MessageBar>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {!loading && totalItems === 0 && folders.length === 0 && (
        <div className={s.empty}>
          <Body1>No items in this workspace yet. Add an item, or create a folder to organize.</Body1>
          <div style={{ marginTop: 12 }}>
            <Button icon={<FolderAdd20Regular />} onClick={() => openCreateFolder(null)} disabled={busy}>New folder</Button>
          </div>
        </div>
      )}

      {(totalItems > 0 || folders.length > 0) && (
        <>
          <div className={s.toolbar}>
            <Button appearance="secondary" icon={<FolderAdd20Regular />} onClick={() => openCreateFolder(null)} disabled={busy}>New folder</Button>
            <div className={s.spacer} />
            <span
              className={`${s.rootDrop} ${rootDropActive ? s.rootDropActive : ''}`}
              onDragOver={(e) => onFolderDragOver(e, 'root')}
              onDragLeave={() => onFolderDragLeave('root')}
              onDrop={(e) => onFolderDrop(e, null)}
            >
              Drop here to move to workspace root
            </span>
          </div>

          {selected.size > 0 && (
            <div className={`${s.toolbar} ${s.bulkBar}`}>
              <Badge appearance="filled" color="brand">{selected.size} selected</Badge>
              <Button size="small" appearance="secondary" icon={<FolderArrowRight20Regular />}
                onClick={() => { setBulkMoveTarget(''); setBulkMoveOpen(true); }} disabled={bulkBusy}>Move to folder…</Button>
              <Button size="small" appearance="secondary" icon={<Open20Regular />} onClick={openSelected}>Open all</Button>
              <Button size="small" appearance="secondary" icon={<Delete20Regular />}
                onClick={() => setBulkDeleteOpen(true)} disabled={bulkBusy}>Delete</Button>
              <div className={s.spacer} />
              <Button size="small" appearance="subtle" onClick={selectAll}>Select all ({items.length})</Button>
              <Button size="small" appearance="subtle" onClick={clearSel}>Clear</Button>
            </div>
          )}

          <div className={s.treeShell}>
            <Tree aria-label="Workspace items">
              {tree.childFolders.map(renderFolder)}
              {tree.childItems.map(renderItem)}
            </Tree>
          </div>

          {/* Bulk move */}
          <Dialog open={bulkMoveOpen} onOpenChange={(_e, d) => { if (!d.open) setBulkMoveOpen(false); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Move {selected.size} item{selected.size === 1 ? '' : 's'}</DialogTitle>
                <DialogContent>
                  <Field label="Destination folder">
                    <Dropdown
                      value={bulkMoveTarget ? (folders.find((f) => f.id === bulkMoveTarget)?.name || 'Folder') : 'Workspace root'}
                      selectedOptions={[bulkMoveTarget || '__root__']}
                      onOptionSelect={(_, d) => setBulkMoveTarget(d.optionValue === '__root__' ? '' : (d.optionValue || ''))}>
                      <Option value="__root__">Workspace root</Option>
                      {folders.map((f) => <Option key={f.id} value={f.id}>{f.name}</Option>)}
                    </Dropdown>
                  </Field>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setBulkMoveOpen(false)} disabled={bulkBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={bulkMove} disabled={bulkBusy}>{bulkBusy ? 'Moving…' : 'Move'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Bulk delete */}
          <Dialog open={bulkDeleteOpen} onOpenChange={(_e, d) => { if (!d.open) setBulkDeleteOpen(false); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Delete {selected.size} item{selected.size === 1 ? '' : 's'}?</DialogTitle>
                <DialogContent>
                  <Body1>This permanently deletes the selected items and their backing artifacts. This cannot be undone.</Body1>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setBulkDeleteOpen(false)} disabled={bulkBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={bulkDelete} disabled={bulkBusy}>{bulkBusy ? 'Deleting…' : `Delete ${selected.size}`}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </>
      )}

      {/* New / rename folder */}
      <Dialog open={!!folderDialog} onOpenChange={(_e, d) => { if (!d.open) setFolderDialog(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{folderDialog?.mode === 'rename' ? 'Rename folder' : 'New folder'}</DialogTitle>
            <DialogContent>
              <Field label="Folder name" required>
                <Input
                  value={folderDialogName}
                  onChange={(_e, d) => setFolderDialogName(d.value)}
                  placeholder="My folder"
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitFolderDialog(); }}
                  autoFocus
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setFolderDialog(null)}>Cancel</Button>
              <Button appearance="primary" disabled={!folderDialogName.trim() || busy} onClick={() => void submitFolderDialog()}>
                {folderDialog?.mode === 'rename' ? 'Rename' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Rename item */}
      <Dialog open={!!renameItem} onOpenChange={(_e, d) => { if (!d.open) setRenameItem(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Rename item</DialogTitle>
            <DialogContent>
              <Field label="Item name" required>
                <Input
                  value={renameItemName}
                  onChange={(_e, d) => setRenameItemName(d.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitRenameItem(); }}
                  autoFocus
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRenameItem(null)}>Cancel</Button>
              <Button appearance="primary" disabled={!renameItemName.trim() || busy} onClick={() => void submitRenameItem()}>Rename</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Confirm delete folder */}
      <Dialog open={!!confirmFolderDelete} onOpenChange={(_e, d) => { if (!d.open) setConfirmFolderDelete(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete folder</DialogTitle>
            <DialogContent>
              <Body1>
                Delete folder &quot;{confirmFolderDelete?.name}&quot;? Any items inside will move to the
                workspace root. Subfolders will also reparent to the root.
              </Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmFolderDelete(null)}>Cancel</Button>
              <Button appearance="primary" disabled={busy}
                onClick={async () => { if (confirmFolderDelete) await onDeleteFolder(confirmFolderDelete.id); setConfirmFolderDelete(null); }}>
                Delete
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Confirm delete item */}
      <Dialog open={!!confirmItemDelete} onOpenChange={(_e, d) => { if (!d.open) setConfirmItemDelete(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete item</DialogTitle>
            <DialogContent>
              <Body1>
                Delete &quot;{confirmItemDelete?.displayName}&quot;? This removes the item from the
                workspace catalog. Linked back-end resources are not affected.
              </Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmItemDelete(null)}>Cancel</Button>
              <Button appearance="primary" disabled={busy}
                onClick={async () => { if (confirmItemDelete) await onDeleteItem(confirmItemDelete.id); setConfirmItemDelete(null); }}>
                Delete
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Move-to-folder picker */}
      <Dialog open={!!moveItem} onOpenChange={(_e, d) => { if (!d.open) setMoveItem(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Move item</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Button appearance="subtle"
                  onClick={async () => { if (moveItem) await onMoveItem(moveItem.id, null); setMoveItem(null); }}>
                  / Workspace root
                </Button>
                {folders.map((f) => (
                  <Button key={f.id} appearance="subtle"
                    icon={<Folder20Filled style={{ color: 'var(--loom-accent-gold)' }} />}
                    onClick={async () => { if (moveItem) await onMoveItem(moveItem.id, f.id); setMoveItem(null); }}>
                    {f.name}
                  </Button>
                ))}
                {folders.length === 0 && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No folders yet. Create one first.</Caption1>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setMoveItem(null)}>Cancel</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
