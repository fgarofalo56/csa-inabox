'use client';

/**
 * WorkspaceAgentConfigDialog — workspace OWNERS/CONTRIBUTORS assign which
 * Foundry project / agent / models this workspace's data agents use.
 *
 * Backend: GET/PUT /api/workspaces/[id]/agent-config (role-gated). The model
 * lists come from the real account-scoped deployments
 * (/api/foundry/model-deployments?account=). Honest Fluent gate when the
 * caller lacks the role or no Foundry is configured. See no-vaporware.md.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Field, Input, Dropdown, Option, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { Save24Regular } from '@fluentui/react-icons';
import {
  RECOMMENDED_CHAT_MODELS, RECOMMENDED_EMBED_MODELS, looksLikeEmbedding,
  type WorkspaceAgentConfig,
} from '@/lib/types/copilot-config';

interface DeploymentRow { name: string; modelName?: string }
interface AgentRow { name: string; description?: string }

const NONE = '__none__';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalM },
  full: { gridColumn: '1 / -1' },
  hint: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
});

export function WorkspaceAgentConfigDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  agents: AgentRow[];
  onSaved?: () => void;
}) {
  const { open, onOpenChange, workspaceId, agents } = props;
  const s = useStyles();

  const [config, setConfig] = useState<WorkspaceAgentConfig>({});
  const [canEdit, setCanEdit] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [tenantDefaults, setTenantDefaults] = useState<any>({});
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const set = useCallback((patch: Partial<WorkspaceAgentConfig>) => setConfig((c) => ({ ...c, ...patch })), []);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true); setError(null); setStatus(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/agent-config`);
      const j = await r.json().catch(() => ({}));
      if (r.status === 403) { setError(j.error || 'You do not have permission to edit this workspace.'); setCanEdit(false); setRole(j.role || null); return; }
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setConfig({ ...j.config });
      setCanEdit(!!j.canEdit);
      setRole(j.role || null);
      setTenantDefaults(j.tenantDefaults || {});
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  // Resolve the account to list model deployments from: workspace cfg →
  // tenant default. Without one we can't list models, so fall back to free text.
  const account = config.foundryAccount || tenantDefaults.foundryAccount;
  const accountRg = config.foundryAccountRg || tenantDefaults.foundryAccountRg;
  useEffect(() => {
    if (!open || !account) { setDeployments([]); return; }
    let cancelled = false;
    const params = new URLSearchParams({ account });
    if (accountRg) params.set('rg', accountRg);
    fetch(`/api/foundry/model-deployments?${params.toString()}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        setDeployments(r.ok && j.ok && Array.isArray(j.deployments) ? j.deployments : []);
      })
      .catch(() => { if (!cancelled) setDeployments([]); });
    return () => { cancelled = true; };
  }, [open, account, accountRg]);

  const chatDeployments = deployments.filter((d) => !looksLikeEmbedding(d.modelName, d.name));
  const embedDeployments = deployments.filter((d) => looksLikeEmbedding(d.modelName, d.name));

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true); setError(null); setStatus(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/agent-config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setConfig({ ...j.config });
      setStatus('Saved.');
      props.onSaved?.();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [config, saving, workspaceId, props]);

  function modelDropdown(label: string, value: string | undefined, rows: DeploymentRow[], onPick: (v?: string) => void, recommend: string[], help: string) {
    return (
      <Field label={label} hint={help}>
        {account ? (
          <Dropdown
            placeholder="Select a deployment…"
            value={value || ''} selectedOptions={value ? [value] : []}
            disabled={!canEdit}
            onOptionSelect={(_, d) => onPick(d.optionValue === NONE ? undefined : d.optionValue)}
          >
            <Option value={NONE} text="(none)">(none)</Option>
            {rows.map((d) => {
              const rec = recommend.some((m) => (d.modelName || d.name).toLowerCase().includes(m));
              return <Option key={d.name} value={d.name} text={d.name}>{d.name}{d.modelName ? ` · ${d.modelName}` : ''}{rec ? '  ★' : ''}</Option>;
            })}
          </Dropdown>
        ) : (
          <Input value={value || ''} disabled={!canEdit} placeholder="deployment name" onChange={(_, d) => onPick(d.value || undefined)} />
        )}
      </Field>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>Workspace data-agent configuration</DialogTitle>
          <DialogContent>
            <Caption1 className={s.hint} style={{ display: 'block', marginBottom: 12 }}>
              Choose which Foundry project, published agent, and models this
              workspace&apos;s data agents use. Recommended: a current
              gpt-4.x / gpt-4o / gpt-5-mini class chat model for reasoning and
              text-embedding-3 / ada for embeddings.
            </Caption1>

            {loading && <Spinner label="Loading…" />}

            {!loading && error && (
              <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                <MessageBarBody><MessageBarTitle>Heads up</MessageBarTitle>{error}</MessageBarBody>
              </MessageBar>
            )}

            {!loading && !canEdit && !error && (
              <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  <MessageBarTitle>Read-only</MessageBarTitle>
                  Your role on this workspace is <code>{role || 'none'}</code>. Only owners and
                  contributors can change the data-agent config.
                </MessageBarBody>
              </MessageBar>
            )}

            {!loading && (
              <div className={s.grid}>
                <Field label="Default published agent" hint="Pre-selected agent for this workspace (optional).">
                  <Dropdown
                    placeholder="Use the pane selection"
                    value={config.defaultAgent || ''} selectedOptions={config.defaultAgent ? [config.defaultAgent] : []}
                    disabled={!canEdit}
                    onOptionSelect={(_, d) => set({ defaultAgent: d.optionValue === NONE ? undefined : d.optionValue })}
                  >
                    <Option value={NONE} text="(none)">(none)</Option>
                    {agents.map((a) => <Option key={a.name} value={a.name} text={a.name}>{a.name}</Option>)}
                  </Dropdown>
                </Field>

                <Field label="Foundry account (optional)" hint="AIServices account hosting the models. Defaults to the tenant account.">
                  <Input value={config.foundryAccount || ''} disabled={!canEdit} placeholder={tenantDefaults.foundryAccount || 'tenant default'} onChange={(_, d) => set({ foundryAccount: d.value || undefined })} />
                </Field>

                <Field label="Foundry project endpoint (optional)" hint="Override the tenant default project for this workspace.">
                  <Input value={config.foundryProjectEndpoint || ''} disabled={!canEdit} placeholder={tenantDefaults.foundryProjectEndpoint || 'https://<acct>.services.ai.azure.com/api/projects/<project>'} onChange={(_, d) => set({ foundryProjectEndpoint: d.value || undefined })} />
                </Field>

                <Field label="Foundry project GUID (optional)" hint="Workspace GUID for the Agent Service project.">
                  <Input value={config.foundryProjectId || ''} disabled={!canEdit} placeholder="00000000-0000-0000-0000-000000000000" onChange={(_, d) => set({ foundryProjectId: d.value || undefined })} />
                </Field>

                {modelDropdown('Chat / reasoning model', config.chatDeployment, chatDeployments, (v) => set({ chatDeployment: v }), RECOMMENDED_CHAT_MODELS, 'Recommend a current gpt-4o / gpt-4.1 / gpt-5-mini class model.')}
                {modelDropdown('Embedding model', config.embeddingDeployment, embedDeployments, (v) => set({ embeddingDeployment: v }), RECOMMENDED_EMBED_MODELS, 'Recommend text-embedding-3-large / -small (or ada-002).')}
              </div>
            )}

            {status && !error && <MessageBar intent="success" style={{ marginTop: 12 }}><MessageBarBody>{status}</MessageBarBody></MessageBar>}
            {role && <div style={{ marginTop: 12 }}><Badge appearance="tint" color="brand" size="small">your role: {role}</Badge></div>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button appearance="primary" icon={<Save24Regular />} onClick={() => void save()} disabled={!canEdit || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
