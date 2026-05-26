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
  Library20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

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

const AGENT_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Agent', actions: [{ label: 'New' }, { label: 'Save' }, { label: 'Publish' }, { label: 'Delete' }] },
    { label: 'Surface', actions: [{ label: 'Knowledge' }, { label: 'Topics' }, { label: 'Actions' }, { label: 'Channels' }, { label: 'Analytics' }] },
  ]},
];

export function CopilotStudioAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<{ name: string; description: string; instructions: string; modelDeployment: string }>({
    name: '', description: '', instructions: '', modelDeployment: 'gpt-4o',
  });
  const [tab, setTab] = useState<'edit' | 'knowledge' | 'topics' | 'actions' | 'channels'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

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

  useEffect(() => { setAgents(null); setSelectedId(''); refreshAgents(); }, [envId, refreshAgents]);

  useEffect(() => {
    const a = agents?.find((x) => x.id === selectedId);
    if (a) {
      setForm({
        name: a.name || '',
        description: a.description || '',
        instructions: a.instructions || '',
        modelDeployment: a.modelDeployment || 'gpt-4o',
      });
    }
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
      setSuccess(isNew ? 'Agent created' : 'Agent updated');
      await refreshAgents();
      if (isNew && j.agent?.id) setSelectedId(j.agent.id);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, selectedId, form, refreshAgents]);

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
      await refreshAgents();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, selectedId, refreshAgents]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={AGENT_RIBBON}
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
                  onClick={() => { setSelectedId(''); setForm({ name: '', description: '', instructions: '', modelDeployment: 'gpt-4o' }); }}
                >
                  <TreeItemLayout iconBefore={<Add20Regular />}>+ New agent</TreeItemLayout>
                </TreeItem>
                {(agents || []).map((a) => (
                  <TreeItem key={a.id} itemType="leaf" value={a.id} onClick={() => setSelectedId(a.id)}>
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
            <Button appearance="primary" icon={<Save20Regular />} disabled={busy || !envId || !form.name} onClick={save}>
              {selectedId ? 'Save' : 'Create'}
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
          </TabList>
          {tab === 'edit' && (
            <div className={s.form}>
              <div className={s.formCol}>
                <Field label="Name" required>
                  <Input value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
                </Field>
                <Field label="Description">
                  <Textarea rows={3} value={form.description} onChange={(_, d) => setForm((f) => ({ ...f, description: d.value }))} />
                </Field>
                <Field label="Model deployment" hint="Azure OpenAI deployment name bound to this agent.">
                  <Input value={form.modelDeployment} onChange={(_, d) => setForm((f) => ({ ...f, modelDeployment: d.value }))} />
                </Field>
              </div>
              <div className={s.formCol}>
                <Field label="Instructions (system prompt)">
                  <Textarea rows={12} value={form.instructions} onChange={(_, d) => setForm((f) => ({ ...f, instructions: d.value }))} />
                </Field>
              </div>
            </div>
          )}
          {tab === 'knowledge' && <InlineKnowledge envId={envId} agentId={selectedId} />}
          {tab === 'topics' && <InlineTopics envId={envId} agentId={selectedId} />}
          {tab === 'actions' && <InlineActions envId={envId} agentId={selectedId} />}
          {tab === 'channels' && <InlineChannels envId={envId} agentId={selectedId} />}
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
          <Input value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
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

const KS_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [{ label: 'Knowledge', actions: [{ label: 'Add' }, { label: 'Remove' }] }] }];

export function CopilotKnowledgeEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={KS_RIBBON}
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

  useEffect(() => {
    const t = topics?.find((x) => x.id === selectedId);
    if (t) {
      setForm({
        name: t.name || '',
        triggerText: (t.triggerPhrases || []).join('\n'),
        flowYaml: t.flowYaml || '',
      });
    }
  }, [selectedId, topics]);

  const save = useCallback(async () => {
    if (!envId || !agentId) return;
    setBusy(true); setError(null);
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
      if (!j.ok) { setError(j.error || 'save failed'); return; }
      await refresh();
      if (isNew && j.topic?.id) setSelectedId(j.topic.id);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [envId, agentId, selectedId, form, refresh]);

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
          setSelectedId('');
          setForm({ name: '', triggerText: '', flowYaml: 'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Hello"' });
        }}>New topic</Button>
        <Button icon={<Save20Regular />} appearance="primary" disabled={busy || !form.name} onClick={save}>
          {selectedId ? 'Save topic' : 'Create topic'}
        </Button>
        <Button icon={<ArrowSync20Regular />} appearance="subtle" disabled={busy} onClick={refresh}>Refresh</Button>
      </div>
      <div className={s.form}>
        <div className={s.formCol}>
          <Field label="Topic name" required>
            <Input value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
          </Field>
          <Field label="Trigger phrases (one per line)">
            <Textarea rows={8} value={form.triggerText} onChange={(_, d) => setForm((f) => ({ ...f, triggerText: d.value }))} />
          </Field>
          <Subtitle2>Existing topics ({topics?.length ?? 0})</Subtitle2>
          {(topics || []).map((t) => (
            <div key={t.id} className={s.card} style={{ cursor: 'pointer', borderColor: t.id === selectedId ? tokens.colorBrandStroke1 : undefined }}
                 onClick={() => setSelectedId(t.id)}>
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
            <textarea
              className={s.yaml}
              spellCheck={false}
              value={form.flowYaml}
              onChange={(e) => setForm((f) => ({ ...f, flowYaml: e.target.value }))}
              aria-label="Topic flow YAML"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

const TOPIC_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [{ label: 'Topic', actions: [{ label: 'New' }, { label: 'Save' }, { label: 'Delete' }] }] }];

export function CopilotTopicEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={TOPIC_RIBBON}
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
          <Input value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
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

const ACTION_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [{ label: 'Action', actions: [{ label: 'Bind' }, { label: 'Remove' }] }] }];

export function CopilotActionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ACTION_RIBBON}
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

function ChannelsPanel({ envId, agentId }: { envId: string; agentId: string }) {
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
              <Field label="Config (JSON)">
                <Textarea
                  rows={3}
                  value={configText[ct.type] ?? ''}
                  onChange={(_, d) => setConfigText((m) => ({ ...m, [ct.type]: d.value }))}
                  placeholder={'{"setting": "value"}'}
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

const CHANNEL_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [{ label: 'Channel', actions: [{ label: 'Publish' }, { label: 'Refresh' }] }] }];

export function CopilotChannelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [envId, setEnvId] = useState('');
  const [agentId, setAgentId] = useState('');
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={CHANNEL_RIBBON}
      main={
        <div className={s.pad}>
          <EnvironmentPicker value={envId} onChange={(v) => { setEnvId(v); setAgentId(''); }} />
          <AgentPicker envId={envId} value={agentId} onChange={setAgentId} />
          <ChannelsPanel envId={envId} agentId={agentId} />
        </div>
      }
    />
  );
}

// ============================================================
// CopilotAnalyticsEditor
// ============================================================

const ANALYTICS_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [{ label: 'Window', actions: [{ label: '7d' }, { label: '30d' }, { label: '90d' }] }] }];

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

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ANALYTICS_RIBBON}
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

const TEMPLATE_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [{ label: 'Template', actions: [{ label: 'Refresh' }, { label: 'Use template' }] }] }];

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

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={TEMPLATE_RIBBON}
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
