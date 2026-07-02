'use client';

/**
 * WorkspaceSettingsDrawer — Fabric workspace Settings affordance.
 *
 * Ships all sections backed by real REST (per no-vaporware):
 *   - General     → PATCH /api/workspaces/[id] (name, description, capacity, domain)
 *   - Permissions → ManageAccessPane (workspace RBAC via Cosmos + real Azure RBAC)
 *   - Networking  → NetworkingPane (private endpoint management)
 *   - Git         → GitIntegrationPane (ADO / GitHub source control)
 *   - OneLake     → ADLS Gen2 binding + lifecycle rules
 *   - Encryption  → CmkPane (customer-managed key)
 *   - Spark       → SparkComputePane (attached Spark pools)
 *   - Sensitivity → WorkspaceSensitivitySection (MIP label taxonomy from Graph;
 *                   labels are applied per-item, not per workspace)
 *   - Danger zone → DELETE /api/workspaces/[id]
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
  Badge, Checkbox,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Settings24Regular, Dismiss24Regular, Delete24Regular,
  Copy16Regular,
} from '@fluentui/react-icons';
import { updateWorkspace, deleteWorkspace, type Workspace } from '@/lib/api/workspaces';
import { ManageAccessPane } from '@/lib/panes/manage-access-pane';
import { NetworkingPane } from '@/lib/panes/networking';
import { GitIntegrationPane } from '@/lib/panes/git-integration';
import { SparkComputePane } from '@/lib/panes/spark-compute';
import { LifecycleRulesPanel } from '@/lib/components/onelake/lifecycle-rules';
import { CmkPane } from '@/lib/panes/cmk';

interface Props {
  workspace: Workspace;
  /** Controlled open state. When provided, the drawer is driven by the parent
   * (e.g. opened from a table row click) instead of its own trigger button. */
  open?: boolean;
  /** Controlled open-change handler. Required for controlled mode. */
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in gear trigger button (used when the parent opens the
   * drawer some other way, e.g. row click). Default false. */
  hideTrigger?: boolean;
}

const useStyles = makeStyles({
  trigger: { flexShrink: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  honest: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    lineHeight: tokens.lineHeightBase200,
  },
});

type TabId = 'general' | 'permissions' | 'networking' | 'git' | 'onelake' | 'encryption' | 'spark' | 'sensitivity' | 'danger';

export function WorkspaceSettingsDrawer({ workspace, open: openProp, onOpenChange, hideTrigger }: Props) {
  const styles = useStyles();
  const router = useRouter();
  const qc = useQueryClient();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (v: boolean) => { onOpenChange ? onOpenChange(v) : setInternalOpen(v); };
  const [tab, setTab] = useState<TabId>('general');

  return (
    <>
      {!hideTrigger && (
        <Tooltip content="Workspace settings" relationship="label">
          <Button className={styles.trigger} appearance="subtle"
            icon={<Settings24Regular />} onClick={() => setOpen(true)}
            aria-label="Workspace settings" />
        </Tooltip>
      )}
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
            <Tab value="encryption">Encryption</Tab>
            <Tab value="spark">Spark compute</Tab>
            <Tab value="sensitivity">Sensitivity</Tab>
            <Tab value="danger">Danger zone</Tab>
          </TabList>
          <div style={{ marginTop: 16 }}>
            {tab === 'general' && <GeneralSection workspace={workspace} onSaved={() => qc.invalidateQueries({ queryKey: ['workspace', workspace.id] })} />}
            {tab === 'permissions' && <ManageAccessPane workspaceId={workspace.id} embeddedMode />}
            {tab === 'networking' && <NetworkingPane workspaceId={workspace.id} />}
            {tab === 'git' && <GitIntegrationPane workspaceId={workspace.id} embeddedMode />}
            {tab === 'onelake' && <OneLakeSection workspace={workspace} />}
            {tab === 'encryption' && <CmkPane workspaceId={workspace.id} />}
            {tab === 'spark' && <SparkComputePane workspaceId={workspace.id} />}
            {tab === 'sensitivity' && <WorkspaceSensitivitySection workspaceId={workspace.id} />}
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

/**
 * WorkspaceSensitivitySection — MIP sensitivity-label guidance for a workspace.
 *
 * Sensitivity labels are applied per-item (lakehouse, warehouse, report, etc.)
 * via the item editor's Sensitivity flyout, which calls the real
 * GET/PUT /api/items/[type]/[id]/sensitivity-label endpoints backed by
 * Microsoft Graph Information Protection. There is no workspace-level label
 * endpoint — the workspace object does not carry a sensitivity label in either
 * the Cosmos schema or the Purview Data Map.
 *
 * This section shows the current label counts from the MIP taxonomy
 * (GET /api/admin/security/mip/labels) and directs users to the surfaces
 * where labels are actually managed. No fake controls.
 */
function WorkspaceSensitivitySection({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [labels, setLabels] = useState<{ id: string; displayName?: string; name?: string; color?: string; sensitivity?: number; isActive?: boolean; tooltip?: string }[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mipConfigured, setMipConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/admin/security/mip/labels')
      .then((r) => r.json())
      .then((d: any) => {
        if (d?.ok && Array.isArray(d.labels)) {
          setLabels(d.labels.filter((l: any) => l.isActive !== false));
          setMipConfigured(true);
        } else if (d?.code === 'mip_not_configured' || d?.code === 'mip_admin_not_configured') {
          setMipConfigured(false);
          setLabels([]);
        } else {
          setError(d?.error || `HTTP error loading labels`);
          setMipConfigured(true);
          setLabels([]);
        }
      })
      .catch((e: any) => { setError(e?.message || String(e)); setLabels([]); })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  return (
    <div className={styles.section}>
      {loading && <Spinner size="tiny" label="Loading sensitivity labels…" />}

      {!loading && mipConfigured === false && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <strong>Microsoft Purview Information Protection is not configured</strong> for this
            deployment. Set <code>LOOM_MIP_ENABLED=true</code> and grant the Console UAMI the{' '}
            <code>InformationProtectionPolicy.Read.All</code> Graph application permission to enable
            the MIP sensitivity label taxonomy. Labels can then be applied per-item in each item's
            editor.
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && mipConfigured === true && !error && (
        <MessageBar intent="info">
          <MessageBarBody>
            <strong>Sensitivity labels are applied per item, not per workspace.</strong> Open any
            item (lakehouse, warehouse, report, etc.) and use the{' '}
            <strong>Sensitivity</strong> action in the item editor to apply a Microsoft Purview
            Information Protection label. The label is recorded in the Loom catalog and, when
            Purview is configured, tagged on the Purview Data Map asset.
            {Array.isArray(labels) && labels.length > 0 && (
              <> {labels.length} label{labels.length !== 1 ? 's' : ''} are active in this tenant.</>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && error && (
        <MessageBar intent="error">
          <MessageBarBody>Could not load sensitivity labels: {error}</MessageBarBody>
        </MessageBar>
      )}

      {!loading && Array.isArray(labels) && labels.length > 0 && (
        <>
          <Subtitle2>Active sensitivity labels ({labels.length})</Subtitle2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
            {labels
              .sort((a, b) => (a.sensitivity ?? 0) - (b.sensitivity ?? 0))
              .map((l) => (
                <div key={l.id} className={styles.row}>
                  {l.color && (
                    <span style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      borderRadius: tokens.borderRadiusCircular,
                      background: l.color,
                      flexShrink: 0,
                    }} />
                  )}
                  <span style={{ fontWeight: 600 }}>{l.displayName || l.name || l.id}</span>
                  {l.tooltip && (
                    <span style={{ color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 }}>
                      — {l.tooltip}
                    </span>
                  )}
                </div>
              ))}
          </div>
          <MessageBar intent="info">
            <MessageBarBody>
              To manage the label taxonomy (create, edit, publish labels), go to{' '}
              <strong>Admin → Security → Sensitivity labels</strong>.
            </MessageBarBody>
          </MessageBar>
        </>
      )}
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
// The Git integration tab now embeds GitIntegrationPane (F12) — Azure-native
// source control over REAL Azure DevOps + GitHub REST: connect, browse
// org/project/repo/branch, commit every workspace item as JSON, live status,
// disconnect. The PAT/SPN secret is stored in Key Vault (never Cosmos). The
// legacy GitSection below is retained (SourceControlPanel depends on its
// types) but no longer wired to the git tab; see lib/panes/git-integration.tsx
// + app/api/admin/workspaces/[id]/git/**.

interface GitBinding {
  provider: 'github' | 'ado';
  repoHost: string; repoPath: string; repoUrl: string;
  branch: string; directory?: string;
  status: string; connectedBy: string; connectedAt: string;
  patSecretRef?: string;
  lastSyncedSha?: string;
}

interface GitChange {
  itemId?: string;
  itemType: string;
  displayName: string;
  status: 'modified' | 'added' | 'removed';
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
    if (!r.ok) { setError(j?.detail || j?.error || `HTTP ${r.status}`); setBusy(false); return; }
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
          Connect an Azure DevOps or GitHub repository, then commit and update
          workspace items directly from Loom. Each item is serialized to a
          canonical text form (TMSL <code>model.bim</code> for semantic models,
          PBIR for reports, JSON for everything else). The PAT is stored in Key
          Vault — never in Cosmos or returned to the browser.
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
      <Field label={provider === 'ado' ? 'Repository path (org/project/_git/repo)' : 'Repository path (owner/repo)'} required>
        <Input value={repoPath} onChange={(_, d) => setRepoPath(d.value)}
          placeholder={provider === 'ado' ? 'myorg/myproject/_git/myrepo' : 'owner/repo'} />
      </Field>
      <Field label="Branch">
        <Input value={branch} onChange={(_, d) => setBranch(d.value)} placeholder="main" />
      </Field>
      <Field label="Directory (optional)">
        <Input value={directory} onChange={(_, d) => setDirectory(d.value)}
          placeholder="fabric-items/" />
      </Field>
      <Field label={provider === 'ado'
        ? 'PAT (Code: Read & Write scope; stored in Key Vault)'
        : 'PAT (repo scope; stored in Key Vault)'}>
        <Input value={pat} onChange={(_, d) => setPat(d.value)} type="password"
          placeholder={binding && binding !== 'loading' && binding.patSecretRef ? '•••••• (on file — leave blank to keep)' : ''} />
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

      {binding && binding !== 'loading' && (
        <>
          <Divider />
          <Subtitle2>Source control</Subtitle2>
          <SourceControlPanel workspaceId={workspaceId} binding={binding} />
        </>
      )}
    </div>
  );
}

// ------------------------- Source control panel -------------------------

function SourceControlPanel({ workspaceId, binding }: { workspaceId: string; binding: GitBinding }) {
  const styles = useStyles();
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const [changed, setChanged] = useState<GitChange[] | null>(null);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [resolveTarget, setResolveTarget] = useState<GitChange | null>(null);

  const fetchStatus = async () => {
    setStatus('loading'); setNote(null);
    try {
      const r = await fetch(`/api/git-integration/status?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        setChanged(null);
        setNote({ intent: 'warning', text: j?.detail || j?.error || `Status failed (HTTP ${r.status})` });
        return;
      }
      setChanged(j.changed || []);
      setHeadSha(j.headSha || null);
      const sel: Record<string, boolean> = {};
      for (const c of j.changed || []) if (c.itemId && c.status !== 'removed') sel[c.itemId] = true;
      setSelected(sel);
    } catch (e: any) {
      setNote({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setStatus('idle');
    }
  };

  useEffect(() => { fetchStatus(); }, [workspaceId]);

  const selectedIds = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);

  const commit = async () => {
    if (selectedIds.length === 0) { setNote({ intent: 'warning', text: 'Select at least one item to commit.' }); return; }
    setBusy(true); setNote(null);
    try {
      const r = await fetch('/api/git-integration/commit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, itemIds: selectedIds, message: message || 'Loom commit' }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setNote({ intent: 'error', text: j?.detail || j?.error || `Commit failed (HTTP ${r.status})` }); return; }
      setNote({ intent: 'success', text: `Committed ${j.files} file(s) — ${String(j.commitSha).slice(0, 8)}` });
      setMessage('');
      await fetchStatus();
    } finally { setBusy(false); }
  };

  const update = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch('/api/git-integration/pull', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setNote({ intent: 'error', text: j?.detail || j?.error || `Update failed (HTTP ${r.status})` }); return; }
      setNote({ intent: 'success', text: `Updated ${j.applied} item(s) from ${String(j.headSha || '').slice(0, 8)}` });
      await fetchStatus();
    } finally { setBusy(false); }
  };

  const resolve = async (target: GitChange, resolution: 'local' | 'remote') => {
    if (!target.itemId) return;
    setBusy(true); setNote(null); setResolveTarget(null);
    try {
      const r = await fetch('/api/git-integration/resolve', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, itemId: target.itemId, resolution }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setNote({ intent: 'error', text: j?.detail || j?.error || `Resolve failed (HTTP ${r.status})` }); return; }
      setNote({
        intent: 'success',
        text: resolution === 'local'
          ? `Kept local — committed ${String(j.commitSha || '').slice(0, 8)}`
          : `Took from repo — applied to ${target.displayName}`,
      });
      await fetchStatus();
    } finally { setBusy(false); }
  };

  const badge = (s: GitChange['status']) =>
    s === 'added' ? <Badge color="success" appearance="tint">added</Badge>
      : s === 'removed' ? <Badge color="danger" appearance="tint">removed</Badge>
        : <Badge color="warning" appearance="tint">modified</Badge>;

  return (
    <div className={styles.section}>
      <div className={styles.honest}>
        Repo: <code>{binding.repoHost}/{binding.repoPath}</code> · branch <code>{binding.branch}</code>
        {binding.lastSyncedSha && <> · last sync <code>{binding.lastSyncedSha.slice(0, 8)}</code></>}
        {headSha && <> · HEAD <code>{headSha.slice(0, 8)}</code></>}
      </div>
      <div className={styles.row}>
        <Button appearance="secondary" onClick={fetchStatus} disabled={status === 'loading' || busy}>
          {status === 'loading' ? 'Fetching…' : 'Fetch status'}
        </Button>
        <Button appearance="secondary" onClick={update} disabled={busy || status === 'loading'}>Update (pull)</Button>
      </div>

      {note && <MessageBar intent={note.intent}><MessageBarBody>{note.text}</MessageBarBody></MessageBar>}

      {status !== 'loading' && changed && changed.length === 0 && (
        <div className={styles.honest}>No changes — workspace matches the repo.</div>
      )}

      {changed && changed.length > 0 && (
        <>
          {changed.map((c, i) => (
            <div key={(c.itemId || c.displayName) + i} className={styles.row} style={{ justifyContent: 'space-between' }}>
              <div className={styles.row}>
                {c.itemId && c.status !== 'removed' && (
                  <Checkbox checked={!!selected[c.itemId]}
                    onChange={(_, d) => setSelected(s => ({ ...s, [c.itemId!]: !!d.checked }))} />
                )}
                <span>{c.displayName}.{c.itemType}</span>
                {badge(c.status)}
              </div>
              {c.status === 'modified' && c.itemId && (
                <Button size="small" appearance="subtle" onClick={() => setResolveTarget(c)}>Resolve…</Button>
              )}
            </div>
          ))}
          <Field label="Commit message">
            <Input value={message} onChange={(_, d) => setMessage(d.value)} placeholder="Update workspace items" />
          </Field>
          <div className={styles.row}>
            <Button appearance="primary" onClick={commit} disabled={busy || selectedIds.length === 0}>
              {busy ? 'Working…' : `Commit selected (${selectedIds.length})`}
            </Button>
          </div>
        </>
      )}

      <Dialog open={!!resolveTarget} onOpenChange={(_, d) => { if (!d.open) setResolveTarget(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Resolve conflict — {resolveTarget?.displayName}</DialogTitle>
            <DialogContent>
              This item differs between Loom and the repo. Choose which version wins:
              <ul>
                <li><strong>Keep local</strong> — commit your Loom version, overwriting the repo.</li>
                <li><strong>Take from repo</strong> — overwrite the Loom item with the repo version.</li>
              </ul>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => resolveTarget && resolve(resolveTarget, 'local')} disabled={busy}>Keep local</Button>
              <Button appearance="primary" onClick={() => resolveTarget && resolve(resolveTarget, 'remote')} disabled={busy}>Take from repo</Button>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="subtle">Cancel</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
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
