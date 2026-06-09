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

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Tab, TabList,
  Button, Tooltip, Field, Input, Textarea, Dropdown, Option,
  MessageBar, MessageBarBody, Spinner, Divider, Subtitle2,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Settings24Regular, Dismiss24Regular, Delete24Regular,
  BranchFork24Regular, Database24Regular,
  Copy16Regular,
} from '@fluentui/react-icons';
import { updateWorkspace, deleteWorkspace, type Workspace } from '@/lib/api/workspaces';
import { ManageAccessPane } from '@/lib/panes/manage-access-pane';
import { NetworkingPane } from '@/lib/panes/networking';
import { LifecycleRulesPanel } from '@/lib/components/onelake/lifecycle-rules';

interface Props { workspace: Workspace; }

const useStyles = makeStyles({
  trigger: { flexShrink: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: 12 },
  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  honest: { marginTop: 6, fontSize: 12, color: tokens.colorNeutralForeground3 },
});

type TabId = 'general' | 'permissions' | 'networking' | 'git' | 'onelake' | 'sensitivity' | 'danger';

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
            <Tab value="networking">Networking</Tab>
            <Tab value="git">Git integration</Tab>
            <Tab value="onelake">OneLake</Tab>
            <Tab value="sensitivity">Sensitivity</Tab>
            <Tab value="danger">Danger zone</Tab>
          </TabList>
          <div style={{ marginTop: 16 }}>
            {tab === 'general' && <GeneralSection workspace={workspace} onSaved={() => qc.invalidateQueries({ queryKey: ['workspace', workspace.id] })} />}
            {tab === 'permissions' && <ManageAccessPane workspaceId={workspace.id} embeddedMode />}
            {tab === 'networking' && <NetworkingPane workspaceId={workspace.id} />}
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
// The Permissions tab now embeds ManageAccessPane (F5) — Azure-native
// workspace RBAC backed by Cosmos `workspace-roles` + real Azure RBAC role
// assignments, with Entra principal (user/group) search. The legacy UPN-only
// PermissionsSection was replaced; see lib/panes/manage-access-pane.tsx.

// ------------------------------ Git ------------------------------

interface GitBinding {
  provider: 'github' | 'ado';
  repoHost: string; repoPath: string; repoUrl: string;
  branch: string; directory?: string;
  status: string; connectedBy: string; connectedAt: string;
  patHash?: string;
}

function GitSection({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [binding, setBinding] = useState<GitBinding | null | 'loading'>('loading');
  const [provider, setProvider] = useState<GitBinding['provider']>('github');
  const [repoHost, setRepoHost] = useState('github.com');
  const [repoPath, setRepoPath] = useState('');
  const [branch, setBranch] = useState('main');
  const [directory, setDirectory] = useState('');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch(`/api/workspaces/${workspaceId}/scm`).then(r => r.json())
      .then(d => {
        setBinding(d?.git ?? null);
        if (d?.git) {
          setProvider(d.git.provider);
          setRepoHost(d.git.repoHost || (d.git.provider === 'github' ? 'github.com' : 'dev.azure.com'));
          setRepoPath(d.git.repoPath || '');
          setBranch(d.git.branch || 'main');
          setDirectory(d.git.directory || '');
        }
      })
      .catch(() => setBinding(null));

  useEffect(() => { load(); }, [workspaceId]);

  const save = async () => {
    setBusy(true); setError(null);
    const r = await fetch(`/api/workspaces/${workspaceId}/scm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider, repoHost, repoPath, branch,
        directory: directory || undefined,
        pat: pat || undefined,
      }),
    });
    const j = await r.json();
    if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); setBusy(false); return; }
    setPat(''); setBusy(false); load();
  };

  const disconnect = async () => {
    await fetch(`/api/workspaces/${workspaceId}/scm`, { method: 'DELETE' });
    setBinding(null); setRepoHost('github.com'); setRepoPath(''); setDirectory('');
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
      <Field label="Repository host" required>
        <Input value={repoHost} onChange={(_, d) => setRepoHost(d.value)}
          placeholder="github.com / dev.azure.com" />
      </Field>
      <Field label="Repository path" required>
        <Input value={repoPath} onChange={(_, d) => setRepoPath(d.value)}
          placeholder="org/repo" />
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
          disabled={!repoHost.trim() || !repoPath.trim() || busy}>
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

interface StorageAccountOption { id: string; name: string; isHns: boolean; location?: string; }

function StorageBindingSection({ workspace }: { workspace: Workspace }) {
  const styles = useStyles();
  const [accounts, setAccounts] = useState<StorageAccountOption[] | null | 'loading'>('loading');
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(workspace.storageAccountId ?? '');
  const [manual, setManual] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/storage/accounts').then((r) => r.json())
      .then((d: any) => {
        if (d?.ok && Array.isArray(d.accounts)) {
          setAccounts(d.accounts.map((a: any) => ({ id: a.id, name: a.name, isHns: a.isHns, location: a.location })));
        } else {
          setAccounts(null);
          setAccountsError(d?.hint || d?.error || 'Could not list storage accounts.');
        }
      })
      .catch((e) => { setAccounts(null); setAccountsError(String(e?.message || e)); });
  }, []);

  const currentName = useMemo(() => {
    const id = selected || manual;
    return id ? id.split('/').pop() : undefined;
  }, [selected, manual]);

  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const storageAccountId = (selected || manual).trim();
      await updateWorkspace(workspace.id, { storageAccountId: storageAccountId || undefined });
      setSaved(true);
      window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: 'workspace' } }));
    } catch (e: any) {
      setError(e?.message || 'Failed to save binding');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.section}>
      <Subtitle2>Storage account binding</Subtitle2>
      <MessageBar intent="info">
        <MessageBarBody>
          Bind this workspace to a specific ADLS Gen2 storage account. Lifecycle
          management rules (below) are written to the bound account. When unbound,
          the deployment-default DLZ account is used.
        </MessageBarBody>
      </MessageBar>
      {accounts === 'loading' && <Spinner size="tiny" label="Listing storage accounts…" />}
      {Array.isArray(accounts) && (
        <Field label="Storage account">
          <Dropdown
            value={currentName ? `${currentName}` : 'Not bound (deployment default)'}
            selectedOptions={[selected]}
            onOptionSelect={(_, d) => { setSelected(d.optionValue || ''); setManual(''); }}>
            <Option value="">Not bound (deployment default)</Option>
            {accounts.map((a) => (
              <Option key={a.id} value={a.id} text={a.name}>
                {a.name} ({a.isHns ? 'ADLS Gen2' : 'Blob'}){a.location ? ` — ${a.location}` : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}
      {accounts === null && (
        <>
          <MessageBar intent="warning">
            <MessageBarBody>
              Reader role on the subscription is required to list storage accounts
              (<code>Microsoft.Storage/storageAccounts/read</code>). {accountsError} You
              can paste the storage account ARM resource id manually below.
            </MessageBarBody>
          </MessageBar>
          <Field label="Storage account ARM resource id">
            <Input value={manual} onChange={(_, d) => { setManual(d.value); setSelected(''); }}
              placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Storage/storageAccounts/…" />
          </Field>
        </>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {saved && <MessageBar intent="success"><MessageBarBody>Binding saved.</MessageBarBody></MessageBar>}
      <div className={styles.row}>
        <Button appearance="primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save binding'}
        </Button>
      </div>
    </div>
  );
}

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

  return (
    <div className={styles.section}>
      <StorageBindingSection workspace={workspace} />

      <Divider />
      <Subtitle2>OneLake URL</Subtitle2>
      {resolved === undefined ? (
        <Spinner size="tiny" label="Loading…" />
      ) : !resolved ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            OneLake base URL not configured for this deployment. Set
            <code style={{ padding: '0 4px' }}>LOOM_ONELAKE_BASE</code> on the
            loom-console container app (e.g.
            <code style={{ padding: '0 4px' }}>abfss://onelake@&lt;account&gt;.dfs.core.windows.net</code>)
            to surface the per-workspace URL.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <>
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
        </>
      )}

      <Divider />
      <Subtitle2>Lifecycle management rules</Subtitle2>
      <LifecycleRulesPanel workspaceId={workspace.id} />
    </div>
  );
}
