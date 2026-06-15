'use client';

/**
 * CopilotAgentsConfig — admin tenant-wide "Copilot & Agents" config card.
 *
 * Mounted at the top of /admin/tenant-settings. Lets a tenant admin pick:
 *   • the DEFAULT Foundry model-hosting account (real ARM list of
 *     Microsoft.CognitiveServices accounts, kind AIServices/OpenAI) —
 *     /api/foundry/accounts (also returned by GET /api/admin/copilot-config)
 *   • the Copilot chat-model deployment, help-agent model, embedding model
 *     (real account-scoped deployments — /api/foundry/model-deployments?account=)
 *   • an optional Foundry project endpoint + GUID for the Agent Service
 *   • optional AI Search grounding service + index (real index list —
 *     /api/ai-search/indexes)
 *
 * Persists via PUT /api/admin/copilot-config (Cosmos copilot-config container).
 * The Copilot + help-agent backends read this config (falling back to env
 * vars). Honest Fluent gate when no Foundry account resolves.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Dropdown, Option, Field, Input, Spinner, Badge, Switch,
  MessageBar, MessageBarBody, MessageBarTitle,
  Caption1, Body1, makeStyles, tokens,
} from '@fluentui/react-components';
import { Save24Regular, ArrowClockwise20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { McpServersPanel } from '@/lib/components/admin/mcp-servers-panel';
import { IqMcpPanel } from '@/lib/components/admin/iq-mcp-panel';
import {
  RECOMMENDED_CHAT_MODELS, RECOMMENDED_EMBED_MODELS, looksLikeEmbedding,
  type TenantCopilotConfig,
} from '@/lib/types/copilot-config';

interface AccountRow { name: string; rg: string; location?: string; kind?: string; endpoint?: string }
interface DeploymentRow { name: string; modelName?: string; modelVersion?: string; provisioningState?: string }
interface IndexRow { name: string }

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalL,
  },
  full: { gridColumn: '1 / -1' },
  bar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  hint: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
});

const NONE = '__none__';

export function CopilotAgentsConfig() {
  const s = useStyles();
  const [config, setConfig] = useState<TenantCopilotConfig>({});
  const [original, setOriginal] = useState<TenantCopilotConfig>({});
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountsError, setAccountsError] = useState<{ error: string; hint?: string } | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [deploymentsError, setDeploymentsError] = useState<string | null>(null);
  const [indexes, setIndexes] = useState<IndexRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDeployments, setLoadingDeployments] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const set = useCallback((patch: Partial<TenantCopilotConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch('/api/admin/copilot-config');
      if (r.status === 401 || r.status === 403) { setLoadError('Sign-in required'); return; }
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setConfig({ ...j.config });
      setOriginal({ ...j.config });
      setAccounts(Array.isArray(j.accounts) ? j.accounts : []);
      setAccountsError(j.accountsError || null);
      // Preselect the env/discovery default account if the admin hasn't chosen one.
      if (!j.config?.foundryAccount && j.defaultAccount) {
        setConfig((c) => ({ ...c, foundryAccount: j.defaultAccount }));
      }
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // When the selected account changes, fetch its real model deployments.
  const account = config.foundryAccount;
  const accountRg = useMemo(
    () => accounts.find((a) => a.name === account)?.rg || config.foundryAccountRg,
    [accounts, account, config.foundryAccountRg],
  );
  useEffect(() => {
    if (!account) { setDeployments([]); return; }
    let cancelled = false;
    setLoadingDeployments(true); setDeploymentsError(null);
    const params = new URLSearchParams({ account });
    if (accountRg) params.set('rg', accountRg);
    fetch(`/api/foundry/model-deployments?${params.toString()}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !j.ok) {
          setDeployments([]);
          setDeploymentsError(j.hint || j.error || `Could not list deployments (HTTP ${r.status})`);
          return;
        }
        setDeployments(Array.isArray(j.deployments) ? j.deployments : []);
        // Persist the resolved AOAI endpoint so the chat backend needs no ARM call.
        if (j.account?.endpoint) set({ aoaiEndpoint: j.account.endpoint, foundryAccountRg: accountRg });
      })
      .catch((e) => { if (!cancelled) { setDeployments([]); setDeploymentsError(String(e)); } })
      .finally(() => { if (!cancelled) setLoadingDeployments(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, accountRg]);

  // Load AI Search indexes when a grounding service is named.
  const groundingService = config.groundingSearchService;
  useEffect(() => {
    if (!groundingService) { setIndexes([]); return; }
    let cancelled = false;
    const params = new URLSearchParams({ service: groundingService });
    fetch(`/api/ai-search/indexes?${params.toString()}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        const rows = Array.isArray(j.indexes) ? j.indexes : (Array.isArray(j.value) ? j.value : []);
        setIndexes(rows.map((x: any) => ({ name: x.name })).filter((x: IndexRow) => x.name));
      })
      .catch(() => { if (!cancelled) setIndexes([]); });
    return () => { cancelled = true; };
  }, [groundingService]);

  const chatDeployments = deployments.filter((d) => !looksLikeEmbedding(d.modelName, d.name));
  const embedDeployments = deployments.filter((d) => looksLikeEmbedding(d.modelName, d.name));

  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(original),
    [config, original],
  );

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true); setSaveError(null); setStatus(null);
    try {
      const r = await fetch('/api/admin/copilot-config', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      setOriginal({ ...j.config });
      setConfig({ ...j.config });
      setStatus(`Saved at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally { setSaving(false); }
  }, [config, saving]);

  function deploymentDropdown(
    label: string, value: string | undefined, rows: DeploymentRow[],
    onPick: (v: string | undefined) => void, recommend: string[], help: string,
  ) {
    return (
      <Field label={label} hint={help}>
        <Dropdown
          placeholder={account ? 'Select a deployment…' : 'Select a Foundry account first'}
          value={value || ''}
          selectedOptions={value ? [value] : []}
          disabled={!account || loadingDeployments}
          onOptionSelect={(_, d) => onPick(d.optionValue === NONE ? undefined : d.optionValue)}
        >
          <Option value={NONE} text="(none)">(none)</Option>
          {rows.map((d) => {
            const recommended = recommend.some((m) => (d.modelName || d.name).toLowerCase().includes(m));
            return (
              <Option key={d.name} value={d.name} text={d.name}>
                {d.name}{d.modelName ? ` · ${d.modelName}` : ''}{recommended ? '  ★ recommended' : ''}
              </Option>
            );
          })}
        </Dropdown>
      </Field>
    );
  }

  if (loading) {
    return (
      <Section title="Copilot & Agents">
        <Spinner label="Loading Copilot & Agents config…" />
      </Section>
    );
  }

  return (
    <>
    <Section title="Copilot & Agents">
      <Body1 className={s.hint}>
        Pick the default Azure AI Foundry account and model deployments the Loom
        Copilot, Help agent, and workspace data agents use. These settings are
        read by the chat backends and override the deployment&apos;s env vars.
      </Body1>

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not load config</MessageBarTitle>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      {accountsError && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No Azure AI Foundry account resolved</MessageBarTitle>
            {accountsError.hint || accountsError.error}
            <div style={{ marginTop: 4, fontSize: 12 }}>
              Provision an AIServices account via{' '}
              <code>platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep</code> and grant the
              Console UAMI <code>Cognitive Services Contributor</code>. You can still type a
              deployment name below; it will be validated when the backend runs.
            </div>
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.grid}>
        <Field label="Default Foundry account" hint="Microsoft.CognitiveServices account (kind AIServices / OpenAI) that hosts model deployments.">
          <Dropdown
            placeholder="Select a Foundry account…"
            value={account || ''}
            selectedOptions={account ? [account] : []}
            onOptionSelect={(_, d) => {
              const next = accounts.find((a) => a.name === d.optionValue);
              set({
                foundryAccount: d.optionValue,
                foundryAccountRg: next?.rg,
                aoaiEndpoint: next?.endpoint,
                copilotChatDeployment: undefined,
                helpAgentDeployment: undefined,
                routerDeployment: undefined,
                embeddingDeployment: undefined,
              });
            }}
          >
            {accounts.map((a) => (
              <Option key={a.name} value={a.name} text={a.name}>
                {a.name}{a.location ? ` · ${a.location}` : ''}{a.kind ? ` · ${a.kind}` : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="AOAI endpoint" hint="Auto-filled from the selected account. Override only for custom domains.">
          <Input
            value={config.aoaiEndpoint || ''}
            placeholder="https://<account>.openai.azure.com"
            onChange={(_, d) => set({ aoaiEndpoint: d.value || undefined })}
          />
        </Field>

        {deploymentDropdown(
          'Copilot chat model', config.copilotChatDeployment, chatDeployments,
          (v) => set({ copilotChatDeployment: v }), RECOMMENDED_CHAT_MODELS,
          'Cross-item Copilot reasoning model. Recommend a current gpt-4o / gpt-4.1 / gpt-5-mini class model.',
        )}

        {deploymentDropdown(
          'Help agent model', config.helpAgentDeployment, chatDeployments,
          (v) => set({ helpAgentDeployment: v }), RECOMMENDED_CHAT_MODELS,
          'Docs-grounded Help Copilot model. Falls back to the Copilot chat model when unset.',
        )}

        {deploymentDropdown(
          'Intent router model (optional)', config.routerDeployment, chatDeployments,
          (v) => set({ routerDeployment: v }), RECOMMENDED_CHAT_MODELS,
          'One cheap classifier call per unified-Copilot turn picks the docs/help vs build/data agent. Falls back to the Copilot chat model when unset.',
        )}

        {deploymentDropdown(
          'Embedding model', config.embeddingDeployment, embedDeployments,
          (v) => set({ embeddingDeployment: v }), RECOMMENDED_EMBED_MODELS,
          'Used for RAG grounding. Recommend text-embedding-3-large / -small (or ada-002 for legacy parity).',
        )}

        <Field label="Foundry project endpoint (optional)" hint="Agent Service endpoint for workspace data agents: https://<acct>.services.ai.azure.com/api/projects/<project>">
          <Input
            value={config.foundryProjectEndpoint || ''}
            placeholder="https://<acct>.services.ai.azure.com/api/projects/<project>"
            onChange={(_, d) => set({ foundryProjectEndpoint: d.value || undefined })}
          />
        </Field>

        <Field label="Foundry project GUID (optional)" hint="Workspace GUID for downstream Foundry / Copilot Studio connections.">
          <Input
            value={config.foundryProjectId || ''}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(_, d) => set({ foundryProjectId: d.value || undefined })}
          />
        </Field>

        <Field label="Grounding AI Search service (optional)" hint="Microsoft.Search service name used for RAG grounding.">
          <Input
            value={config.groundingSearchService || ''}
            placeholder="my-search-service"
            onChange={(_, d) => set({ groundingSearchService: d.value || undefined })}
          />
        </Field>

        <Field label="Grounding index (optional)" hint={groundingService ? 'Pick an index in the named search service.' : 'Name a search service to list its indexes.'}>
          <Dropdown
            placeholder={groundingService ? 'Select an index…' : 'No grounding service set'}
            value={config.groundingSearchIndex || ''}
            selectedOptions={config.groundingSearchIndex ? [config.groundingSearchIndex] : []}
            disabled={!groundingService}
            onOptionSelect={(_, d) => set({ groundingSearchIndex: d.optionValue === NONE ? undefined : d.optionValue })}
          >
            <Option value={NONE} text="(none)">(none)</Option>
            {indexes.map((i) => <Option key={i.name} value={i.name} text={i.name}>{i.name}</Option>)}
          </Dropdown>
        </Field>

        {/* ── Fabric / Power BI Copilot opt-in (default OFF → Azure-native) ── */}
        <Field
          className={s.full}
          label="Fabric / Power BI Copilot (opt-in)"
          hint={
            'OFF (default): the cross-item Copilot runs 100% on Azure OpenAI — no Fabric workspace required, ' +
            'no Fabric/Power BI call. ON: the orchestrator validates the bound Fabric workspace via ' +
            'api.fabric.microsoft.com before each session and prefers Fabric-native tools; LLM inference still ' +
            'runs on Azure OpenAI (Fabric Copilot has no public invocation API). Requires F2+ capacity and ' +
            '"Service principals can use Fabric APIs" in the Fabric admin portal. Not available in GCC-High / IL5 / DoD.'
          }
        >
          <Switch
            checked={!!config.fabricCopilotBackend}
            label={config.fabricCopilotBackend ? 'Fabric path enabled' : 'Azure-native (default)'}
            onChange={(_, d) => set({ fabricCopilotBackend: d.checked || undefined })}
          />
        </Field>

        {config.fabricCopilotBackend && (
          <Field
            className={s.full}
            label="Fabric workspace id"
            hint="Workspace on F2+ capacity. The Console UAMI must be added as Member or Contributor. When empty, the orchestrator stays on the Azure-native path."
          >
            <Input
              value={config.fabricCopilotWorkspaceId || ''}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(_, d) => set({ fabricCopilotWorkspaceId: d.value || undefined })}
            />
          </Field>
        )}
      </div>

      {deploymentsError && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Deployment list unavailable</MessageBarTitle>{deploymentsError}</MessageBarBody>
        </MessageBar>
      )}

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveError}</MessageBarBody>
        </MessageBar>
      )}
      {status && !saveError && (
        <MessageBar intent="success"><MessageBarBody>{status}</MessageBarBody></MessageBar>
      )}

      <div className={s.bar}>
        <Sparkle20Regular style={{ color: 'var(--loom-accent-purple)' }} />
        <Caption1 className={s.hint}>
          {loadingDeployments
            ? 'Loading model deployments…'
            : account
              ? `${deployments.length} deployment${deployments.length === 1 ? '' : 's'} on ${account}`
              : 'Select a Foundry account to list its model deployments.'}
        </Caption1>
        {dirty && <Badge appearance="filled" color="warning" size="small">unsaved changes</Badge>}
        <div className={s.spacer} />
        <Button icon={<ArrowClockwise20Regular />} onClick={() => void load()} disabled={saving}>Reload</Button>
        <Button appearance="primary" icon={<Save24Regular />} onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save Copilot & Agents'}
        </Button>
      </div>
    </Section>
    <McpServersPanel />
    <IqMcpPanel />
    </>
  );
}
