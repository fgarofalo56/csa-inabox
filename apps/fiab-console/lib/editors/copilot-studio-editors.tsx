'use client';

/**
 * Copilot Studio editors — v3.
 *
 * Wired live to Power Platform (BAP) + Dataverse via the BFF
 * (/api/items/copilot-studio-*). No mock data. Tenant-gate errors
 * surface as MessageBar with a remediation hint.
 *
 * Editors:
 *   CopilotStudioAgentEditor       — env picker, agent list/CRUD/Publish, tabs to other editors
 *   CopilotKnowledgeEditor         — agent picker, knowledge sources list + add (URL/file/SharePoint/Dataverse)
 *   CopilotTopicEditor             — agent picker, topics list, trigger phrases + flow YAML editor
 *   CopilotActionEditor            — agent picker, action list (Power Automate flow / connector / prebuilt)
 *   CopilotChannelEditor           — agent picker, channels grid + Publish-to-channel
 *   CopilotAnalyticsEditor         — agent picker, KPI cards + daily session sparkline placeholder
 *   CopilotTemplateLibraryEditor   — CSA template gallery (Cosmos-backed), Use template → creates agent in selected env
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Dropdown, Option, Field,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Save20Regular, ArrowSync20Regular, Add20Regular, Delete20Regular, CloudArrowUp20Regular,
  Bot20Regular, BookOpen20Regular, Chat20Regular, Flow20Regular, Channel20Regular, DataBarVertical20Regular,
  Library20Regular, Send20Regular, PlayCircle20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { KeyValueGrid } from '@/lib/components/ui/key-value-grid';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  form: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' },
  formCol: { display: 'flex', flexDirection: 'column', gap: 12 },
  yaml: {
    width: '100%', minHeight: 260,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 8 },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 },
  kpi: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 4 },
  kpiValue: { fontSize: 28, fontWeight: 600 },
  treePad: { padding: 8 },
  spark: {
    height: 60, display: 'flex', alignItems: 'flex-end', gap: 2,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 6,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  bar: { flex: 1, backgroundColor: tokens.colorBrandBackground, borderRadius: 2 },
  tagRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  chatWrap: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720 },
  chatLog: {
    height: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 12,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  msgUser: {
    alignSelf: 'flex-end', maxWidth: '75%', padding: '8px 12px', borderRadius: 12,
    backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand,
  },
  msgBot: {
    alignSelf: 'flex-start', maxWidth: '75%', padding: '8px 12px', borderRadius: 12,
    backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  chatInputRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
});

// ============================================================
// Shared types
// ============================================================

interface Environment {
  id: string;
  name: string;
  displayName: string;
  dataverseHost?: string;
  hasDataverse: boolean;
}

interface Agent {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  modelDeployment?: string;
  state?: string;
}

interface KnowledgeSource {
  id: string;
  name: string;
  type: string;
  uri?: string;
  status?: string;
}

interface Topic {
  id: string;
  name: string;
  triggerPhrases: string[];
  flowYaml?: string;
  modifiedOn?: string;
}

interface Action {
  id: string;
  name: string;
  type?: string;
  connectorId?: string;
  flowId?: string;
  enabled?: boolean;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  embedUrl?: string;
}

interface Analytics {
  agentId: string;
  windowDays: number;
  sessions: number;
  resolvedSessions: number;
  escalatedSessions: number;
  satisfactionScore?: number;
  resolutionRate?: number;
  escalationRate?: number;
  daily?: { date: string; sessions: number }[];
}

interface Template {
  id: string;
  name: string;
  description: string;
  instructions: string;
  category?: string;
  suggestedModel?: string;
  builtin?: boolean;
  knowledge?: any[];
  topics?: any[];
}

// ============================================================
// Shared helpers
// ============================================================

function ErrorBar({ error, hint }: { error: string | null; hint?: string }) {
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        <MessageBarTitle>Copilot Studio call failed</MessageBarTitle>
        {error}
        {hint && <div style={{ marginTop: 4 }}><Caption1>{hint}</Caption1></div>}
      </MessageBarBody>
    </MessageBar>
  );
}

const TENANT_HINT =
  'If you see "tenant isolation" or "principal not found", ensure the Loom UAMI is added as a Dataverse application user with a maker role in the target environment.';

function EnvironmentPicker({
  value, onChange, label = 'Environment',
}: { value: string; onChange: (id: string) => void; label?: string }) {
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/items/copilot-studio-agent?envs=1')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) { setError(j.error || 'failed to load environments'); return; }
        setEnvs(j.environments || []);
        if (!value && (j.environments || []).length > 0) {
          const first = (j.environments as Environment[]).find((e) => e.hasDataverse) || j.environments[0];
          onChange(first.id);
        }
      })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Field label={label}>
      {error && <ErrorBar error={error} hint={TENANT_HINT} />}
      <Dropdown
        value={envs?.find((e) => e.id === value)?.displayName || ''}
        selectedOptions={value ? [value] : []}
        onOptionSelect={(_, d) => d.optionValue && onChange(d.optionValue)}
        placeholder={envs ? 'Select an environment' : 'Loading…'}
      >
        {(envs || []).map((e) => (
          <Option key={e.id} value={e.id} disabled={!e.hasDataverse}>
            {e.displayName} {e.hasDataverse ? '' : ' (no Dataverse)'}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );
}

function AgentPicker({
  envId, value, onChange,
}: { envId: string; value: string; onChange: (id: string, agent?: Agent) => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!envId) { setAgents(null); return; }
    let cancelled = false;
    setAgents(null); setError(null);
    fetch(`/api/items/copilot-studio-agent?envId=${encodeURIComponent(envId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) { setError(j.error || 'failed to load agents'); return; }
        setAgents(j.agents || []);
      })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [envId]);
  return (
    <Field label="Agent">
      {error && <ErrorBar error={error} hint={TENANT_HINT} />}
      <Dropdown
        value={agents?.find((a) => a.id === value)?.name || ''}
        selectedOptions={value ? [value] : []}
        onOptionSelect={(_, d) => {
          if (!d.optionValue) return;
          onChange(d.optionValue, agents?.find((a) => a.id === d.optionValue));
        }}
        placeholder={agents ? (agents.length === 0 ? 'No agents in this environment' : 'Select an agent') : 'Loading…'}
        disabled={!envId}
      >
        {(agents || []).map((a) => (
          <Option key={a.id} value={a.id}>{a.name}</Option>
        ))}
      </Dropdown>
    </Field>
  );
}

// ============================================================
// CopilotStudioAgentEditor
// ============================================================

export function CopilotStudioAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<{ name: string; description: string; instructions: string; modelDeployment: string }>({
    name: '', description: '', instructions: '', modelDeployment: 'gpt-4o',
  });
  // Phase 4.5 — dirty flag protects in-flight edits from being clobbered by
  // the agents-list reload that runs after save/refresh/publish.
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'edit' | 'knowledge' | 'topics' | 'actions' | 'channels' | 'test'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const setFormField = useCallback(
    <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
      setDirty(true);
    },
    [],
  );

  const refreshAgents = useCallback(async () => {
    if (!envId) return;
    setError(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-agent?envId=${encodeURIComponent(envId)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to load agents'); return; }
      setAgents(j.agents || []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [envId]);

  useEffect(() => { setAgents(null); setSelectedId(''); setDirty(false); refreshAgents(); }, [envId, refreshAgents]);

  // When the selectedId changes (user clicked a different agent in the
  // sidebar), reset dirty so the form sync effect adopts the new agent.
  useEffect(() => { setDirty(false); }, [selectedId]);

  useEffect(() => {
    // Phase 4.5 — never clobber unsaved edits when the list reloads. The
    // form only adopts server values when the user has no in-flight edits.
    if (dirty) return;
    const a = agents?.find((x) => x.id === selectedId);
    if (a) {
      setForm({
        name: a.name || '',
        description: a.description || '',
        instructions: a.instructions || '',
        modelDeployment: a.modelDeployment || 'gpt-4o',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, agents]);

  const save = useCallback(async () => {
    if (!envId) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const isNew = !selectedId;
      const url = isNew
        ? '/api/items/copilot-studio-agent'
        : `/api/items/copilot-studio-agent/${encodeURIComponent(selectedId)}`;
      const r = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId, ...form }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'save failed'); return; }
      setSuccess(isNew ? `Saved at ${new Date().toLocaleTimeString()}` : `Saved at ${new Date().toLocaleTimeString()}`);
      setDirty(false);
      await refreshAgents();
      if (isNew && j.agent?.id) setSelectedId(j.agent.id);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, selectedId, form, refreshAgents]);

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (envId && form.name && !busy && dirty) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [envId, form.name, busy, dirty, save]);

  const publish = useCallback(async () => {
    if (!envId || !selectedId) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-agent/${encodeURIComponent(selectedId)}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'publish failed'); return; }
      setSuccess('Published');
      await refreshAgents();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, selectedId, refreshAgents]);

  const remove = useCallback(async () => {
    if (!envId || !selectedId) return;
    if (!window.confirm('Delete this agent?')) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-agent/${encodeURIComponent(selectedId)}?envId=${encodeURIComponent(envId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'delete failed'); return; }
      setSuccess('Deleted');
      setSelectedId('');
      setForm({ name: '', description: '', instructions: '', modelDeployment: 'gpt-4o' });
      setDirty(false);
      await refreshAgents();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, selectedId, refreshAgents]);

  // Wire the Fabric-style ribbon to the editor's real handlers. Previously the
  // 9 actions in AGENT_RIBBON had no onClick and the Ribbon component
  // auto-disabled them with a "not wired" tooltip — surfacing 9 dead buttons.
  const startNew = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes to the current agent?')) return;
    setSelectedId('');
    setForm({ name: '', description: '', instructions: '', modelDeployment: 'gpt-4o' });
    setDirty(false);
  }, [dirty]);
  const ribbon: RibbonTab[] = useMemo(() => {
    const canSave = !!envId && !!form.name && !busy && (!selectedId || dirty);
    const canPublish = !!selectedId && !busy;
    const canDelete = !!selectedId && !busy;
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'Agent', actions: [
          { label: 'New', onClick: startNew },
          { label: 'Save', onClick: canSave ? save : undefined, disabled: !canSave,
            title: canSave ? undefined : 'Save — pick an environment, set a name, and edit something to enable' },
          { label: 'Publish', onClick: canPublish ? publish : undefined, disabled: !canPublish,
            title: canPublish ? undefined : 'Publish — select a saved agent first' },
          { label: 'Delete', onClick: canDelete ? remove : undefined, disabled: !canDelete,
            title: canDelete ? undefined : 'Delete — select an agent first' },
        ]},
        { label: 'Surface', actions: [
          { label: 'Knowledge', onClick: () => setTab('knowledge') },
          { label: 'Topics', onClick: () => setTab('topics') },
          { label: 'Actions', onClick: () => setTab('actions') },
          { label: 'Channels', onClick: () => setTab('channels') },
          { label: 'Test', onClick: () => setTab('test'), disabled: !selectedId,
            title: selectedId ? undefined : 'Test — save the agent first, then chat with it over Direct Line' },
          { label: 'Analytics', disabled: true,
            title: 'Analytics — open the dedicated Copilot Analytics editor (not a tab in the Agent editor)' },
        ]},
      ]},
    ];
  }, [envId, form.name, busy, selectedId, dirty, startNew, save, publish, remove]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Tree aria-label="Agents" defaultOpenItems={['agents']}>
            <TreeItem itemType="branch" value="agents">
              <TreeItemLayout iconBefore={<Bot20Regular />}>
                Agents ({agents?.length ?? 0})
              </TreeItemLayout>
              <Tree>
                <TreeItem
                  itemType="leaf"
                  value="new"
                  onClick={() => {
                    // Phase 4.5 — confirm before discarding unsaved edits.
                    if (dirty && !window.confirm('Discard unsaved changes to the current agent?')) return;
                    setSelectedId('');
                    setForm({ name: '', description: '', instructions: '', modelDeployment: 'gpt-4o' });
                    setDirty(false);
                  }}
                >
                  <TreeItemLayout iconBefore={<Add20Regular />}>+ New agent</TreeItemLayout>
                </TreeItem>
                {(agents || []).map((a) => (
                  <TreeItem key={a.id} itemType="leaf" value={a.id} onClick={() => {
                    if (a.id === selectedId) return;
                    if (dirty && !window.confirm('Discard unsaved changes to the current agent?')) return;
                    setSelectedId(a.id);
                  }}>
                    <TreeItemLayout iconBefore={<Bot20Regular />}>
                      {a.name} {a.state === 'Published' && <Badge size="small" color="success" appearance="outline">Published</Badge>}
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Copilot Studio</Badge>
            <Caption1>Env: <strong>{envId || 'select an environment'}</strong></Caption1>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button appearance="primary" icon={<Save20Regular />} disabled={busy || !envId || !form.name || (!!selectedId && !dirty)} onClick={save}>
              {selectedId ? (dirty ? 'Save (Ctrl+S)' : 'Saved') : 'Create'}
            </Button>
            <Button appearance="outline" icon={<CloudArrowUp20Regular />} disabled={busy || !selectedId} onClick={publish}>
              Publish
            </Button>
            <Button appearance="outline" icon={<Delete20Regular />} disabled={busy || !selectedId} onClick={remove}>
              Delete
            </Button>
            <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy} onClick={refreshAgents}>Refresh</Button>
          </div>
          <EnvironmentPicker value={envId} onChange={setEnvId} />
          <ErrorBar error={error} hint={TENANT_HINT} />
          {success && (
            <MessageBar intent="success"><MessageBarBody><MessageBarTitle>OK</MessageBarTitle>{success}</MessageBarBody></MessageBar>
          )}
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
            <Tab value="edit" icon={<Bot20Regular />}>Agent</Tab>
            <Tab value="knowledge" icon={<BookOpen20Regular />}>Knowledge</Tab>
            <Tab value="topics" icon={<Chat20Regular />}>Topics</Tab>
            <Tab value="actions" icon={<Flow20Regular />}>Actions</Tab>
            <Tab value="channels" icon={<Channel20Regular />}>Channels</Tab>
            <Tab value="test" icon={<Chat20Regular />}>Test</Tab>
          </TabList>
          {tab === 'edit' && (
            <div className={s.form}>
              <div className={s.formCol}>
                <Field label="Name" required>
                  <Input value={form.name} onChange={(_, d) => setFormField('name', d.value)} />
                </Field>
                <Field label="Description">
                  <Textarea rows={3} value={form.description} onChange={(_, d) => setFormField('description', d.value)} />
                </Field>
                <Field label="Model deployment" hint="Azure OpenAI deployment name bound to this agent.">
                  <Input value={form.modelDeployment} onChange={(_, d) => setFormField('modelDeployment', d.value)} />
                </Field>
              </div>
              <div className={s.formCol}>
                <Field label="Instructions (system prompt)">
                  <Textarea rows={12} value={form.instructions} onChange={(_, d) => setFormField('instructions', d.value)} />
                </Field>
              </div>
            </div>
          )}
          {tab === 'knowledge' && <InlineKnowledge envId={envId} agentId={selectedId} />}
          {tab === 'topics' && <InlineTopics envId={envId} agentId={selectedId} />}
          {tab === 'actions' && <InlineActions envId={envId} agentId={selectedId} />}
          {tab === 'channels' && <InlineChannels envId={envId} agentId={selectedId} />}
          {tab === 'test' && <TestChatPanel agentId={selectedId} />}
        </div>
      }
    />
  );
}

// ============================================================
// Inline sub-panels reused by the Agent editor tabs
// ============================================================

function InlineKnowledge({ envId, agentId }: { envId: string; agentId: string }) {
  return <KnowledgePanel envId={envId} agentId={agentId} />;
}
function InlineTopics({ envId, agentId }: { envId: string; agentId: string }) {
  return <TopicsPanel envId={envId} agentId={agentId} />;
}
function InlineActions({ envId, agentId }: { envId: string; agentId: string }) {
  return <ActionsPanel envId={envId} agentId={agentId} />;
}
function InlineChannels({ envId, agentId }: { envId: string; agentId: string }) {
  return <ChannelsPanel envId={envId} agentId={agentId} />;
}

// ============================================================
// KnowledgePanel + CopilotKnowledgeEditor
// ============================================================

function KnowledgePanel({ envId, agentId }: { envId: string; agentId: string }) {
  const s = useStyles();
  const [items, setItems] = useState<KnowledgeSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ type: string; name: string; uri: string }>({ type: 'url', name: '', uri: '' });

  const refresh = useCallback(async () => {
    if (!envId || !agentId) { setItems(null); return; }
    setError(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-knowledge?envId=${encodeURIComponent(envId)}&agentId=${encodeURIComponent(agentId)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setItems(j.knowledge || []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [envId, agentId]);
  useEffect(() => { refresh(); }, [refresh]);

  const add = useCallback(async () => {
    if (!envId || !agentId) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/items/copilot-studio-knowledge', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId, agentId, ...form }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'add failed'); return; }
      setForm({ type: 'url', name: '', uri: '' });
      await refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, agentId, form, refresh]);

  const remove = useCallback(async (id: string) => {
    if (!envId) return;
    setBusy(true);
    try {
      await fetch(`/api/items/copilot-studio-knowledge/${encodeURIComponent(id)}?envId=${encodeURIComponent(envId)}`, { method: 'DELETE' });
      await refresh();
    } finally { setBusy(false); }
  }, [envId, refresh]);

  if (!agentId) return <Caption1>Pick an agent to manage knowledge sources.</Caption1>;
  return (
    <div className={s.formCol}>
      <ErrorBar error={error} hint={TENANT_HINT} />
      <div className={s.form}>
        <Field label="Type">
          <Dropdown
            value={form.type}
            selectedOptions={[form.type]}
            onOptionSelect={(_, d) => d.optionValue && setForm((f) => ({ ...f, type: d.optionValue! }))}
          >
            <Option value="url">URL</Option>
            <Option value="file">File</Option>
            <Option value="sharepoint">SharePoint</Option>
            <Option value="dataverse-table">Dataverse table</Option>
          </Dropdown>
        </Field>
        <Field label="Name">
          <Input id="ks-name-input" value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
        </Field>
        <Field label="URI / location" hint="URL, file URI, SharePoint site URL, or Dataverse table logical name">
          <Input value={form.uri} onChange={(_, d) => setForm((f) => ({ ...f, uri: d.value }))} />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <Button appearance="primary" icon={<Add20Regular />} disabled={busy || !form.type} onClick={add}>Add</Button>
        </div>
      </div>
      <Subtitle2>Sources ({items?.length ?? 0})</Subtitle2>
      {items === null ? <Spinner size="tiny" /> : items.length === 0 ? (
        <Caption1>No knowledge sources yet.</Caption1>
      ) : (
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>URI</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((k) => (
              <TableRow key={k.id}>
                <TableCell>{k.name}</TableCell>
                <TableCell><Badge appearance="outline">{k.type}</Badge></TableCell>
                <TableCell>{k.uri || '—'}</TableCell>
                <TableCell>{k.status || '—'}</TableCell>
                <TableCell>
                  <Button size="small" icon={<Delete20Regular />} appearance="subtle" onClick={() => remove(k.id)}>Remove</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function CopilotKnowledgeEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  // The inline KnowledgePanel owns the form state for the Add row and the
  // per-row Remove buttons. The ribbon's Add focuses+scrolls the Name input
  // (it can't submit alone — the user still has to pick a Type/URI). Remove
  // is inherently row-specific and stays disabled with a clear tooltip.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [{ label: 'Knowledge', actions: [
      { label: 'Add', onClick: () => {
        const el = document.getElementById('ks-name-input') as HTMLInputElement | null;
        if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
      }, disabled: !agentId,
        title: agentId ? undefined : 'Add — pick an environment + agent first' },
      { label: 'Remove', disabled: true,
        title: 'Remove — use the per-row Remove button on a specific knowledge source' },
    ]}]},
  ], [agentId]);
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          <EnvironmentPicker value={envId} onChange={(v) => { setEnvId(v); setAgentId(''); }} />
          <AgentPicker envId={envId} value={agentId} onChange={setAgentId} />
          <KnowledgePanel envId={envId} agentId={agentId} />
        </div>
      }
    />
  );
}

// ============================================================
// TopicsPanel + CopilotTopicEditor
// ============================================================

function TopicsPanel({ envId, agentId }: { envId: string; agentId: string }) {
  const s = useStyles();
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('');
  const [form, setForm] = useState<{ name: string; triggerText: string; flowYaml: string }>({
    name: '', triggerText: '', flowYaml: 'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Hello"',
  });
  // Phase 4.5 — dirty flag prevents the topics-reload effect from
  // clobbering in-flight edits after save/refresh.
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const setFormField = useCallback(
    <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
      setDirty(true);
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!envId || !agentId) { setTopics(null); return; }
    setError(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-topic?envId=${encodeURIComponent(envId)}&agentId=${encodeURIComponent(agentId)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setTopics(j.topics || []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [envId, agentId]);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => { setDirty(false); }, [selectedId]);

  useEffect(() => {
    // Phase 4.5 — don't clobber unsaved edits when topics list reloads.
    if (dirty) return;
    const t = topics?.find((x) => x.id === selectedId);
    if (t) {
      setForm({
        name: t.name || '',
        triggerText: (t.triggerPhrases || []).join('\n'),
        flowYaml: t.flowYaml || '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, topics]);

  const save = useCallback(async () => {
    if (!envId || !agentId) return;
    setBusy(true); setError(null); setSaveMsg('Saving…');
    const triggerPhrases = form.triggerText.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      const isNew = !selectedId;
      const url = isNew
        ? '/api/items/copilot-studio-topic'
        : `/api/items/copilot-studio-topic/${encodeURIComponent(selectedId)}`;
      const r = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId, agentId, name: form.name, triggerPhrases, flowYaml: form.flowYaml }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'save failed'); setSaveMsg(null); return; }
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      await refresh();
      if (isNew && j.topic?.id) setSelectedId(j.topic.id);
    } catch (e: any) { setError(e?.message || String(e)); setSaveMsg(null); }
    finally { setBusy(false); }
  }, [envId, agentId, selectedId, form, refresh]);

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (envId && agentId && form.name && !busy && dirty) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [envId, agentId, form.name, busy, dirty, save]);

  const remove = useCallback(async (tid: string) => {
    if (!envId) return;
    setBusy(true);
    try {
      await fetch(`/api/items/copilot-studio-topic/${encodeURIComponent(tid)}?envId=${encodeURIComponent(envId)}`, { method: 'DELETE' });
      if (selectedId === tid) setSelectedId('');
      await refresh();
    } finally { setBusy(false); }
  }, [envId, selectedId, refresh]);

  if (!agentId) return <Caption1>Pick an agent to manage topics.</Caption1>;
  return (
    <div className={s.formCol}>
      <ErrorBar error={error} hint={TENANT_HINT} />
      <div className={s.toolbar}>
        <Button icon={<Add20Regular />} appearance="outline" onClick={() => {
          if (dirty && !window.confirm('Discard unsaved changes to the current topic?')) return;
          setSelectedId('');
          setForm({ name: '', triggerText: '', flowYaml: 'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Hello"' });
          setDirty(false);
        }}>New topic</Button>
        <Button icon={<Save20Regular />} appearance="primary" disabled={busy || !form.name || (!!selectedId && !dirty)} onClick={save}>
          {selectedId ? (dirty ? 'Save topic (Ctrl+S)' : 'Saved') : 'Create topic'}
        </Button>
        {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
        <Button icon={<ArrowSync20Regular />} appearance="subtle" disabled={busy} onClick={refresh}>Refresh</Button>
        {saveMsg && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
      </div>
      <div className={s.form}>
        <div className={s.formCol}>
          <Field label="Topic name" required>
            <Input id="topic-name-input" value={form.name} onChange={(_, d) => setFormField('name', d.value)} />
          </Field>
          <Field label="Trigger phrases (one per line)">
            <Textarea rows={8} value={form.triggerText} onChange={(_, d) => setFormField('triggerText', d.value)} />
          </Field>
          <Subtitle2>Existing topics ({topics?.length ?? 0})</Subtitle2>
          {(topics || []).map((t) => (
            <div key={t.id} className={s.card} style={{ cursor: 'pointer', borderColor: t.id === selectedId ? tokens.colorBrandStroke1 : undefined }}
                 onClick={() => {
                   if (t.id === selectedId) return;
                   if (dirty && !window.confirm('Discard unsaved changes to the current topic?')) return;
                   setSelectedId(t.id);
                 }}>
              <Body1><strong>{t.name}</strong></Body1>
              <div className={s.tagRow}>
                {(t.triggerPhrases || []).slice(0, 6).map((p, i) => <Badge key={i} appearance="outline" size="small">{p}</Badge>)}
                {(t.triggerPhrases || []).length > 6 && <Caption1>+{t.triggerPhrases.length - 6} more</Caption1>}
              </div>
              <Button size="small" icon={<Delete20Regular />} appearance="subtle"
                onClick={(e) => { e.stopPropagation(); remove(t.id); }}>Delete</Button>
            </div>
          ))}
        </div>
        <div className={s.formCol}>
          <Field label="Flow YAML">
            <MonacoTextarea
              value={form.flowYaml}
              onChange={(v) => setFormField('flowYaml', v)}
              language="plaintext"
              height={320}
              minHeight={240}
              ariaLabel="Topic flow YAML"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

export function CopilotTopicEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  // TopicsPanel owns Save (form-dependent) and per-row Delete. The ribbon's
  // New focuses the inline "New topic" button; Save/Delete are inherently
  // bound to the in-panel selection and stay disabled with explanations.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [{ label: 'Topic', actions: [
      { label: 'New', onClick: () => {
        const el = document.getElementById('topic-name-input') as HTMLInputElement | null;
        if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
      }, disabled: !agentId,
        title: agentId ? undefined : 'New — pick an environment + agent first' },
      { label: 'Save', disabled: true,
        title: 'Save — use the inline "Save topic" button (Ctrl+S also works while editing)' },
      { label: 'Delete', disabled: true,
        title: 'Delete — use the per-row Delete button on a specific topic card' },
    ]}]},
  ], [agentId]);
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          <EnvironmentPicker value={envId} onChange={(v) => { setEnvId(v); setAgentId(''); }} />
          <AgentPicker envId={envId} value={agentId} onChange={setAgentId} />
          <TopicsPanel envId={envId} agentId={agentId} />
        </div>
      }
    />
  );
}

// ============================================================
// ActionsPanel + CopilotActionEditor
// ============================================================

function ActionsPanel({ envId, agentId }: { envId: string; agentId: string }) {
  const s = useStyles();
  const [items, setItems] = useState<Action[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ name: string; type: string; connectorId: string; flowId: string }>({
    name: '', type: 'power-automate-flow', connectorId: '', flowId: '',
  });

  const refresh = useCallback(async () => {
    if (!envId || !agentId) { setItems(null); return; }
    setError(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-action?envId=${encodeURIComponent(envId)}&agentId=${encodeURIComponent(agentId)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setItems(j.actions || []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [envId, agentId]);
  useEffect(() => { refresh(); }, [refresh]);

  const bind = useCallback(async () => {
    if (!envId || !agentId || !form.name) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/items/copilot-studio-action', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId, agentId, ...form }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'bind failed'); return; }
      setForm({ name: '', type: 'power-automate-flow', connectorId: '', flowId: '' });
      await refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, agentId, form, refresh]);

  const remove = useCallback(async (aid: string) => {
    if (!envId) return;
    setBusy(true);
    try {
      await fetch(`/api/items/copilot-studio-action/${encodeURIComponent(aid)}?envId=${encodeURIComponent(envId)}`, { method: 'DELETE' });
      await refresh();
    } finally { setBusy(false); }
  }, [envId, refresh]);

  if (!agentId) return <Caption1>Pick an agent to manage actions.</Caption1>;
  return (
    <div className={s.formCol}>
      <ErrorBar error={error} hint={TENANT_HINT} />
      <div className={s.form}>
        <Field label="Action name" required>
          <Input id="action-name-input" value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
        </Field>
        <Field label="Type">
          <Dropdown
            value={form.type}
            selectedOptions={[form.type]}
            onOptionSelect={(_, d) => d.optionValue && setForm((f) => ({ ...f, type: d.optionValue! }))}
          >
            <Option value="power-automate-flow">Power Automate flow</Option>
            <Option value="custom-connector">Custom connector</Option>
            <Option value="prebuilt">Prebuilt</Option>
          </Dropdown>
        </Field>
        <Field label="Flow id" hint="Power Automate flow GUID (when type = power-automate-flow)">
          <Input value={form.flowId} onChange={(_, d) => setForm((f) => ({ ...f, flowId: d.value }))} />
        </Field>
        <Field label="Connector id" hint="Custom connector resource id (when type = custom-connector)">
          <Input value={form.connectorId} onChange={(_, d) => setForm((f) => ({ ...f, connectorId: d.value }))} />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <Button appearance="primary" icon={<Add20Regular />} disabled={busy || !form.name} onClick={bind}>Bind action</Button>
        </div>
      </div>
      <Subtitle2>Bound actions ({items?.length ?? 0})</Subtitle2>
      {items === null ? <Spinner size="tiny" /> : items.length === 0 ? (
        <Caption1>No actions bound to this agent yet.</Caption1>
      ) : (
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Reference</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((a) => (
              <TableRow key={a.id}>
                <TableCell>{a.name}</TableCell>
                <TableCell><Badge appearance="outline">{a.type || '—'}</Badge></TableCell>
                <TableCell>{a.flowId || a.connectorId || '—'}</TableCell>
                <TableCell>
                  <Badge appearance="outline" color={a.enabled ? 'success' : 'severe'}>{a.enabled ? 'Enabled' : 'Disabled'}</Badge>
                </TableCell>
                <TableCell>
                  <Button size="small" icon={<Delete20Regular />} appearance="subtle" onClick={() => remove(a.id)}>Remove</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function CopilotActionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  // ActionsPanel owns Bind (form-dependent) and per-row Remove. The ribbon's
  // Bind focuses the inline form's Name input; Remove is row-specific.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [{ label: 'Action', actions: [
      { label: 'Bind', onClick: () => {
        const el = document.getElementById('action-name-input') as HTMLInputElement | null;
        if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
      }, disabled: !agentId,
        title: agentId ? undefined : 'Bind — pick an environment + agent first' },
      { label: 'Remove', disabled: true,
        title: 'Remove — use the per-row Remove button on a specific bound action' },
    ]}]},
  ], [agentId]);
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          <EnvironmentPicker value={envId} onChange={(v) => { setEnvId(v); setAgentId(''); }} />
          <AgentPicker envId={envId} value={agentId} onChange={setAgentId} />
          <ActionsPanel envId={envId} agentId={agentId} />
        </div>
      }
    />
  );
}

// ============================================================
// ChannelsPanel + CopilotChannelEditor
// ============================================================

const CHANNEL_TYPES: { type: string; label: string; description: string }[] = [
  { type: 'teams', label: 'Microsoft Teams', description: 'Publish as a Teams app — 1:1 chat, channel mentions, meeting side panel.' },
  { type: 'web', label: 'Web chat', description: 'Embeddable Bot Framework Web Chat widget.' },
  { type: 'direct-line', label: 'Direct Line', description: 'REST/Websocket endpoint for custom clients.' },
  { type: 'slack', label: 'Slack', description: 'Publish to a Slack workspace via the Bot Framework Slack connector.' },
  { type: 'facebook', label: 'Facebook', description: 'Publish to a Facebook Page via Messenger.' },
  { type: 'custom', label: 'Custom channel', description: 'Adapter-backed custom channel; provide raw JSON config.' },
];

function ChannelsPanel({ envId, agentId, refreshSignal }: { envId: string; agentId: string; refreshSignal?: number }) {
  const s = useStyles();
  const [items, setItems] = useState<Channel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [configText, setConfigText] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!envId || !agentId) { setItems(null); return; }
    setError(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-channel?envId=${encodeURIComponent(envId)}&agentId=${encodeURIComponent(agentId)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setItems(j.channels || []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [envId, agentId]);
  useEffect(() => { refresh(); }, [refresh]);
  // External nonce-driven refresh from the parent's ribbon Refresh action.
  useEffect(() => { if (refreshSignal && refreshSignal > 0) refresh(); }, [refreshSignal, refresh]);

  const publish = useCallback(async (channelType: string) => {
    if (!envId || !agentId) return;
    setBusy(channelType); setError(null);
    let config: any = {};
    const raw = configText[channelType];
    if (raw) { try { config = JSON.parse(raw); } catch { setError(`Invalid JSON for ${channelType} config`); setBusy(null); return; } }
    try {
      const r = await fetch(`/api/items/copilot-studio-channel/${encodeURIComponent(agentId)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId, channelType, config }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'publish failed'); return; }
      await refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(null); }
  }, [envId, agentId, configText, refresh]);

  if (!agentId) return <Caption1>Pick an agent to publish channels.</Caption1>;
  const byType = new Map((items || []).map((c) => [c.type, c]));
  return (
    <div className={s.formCol}>
      <ErrorBar error={error} hint={TENANT_HINT} />
      <div className={s.cardGrid}>
        {CHANNEL_TYPES.map((ct) => {
          const existing = byType.get(ct.type);
          return (
            <div key={ct.type} className={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Body1><strong>{ct.label}</strong></Body1>
                {existing
                  ? <Badge color={existing.enabled ? 'success' : 'severe'} appearance="filled">{existing.enabled ? 'Published' : 'Disabled'}</Badge>
                  : <Badge appearance="outline">Not published</Badge>}
              </div>
              <Caption1>{ct.description}</Caption1>
              {existing?.embedUrl && <Caption1>Embed: <code>{existing.embedUrl}</code></Caption1>}
              <Field label="Channel settings">
                <KeyValueGrid
                  value={configText[ct.type] ?? ''}
                  onChange={(v) => setConfigText((m) => ({ ...m, [ct.type]: v }))}
                  keyLabel="Setting" valueLabel="Value"
                  keyPlaceholder="setting" valuePlaceholder="value" addLabel="Add setting"
                />
              </Field>
              <Button
                appearance="primary"
                icon={<CloudArrowUp20Regular />}
                disabled={busy === ct.type}
                onClick={() => publish(ct.type)}
              >
                {existing ? 'Re-publish' : 'Publish to channel'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CopilotChannelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [refreshSignal, setRefreshSignal] = useState(0);
  // Publish is per-channel-type (lives on each card); the ribbon disables it
  // with a tooltip pointing the user at the per-card Publish button. Refresh
  // bumps a signal that ChannelsPanel watches.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [{ label: 'Channel', actions: [
      { label: 'Publish', disabled: true,
        title: 'Publish — use the per-card "Publish to channel" button (each channel type has its own config)' },
      { label: 'Refresh', onClick: () => setRefreshSignal((n) => n + 1), disabled: !agentId,
        title: agentId ? undefined : 'Refresh — pick an environment + agent first' },
    ]}]},
  ], [agentId]);
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          <EnvironmentPicker value={envId} onChange={(v) => { setEnvId(v); setAgentId(''); }} />
          <AgentPicker envId={envId} value={agentId} onChange={setAgentId} />
          <ChannelsPanel envId={envId} agentId={agentId} refreshSignal={refreshSignal} />
        </div>
      }
    />
  );
}

// ============================================================
// TestChatPanel — live "Test your agent" over Bot Framework Direct Line
// ============================================================

interface ChatMessage { from: 'user' | 'bot'; text: string }

function TestChatPanel({ agentId }: { agentId: string }) {
  const s = useStyles();
  const [token, setToken] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [watermark, setWatermark] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const DL = 'https://directline.botframework.com/v3/directline';

  const connect = useCallback(async () => {
    if (!agentId) return;
    setConnecting(true); setError(null); setHint(null); setMessages([]); setWatermark(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-agent/${encodeURIComponent(agentId)}/directline-token`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'token request failed'); if (j.status === 424) setHint('Configure the Direct Line secret env var, then reconnect.'); return; }
      setToken(j.token);
      // Start a Direct Line conversation directly from the browser using the token.
      const cr = await fetch(`${DL}/conversations`, { method: 'POST', headers: { authorization: `Bearer ${j.token}` } });
      const cj = await cr.json();
      if (!cr.ok || !cj.conversationId) { setError(`start conversation failed (HTTP ${cr.status})`); return; }
      setConversationId(cj.conversationId);
      // Trigger the greeting/welcome.
      await fetch(`${DL}/conversations/${cj.conversationId}/activities`, {
        method: 'POST', headers: { authorization: `Bearer ${j.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'event', name: 'startConversation', from: { id: 'loom-user' } }),
      }).catch(() => {});
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setConnecting(false); }
  }, [agentId]);

  const poll = useCallback(async () => {
    if (!token || !conversationId) return;
    const url = `${DL}/conversations/${conversationId}/activities${watermark ? `?watermark=${watermark}` : ''}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const j = await r.json();
    if (j.watermark) setWatermark(j.watermark);
    const botMsgs: ChatMessage[] = (j.activities || [])
      .filter((a: any) => a.type === 'message' && a.from?.id !== 'loom-user' && a.text)
      .map((a: any) => ({ from: 'bot' as const, text: a.text }));
    if (botMsgs.length) setMessages((m) => [...m, ...botMsgs]);
  }, [token, conversationId, watermark]);

  // Poll for bot replies while a conversation is open.
  useEffect(() => {
    if (!token || !conversationId) return;
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [token, conversationId, poll]);

  const send = useCallback(async () => {
    if (!token || !conversationId || !draft.trim()) return;
    const text = draft.trim();
    setDraft(''); setSending(true);
    setMessages((m) => [...m, { from: 'user', text }]);
    try {
      await fetch(`${DL}/conversations/${conversationId}/activities`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'message', from: { id: 'loom-user' }, text }),
      });
      setTimeout(poll, 800);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSending(false); }
  }, [token, conversationId, draft, poll]);

  if (!agentId) return <Caption1>Pick an agent to open the test chat.</Caption1>;
  return (
    <div className={s.chatWrap}>
      <Caption1>
        Talks to the published agent over Bot Framework Direct Line — the same channel the in-product
        "Test your agent" panel uses. Requires a Direct Line secret (see the connect error if not configured).
      </Caption1>
      {error && (
        <MessageBar intent={error.includes('Direct Line secret') ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{error.includes('Direct Line secret') ? 'Test chat not configured' : 'Test chat error'}</MessageBarTitle>
            {error}{hint && <div style={{ marginTop: 4 }}><Caption1>{hint}</Caption1></div>}
          </MessageBarBody>
        </MessageBar>
      )}
      {!conversationId ? (
        <Button appearance="primary" icon={<PlayCircle20Regular />} disabled={connecting} onClick={connect}>
          {connecting ? 'Connecting…' : 'Connect & start test conversation'}
        </Button>
      ) : (
        <>
          <div className={s.chatLog} aria-label="Test chat transcript">
            {messages.length === 0 && <Caption1>Conversation started — say hello.</Caption1>}
            {messages.map((m, i) => (
              <div key={i} className={m.from === 'user' ? s.msgUser : s.msgBot}>{m.text}</div>
            ))}
          </div>
          <div className={s.chatInputRow}>
            <Input
              style={{ flex: 1 }}
              value={draft}
              placeholder="Type a message…"
              onChange={(_, d) => setDraft(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <Button appearance="primary" icon={<Send20Regular />} disabled={sending || !draft.trim()} onClick={send}>Send</Button>
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={connect} title="Reset conversation">Reset</Button>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// CopilotAnalyticsEditor
// ============================================================

export function CopilotAnalyticsEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!envId || !agentId) { setData(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/copilot-studio-analytics/${encodeURIComponent(agentId)}?envId=${encodeURIComponent(envId)}&days=${days}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setData(null); return; }
      setData(j.analytics);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [envId, agentId, days]);
  useEffect(() => { refresh(); }, [refresh]);

  const maxDaily = useMemo(() => Math.max(1, ...(data?.daily || []).map((d) => d.sessions)), [data]);

  // Wire the timeframe ribbon to the inline `days` state. Each window button
  // sets the days count, which drives the analytics fetch via `refresh`.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [{ label: 'Window', actions: [
      { label: '7d', onClick: () => setDays(7) },
      { label: '30d', onClick: () => setDays(30) },
      { label: '90d', onClick: () => setDays(90) },
    ]}]},
  ], []);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          <EnvironmentPicker value={envId} onChange={(v) => { setEnvId(v); setAgentId(''); }} />
          <AgentPicker envId={envId} value={agentId} onChange={setAgentId} />
          <div className={s.toolbar}>
            <Caption1>Window:</Caption1>
            {[7, 30, 90].map((d) => (
              <Button key={d} size="small" appearance={d === days ? 'primary' : 'outline'} onClick={() => setDays(d)}>{d}d</Button>
            ))}
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={refresh} disabled={loading}>Refresh</Button>
          </div>
          <ErrorBar error={error} hint={TENANT_HINT} />
          {loading && <Spinner size="small" label="Loading analytics…" labelPosition="after" />}
          {data && (
            <>
              <div className={s.kpiGrid}>
                <div className={s.kpi}>
                  <Caption1>Sessions ({data.windowDays}d)</Caption1>
                  <div className={s.kpiValue}>{data.sessions.toLocaleString()}</div>
                </div>
                <div className={s.kpi}>
                  <Caption1>Resolved</Caption1>
                  <div className={s.kpiValue}>{data.resolvedSessions.toLocaleString()}</div>
                  {data.resolutionRate !== undefined && <Caption1>{(data.resolutionRate * 100).toFixed(1)}% resolution rate</Caption1>}
                </div>
                <div className={s.kpi}>
                  <Caption1>Escalated</Caption1>
                  <div className={s.kpiValue}>{data.escalatedSessions.toLocaleString()}</div>
                  {data.escalationRate !== undefined && <Caption1>{(data.escalationRate * 100).toFixed(1)}% escalation rate</Caption1>}
                </div>
                <div className={s.kpi}>
                  <Caption1>CSAT</Caption1>
                  <div className={s.kpiValue}>{data.satisfactionScore !== undefined ? data.satisfactionScore.toFixed(2) : '—'}</div>
                </div>
              </div>
              <Subtitle2>Daily sessions</Subtitle2>
              {(data.daily && data.daily.length > 0) ? (
                <div className={s.spark} aria-label="Daily session bar chart">
                  {data.daily.map((d, i) => (
                    <div key={i} className={s.bar} style={{ height: `${(d.sessions / maxDaily) * 100}%` }} title={`${d.date}: ${d.sessions}`} />
                  ))}
                </div>
              ) : (
                <Caption1>No daily data returned for this window.</Caption1>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

// ============================================================
// CopilotTemplateLibraryEditor
// ============================================================

export function CopilotTemplateLibraryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/items/copilot-template-library');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setTemplates(j.templates || []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const use = useCallback(async (tid: string, tname: string) => {
    if (!envId) { setError('Select an environment first.'); return; }
    setBusy(tid); setError(null); setResult(null);
    try {
      const r = await fetch(`/api/items/copilot-template-library/${encodeURIComponent(tid)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'create failed'); return; }
      setResult({ ok: true, msg: `Created agent "${j.agent?.name || tname}" with ${(j.knowledge || []).length} knowledge source(s) and ${(j.topics || []).length} topic(s).` });
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(null); }
  }, [envId]);

  const byCategory = useMemo(() => {
    const m = new Map<string, Template[]>();
    (templates || []).forEach((t) => {
      const k = t.category || 'Uncategorized';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    });
    return Array.from(m.entries());
  }, [templates]);

  // Wire the ribbon: Refresh reloads the template list; "Use template" is
  // inherently per-template (each card has its own Use button) so the ribbon
  // entry disables with a tooltip pointing at the per-card button.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [{ label: 'Template', actions: [
      { label: 'Refresh', onClick: refresh },
      { label: 'Use template', disabled: true,
        title: 'Use template — click the "Use template" button on a specific template card' },
    ]}]},
  ], [refresh]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand"><Library20Regular /> CSA template library</Badge>
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={refresh}>Refresh</Button>
          </div>
          <EnvironmentPicker value={envId} onChange={setEnvId} label="Target environment" />
          <ErrorBar error={error} hint={TENANT_HINT} />
          {result && <MessageBar intent="success"><MessageBarBody><MessageBarTitle>Template instantiated</MessageBarTitle>{result.msg}</MessageBarBody></MessageBar>}
          {templates === null ? <Spinner size="small" label="Loading templates…" labelPosition="after" /> : (
            byCategory.map(([cat, tmpls]) => (
              <div key={cat} className={s.formCol}>
                <Subtitle2>{cat}</Subtitle2>
                <div className={s.cardGrid}>
                  {tmpls.map((t) => (
                    <div key={t.id} className={s.card}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Body1><strong>{t.name}</strong></Body1>
                        {t.builtin && <Badge appearance="outline" color="brand">Built-in</Badge>}
                      </div>
                      <Caption1>{t.description}</Caption1>
                      {t.suggestedModel && <Caption1>Model: <code>{t.suggestedModel}</code></Caption1>}
                      <div className={s.tagRow}>
                        {(t.knowledge || []).slice(0, 3).map((k: any, i: number) => (
                          <Badge key={i} appearance="outline" size="small">{k.type}</Badge>
                        ))}
                        {(t.topics || []).length > 0 && <Badge appearance="outline" size="small">{(t.topics || []).length} topic(s)</Badge>}
                      </div>
                      <Button
                        appearance="primary"
                        icon={<Add20Regular />}
                        disabled={!envId || busy === t.id}
                        onClick={() => use(t.id, t.name)}
                      >
                        {busy === t.id ? 'Creating…' : 'Use template'}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      }
    />
  );
}
