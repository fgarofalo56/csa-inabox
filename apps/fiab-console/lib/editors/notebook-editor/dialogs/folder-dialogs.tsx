'use client';

// notebook-editor/dialogs/folder-dialogs.tsx — the four self-contained
// notebook explorer-tree dialogs (folder create/rename, folder delete, move
// notebook, notebook rename), extracted from notebook-editor.tsx (R9
// decomposition). Each is a thin prop-driven component; the JSX is verbatim
// from the shell — only the closed-over state/handlers become props, so
// behavior is preserved. The shell keeps the owning state + handlers.
import {
  Button, Input, Field, Caption1,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  tokens,
} from '@fluentui/react-components';
import { FolderArrowRight20Regular, Folder20Filled } from '@fluentui/react-icons';
import type { WorkspaceFolder } from '@/lib/api/workspaces';
import type { NotebookLite } from '../types';

export type NbFolderDialogState =
  | { mode: 'create'; parent: string | null }
  | { mode: 'rename'; folderId: string; current: string }
  | null;

/** New / rename notebook folder. */
export function NbFolderDialog(props: {
  state: NbFolderDialogState;
  onClose: () => void;
  name: string;
  onNameChange: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  const { state, onClose, name, onNameChange, busy, onSubmit } = props;
  return (
    <Dialog open={!!state} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{state?.mode === 'rename' ? 'Rename folder' : 'New folder'}</DialogTitle>
          <DialogContent>
            <Field label="Folder name" required>
              <Input value={name} onChange={(_e, d) => onNameChange(d.value)} placeholder="My folder"
                onKeyDown={(e) => { if (e.key === 'Enter') void onSubmit(); }} autoFocus />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!name.trim() || busy} onClick={() => void onSubmit()}>
              {state?.mode === 'rename' ? 'Rename' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Confirm delete notebook folder (cascade reparents to root). */
export function NbFolderDeleteDialog(props: {
  target: WorkspaceFolder | null;
  onClose: () => void;
  busy: boolean;
  onDelete: (id: string) => Promise<void> | void;
}) {
  const { target, onClose, busy, onDelete } = props;
  return (
    <Dialog open={!!target} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Delete folder</DialogTitle>
          <DialogContent>
            <Caption1>
              Delete folder &quot;{target?.name}&quot;? Notebooks inside move to the workspace root;
              subfolders reparent to the root.
            </Caption1>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={busy}
              onClick={async () => { if (target) await onDelete(target.id); onClose(); }}>
              Delete
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Move notebook to folder. */
export function NbMoveDialog(props: {
  target: NotebookLite | null;
  onClose: () => void;
  folders: WorkspaceFolder[];
  onMove: (nbId: string, folderId: string | null) => Promise<void> | void;
}) {
  const { target, onClose, folders, onMove } = props;
  return (
    <Dialog open={!!target} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Move notebook</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
              <Button appearance="subtle" icon={<FolderArrowRight20Regular />}
                onClick={async () => { if (target) await onMove(target.id, null); onClose(); }}>
                / Workspace root
              </Button>
              {folders.map((f) => (
                <Button key={f.id} appearance="subtle"
                  icon={<Folder20Filled style={{ color: 'var(--loom-accent-gold)' }} />}
                  onClick={async () => { if (target) await onMove(target.id, f.id); onClose(); }}>
                  {f.name}
                </Button>
              ))}
              {folders.length === 0 && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No folders yet. Create one first.</Caption1>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** R4-NB-8 — Inline notebook rename. */
export function NbRenameDialog(props: {
  open: boolean;
  onClose: () => void;
  value: string;
  onValueChange: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  const { open, onClose, value, onValueChange, busy, onSubmit } = props;
  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Rename notebook</DialogTitle>
          <DialogContent>
            <Field label="Name" required>
              <Input value={value} onChange={(_e, d) => onValueChange(d.value)} autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') void onSubmit(); }} />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!value.trim() || busy} onClick={() => void onSubmit()}>
              {busy ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
