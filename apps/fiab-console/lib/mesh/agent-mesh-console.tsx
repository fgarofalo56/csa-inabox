'use client';

/**
 * agent-mesh-console — WS-9 Sovereign Agent Mesh UI (/mesh).
 *
 * A governed, in-VNet multi-agent mesh surface: browse + register mesh agents
 * (governance / pipeline / BI / orchestrator / custom), run a governed mesh task,
 * and inspect the Tier-0 air-gap-safe tool catalog. Every control is wired to the
 * REAL /api/mesh/* routes (no-vaporware.md) — the run pane shows each inter-agent
 * policy decision + every egress-blocked tool call, proving the sovereignty
 * guarantee (nothing leaves the boundary on an air-gap profile).
 *
 * Loom design tokens throughout (web3-ui.md); SplitPane with a persisted sizingKey
 * for the resizable registry | run layout (ux-baseline G3). No Microsoft Fabric
 * dependency (no-fabric-dependency.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Body1, Caption1, Subtitle2, Title3, Text, Button, Badge, Card, Spinner, Switch,
  Textarea, Input, Dropdown, Option, Checkbox, Divider, Tab, TabList,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Flow24Regular, ShieldCheckmark20Regular, Play20Regular, Add20Regular,
  Delete20Regular, LockClosed20Regular, Globe20Regular, CheckmarkCircle20Filled,
  DismissCircle20Filled,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { EmptyState } from '@/lib/components/empty-state';
import {
  MESH_AGENT_KINDS, MESH_EGRESS_PROFILES, TIER0_NATIVE_TOOL_KINDS, EXTERNAL_TOOL_KINDS,
  type MeshAgentDef, type MeshAgentKind, type MeshEgressProfile,
} from '@/lib/copilot/agent-registry';
import type { MeshRunResult } from '@/lib/azure/agent-mesh';
import type { AgentToolKind } from '@/lib/copilot/agent-tool-catalog';

const useStyles = makeStyles({
  intro: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalL, padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // Height comes from the surrounding ResizableCanvasRegion (G3 user-set,
  // persisted under loom.canvasHeight.agent-mesh) — was a fixed 68vh.
  split: { height: '100%', minHeight: '0', border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden' },
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL, overflowY: 'auto', minWidth: '0', height: '100%' },
  paneHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM },
  agentCard: {
    padding: tokens.spacingHorizontalM, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXS, cursor: 'pointer',
    boxShadow: tokens.shadow4, ':hover': { boxShadow: tokens.shadow16 },
    borderRadius: tokens.borderRadiusLarge,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
  },
  agentCardSel: { outline: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}` },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: '0' },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: '0' },
  spacer: { flex: '1 1 0%', minWidth: '0' },
  grow: { flexGrow: 1, minWidth: '0' },
  name: { fontWeight: tokens.fontWeightSemibold, minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stepCard: { padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusMedium, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, backgroundColor: tokens.colorNeutralBackground2 },
  toolRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: '0' },
  answer: { whiteSpace: 'pre-wrap', padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, maxHeight: '30vh', overflowY: 'auto' },
  counters: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginBottom: tokens.spacingVerticalS },
  catalogGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM },
  chipWrap: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
});

const PROFILE_LABEL: Record<MeshEgressProfile, string> = { commercial: 'Commercial', gov: 'Gov', 'air-gap': 'Air-gap' };
const KIND_COLOR: Record<MeshAgentKind, 'brand' | 'success' | 'warning' | 'informative' | 'subtle'> = {
  orchestrator: 'brand', governance: 'success', pipeline: 'informative', bi: 'warning', custom: 'subtle',
};
function profileColor(p: MeshEgressProfile): 'danger' | 'warning' | 'subtle' {
  return p === 'air-gap' ? 'danger' : p === 'gov' ? 'warning' : 'subtle';
}

interface Tier0Catalog { nativeKinds: AgentToolKind[]; mcpServers: Array<{ id: string; name: string; description: string; category: string }>; govAoaiDirect: boolean; }
interface CatalogResp { catalog: Tier0Catalog; defaultProfile: MeshEgressProfile; govAoaiDirect: boolean; egressAllowSuffixes: string[]; }

export function AgentMeshConsole() {
  const styles = useStyles();
  const [tab, setTab] = useState<'mesh' | 'catalog'>('mesh');
  const [agents, setAgents] = useState<MeshAgentDef[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogResp | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [task, setTask] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MeshRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dlgOpen, setDlgOpen] = useState(false);

  const loadAgents = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch('/api/mesh/agents');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed to load agents');
      setAgents(j.agents);
      setSelected(new Set((j.agents as MeshAgentDef[]).map((a) => a.id)));
    } catch (e: any) { setErr(e?.message || String(e)); setAgents([]); }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const r = await fetch('/api/mesh/catalog');
      const j = await r.json();
      if (j.ok) setCatalog(j);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void loadAgents(); void loadCatalog(); }, [loadAgents, loadCatalog]);

  const orderedSelected = useMemo(
    () => (agents || []).filter((a) => selected.has(a.id)),
    [agents, selected],
  );

  const runMesh = useCallback(async () => {
    if (!task.trim()) { setErr('Enter a task for the mesh to run.'); return; }
    if (orderedSelected.length === 0) { setErr('Select at least one agent (the first is the lead).'); return; }
    setRunning(true); setErr(null); setResult(null);
    try {
      const r = await fetch('/api/mesh/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task, agentIds: orderedSelected.map((a) => a.id) }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'mesh run failed');
      setResult(j.result);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setRunning(false); }
  }, [task, orderedSelected]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const del = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/mesh/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'delete failed');
      setNote('Agent removed.'); await loadAgents();
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [loadAgents]);

  return (
    <PageShell
      title="Agent Mesh"
      subtitle="Governed, in-VNet multi-agent mesh — every hop policy-checked and audited, egress fail-closed"
      actions={<Button appearance="primary" icon={<Add20Regular />} onClick={() => setDlgOpen(true)}>Register agent</Button>}
    >
      <div className={styles.intro}>
        <div className={styles.row}>
          <Flow24Regular />
          <Title3>Sovereign Agent Mesh + MCP/A2A hub</Title3>
        </div>
        <Body1>
          A lead orchestrator delegates a task to governance, pipeline, and BI agents entirely inside the VNet.
          Every inter-agent call passes a policy check (PDP + structural sovereignty rules) and is audited;
          per-agent MCP tool scoping and an air-gap egress guard keep regulated data in the boundary.
        </Body1>
        {catalog && (
          <div className={styles.badges}>
            <Badge appearance="tint" color={profileColor(catalog.defaultProfile)} icon={<LockClosed20Regular />}>
              Default profile: {PROFILE_LABEL[catalog.defaultProfile]}
            </Badge>
            <Badge appearance="tint" color={catalog.govAoaiDirect ? 'warning' : 'informative'}>
              {catalog.govAoaiDirect ? 'Gov AOAI direct (*.openai.azure.us)' : 'Commercial AOAI'}
            </Badge>
            <Badge appearance="tint" color="subtle">
              Egress allow-list: {catalog.egressAllowSuffixes.length ? catalog.egressAllowSuffixes.join(', ') : 'empty (fail-closed)'}
            </Badge>
          </div>
        )}
      </div>

      {err && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Error</MessageBarTitle> {err}</MessageBarBody></MessageBar>}
      {note && <MessageBar intent="success" style={{ marginBottom: tokens.spacingVerticalM }}><MessageBarBody>{note}</MessageBarBody></MessageBar>}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)} style={{ marginBottom: tokens.spacingVerticalM }}>
        <Tab value="mesh">Mesh</Tab>
        <Tab value="catalog">Tier-0 air-gap catalog</Tab>
      </TabList>

      {tab === 'mesh' && (
        <ResizableCanvasRegion storageKey="agent-mesh" defaultPx={600} minPx={320} ariaLabel="Resize mesh registry and run pane height">
          <div className={styles.split}>
            <SplitPane direction="horizontal" defaultSize="40%" minSize={260} storageKey="mesh-registry-run" dividerLabel="Resize registry / run">
              {renderRegistry()}
              {renderRunPane()}
            </SplitPane>
          </div>
        </ResizableCanvasRegion>
      )}

      {tab === 'catalog' && renderCatalog()}

      {renderDialog()}
    </PageShell>
  );

  function renderRegistry() {
    return (
      <div className={styles.pane}>
        <div className={styles.paneHeader}>
          <Subtitle2>Mesh agents</Subtitle2>
          <Caption1 className={styles.muted}>{orderedSelected.length} selected · first = lead</Caption1>
        </div>
        {agents === null && <Spinner label="Loading mesh…" />}
        {agents && agents.length === 0 && (
          <EmptyState
            icon={<Flow24Regular />}
            title="No mesh agents yet"
            body="Register a governance, pipeline, or BI agent to build your mesh."
            primaryAction={{ label: 'Register agent', onClick: () => setDlgOpen(true) }}
          />
        )}
        {agents && agents.map((a) => (
          <Card key={a.id} className={`${styles.agentCard} ${selected.has(a.id) ? styles.agentCardSel : ''}`} onClick={() => toggle(a.id)}>
            <div className={styles.row}>
              <Checkbox checked={selected.has(a.id)} onChange={() => toggle(a.id)} onClick={(e) => e.stopPropagation()} />
              <Text className={`${styles.name} ${styles.grow}`}>{a.name}</Text>
              <Button appearance="subtle" size="small" icon={<Delete20Regular />} aria-label={`Delete ${a.name}`}
                onClick={(e) => { e.stopPropagation(); void del(a.id); }} />
            </div>
            <div className={styles.badges}>
              <Badge appearance="tint" color={KIND_COLOR[a.kind]}>{a.kind}</Badge>
              <Badge appearance="outline" color={profileColor(a.egressProfile)} icon={a.egressProfile === 'air-gap' ? <LockClosed20Regular /> : undefined}>{PROFILE_LABEL[a.egressProfile]}</Badge>
              {a.publishA2A && <Badge appearance="tint" color="brand" icon={<Globe20Regular />}>A2A</Badge>}
              <Badge appearance="ghost" color="subtle">{a.toolScope.length} tools</Badge>
            </div>
            {a.description && <Caption1 className={styles.muted}>{a.description}</Caption1>}
          </Card>
        ))}
      </div>
    );
  }

  function renderRunPane() {
    return (
      <div className={styles.pane}>
        <Subtitle2>Run a governed mesh task</Subtitle2>
        <Textarea value={task} onChange={(_, d) => setTask(d.value)} placeholder="e.g. Summarize the customer dataset and confirm it meets our DLP + access policy before publishing." resize="vertical" rows={3} />
        <div className={styles.row}>
          <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <Play20Regular />} disabled={running} onClick={() => void runMesh()}>
            {running ? 'Running mesh…' : 'Run mesh'}
          </Button>
          <Caption1 className={styles.muted}>Lead: {orderedSelected[0]?.name || '—'}</Caption1>
        </div>
        <Divider />
        {!result && !running && <Caption1 className={styles.muted}>Select agents on the left (first = lead) and run a task. Every hop is policy-checked and audited.</Caption1>}
        {result && (
          <>
            <div className={styles.counters}>
              <Badge appearance="tint" color={result.completed ? 'success' : 'danger'} icon={result.completed ? <CheckmarkCircle20Filled /> : <DismissCircle20Filled />}>{result.completed ? 'Completed in-VNet' : 'Did not complete'}</Badge>
              <Badge appearance="tint" color="informative" icon={<ShieldCheckmark20Regular />}>{result.policyChecks.length} policy checks</Badge>
              {result.policyDenied > 0 && <Badge appearance="tint" color="danger">{result.policyDenied} denied</Badge>}
              <Badge appearance="tint" color={result.egressBlocked > 0 ? 'danger' : 'success'} icon={<LockClosed20Regular />}>{result.egressBlocked} egress blocked</Badge>
              <Badge appearance="outline" color={profileColor(result.profile)}>{PROFILE_LABEL[result.profile]}</Badge>
            </div>
            <Subtitle2>Final answer</Subtitle2>
            <div className={styles.answer}><Body1>{result.finalAnswer}</Body1></div>
            <Subtitle2>Delegation trace</Subtitle2>
            {result.steps.map((s, i) => (
              <div key={`${s.agentId}-${i}`} className={styles.stepCard}>
                <div className={styles.row}>
                  <Badge appearance="tint" color={KIND_COLOR[s.kind as MeshAgentKind] || 'subtle'}>{s.kind}</Badge>
                  <Text className={`${styles.name} ${styles.grow}`}>{s.agentName}</Text>
                  <Badge appearance="filled" color={s.status === 'blocked' ? 'danger' : s.status === 'gated' ? 'warning' : 'success'}>{s.status}</Badge>
                </div>
                <Caption1 className={styles.muted}>policy: {s.policy.effect} — {s.policy.reason}{s.policy.source ? ` (${s.policy.source})` : ''}</Caption1>
                {s.gate && <MessageBar intent="warning"><MessageBarBody>{s.gate}</MessageBarBody></MessageBar>}
                {s.toolCalls.length > 0 && (
                  <div className={styles.chipWrap}>
                    {s.toolCalls.map((t, j) => (
                      <Badge key={j} appearance="outline" color={t.egressBlocked ? 'danger' : 'success'} icon={t.egressBlocked ? <LockClosed20Regular /> : undefined} title={t.egressReason || t.detail}>{t.kind}{t.egressBlocked ? ' — blocked' : ''}</Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  function renderCatalog() {
    if (!catalog) return <Spinner label="Loading catalog…" />;
    const c = catalog.catalog;
    return (
      <div>
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>Tier-0 air-gap-safe tools</MessageBarTitle>
            These native tool kinds and MCP servers run entirely inside the VNet — zero external egress — so they are safe to grant to a sovereign / air-gap agent. Gov AOAI is reached {catalog.govAoaiDirect ? 'directly on *.openai.azure.us' : 'on the commercial endpoint'}.
          </MessageBarBody>
        </MessageBar>
        <Subtitle2>Native in-VNet tool kinds</Subtitle2>
        <div className={styles.chipWrap} style={{ margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalL}` }}>
          {c.nativeKinds.map((k) => <Badge key={k} appearance="tint" color="success">{k}</Badge>)}
        </div>
        <Subtitle2>Air-gap-safe MCP servers ({c.mcpServers.length})</Subtitle2>
        <div className={styles.catalogGrid} style={{ marginTop: tokens.spacingVerticalS }}>
          {c.mcpServers.map((m) => (
            <Card key={m.id} className={styles.agentCard}>
              <div className={styles.row}><Text className={styles.name}>{m.name}</Text><Badge appearance="ghost" color="subtle">{m.category}</Badge></div>
              <Caption1 className={styles.muted}>{m.description}</Caption1>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  function renderDialog() {
    return <RegisterAgentDialog open={dlgOpen} onClose={() => setDlgOpen(false)} onSaved={async () => { setDlgOpen(false); setNote('Agent registered.'); await loadAgents(); }} onError={setErr} />;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register-agent dialog (structured — no free-form config).
// ─────────────────────────────────────────────────────────────────────────────
function RegisterAgentDialog({ open, onClose, onSaved, onError }: {
  open: boolean; onClose: () => void; onSaved: () => Promise<void>; onError: (m: string) => void;
}) {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MeshAgentKind>('custom');
  const [profile, setProfile] = useState<MeshEgressProfile>('commercial');
  const [publishA2A, setPublishA2A] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<Set<AgentToolKind>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setName(''); setKind('custom'); setProfile('commercial'); setPublishA2A(false); setInstructions(''); setScope(new Set()); } }, [open]);

  const allKinds: AgentToolKind[] = [...TIER0_NATIVE_TOOL_KINDS, ...EXTERNAL_TOOL_KINDS, 'mcp'];
  const toggle = (k: AgentToolKind) => setScope((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const save = useCallback(async () => {
    if (!name.trim()) { onError('An agent name is required.'); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/mesh/agents', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kind, egressProfile: profile, publishA2A, instructions, toolScope: Array.from(scope) }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed to register');
      await onSaved();
    } catch (e: any) { onError(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [name, kind, profile, publishA2A, instructions, scope, onSaved, onError]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register a mesh agent</DialogTitle>
          <DialogContent>
            <div className={styles.field}>
              <Caption1>Name</Caption1>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Governance Agent" />
            </div>
            <div className={styles.field}>
              <Caption1>Role (kind)</Caption1>
              <Dropdown value={kind} selectedOptions={[kind]} onOptionSelect={(_, d) => setKind(d.optionValue as MeshAgentKind)}>
                {MESH_AGENT_KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
              </Dropdown>
            </div>
            <div className={styles.field}>
              <Caption1>Egress profile</Caption1>
              <Dropdown value={PROFILE_LABEL[profile]} selectedOptions={[profile]} onOptionSelect={(_, d) => setProfile(d.optionValue as MeshEgressProfile)}>
                {MESH_EGRESS_PROFILES.map((p) => <Option key={p} value={p}>{PROFILE_LABEL[p as MeshEgressProfile]}</Option>)}
              </Dropdown>
            </div>
            <div className={styles.field}>
              <Switch checked={publishA2A} onChange={(_, d) => setPublishA2A(d.checked)} label="Publish to the A2A hub (external agents may delegate in)" />
            </div>
            <div className={styles.field}>
              <Caption1>Instructions (optional — a default is used per role)</Caption1>
              <Textarea value={instructions} onChange={(_, d) => setInstructions(d.value)} rows={2} resize="vertical" />
            </div>
            <div className={styles.field}>
              <Caption1>Tool scope (per-agent least privilege)</Caption1>
              <div className={styles.chipWrap}>
                {allKinds.map((k) => (
                  <Checkbox key={k} label={k} checked={scope.has(k)} onChange={() => toggle(k)} />
                ))}
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={saving} icon={saving ? <Spinner size="tiny" /> : undefined} onClick={() => void save()}>Register</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
