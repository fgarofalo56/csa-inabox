'use client';

/**
 * WorkspaceSettingsDrawer — Fabric workspace Settings affordance.
 *
 * Ships only the sections backed by real REST today (per no-vaporware):
 *   - General → PATCH /api/workspaces/[id] (name, description, capacity, domain)
 *   - Danger  → DELETE /api/workspaces/[id]
 *
 * Other Fabric sections (Git integration, OneLake, sensitivity, members)
 * are surfaced with honest MessageBars pointing at the work item that
 * will deliver them — never auto-generated form stubs.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Tab, TabList,
  Button, Tooltip, Field, Input, Textarea,
  MessageBar, MessageBarBody,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Settings24Regular, Dismiss24Regular, Delete24Regular,
} from '@fluentui/react-icons';
import { updateWorkspace, deleteWorkspace, type Workspace } from '@/lib/api/workspaces';

interface Props { workspace: Workspace; }

const useStyles = makeStyles({
  trigger: { flexShrink: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: 12 },
  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  honest: { marginTop: 6, fontSize: 12, color: tokens.colorNeutralForeground3 },
});

type TabId = 'general' | 'permissions' | 'git' | 'onelake' | 'sensitivity' | 'danger';

export function WorkspaceSettingsDrawer({ workspace }: Props) {
  const styles = useStyles();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('general');

  return (
    <>
      <Tooltip content="Workspace settings" relationship="label">
        <Button className={styles.trigger} appearance="subtle"
          icon={<Settings24Regular />} onClick={() => setOpen(true)}
          aria-label="Workspace settings" />
      </Tooltip>
      <Drawer open={open} onOpenChange={(_, d) => setOpen(d.open)} position="end" size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={
            <Button appearance="subtle" icon={<Dismiss24Regular />}
              onClick={() => setOpen(false)} aria-label="Close" />
          }>
            Workspace settings
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)} vertical>
            <Tab value="general">General</Tab>
            <Tab value="permissions">Permissions</Tab>
            <Tab value="git">Git integration</Tab>
            <Tab value="onelake">OneLake</Tab>
            <Tab value="sensitivity">Sensitivity</Tab>
            <Tab value="danger">Danger zone</Tab>
          </TabList>
          <div style={{ marginTop: 16 }}>
            {tab === 'general' && <GeneralSection workspace={workspace} onSaved={() => qc.invalidateQueries({ queryKey: ['workspace', workspace.id] })} />}
            {tab === 'permissions' && <DeferredSection
              title="Permissions"
              body="Member + role management needs a backing /api/workspaces/[id]/permissions route + Microsoft Graph SP grants. Tracked for v3.3."
            />}
            {tab === 'git' && <DeferredSection
              title="Git integration"
              body="Fabric Git integration uses Azure DevOps / GitHub PATs. Wiring the connection flow + per-branch deploy is tracked for v3.3."
            />}
            {tab === 'onelake' && <DeferredSection
              title="OneLake"
              body="OneLake URL surfaces from Fabric REST. CSA Loom's OneLake parity ships via the lakehouse editor + ADLS Gen2 explorer today — workspace-level overrides will land in v3.3."
            />}
            {tab === 'sensitivity' && <DeferredSection
              title="Sensitivity label"
              body="Sensitivity labels require Microsoft Purview Information Protection. Workspace-level enforcement lands when the Purview governance pillar wires up (see docs/fiab/v118-handoff.md governance backlog)."
            />}
            {tab === 'danger' && <DangerSection workspace={workspace} onDeleted={() => { setOpen(false); router.push('/workspaces'); }} />}
          </div>
        </DrawerBody>
      </Drawer>
    </>
  );
}

function GeneralSection({ workspace, onSaved }: { workspace: Workspace; onSaved: () => void }) {
  const styles = useStyles();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const [capacity, setCapacity] = useState(workspace.capacity ?? '');
  const [domain, setDomain] = useState(workspace.domain ?? '');

  const mut = useMutation({
    mutationFn: () => updateWorkspace(workspace.id, {
      name: name.trim(),
      description: description.trim() || undefined,
      capacity: capacity.trim() || undefined,
      domain: domain.trim() || undefined,
    }),
    onSuccess: () => {
      onSaved();
      window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: 'workspace' } }));
    },
  });

  return (
    <div className={styles.section}>
      <Field label="Name" required>
        <Input value={name} onChange={(_, d) => setName(d.value)} />
      </Field>
      <Field label="Description">
        <Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={3} resize="vertical" />
      </Field>
      <Field label="Capacity">
        <Input value={capacity} onChange={(_, d) => setCapacity(d.value)} placeholder="shared / F2 / F64…" />
      </Field>
      <Field label="Domain">
        <Input value={domain} onChange={(_, d) => setDomain(d.value)} placeholder="e.g. finance, marketing" />
      </Field>
      {mut.error && (
        <MessageBar intent="error"><MessageBarBody>{(mut.error as Error).message}</MessageBarBody></MessageBar>
      )}
      {mut.isSuccess && !mut.isPending && (
        <MessageBar intent="success"><MessageBarBody>Saved.</MessageBarBody></MessageBar>
      )}
      <div className={styles.row}>
        <Button appearance="primary" onClick={() => mut.mutate()}
          disabled={!name.trim() || mut.isPending}>
          {mut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function DangerSection({ workspace, onDeleted }: { workspace: Workspace; onDeleted: () => void }) {
  const styles = useStyles();
  const [confirmName, setConfirmName] = useState('');
  const mut = useMutation({
    mutationFn: () => deleteWorkspace(workspace.id),
    onSuccess: onDeleted,
  });
  return (
    <div className={styles.section}>
      <MessageBar intent="warning">
        <MessageBarBody>
          Deleting the workspace removes all items, comments, and shares under it.
          Cosmos audit records are kept for compliance. This cannot be undone.
        </MessageBarBody>
      </MessageBar>
      <Field label={`Type "${workspace.name}" to confirm`}>
        <Input value={confirmName} onChange={(_, d) => setConfirmName(d.value)} />
      </Field>
      {mut.error && (
        <MessageBar intent="error"><MessageBarBody>{(mut.error as Error).message}</MessageBarBody></MessageBar>
      )}
      <Dialog>
        <DialogTrigger disableButtonEnhancement>
          <Button appearance="primary" icon={<Delete24Regular />}
            disabled={confirmName !== workspace.name || mut.isPending}>
            Delete workspace
          </Button>
        </DialogTrigger>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete {workspace.name}?</DialogTitle>
            <DialogContent>This is irreversible.</DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={() => mut.mutate()}>Delete</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function DeferredSection({ title, body }: { title: string; body: string }) {
  return (
    <MessageBar intent="info">
      <MessageBarBody>
        <strong>{title}</strong> — {body}
      </MessageBarBody>
    </MessageBar>
  );
}
