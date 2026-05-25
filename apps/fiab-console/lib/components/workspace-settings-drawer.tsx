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

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Tab, TabList,
  Button, Tooltip, Field, Input, Textarea, Dropdown, Option,
  MessageBar, MessageBarBody, Spinner,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Settings24Regular, Dismiss24Regular, Delete24Regular,
  Person24Regular, BranchFork24Regular, Database24Regular,
  Copy16Regular,
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
            {tab === 'permissions' && <PermissionsSection workspaceId={workspace.id} />}
            {tab === 'git' && <GitSection workspaceId={workspace.id} />}
            {tab === 'onelake' && <OneLakeSection workspace={workspace} />}
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

// ------------------------------ Permissions ------------------------------

interface PermissionRow {
  id: string; upn: string; name?: string; role: 'admin' | 'contributor' | 'viewer';
  addedBy: string; addedAt: string; implicit?: boolean;
}

function PermissionsSection({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [rows, setRows] = useState<PermissionRow[] | null>(null);
  const [upn, setUpn] = useState('');
  const [role, setRole] = useState<PermissionRow['role']>('contributor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch(`/api/workspaces/${workspaceId}/permissions`).then(r => r.json())
      .then(d => setRows(d?.permissions ?? []))
      .catch(() => setRows([]));

  useEffect(() => { load(); }, [workspaceId]);

  const add = async () => {
    if (!upn.trim()) return;
    setBusy(true); setError(null);
    const r = await fetch(`/api/workspaces/${workspaceId}/permissions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upn: upn.trim(), role }),
    });
    const j = await r.json();
    if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); setBusy(false); return; }
    setUpn(''); setBusy(false); load();
  };

  const remove = async (rowUpn: string) => {
    await fetch(`/api/workspaces/${workspaceId}/permissions?upn=${encodeURIComponent(rowUpn)}`,
      { method: 'DELETE' });
    load();
  };

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <Field label="UPN (email)" style={{ flex: 2 }}>
          <Input value={upn} onChange={(_, d) => setUpn(d.value)} placeholder="user@tenant.com" />
        </Field>
        <Field label="Role">
          <Dropdown value={role} selectedOptions={[role]}
            onOptionSelect={(_, d) => setRole((d.optionValue || 'contributor') as PermissionRow['role'])}>
            <Option value="admin">Admin</Option>
            <Option value="contributor">Contributor</Option>
            <Option value="viewer">Viewer</Option>
          </Dropdown>
        </Field>
        <Button appearance="primary" onClick={add} disabled={!upn.trim() || busy}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {rows === null && <Spinner size="tiny" label="Loading…" />}
      {rows !== null && rows.map(r => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: 8,
          border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
        }}>
          <Person24Regular />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{r.upn}</div>
            <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>
              {r.role}{r.implicit ? ' (workspace owner)' : ` · added by ${r.addedBy} on ${new Date(r.addedAt).toLocaleDateString()}`}
            </div>
          </div>
          {!r.implicit && (
            <Button appearance="subtle" size="small" icon={<Delete24Regular />}
              onClick={() => remove(r.upn)} aria-label={`Remove ${r.upn}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------ Git ------------------------------

interface GitBinding {
  provider: 'github' | 'ado';
  repoUrl: string; branch: string; directory?: string;
  status: string; connectedBy: string; connectedAt: string;
  patHash?: string;
}

function GitSection({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [binding, setBinding] = useState<GitBinding | null | 'loading'>('loading');
  const [provider, setProvider] = useState<GitBinding['provider']>('github');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [directory, setDirectory] = useState('');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch(`/api/workspaces/${workspaceId}/git`).then(r => r.json())
      .then(d => {
        setBinding(d?.git ?? null);
        if (d?.git) {
          setProvider(d.git.provider);
          setRepoUrl(d.git.repoUrl);
          setBranch(d.git.branch || 'main');
          setDirectory(d.git.directory || '');
        }
      })
      .catch(() => setBinding(null));

  useEffect(() => { load(); }, [workspaceId]);

  const save = async () => {
    setBusy(true); setError(null);
    const r = await fetch(`/api/workspaces/${workspaceId}/git`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, repoUrl, branch, directory: directory || undefined,
        pat: pat || undefined }),
    });
    const j = await r.json();
    if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); setBusy(false); return; }
    setPat(''); setBusy(false); load();
  };

  const disconnect = async () => {
    await fetch(`/api/workspaces/${workspaceId}/git`, { method: 'DELETE' });
    setBinding(null); setRepoUrl(''); setDirectory('');
  };

  return (
    <div className={styles.section}>
      <MessageBar intent="info">
        <MessageBarBody>
          Records the workspace's Git binding. Loom does not execute Git on
          your behalf — you clone the repo, edit, and push with your own
          tooling. PAT is hashed before storage; never sent anywhere.
        </MessageBarBody>
      </MessageBar>
      {binding === 'loading' && <Spinner size="tiny" label="Loading…" />}
      <Field label="Provider">
        <Dropdown value={provider} selectedOptions={[provider]}
          onOptionSelect={(_, d) => setProvider((d.optionValue || 'github') as GitBinding['provider'])}>
          <Option value="github">GitHub</Option>
          <Option value="ado">Azure DevOps</Option>
        </Dropdown>
      </Field>
      <Field label="Repository URL" required>
        <Input value={repoUrl} onChange={(_, d) => setRepoUrl(d.value)}
          placeholder="https://github.com/org/repo" />
      </Field>
      <Field label="Branch">
        <Input value={branch} onChange={(_, d) => setBranch(d.value)} placeholder="main" />
      </Field>
      <Field label="Directory (optional)">
        <Input value={directory} onChange={(_, d) => setDirectory(d.value)}
          placeholder="fabric-items/" />
      </Field>
      <Field label="PAT (optional; hashed, never stored in clear)">
        <Input value={pat} onChange={(_, d) => setPat(d.value)} type="password" />
      </Field>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      <div className={styles.row}>
        <Button appearance="primary" onClick={save}
          disabled={!repoUrl.trim() || busy}>
          {busy ? 'Saving…' : (binding && binding !== 'loading' ? 'Update' : 'Connect')}
        </Button>
        {binding && binding !== 'loading' && (
          <Button appearance="subtle" onClick={disconnect}>Disconnect</Button>
        )}
      </div>
      {binding && binding !== 'loading' && binding.patHash && (
        <div className={styles.honest}>
          PAT hash on file: <code>{binding.patHash}</code>
        </div>
      )}
    </div>
  );
}

// ------------------------------ OneLake ------------------------------

function OneLakeSection({ workspace }: { workspace: Workspace }) {
  const styles = useStyles();
  const url = (workspace as any).oneLake as string | null | undefined;
  // Fall back to a GET when the prop isn't hydrated.
  const [resolved, setResolved] = useState<string | null | undefined>(url);
  useEffect(() => {
    if (resolved !== undefined) return;
    fetch(`/api/workspaces/${workspace.id}`).then(r => r.json())
      .then((d: any) => setResolved(d?.oneLake ?? null))
      .catch(() => setResolved(null));
  }, [workspace.id, resolved]);

  if (resolved === undefined) return <Spinner size="tiny" label="Loading…" />;

  if (!resolved) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          OneLake base URL not configured for this deployment. Set
          <code style={{ padding: '0 4px' }}>LOOM_ONELAKE_BASE</code> on the
          loom-console container app (e.g.
          <code style={{ padding: '0 4px' }}>abfss://onelake@&lt;account&gt;.dfs.core.windows.net</code>)
          to surface the per-workspace URL.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={styles.section}>
      <MessageBar intent="success">
        <MessageBarBody>
          This workspace's OneLake URL is derived from
          <code style={{ padding: '0 4px' }}>LOOM_ONELAKE_BASE + workspace name</code>.
          Items in the workspace store their data under this prefix.
        </MessageBarBody>
      </MessageBar>
      <Field label="OneLake URL">
        <Input value={resolved} readOnly />
      </Field>
      <div className={styles.row}>
        <Button icon={<Copy16Regular />}
          onClick={() => navigator.clipboard?.writeText(resolved)}>
          Copy
        </Button>
      </div>
    </div>
  );
}
