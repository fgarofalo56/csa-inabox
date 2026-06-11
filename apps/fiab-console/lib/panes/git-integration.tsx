'use client';

/**
 * GitIntegrationPane — F12 Git integration, Azure-native parity with the Fabric
 * workspace "Git integration" panel.
 *
 * Source UI (Fabric): Workspace → Settings → Git integration — provider radio,
 * org/project/repo/branch/folder dropdowns, Connect & sync, a current-branch
 * chip, last-sync time, and Disconnect. This rebuilds that one-for-one with the
 * Loom theme over real Azure DevOps + GitHub REST (per ui-parity.md).
 *
 * Backend (all real, per no-vaporware.md):
 *   GET    /api/admin/workspaces/{id}/git            binding + cloud caps
 *   GET    /api/admin/workspaces/{id}/git/meta       chained dropdown metadata
 *   POST   /api/admin/workspaces/{id}/git            connect (validates live)
 *   POST   /api/admin/workspaces/{id}/git/sync       commit items → real SHA
 *   GET    /api/admin/workspaces/{id}/git/status     live head commit
 *   DELETE /api/admin/workspaces/{id}/git            disconnect
 *
 * GitHub is hidden in GCC-High / IL5 (githubAvailable=false) with an honest note;
 * Azure DevOps works in every cloud.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Field, Input, Dropdown, Option, Button, Spinner, Badge, Divider,
  Radio, RadioGroup, Caption1, Body1Strong, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BranchFork24Regular, ArrowSync20Regular, PlugDisconnected20Regular,
  Branch16Regular, Checkmark16Filled, Copy16Regular,
} from '@fluentui/react-icons';

type Provider = 'ado' | 'github';
type AuthMethod = 'pat' | 'spn';

interface BindingView {
  provider: Provider;
  adoOrg?: string; adoProject?: string; repoId?: string; repoName?: string;
  githubOwner?: string; githubRepo?: string; githubHost?: string;
  branch: string; folder: string;
  authMethod: AuthMethod;
  status: 'connected' | 'error';
  connectedBy: string; connectedAt: string;
  lastSyncAt?: string; lastSyncCommitId?: string; lastSyncFileCount?: number; lastSyncError?: string;
  hasSecret: boolean;
}

interface CloudCaps { boundary: string; label: string; githubAvailable: boolean; }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  chipRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  card: {
    display: 'flex', flexDirection: 'column', gap: '10px',
    padding: '14px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  meta: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px' },
  spacer: { flex: 1 },
  grow: { flex: 1 },
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '120px', padding: '14px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  commit: {
    display: 'inline-flex', alignItems: 'center', gap: '2px',
    fontFamily: tokens.fontFamilyMonospace, fontSize: '12px',
  },
});

async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

/** Short commit SHA with a one-click copy affordance (Fabric/portal pattern). */
function CommitSha({ sha }: { sha: string }) {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(sha).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [sha]);
  return (
    <span className={styles.commit}>
      <span className={styles.mono}>{sha.slice(0, 8)}</span>
      <Tooltip content={copied ? 'Copied' : 'Copy full commit SHA'} relationship="label">
        <Button
          appearance="subtle" size="small"
          icon={copied ? <Checkmark16Filled /> : <Copy16Regular />}
          onClick={copy} aria-label="Copy commit SHA"
        />
      </Tooltip>
    </span>
  );
}

export function GitIntegrationPane({ workspaceId, embeddedMode: _embeddedMode }: { workspaceId: string; embeddedMode?: boolean }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(true);
  const [binding, setBinding] = useState<BindingView | null>(null);
  const [caps, setCaps] = useState<CloudCaps | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const { res, json } = await getJson(`/api/admin/workspaces/${workspaceId}/git`);
    if (!res.ok || !json.ok) { setLoadError(json?.error || `HTTP ${res.status}`); setLoading(false); return; }
    setBinding(json.git || null);
    setCaps(json.cloud || null);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className={styles.loading}><Spinner size="small" label="Loading Git integration…" /></div>;

  return (
    <div className={styles.root}>
      {loadError && <MessageBar intent="error"><MessageBarBody>{loadError}</MessageBarBody></MessageBar>}
      {binding
        ? <ConnectedView workspaceId={workspaceId} binding={binding} onChanged={load} />
        : <ConnectWizard workspaceId={workspaceId} caps={caps} onConnected={load} />}
    </div>
  );
}

// ========================================================================
// Connected view — chip + last sync + Sync now + Disconnect + live status
// ========================================================================

function ConnectedView({ workspaceId, binding, onChanged }: { workspaceId: string; binding: BindingView; onChanged: () => void }) {
  const styles = useStyles();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [remoteHead, setRemoteHead] = useState<{ commitId: string; commitDate?: string; authorName?: string } | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const ghHostLabel = binding.githubHost
    ? (binding.githubHost.includes('.') ? binding.githubHost.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : `${binding.githubHost}.ghe.com`)
    : 'github.com';
  const repoLabel = binding.provider === 'ado'
    ? `${binding.adoOrg}/${binding.adoProject}/${binding.repoName || binding.repoId}`
    : `${binding.githubOwner}/${binding.githubRepo}`;

  const loadStatus = useCallback(async () => {
    const { res, json } = await getJson(`/api/admin/workspaces/${workspaceId}/git/status`);
    if (res.ok && json.ok) { setRemoteHead(json.remoteHead || null); setRemoteError(json.remoteError || null); }
  }, [workspaceId]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const sync = useCallback(async () => {
    setSyncing(true); setSyncMsg(null);
    const { res, json } = await getJson(`/api/admin/workspaces/${workspaceId}/git/sync`, { method: 'POST' });
    if (!res.ok || !json.ok) {
      setSyncMsg({ intent: 'error', text: json?.error || `HTTP ${res.status}` });
    } else {
      setSyncMsg({ intent: 'success', text: `Committed ${json.itemCount} item(s) in ${json.fileCount} file(s). Commit ${String(json.commitId).slice(0, 8)}.` });
      onChanged();
      void loadStatus();
    }
    setSyncing(false);
  }, [workspaceId, onChanged, loadStatus]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    await fetch(`/api/admin/workspaces/${workspaceId}/git`, { method: 'DELETE' });
    setDisconnecting(false);
    onChanged();
  }, [workspaceId, onChanged]);

  return (
    <div className={styles.card}>
      <div className={styles.chipRow}>
        <Badge appearance="filled" color="brand" icon={<Branch16Regular />}>{binding.branch}</Badge>
        <Body1Strong>{repoLabel}</Body1Strong>
        <Badge appearance="outline" color={binding.provider === 'ado' ? 'informative' : 'subtle'}>
          {binding.provider === 'ado' ? 'Azure DevOps' : 'GitHub'}
        </Badge>
        {binding.provider === 'github' && (
          <Badge appearance="outline" color={binding.githubHost ? 'brand' : 'subtle'}>{ghHostLabel}</Badge>
        )}
        {binding.status === 'connected'
          ? <Badge appearance="tint" color="success" icon={<Checkmark16Filled />}>Connected</Badge>
          : <Badge appearance="tint" color="danger">Error</Badge>}
      </div>

      <Caption1 className={styles.meta}>
        Folder <span className={styles.mono}>{binding.folder}</span> · connected by {binding.connectedBy} on{' '}
        {new Date(binding.connectedAt).toLocaleString()}
      </Caption1>

      {binding.lastSyncAt ? (
        <Caption1 className={styles.meta}>
          Last sync {new Date(binding.lastSyncAt).toLocaleString()} ·{' '}
          {binding.lastSyncCommitId && (
            <>commit <CommitSha sha={binding.lastSyncCommitId} /> · </>)}
          {binding.lastSyncFileCount ?? 0} file(s)
        </Caption1>
      ) : (
        <Caption1 className={styles.meta}>No sync yet — click &quot;Sync now&quot; to commit the workspace.</Caption1>
      )}

      {binding.lastSyncError && (
        <MessageBar intent="error"><MessageBarBody>Last sync failed: {binding.lastSyncError}</MessageBarBody></MessageBar>
      )}

      <Divider />

      <div>
        <Caption1 className={styles.meta}>Remote branch head</Caption1>
        {remoteError && <MessageBar intent="warning"><MessageBarBody>{remoteError}</MessageBarBody></MessageBar>}
        {!remoteError && remoteHead && (
          <Caption1 className={styles.meta}>
            <CommitSha sha={remoteHead.commitId} />
            {remoteHead.authorName ? ` · ${remoteHead.authorName}` : ''}
            {remoteHead.commitDate ? ` · ${new Date(remoteHead.commitDate).toLocaleString()}` : ''}
          </Caption1>
        )}
        {!remoteError && !remoteHead && <Caption1 className={styles.meta}>Branch has no commits yet (created on first sync).</Caption1>}
      </div>

      {syncMsg && (
        <MessageBar intent={syncMsg.intent}>
          <MessageBarBody>{syncMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.row}>
        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </Button>
        <div className={styles.spacer} />
        <Button appearance="subtle" icon={<PlugDisconnected20Regular />} onClick={disconnect} disabled={disconnecting}>
          {disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </div>
    </div>
  );
}

// ========================================================================
// Connect wizard — provider radio + dependent dropdowns + auth + connect
// ========================================================================

function ConnectWizard({ workspaceId, caps, onConnected }: { workspaceId: string; caps: CloudCaps | null; onConnected: () => void }) {
  const styles = useStyles();
  const githubAvailable = caps?.githubAvailable !== false;

  const [provider, setProvider] = useState<Provider>('ado');
  const [pat, setPat] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('pat');
  const [spnTenantId, setSpnTenantId] = useState('');
  const [spnClientId, setSpnClientId] = useState('');

  // ADO chained selectors.
  const [org, setOrg] = useState('');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [project, setProject] = useState('');
  const [repos, setRepos] = useState<{ id: string; name: string; defaultBranch?: string }[]>([]);
  const [repoId, setRepoId] = useState('');
  const [repoName, setRepoName] = useState('');

  // GitHub.
  const [ghHostKind, setGhHostKind] = useState<'github.com' | 'ghe'>('github.com');
  const [ghSubdomain, setGhSubdomain] = useState('');
  const [ghOwner, setGhOwner] = useState('');
  const [ghRepos, setGhRepos] = useState<{ fullName: string; owner: string; name: string; defaultBranch?: string }[]>([]);
  const [ghRepo, setGhRepo] = useState('');
  // ghe.com: dedicated single-repo entry (no org-level browse, per Fabric).
  const [ghRepoInput, setGhRepoInput] = useState('');

  // Shared.
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState('main');
  const [folder, setFolder] = useState('loom-workspace');

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const meta = useCallback(
    async (qs: string) => {
      const sep = qs.includes('?') ? '&' : '?';
      return getJson(`/api/admin/workspaces/${workspaceId}/git/meta${qs}${sep}pat=${encodeURIComponent(pat)}`);
    },
    [workspaceId, pat],
  );

  const loadAdoProjects = useCallback(async () => {
    if (!org.trim() || !pat.trim()) { setError('Enter the organization and a PAT first.'); return; }
    setBusyAction('projects'); setError(null);
    const { res, json } = await meta(`?action=projects&org=${encodeURIComponent(org.trim())}`);
    if (!res.ok || !json.ok) setError(json?.error || `HTTP ${res.status}`);
    else { setProjects(json.projects || []); setProject(''); setRepos([]); setRepoId(''); setBranches([]); }
    setBusyAction(null);
  }, [org, pat, meta]);

  const loadAdoRepos = useCallback(async (proj: string) => {
    setBusyAction('repos'); setError(null);
    const { res, json } = await meta(`?action=repos&org=${encodeURIComponent(org.trim())}&project=${encodeURIComponent(proj)}`);
    if (!res.ok || !json.ok) setError(json?.error || `HTTP ${res.status}`);
    else setRepos(json.repos || []);
    setBusyAction(null);
  }, [org, meta]);

  const loadAdoBranches = useCallback(async (rid: string) => {
    setBusyAction('branches'); setError(null);
    const { res, json } = await meta(`?action=branches&org=${encodeURIComponent(org.trim())}&project=${encodeURIComponent(project)}&repoId=${encodeURIComponent(rid)}`);
    if (!res.ok || !json.ok) setError(json?.error || `HTTP ${res.status}`);
    else setBranches((json.branches || []).map((b: any) => b.name));
    setBusyAction(null);
  }, [org, project, meta]);

  const loadGhRepos = useCallback(async () => {
    if (!pat.trim()) { setError('Enter a GitHub PAT first.'); return; }
    setBusyAction('gh-repos'); setError(null);
    const { res, json } = await meta(`?action=gh-repos&owner=${encodeURIComponent(ghOwner.trim())}`);
    if (!res.ok || !json.ok) setError(json?.error || `HTTP ${res.status}`);
    else { setGhRepos(json.repos || []); setGhRepo(''); setBranches([]); }
    setBusyAction(null);
  }, [pat, ghOwner, meta]);

  const loadGhBranches = useCallback(async (owner: string, repo: string) => {
    setBusyAction('gh-branches'); setError(null);
    const host = ghHostKind === 'ghe' ? `&host=${encodeURIComponent(ghSubdomain.trim())}` : '';
    const { res, json } = await meta(`?action=gh-branches&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}${host}`);
    if (!res.ok || !json.ok) setError(json?.error || `HTTP ${res.status}`);
    else setBranches((json.branches || []).map((b: any) => b.name));
    setBusyAction(null);
  }, [meta, ghHostKind, ghSubdomain]);

  const canConnect = pat.trim() && branch.trim() && (
    provider === 'ado' ? org.trim() && project.trim() && repoId.trim()
      : provider === 'github' && ghHostKind === 'ghe'
        ? ghSubdomain.trim() && ghOwner.trim() && ghRepoInput.trim()
        : ghOwner.trim() && ghRepo.trim()
  );

  const connect = useCallback(async () => {
    setConnecting(true); setError(null);
    const payload: Record<string, unknown> = { provider, branch: branch.trim(), folder: folder.trim() || 'loom-workspace', pat: pat.trim() };
    if (provider === 'ado') {
      payload.adoOrg = org.trim(); payload.adoProject = project.trim(); payload.repoId = repoId.trim(); payload.repoName = repoName.trim();
      payload.authMethod = authMethod;
      if (authMethod === 'spn') { payload.spnTenantId = spnTenantId.trim(); payload.spnClientId = spnClientId.trim(); }
    } else {
      if (ghHostKind === 'ghe') {
        payload.githubHost = ghSubdomain.trim();
        payload.githubOwner = ghOwner.trim();
        payload.githubRepo = ghRepoInput.trim();
      } else {
        const found = ghRepos.find((r) => r.fullName === ghRepo);
        payload.githubOwner = found?.owner || ghOwner.trim(); payload.githubRepo = found?.name || ghRepo;
      }
    }
    const { res, json } = await getJson(`/api/admin/workspaces/${workspaceId}/git`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok || !json.ok) { setConnecting(false); setError(json?.error || `HTTP ${res.status}`); return; }
    // Connect & sync — immediately commit the workspace (Fabric's combined action).
    // A sync failure does not undo the binding; the connected view surfaces it.
    await getJson(`/api/admin/workspaces/${workspaceId}/git/sync`, { method: 'POST' }).catch(() => {});
    setConnecting(false);
    onConnected();
  }, [provider, branch, folder, pat, org, project, repoId, repoName, authMethod, spnTenantId, spnClientId, ghRepos, ghRepo, ghOwner, ghHostKind, ghSubdomain, ghRepoInput, workspaceId, onConnected]);

  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <BranchFork24Regular />
        <Body1Strong>Connect to source control</Body1Strong>
      </div>
      <Caption1 className={styles.meta}>
        Bind this workspace to an Azure DevOps or GitHub repository (GitHub.com or GitHub
        Enterprise Cloud with data residency, <span className={styles.mono}>ghe.com</span>).
        &quot;Sync now&quot; commits every item as <span className={styles.mono}>*.item.json</span> to
        the chosen branch. The token is stored in Key Vault, never in the workspace.
      </Caption1>

      <Field label="Provider">
        <RadioGroup value={provider} layout="horizontal" onChange={(_, d) => { setProvider(d.value as Provider); setBranches([]); setError(null); }}>
          <Radio value="ado" label="Azure DevOps" />
          <Radio value="github" label="GitHub" disabled={!githubAvailable} />
        </RadioGroup>
      </Field>
      {!githubAvailable && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>GitHub is unavailable in {caps?.label || 'this cloud'}</MessageBarTitle>
            GitHub has no FedRAMP-High / IL5 authorization, so it is hidden in GCC-High / IL5. Azure
            DevOps operates on commercial endpoints and is available in every Loom cloud boundary.
          </MessageBarBody>
        </MessageBar>
      )}

      {provider === 'ado' ? (
        <>
          <Field label="Authentication">
            <RadioGroup value={authMethod} layout="horizontal" onChange={(_, d) => setAuthMethod(d.value as AuthMethod)}>
              <Radio value="pat" label="Personal Access Token" />
              <Radio value="spn" label="Service principal" />
            </RadioGroup>
          </Field>
          {authMethod === 'spn' && (
            <div className={styles.row}>
              <Field label="SPN tenant id" className={styles.grow}>
                <Input value={spnTenantId} onChange={(_, d) => setSpnTenantId(d.value)} placeholder="00000000-0000-…" />
              </Field>
              <Field label="SPN client id" className={styles.grow}>
                <Input value={spnClientId} onChange={(_, d) => setSpnClientId(d.value)} placeholder="00000000-0000-…" />
              </Field>
            </div>
          )}
          <Field label={authMethod === 'spn' ? 'SPN client secret' : 'Personal Access Token (Code: Read & Write)'} required>
            <Input type="password" value={pat} onChange={(_, d) => setPat(d.value)} placeholder="paste token" />
          </Field>
          <Field label="Organization" required>
            <div className={styles.row}>
              <Input value={org} onChange={(_, d) => setOrg(d.value)} placeholder="myorg" className={styles.grow} />
              <Button onClick={loadAdoProjects} disabled={busyAction === 'projects' || !org.trim() || !pat.trim()}>
                {busyAction === 'projects' ? 'Loading…' : 'Load projects'}
              </Button>
            </div>
          </Field>
          <Field label="Project" required>
            <Dropdown value={project} selectedOptions={project ? [project] : []} placeholder="Select a project"
              disabled={projects.length === 0}
              onOptionSelect={(_, d) => { const p = d.optionValue || ''; setProject(p); setRepoId(''); setRepos([]); setBranches([]); if (p) void loadAdoRepos(p); }}>
              {projects.map((p) => <Option key={p.id} value={p.name}>{p.name}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Repository" required>
            <Dropdown value={repoName} selectedOptions={repoId ? [repoId] : []} placeholder="Select a repository"
              disabled={repos.length === 0}
              onOptionSelect={(_, d) => {
                const r = repos.find((x) => x.id === d.optionValue);
                setRepoId(r?.id || ''); setRepoName(r?.name || ''); setBranch(r?.defaultBranch || 'main'); setBranches([]);
                if (r) void loadAdoBranches(r.id);
              }}>
              {repos.map((r) => <Option key={r.id} value={r.id} text={r.name}>{r.name}</Option>)}
            </Dropdown>
          </Field>
        </>
      ) : (
        <>
          <Field label="GitHub host" hint="GitHub Enterprise Cloud with data residency uses the same GitHub provider over an api.<subdomain>.ghe.com base.">
            <RadioGroup value={ghHostKind} layout="horizontal"
              onChange={(_, d) => { setGhHostKind(d.value as 'github.com' | 'ghe'); setGhRepos([]); setGhRepo(''); setBranches([]); setError(null); }}>
              <Radio value="github.com" label="GitHub.com" />
              <Radio value="ghe" label="GitHub Enterprise Cloud (ghe.com)" />
            </RadioGroup>
          </Field>
          <Field label="Personal Access Token (repo scope)" required
            hint={ghHostKind === 'ghe' ? 'Mint the token on your <subdomain>.ghe.com tenant — ghe.com PATs are per-host.' : undefined}>
            <Input type="password" value={pat} onChange={(_, d) => setPat(d.value)} placeholder="paste token" />
          </Field>

          {ghHostKind === 'ghe' ? (
            <>
              <Field label="Enterprise subdomain" required hint="The <subdomain> in <subdomain>.ghe.com — e.g. octocorp.">
                <Input value={ghSubdomain} onChange={(_, d) => { setGhSubdomain(d.value); setBranches([]); }} placeholder="octocorp"
                  contentAfter={<Caption1 className={styles.meta}>.ghe.com</Caption1>} />
              </Field>
              <Field label="Owner / organization" required hint="ghe.com connects to one dedicated repository (no org-level browse).">
                <Input value={ghOwner} onChange={(_, d) => { setGhOwner(d.value); setBranches([]); }} placeholder="my-org" />
              </Field>
              <Field label="Repository" required>
                <div className={styles.row}>
                  <Input value={ghRepoInput} onChange={(_, d) => { setGhRepoInput(d.value); setBranches([]); }} placeholder="my-repo" className={styles.grow} />
                  <Button onClick={() => void loadGhBranches(ghOwner.trim(), ghRepoInput.trim())}
                    disabled={busyAction === 'gh-branches' || !pat.trim() || !ghSubdomain.trim() || !ghOwner.trim() || !ghRepoInput.trim()}>
                    {busyAction === 'gh-branches' ? 'Loading…' : 'Load branches'}
                  </Button>
                </div>
              </Field>
            </>
          ) : (
            <>
              <Field label="Owner / organization (blank = your repos)">
                <div className={styles.row}>
                  <Input value={ghOwner} onChange={(_, d) => setGhOwner(d.value)} placeholder="my-org (optional)" className={styles.grow} />
                  <Button onClick={loadGhRepos} disabled={busyAction === 'gh-repos' || !pat.trim()}>
                    {busyAction === 'gh-repos' ? 'Loading…' : 'Load repos'}
                  </Button>
                </div>
              </Field>
              <Field label="Repository" required>
                <Dropdown value={ghRepo} selectedOptions={ghRepo ? [ghRepo] : []} placeholder="Select a repository"
                  disabled={ghRepos.length === 0}
                  onOptionSelect={(_, d) => {
                    const r = ghRepos.find((x) => x.fullName === d.optionValue);
                    setGhRepo(r?.fullName || ''); setBranch(r?.defaultBranch || 'main'); setBranches([]);
                    if (r) void loadGhBranches(r.owner, r.name);
                  }}>
                  {ghRepos.map((r) => <Option key={r.fullName} value={r.fullName}>{r.fullName}</Option>)}
                </Dropdown>
              </Field>
            </>
          )}
        </>
      )}

      <Field label="Branch" required hint="Pick an existing branch, or type a new name — it is created on first sync.">
        <Dropdown freeform value={branch} selectedOptions={branches.includes(branch) ? [branch] : []} placeholder="main"
          onInput={(e) => setBranch((e.target as HTMLInputElement).value)}
          onOptionSelect={(_, d) => setBranch(d.optionValue || 'main')}>
          {branches.map((b) => <Option key={b} value={b}>{b}</Option>)}
        </Dropdown>
      </Field>
      <Field label="Folder" hint="Repo subfolder for the item JSON tree.">
        <Input value={folder} onChange={(_, d) => setFolder(d.value)} placeholder="loom-workspace" />
      </Field>

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      <div className={styles.row}>
        <Button appearance="primary" icon={<BranchFork24Regular />} onClick={connect} disabled={!canConnect || connecting}>
          {connecting ? 'Connecting…' : 'Connect & sync'}
        </Button>
      </div>
    </div>
  );
}
