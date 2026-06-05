'use client';

/**
 * DeploymentPipelinesPane — the CSA Loom Deployment surface, one-for-one with
 * the Fabric Deployment Pipelines experience plus the platform's own ARM /
 * bicep rollout history.
 *
 * Two tabs, every control backed by a real REST call via /api/deployment-pipelines/*:
 *
 *   Deployment pipelines  — Fabric REST (GET /v1/deploymentPipelines):
 *       • pick a pipeline
 *       • see its ordered stages (Development → Test → Production) as columns,
 *         each showing the assigned workspace + the supported items in it
 *       • Deploy stage → next stage (Deploy all OR selective item picker) with
 *         an optional note, via POST .../deploy (long-running)
 *       • Deployment history (recent deploy operations + status)
 *   Infra deployments     — ARM REST (Microsoft.Resources/deployments): the
 *       bicep rollouts across the Loom resource groups.
 *
 * Honest gates: when the Console UAMI isn't authorized for Fabric APIs, or
 * when LOOM_SUBSCRIPTION_ID / Loom RGs aren't configured, the relevant tab
 * shows a Fluent MessageBar naming the exact thing to fix — the full UI still
 * renders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tab, TabList, Spinner, Badge, Button, Dropdown, Option, Textarea, Checkbox, Input, Field, Switch,
  MessageBar, MessageBarBody, MessageBarTitle, Text, Caption1,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Rocket20Regular, ArrowRight20Regular, ArrowLeft20Regular, ChevronRight24Regular,
  Beaker20Regular, Server20Regular, Globe20Regular, BranchFork20Regular,
  Add20Regular, Link20Regular, PlugDisconnected20Regular, ArrowUpload20Regular, ArrowDownload20Regular,
  CheckmarkCircle20Filled, Warning20Filled, Delete20Regular, Branch20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

// ---- types mirrored from the clients ---------------------------------------

interface Pipeline { id: string; displayName: string; description?: string }
interface Stage {
  id: string; order: number; displayName: string; description?: string;
  workspaceId?: string; workspaceName?: string; isPublic?: boolean;
}
interface StageItem {
  itemId: string; itemDisplayName: string; itemType: string; lastDeploymentTime?: string;
}
interface Operation {
  id: string; type?: string; status?: string; sourceStageId?: string; targetStageId?: string;
  executionStartTime?: string; executionEndTime?: string; note?: string; performedBy?: string;
}
interface ArmDeployment {
  id: string; name: string; resourceGroup: string; provisioningState?: string;
  timestamp?: string; durationSec?: number; mode?: string; resourceCount?: number; error?: string;
}
interface Gate { missing: string[]; message: string }
interface WorkspaceOpt { id: string; name: string }

type CompareStatus = 'Same' | 'Different' | 'OnlyInSource' | 'NotInSource';
interface ComparePair {
  itemType: string;
  sourceItemId?: string; sourceItemDisplayName?: string;
  targetItemId?: string; targetItemDisplayName?: string;
  status: CompareStatus; lastDeploymentTime?: string;
}
interface CompareResult {
  sourceStageId: string; targetStageId: string;
  pairs: ComparePair[];
  summary: { same: number; different: number; onlyInSource: number; notInSource: number };
}

interface GitConnection {
  gitConnectionState: 'NotConnected' | 'Connected' | 'ConnectedAndInitialized';
  gitProviderDetails: {
    gitProviderType?: string; branchName?: string; directoryName?: string;
    organizationName?: string; projectName?: string; repositoryName?: string;
    ownerName?: string; customDomainName?: string;
  } | null;
  gitSyncDetails: { head?: string; lastSyncTime?: string } | null;
}
interface GitChange {
  itemMetadata: { itemIdentifier: { logicalId?: string; objectId?: string }; itemType: string; displayName: string };
  workspaceChange?: string; remoteChange?: string; conflictType?: string;
}
interface GitStatus { workspaceHead?: string; remoteCommitHash?: string; changes: GitChange[] }

// ---- styles ----------------------------------------------------------------

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' },
  section: { display: 'flex', flexDirection: 'column', gap: '12px' },
  gap: { marginBottom: '12px' },
  stageFlow: {
    display: 'flex', alignItems: 'stretch', gap: '4px',
    flexWrap: 'wrap', marginBottom: '8px',
  },
  stageCol: { flex: '1 1 260px', minWidth: '240px', display: 'flex', flexDirection: 'column' },
  connector: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForeground4, flexShrink: 0, alignSelf: 'stretch',
  },
  stageCard: {
    display: 'flex', flexDirection: 'column', gap: '10px',
    padding: '16px', borderRadius: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    minHeight: '180px', flex: 1,
    borderTopWidth: '3px', borderTopStyle: 'solid',
  },
  stageHead: { display: 'flex', alignItems: 'center', gap: '10px' },
  stageChip: {
    flexShrink: 0, width: '34px', height: '34px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge,
  },
  stageName: { fontSize: '15px', fontWeight: 700 },
  stageMeta: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  itemList: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflow: 'auto' },
  itemRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    fontSize: '13px', padding: '4px 6px', borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  itemType: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  deployRow: { display: 'flex', justifyContent: 'center', alignItems: 'center', paddingTop: '4px' },
  empty: {
    padding: '32px', borderRadius: '12px', border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
    fontSize: '14px', textAlign: 'center', lineHeight: 1.6,
  },
  dialogItems: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflow: 'auto', marginTop: '8px' },
  stageActions: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '4px' },
  assignRow: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' },
  compareSummary: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' },
  syncDot: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' },
  gitGrid: { display: 'flex', flexDirection: 'column', gap: '12px' },
  gitMeta: {
    display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px',
    fontSize: '13px', padding: '12px 16px', borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  gitMetaKey: { color: tokens.colorNeutralForeground3, fontWeight: 600 },
  formGrid: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '4px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px' },
});

function statusBadge(status: CompareStatus) {
  switch (status) {
    case 'Same': return <Badge color="success" appearance="tint">Same as source</Badge>;
    case 'Different': return <Badge color="warning" appearance="filled">Different from source</Badge>;
    case 'OnlyInSource': return <Badge color="brand" appearance="filled">Only in source</Badge>;
    case 'NotInSource': return <Badge color="subtle" appearance="outline">Not in source</Badge>;
  }
}

function gitChangeBadge(c: GitChange) {
  if (c.conflictType === 'Conflict') return <Badge color="danger" appearance="filled">Conflict</Badge>;
  const w = c.workspaceChange;
  const r = c.remoteChange;
  if (w && r) return <Badge color="warning" appearance="filled">Both changed</Badge>;
  if (w) return <Badge color="brand" appearance="tint">Workspace: {w}</Badge>;
  if (r) return <Badge color="informative" appearance="tint">Remote: {r}</Badge>;
  return <Badge color="success" appearance="outline">Synced</Badge>;
}

function GateBar({ gate, subject }: { gate: Gate; subject: string }) {
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>{subject} not available</MessageBarTitle>
        {gate.message}{' '}
        {gate.missing?.length ? <>Resolve: <strong>{gate.missing.join(', ')}</strong>.</> : null}
      </MessageBarBody>
    </MessageBar>
  );
}

function opStatusBadge(status?: string) {
  const s = (status || '').toLowerCase();
  if (s === 'succeeded') return <Badge color="success" appearance="filled">Succeeded</Badge>;
  if (s === 'failed') return <Badge color="danger" appearance="filled">Failed</Badge>;
  if (s === 'running') return <Badge color="brand" appearance="filled">Running</Badge>;
  if (s === 'notstarted') return <Badge color="subtle" appearance="outline">Not started</Badge>;
  return <Badge color="subtle" appearance="outline">{status || 'Unknown'}</Badge>;
}

function provStateBadge(state?: string) {
  const s = (state || '').toLowerCase();
  if (s === 'succeeded') return <Badge color="success" appearance="filled">Succeeded</Badge>;
  if (s === 'failed') return <Badge color="danger" appearance="filled">Failed</Badge>;
  if (s === 'running' || s === 'accepted') return <Badge color="brand" appearance="filled">{state}</Badge>;
  if (s === 'canceled') return <Badge color="warning" appearance="filled">Canceled</Badge>;
  return <Badge color="subtle" appearance="outline">{state || 'Unknown'}</Badge>;
}

/**
 * Stage visual — colour + icon by stage position (Dev → Test → Prod), the
 * same colour language Fabric uses for its deployment-pipeline stage cards.
 */
function stageVisual(order: number, displayName?: string) {
  const name = (displayName || '').toLowerCase();
  if (order === 0 || name.includes('dev')) return { color: 'var(--loom-accent-blue)', Icon: BranchFork20Regular };   // Development — blue
  if (name.includes('prod')) return { color: 'var(--loom-accent-green)', Icon: Globe20Regular };                       // Production — green
  if (order === 1 || name.includes('test') || name.includes('stag')) return { color: 'var(--loom-accent-orange)', Icon: Beaker20Regular }; // Test — orange
  return { color: 'var(--loom-accent-violet)', Icon: Server20Regular };                                                  // extra stages — purple
}

type TabKey = 'pipelines' | 'git' | 'infra';

export function DeploymentPipelinesPane() {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('pipelines');
  const [unauth, setUnauth] = useState(false);

  return (
    <div>
      {unauth && <SignInRequired subject="deployment pipelines" />}
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabKey)} className={styles.gap}>
        <Tab value="pipelines" icon={<Rocket20Regular />}>Deployment pipelines</Tab>
        <Tab value="git" icon={<Branch20Regular />}>Git integration</Tab>
        <Tab value="infra" icon={<Server20Regular />}>Infra deployments (ARM)</Tab>
      </TabList>
      {tab === 'pipelines' && <PipelinesTab onUnauth={() => setUnauth(true)} />}
      {tab === 'git' && <GitTab onUnauth={() => setUnauth(true)} />}
      {tab === 'infra' && <InfraTab onUnauth={() => setUnauth(true)} />}
    </div>
  );
}

// ---- shared: Fabric workspace picker hook ----------------------------------

function useFabricWorkspaces(): WorkspaceOpt[] | null {
  const [list, setList] = useState<WorkspaceOpt[] | null>(null);
  useEffect(() => {
    fetch('/api/fabric/workspaces').then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (j?.ok && Array.isArray(j.workspaces)) {
        setList(j.workspaces.map((w: any) => ({ id: w.id, name: w.name })));
      } else {
        setList([]);
      }
    }).catch(() => setList([]));
  }, []);
  return list;
}

// ---------------------------------------------------------------------------
// Pipelines tab — Fabric deployment pipelines: stages + deploy + history
// ---------------------------------------------------------------------------

function PipelinesTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setPipelines(null); setGate(null); setErr(null);
    fetch('/api/deployment-pipelines').then(async (r) => {
      if (r.status === 401 || r.status === 403) { onUnauth(); setPipelines([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setPipelines([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load deployment pipelines'); setPipelines([]); return; }
      const list: Pipeline[] = j.data.pipelines || [];
      setPipelines(list);
      if (list[0] && !selected) setSelected(list[0].id);
    }).catch((e) => { setErr(String(e)); setPipelines([]); });
  }, [tick, onUnauth]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pipelines === null) return <Spinner label="Loading Fabric deployment pipelines…" />;

  const selectedPipeline = pipelines.find((p) => p.id === selected);

  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
        <Dropdown
          aria-label="Deployment pipeline"
          placeholder="Select a deployment pipeline"
          value={selectedPipeline ? selectedPipeline.displayName : ''}
          selectedOptions={selected ? [selected] : []}
          onOptionSelect={(_, d) => d.optionValue && setSelected(d.optionValue)}
          style={{ minWidth: 320 }}
          disabled={pipelines.length === 0}
        >
          {pipelines.map((p) => <Option key={p.id} value={p.id} text={p.displayName}>{p.displayName}</Option>)}
        </Dropdown>
        <CreatePipelineDialog onCreated={(newId) => { setSelected(newId); setTick((t) => t + 1); }} />
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>
      </div>

      {gate && <GateBar gate={gate} subject="Fabric deployment pipelines" />}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {pipelines.length === 0 && !gate && !err && (
        <div className={styles.empty}>
          No Fabric deployment pipelines are visible to the Console identity.<br />
          Create one in Fabric (Workspaces → Create deployment pipeline) and add the Console UAMI
          as a pipeline admin, then refresh.
        </div>
      )}

      {selectedPipeline && <PipelineDetail pipeline={selectedPipeline} />}
    </div>
  );
}

function PipelineDetail({ pipeline }: { pipeline: Pipeline }) {
  const styles = useStyles();
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [stageItems, setStageItems] = useState<Record<string, StageItem[]>>({});
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // stages
  useEffect(() => {
    setStages(null); setStageItems({}); setErr(null);
    fetch(`/api/deployment-pipelines/${pipeline.id}/stages`).then(async (r) => {
      const j = await r.json();
      if (j.gate) { setErr(j.gate.message); setStages([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load stages'); setStages([]); return; }
      const s: Stage[] = j.data.stages || [];
      setStages(s);
      // fetch items per stage that has a workspace
      s.forEach((st) => {
        if (!st.workspaceId) return;
        fetch(`/api/deployment-pipelines/${pipeline.id}/stages/${st.id}/items`).then(async (ri) => {
          const ji = await ri.json();
          if (ji.ok) setStageItems((prev) => ({ ...prev, [st.id]: ji.data.items || [] }));
        }).catch(() => {});
      });
    }).catch((e) => { setErr(String(e)); setStages([]); });
  }, [pipeline.id, tick]);

  // history
  useEffect(() => {
    setOperations(null);
    fetch(`/api/deployment-pipelines/${pipeline.id}/operations`).then(async (r) => {
      const j = await r.json();
      if (j.ok) setOperations(j.data.operations || []);
      else setOperations([]);
    }).catch(() => setOperations([]));
  }, [pipeline.id, tick]);

  if (stages === null) return <Spinner label="Loading pipeline stages…" />;

  const stageName = (id?: string) => stages.find((s) => s.id === id)?.displayName || id || '—';

  const historyCols: LoomColumn<Operation>[] = [
    {
      key: 'executionStartTime', label: 'Started', sortable: true, filterable: false, width: 180,
      getValue: (o) => o.executionStartTime ? new Date(o.executionStartTime).getTime() : 0,
      render: (o) => o.executionStartTime ? new Date(o.executionStartTime).toLocaleString() : '—',
    },
    {
      key: 'route', label: 'From → To', sortable: true, filterable: true, width: 220,
      getValue: (o) => `${stageName(o.sourceStageId)} → ${stageName(o.targetStageId)}`,
      render: (o) => <>{stageName(o.sourceStageId)} <ArrowRight20Regular style={{ verticalAlign: 'middle', width: 14, height: 14 }} /> {stageName(o.targetStageId)}</>,
    },
    {
      key: 'status', label: 'Status', sortable: true, filterable: true, width: 130,
      getValue: (o) => o.status || '',
      render: (o) => opStatusBadge(o.status),
    },
    { key: 'performedBy', label: 'By', sortable: true, filterable: true, width: 180, render: (o) => o.performedBy || '—' },
    { key: 'note', label: 'Note', sortable: false, filterable: true, width: 240, render: (o) => o.note || '—' },
  ];

  return (
    <div className={styles.section}>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      <Section title="Stages">
        <div className={styles.stageFlow}>
          {stages.map((st, i) => {
            const next = stages[i + 1];
            const prev = stages[i - 1];
            const items = stageItems[st.id];
            const { color, Icon } = stageVisual(st.order ?? i, st.displayName);
            return (
              <div key={st.id} style={{ display: 'contents' }}>
                <div className={styles.stageCol}>
                  <div className={styles.stageCard} style={{ borderTopColor: color }}>
                    <div className={styles.stageHead}>
                      <span className={styles.stageChip} style={{ backgroundColor: `${color}1f`, color }} aria-hidden>
                        <Icon style={{ width: 20, height: 20, color }} />
                      </span>
                      <span className={styles.stageName}>{st.displayName}</span>
                      {st.isPublic && <Badge appearance="outline" size="small">Public</Badge>}
                      {items !== undefined && (
                        <Badge appearance="tint" size="small" style={{ marginLeft: 'auto' }}>{items.length}</Badge>
                      )}
                    </div>
                    <div className={styles.stageMeta}>
                      {st.workspaceName
                        ? <>Workspace: <strong>{st.workspaceName}</strong></>
                        : st.workspaceId
                          ? <>Workspace assigned ({st.workspaceId.slice(0, 8)}…)</>
                          : <>No workspace assigned</>}
                    </div>
                    {st.description && <div className={styles.stageMeta}>{st.description}</div>}

                    {st.workspaceId ? (
                      items === undefined ? (
                        <Spinner size="tiny" label="Loading items…" />
                      ) : items.length === 0 ? (
                        <div className={styles.stageMeta}>No supported items in this stage yet.</div>
                      ) : (
                        <div className={styles.itemList}>
                          {items.map((it) => (
                            <div key={it.itemId} className={styles.itemRow}>
                              <span title={it.itemDisplayName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {it.itemDisplayName}
                              </span>
                              <span className={styles.itemType}>{it.itemType}</span>
                            </div>
                          ))}
                        </div>
                      )
                    ) : (
                      <AssignWorkspaceInline pipelineId={pipeline.id} stage={st} onChanged={reload} />
                    )}

                    <div className={styles.stageActions}>
                      {st.workspaceId && (
                        <UnassignWorkspaceButton pipelineId={pipeline.id} stage={st} onChanged={reload} />
                      )}
                      {st.workspaceId && (
                        <DeploymentRulesButton stage={st} />
                      )}
                    </div>

                    {next && (
                      <div className={styles.deployRow}>
                        <DeployDialog
                          pipelineId={pipeline.id}
                          source={st}
                          target={next}
                          items={items || []}
                          onDeployed={reload}
                        />
                      </div>
                    )}
                    {/* Backward deploy: this stage → the previous (earlier) stage,
                        allowed by Fabric only when the earlier stage is empty. */}
                    {prev && !prev.workspaceId && st.workspaceId && (
                      <div className={styles.deployRow}>
                        <DeployDialog
                          pipelineId={pipeline.id}
                          source={st}
                          target={prev}
                          items={items || []}
                          onDeployed={reload}
                          backward
                        />
                      </div>
                    )}
                  </div>
                </div>
                {next && (
                  <div className={styles.connector} aria-hidden>
                    <ChevronRight24Regular />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <MessageBar intent="info">
          <MessageBarBody>
            <strong>Sync indicator</strong> below pairs each stage against the previous one
            (Fabric exposes no content-hash compare endpoint, so pairing is by item type + name).
            Workspace <strong>folder hierarchy</strong> and <strong>parent/child items</strong> are a
            Fabric portal-only preview surface — the stage-items REST returns a flat list, so Loom shows
            items flat and discloses this rather than faking a tree.
          </MessageBarBody>
        </MessageBar>
      </Section>

      <Section title="Compare / sync status">
        {stages.length < 2 ? (
          <div className={styles.stageMeta}>Add at least two stages to compare.</div>
        ) : (
          <StageCompare pipelineId={pipeline.id} stages={stages} tick={tick} />
        )}
      </Section>

      <Section title="Deployment history">
        {operations === null ? (
          <Spinner size="tiny" label="Loading deployment history…" />
        ) : (
          <LoomDataTable
            ariaLabel="Deployment history"
            columns={historyCols}
            rows={operations}
            getRowId={(o) => o.id}
            empty="No deployments recorded for this pipeline yet."
          />
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deploy dialog — Deploy all OR selective deploy of specific items, + note
// ---------------------------------------------------------------------------

function DeployDialog({
  pipelineId, source, target, items, onDeployed, backward = false,
}: {
  pipelineId: string; source: Stage; target: Stage; items: StageItem[]; onDeployed: () => void; backward?: boolean;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [selective, setSelective] = useState(false);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  // Deploying into an empty (vacant) target stage requires Fabric to create a
  // new workspace — the operator must name it. This is always true for the
  // backward (later → earlier empty) case and also for an empty forward target.
  const targetEmpty = !target.workspaceId;

  const chosenList = useMemo(
    () => items.filter((it) => chosen[it.itemId]).map((it) => ({ sourceItemId: it.itemId, itemType: it.itemType })),
    [items, chosen],
  );

  const deploy = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const body: any = { sourceStageId: source.id, targetStageId: target.id };
      if (note.trim()) body.note = note.trim();
      if (selective) {
        if (chosenList.length === 0) { setMsg({ kind: 'error', text: 'Select at least one item, or switch off selective deploy.' }); setBusy(false); return; }
        body.items = chosenList;
      }
      if (targetEmpty) {
        if (!newWorkspaceName.trim()) {
          setMsg({ kind: 'error', text: 'The target stage is empty — name the workspace Fabric will create for it.' });
          setBusy(false); return;
        }
        body.createdWorkspaceDetails = { name: newWorkspaceName.trim() };
      }
      const r = await fetch(`/api/deployment-pipelines/${pipelineId}/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.gate) { setMsg({ kind: 'error', text: j.gate.message }); return; }
      if (!j.ok) { setMsg({ kind: 'error', text: j.error || 'Deployment failed' }); return; }
      setMsg({ kind: 'success', text: 'Deployment started. Track its status in Deployment history.' });
      onDeployed();
      setTimeout(() => setOpen(false), 1200);
    } catch (e) {
      setMsg({ kind: 'error', text: String(e) });
    } finally {
      setBusy(false);
    }
  }, [pipelineId, source.id, target.id, note, selective, chosenList, targetEmpty, newWorkspaceName, onDeployed]);

  const canDeploy = !!source.workspaceId; // must have content to deploy
  const Arrow = backward ? ArrowLeft20Regular : ArrowRight20Regular;

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button
          appearance={backward ? 'secondary' : 'primary'}
          icon={backward ? <ArrowLeft20Regular /> : <Rocket20Regular />}
          disabled={!canDeploy}
          title={canDeploy ? `Deploy ${source.displayName} → ${target.displayName}` : 'Assign a workspace to the source stage first'}
        >
          {backward ? `Back-deploy to ${target.displayName}` : `Deploy to ${target.displayName}`}
        </Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {backward ? 'Backward deploy ' : 'Deploy '}<Arrow style={{ verticalAlign: 'middle' }} /> {source.displayName} → {target.displayName}
          </DialogTitle>
          <DialogContent>
            {backward && (
              <MessageBar intent="warning" style={{ marginBottom: 8 }}>
                <MessageBarBody>
                  Backward deployment (a later stage into an earlier one) is allowed by Fabric
                  <strong> only when the earlier stage is empty</strong>. Fabric will create a fresh
                  workspace for <strong>{target.displayName}</strong>.
                </MessageBarBody>
              </MessageBar>
            )}
            <Text block>
              Content from <strong>{source.displayName}</strong> will be copied to{' '}
              <strong>{target.displayName}</strong>
              {target.workspaceName ? <> ({target.workspaceName})</> : null}. Paired items in the target stage are overwritten.
            </Text>

            {targetEmpty && (
              <div style={{ marginTop: 12 }}>
                <Field label="New workspace name (target stage is empty)" required>
                  <Input
                    value={newWorkspaceName}
                    onChange={(_, d) => setNewWorkspaceName(d.value.slice(0, 256))}
                    placeholder={`${target.displayName} workspace`}
                  />
                </Field>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <Checkbox
                label="Selective deploy (choose specific items)"
                checked={selective}
                onChange={(_, d) => setSelective(!!d.checked)}
              />
            </div>

            {selective && (
              <div className={styles.dialogItems}>
                {items.length === 0 ? (
                  <Text size={200}>No items available in the source stage.</Text>
                ) : items.map((it) => (
                  <Checkbox
                    key={it.itemId}
                    label={`${it.itemDisplayName} · ${it.itemType}`}
                    checked={!!chosen[it.itemId]}
                    onChange={(_, d) => setChosen((prev) => ({ ...prev, [it.itemId]: !!d.checked }))}
                  />
                ))}
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <Textarea
                aria-label="Deployment note"
                placeholder="Deployment note (optional, max 1024 chars)"
                value={note}
                onChange={(_, d) => setNote(d.value.slice(0, 1024))}
                rows={3}
                resize="vertical"
                style={{ width: '100%' }}
              />
            </div>

            {msg && (
              <div style={{ marginTop: 12 }}>
                <MessageBar intent={msg.kind === 'success' ? 'success' : 'error'}>
                  <MessageBarBody>{msg.text}</MessageBarBody>
                </MessageBar>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" disabled={busy}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" icon={<Rocket20Regular />} onClick={deploy} disabled={busy}>
              {busy ? 'Deploying…' : selective ? 'Deploy selected' : 'Deploy all'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create pipeline — name + ordered stages (2-10), each optionally public
// ---------------------------------------------------------------------------

function CreatePipelineDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stages, setStages] = useState<Array<{ displayName: string; isPublic: boolean }>>([
    { displayName: 'Development', isPublic: false },
    { displayName: 'Test', isPublic: false },
    { displayName: 'Production', isPublic: true },
  ]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const setStage = (i: number, patch: Partial<{ displayName: string; isPublic: boolean }>) =>
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStage = () => setStages((prev) => (prev.length >= 10 ? prev : [...prev, { displayName: '', isPublic: false }]));
  const removeStage = (i: number) => setStages((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));

  const create = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const cleanStages = stages.map((s) => ({ displayName: s.displayName.trim(), isPublic: s.isPublic })).filter((s) => s.displayName);
      if (!name.trim()) { setMsg({ kind: 'error', text: 'Pipeline name is required.' }); setBusy(false); return; }
      if (cleanStages.length < 2) { setMsg({ kind: 'error', text: 'At least 2 named stages are required.' }); setBusy(false); return; }
      const r = await fetch('/api/deployment-pipelines/create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name.trim(), description: description.trim() || undefined, stages: cleanStages }),
      });
      const j = await r.json();
      if (j.gate) { setMsg({ kind: 'error', text: j.gate.message }); return; }
      if (!j.ok) { setMsg({ kind: 'error', text: j.error || 'Create failed' }); return; }
      setMsg({ kind: 'success', text: 'Pipeline created.' });
      onCreated(j.data.pipeline.id);
      setTimeout(() => setOpen(false), 800);
    } catch (e) {
      setMsg({ kind: 'error', text: String(e) });
    } finally { setBusy(false); }
  }, [name, description, stages, onCreated]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add20Regular />}>New pipeline</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create deployment pipeline</DialogTitle>
          <DialogContent>
            <div className={styles.formGrid}>
              <Field label="Pipeline name" required>
                <Input value={name} onChange={(_, d) => setName(d.value.slice(0, 256))} placeholder="e.g. Sales analytics CI/CD" />
              </Field>
              <Field label="Description">
                <Input value={description} onChange={(_, d) => setDescription(d.value.slice(0, 1024))} />
              </Field>
              <Text weight="semibold">Stages (2–10, order is permanent)</Text>
              {stages.map((s, i) => (
                <div key={i} className={styles.assignRow}>
                  <Field label={`Stage ${i + 1} name`} style={{ flex: 1 }}>
                    <Input value={s.displayName} onChange={(_, d) => setStage(i, { displayName: d.value.slice(0, 256) })} />
                  </Field>
                  <Switch label="Public" checked={s.isPublic} onChange={(_, d) => setStage(i, { isPublic: !!d.checked })} />
                  <Button appearance="subtle" icon={<Delete20Regular />} disabled={stages.length <= 2} onClick={() => removeStage(i)} aria-label={`Remove stage ${i + 1}`} />
                </div>
              ))}
              <Button appearance="subtle" icon={<Add20Regular />} disabled={stages.length >= 10} onClick={addStage}>Add stage</Button>
              {msg && (
                <MessageBar intent={msg.kind === 'success' ? 'success' : 'error'}>
                  <MessageBarBody>{msg.text}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary" disabled={busy}>Cancel</Button></DialogTrigger>
            <Button appearance="primary" icon={<Add20Regular />} onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Assign workspace to an empty stage (inline dropdown of Fabric workspaces)
// ---------------------------------------------------------------------------

function AssignWorkspaceInline({ pipelineId, stage, onChanged }: { pipelineId: string; stage: Stage; onChanged: () => void }) {
  const styles = useStyles();
  const workspaces = useFabricWorkspaces();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const assign = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/deployment-pipelines/${pipelineId}/stages/${stage.id}/workspace`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: selected }),
      });
      const j = await r.json();
      if (j.gate) { setErr(j.gate.message); return; }
      if (!j.ok) { setErr(j.error || 'Assign failed'); return; }
      onChanged();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }, [pipelineId, stage.id, selected, onChanged]);

  const selectedName = workspaces?.find((w) => w.id === selected)?.name || '';

  return (
    <div>
      <div className={styles.stageMeta} style={{ marginBottom: 6 }}>No workspace assigned. Add content to this stage:</div>
      <div className={styles.assignRow}>
        <Dropdown
          aria-label="Assign workspace"
          placeholder={workspaces === null ? 'Loading workspaces…' : 'Select a workspace'}
          value={selectedName}
          selectedOptions={selected ? [selected] : []}
          onOptionSelect={(_, d) => d.optionValue && setSelected(d.optionValue)}
          disabled={!workspaces || workspaces.length === 0}
          style={{ minWidth: 180 }}
        >
          {(workspaces || []).map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
        </Dropdown>
        <Button appearance="primary" size="small" icon={<Link20Regular />} disabled={!selected || busy} onClick={assign}>
          {busy ? 'Assigning…' : 'Assign'}
        </Button>
      </div>
      {workspaces && workspaces.length === 0 && (
        <div className={styles.stageMeta} style={{ marginTop: 4 }}>No Fabric workspaces visible to the Console identity.</div>
      )}
      {err && <Text size={100} style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Text>}
    </div>
  );
}

function UnassignWorkspaceButton({ pipelineId, stage, onChanged }: { pipelineId: string; stage: Stage; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const unassign = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/deployment-pipelines/${pipelineId}/stages/${stage.id}/workspace`, { method: 'DELETE' });
      const j = await r.json();
      if (j.gate) { setErr(j.gate.message); return; }
      if (!j.ok) { setErr(j.error || 'Unassign failed'); return; }
      onChanged(); setOpen(false);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }, [pipelineId, stage.id, onChanged]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="subtle" size="small" icon={<PlugDisconnected20Regular />}>Unassign workspace</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Unassign workspace from {stage.displayName}</DialogTitle>
          <DialogContent>
            <MessageBar intent="warning">
              <MessageBarBody>
                Unassigning <strong>{stage.workspaceName || 'the workspace'}</strong> releases it from this stage.
                You lose this stage's <strong>deployment history and configured deployment rules</strong>.
              </MessageBarBody>
            </MessageBar>
            {err && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary" disabled={busy}>Cancel</Button></DialogTrigger>
            <Button appearance="primary" icon={<PlugDisconnected20Regular />} onClick={unassign} disabled={busy}>{busy ? 'Unassigning…' : 'Unassign'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Deployment rules — honest gate. Fabric's deployment-rules (data-source /
// parameter / default-lakehouse rebinding) are NOT in the Fabric core REST
// surface; they remain a Power BI legacy / portal-only capability. We render
// the full affordance and disclose the gate rather than ship a dead button.
// ---------------------------------------------------------------------------

function DeploymentRulesButton({ stage }: { stage: Stage }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="subtle" size="small" icon={<BranchFork20Regular />}>Deployment rules</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Deployment rules — {stage.displayName}</DialogTitle>
          <DialogContent>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Not available in the Fabric REST surface</MessageBarTitle>
                Per-stage <strong>deployment rules</strong> (data-source rules, parameter rules, and
                default-lakehouse rules that rebind a semantic model / dataflow / notebook on deploy)
                are configured in the Power BI / Fabric portal only — there is no public Fabric REST
                endpoint to create or read them, so Loom cannot wire a real backend here. Configure
                them in the portal under <strong>{stage.displayName}</strong> → the item → <em>Deployment rules</em>.
                Once set, they apply automatically on the next deploy through Loom.
              </MessageBarBody>
            </MessageBar>
            <Text block style={{ marginTop: 12 }} size={200}>
              Supported rule types per item (Microsoft Learn): Dataflow Gen1 & Semantic model — data
              source + parameter; Paginated report & Mirrored database — data source; Notebook —
              default lakehouse.
            </Text>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement><Button appearance="primary">Close</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Stage compare — pick source/target, pair items, show per-item sync status
// ---------------------------------------------------------------------------

function StageCompare({ pipelineId, stages, tick }: { pipelineId: string; stages: Stage[]; tick: number }) {
  const styles = useStyles();
  // Default: compare the second stage against the first (target vs its source).
  const [targetId, setTargetId] = useState(stages[1]?.id || '');
  const target = stages.find((s) => s.id === targetId) || stages[1] || stages[0];
  const targetIndex = stages.findIndex((s) => s.id === target?.id);
  const source = stages[targetIndex - 1];

  const [result, setResult] = useState<CompareResult | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!source || !target) { setResult(null); return; }
    setLoading(true); setErr(null); setGate(null); setResult(null);
    fetch(`/api/deployment-pipelines/${pipelineId}/compare?source=${encodeURIComponent(source.id)}&target=${encodeURIComponent(target.id)}`)
      .then(async (r) => {
        const j = await r.json();
        if (j.gate) { setGate(j.gate); return; }
        if (!j.ok) { setErr(j.error || 'Compare failed'); return; }
        setResult(j.data);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [pipelineId, source?.id, target?.id, tick]);

  if (!source || !target) return <div className={styles.stageMeta}>Select a non-first stage to compare against its source.</div>;

  const anyDiff = result ? (result.summary.different + result.summary.onlyInSource + result.summary.notInSource) > 0 : false;

  return (
    <div className={styles.section}>
      <div className={styles.assignRow} style={{ marginBottom: 8 }}>
        <Field label="Compare stage">
          <Dropdown
            value={target.displayName}
            selectedOptions={[target.id]}
            onOptionSelect={(_, d) => d.optionValue && setTargetId(d.optionValue)}
            style={{ minWidth: 200 }}
          >
            {stages.slice(1).map((s) => <Option key={s.id} value={s.id} text={s.displayName}>{s.displayName}</Option>)}
          </Dropdown>
        </Field>
        <Text size={300} style={{ paddingBottom: 6 }}>
          against source <strong>{source.displayName}</strong>
        </Text>
      </div>

      {gate && <GateBar gate={gate} subject="Stage compare" />}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {loading && <Spinner size="tiny" label="Comparing stages…" />}

      {result && (
        <>
          <div className={styles.compareSummary}>
            <span className={styles.syncDot}>
              {anyDiff
                ? <><Warning20Filled style={{ color: tokens.colorStatusWarningForeground1 }} /> Stages differ</>
                : <><CheckmarkCircle20Filled style={{ color: tokens.colorStatusSuccessForeground1 }} /> In sync</>}
            </span>
            <Badge color="success" appearance="tint">Same {result.summary.same}</Badge>
            <Badge color="warning" appearance="tint">Different {result.summary.different}</Badge>
            <Badge color="brand" appearance="tint">Only in source {result.summary.onlyInSource}</Badge>
            <Badge color="subtle" appearance="outline">Not in source {result.summary.notInSource}</Badge>
          </div>
          {result.pairs.length === 0 ? (
            <div className={styles.stageMeta}>No items in either stage.</div>
          ) : (
            <Table aria-label={`Compare ${source.displayName} to ${target.displayName}`} size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{target.displayName} (item)</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Paired source item</TableHeaderCell>
                  <TableHeaderCell>Sync status</TableHeaderCell>
                  <TableHeaderCell>Last deployed</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.pairs.map((p, idx) => (
                  <TableRow key={`${p.itemType}-${p.sourceItemId || p.targetItemId}-${idx}`}>
                    <TableCell>{p.targetItemDisplayName || <em style={{ color: tokens.colorNeutralForeground3 }}>(none)</em>}</TableCell>
                    <TableCell><span className={styles.itemType}>{p.itemType}</span></TableCell>
                    <TableCell>{p.sourceItemDisplayName || <em style={{ color: tokens.colorNeutralForeground3 }}>(none)</em>}</TableCell>
                    <TableCell>{statusBadge(p.status)}</TableCell>
                    <TableCell>{p.lastDeploymentTime ? new Date(p.lastDeploymentTime).toLocaleDateString() : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <MessageBar intent="info" style={{ marginTop: 8 }}>
            <MessageBarBody>
              Content/change review (line-by-line schema diff) is a Fabric portal-only surface and not
              in the public REST API. The authoritative new/different/identical counts are returned by
              the deploy operation itself and shown in Deployment history after a deploy runs.
            </MessageBarBody>
          </MessageBar>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git integration tab — connect a workspace to ADO/GitHub, see status,
// commit-to-git + update-from-git
// ---------------------------------------------------------------------------

function GitTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const workspaces = useFabricWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const wsName = workspaces?.find((w) => w.id === workspaceId)?.name || '';

  return (
    <div className={styles.section}>
      <MessageBar intent="info">
        <MessageBarBody>
          Connect a Fabric workspace to an Azure DevOps or GitHub repository and branch, view the
          per-item Git sync status, then <strong>commit to Git</strong> or <strong>update from Git</strong>.
          Backed by the Fabric core/git REST APIs. Connecting as the Console identity (UAMI/SPN) requires a
          configured Git provider credentials connection id (GitHub always requires one).
        </MessageBarBody>
      </MessageBar>
      <div className={styles.toolbar}>
        <Dropdown
          aria-label="Workspace"
          placeholder={workspaces === null ? 'Loading workspaces…' : 'Select a Fabric workspace'}
          value={wsName}
          selectedOptions={workspaceId ? [workspaceId] : []}
          onOptionSelect={(_, d) => d.optionValue && setWorkspaceId(d.optionValue)}
          disabled={!workspaces || workspaces.length === 0}
          style={{ minWidth: 320 }}
        >
          {(workspaces || []).map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
        </Dropdown>
      </div>
      {workspaces && workspaces.length === 0 && (
        <div className={styles.empty}>No Fabric workspaces are visible to the Console identity.</div>
      )}
      {workspaceId && <GitWorkspacePanel workspaceId={workspaceId} onUnauth={onUnauth} />}
    </div>
  );
}

function GitWorkspacePanel({ workspaceId, onUnauth }: { workspaceId: string; onUnauth: () => void }) {
  const styles = useStyles();
  const [connection, setConnection] = useState<GitConnection | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setConnection(null); setGate(null); setErr(null);
    fetch(`/api/deployment-pipelines/git/${workspaceId}/connection`).then(async (r) => {
      if (r.status === 401) { onUnauth(); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load Git connection'); return; }
      setConnection(j.data.connection);
    }).catch((e) => setErr(String(e)));
  }, [workspaceId, tick, onUnauth]);

  if (gate) return <GateBar gate={gate} subject="Workspace Git integration" />;
  if (err) return <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>;
  if (connection === null) return <Spinner size="tiny" label="Loading Git connection…" />;

  const connected = connection.gitConnectionState !== 'NotConnected';
  const d = connection.gitProviderDetails;

  return (
    <div className={styles.gitGrid}>
      {connected ? (
        <>
          <div className={styles.gitMeta}>
            <span className={styles.gitMetaKey}>State</span>
            <span><Badge color={connection.gitConnectionState === 'ConnectedAndInitialized' ? 'success' : 'brand'} appearance="tint">{connection.gitConnectionState}</Badge></span>
            <span className={styles.gitMetaKey}>Provider</span><span>{d?.gitProviderType || '—'}</span>
            {d?.organizationName && (<><span className={styles.gitMetaKey}>Organization</span><span>{d.organizationName}</span></>)}
            {d?.projectName && (<><span className={styles.gitMetaKey}>Project</span><span>{d.projectName}</span></>)}
            {d?.ownerName && (<><span className={styles.gitMetaKey}>Owner</span><span>{d.ownerName}</span></>)}
            <span className={styles.gitMetaKey}>Repository</span><span>{d?.repositoryName || '—'}</span>
            <span className={styles.gitMetaKey}>Branch</span><span><Branch20Regular style={{ verticalAlign: 'middle', width: 14, height: 14 }} /> {d?.branchName || '—'}</span>
            {d?.directoryName ? (<><span className={styles.gitMetaKey}>Directory</span><span>{d.directoryName}</span></>) : null}
            <span className={styles.gitMetaKey}>Synced commit</span><span className={styles.mono}>{connection.gitSyncDetails?.head?.slice(0, 12) || '—'}</span>
            {connection.gitSyncDetails?.lastSyncTime && (<><span className={styles.gitMetaKey}>Last sync</span><span>{new Date(connection.gitSyncDetails.lastSyncTime).toLocaleString()}</span></>)}
          </div>
          <div className={styles.toolbar}>
            {connection.gitConnectionState === 'Connected' && (
              <InitializeButton workspaceId={workspaceId} onDone={reload} />
            )}
            <DisconnectButton workspaceId={workspaceId} onDone={reload} />
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={reload}>Refresh</Button>
          </div>
          <GitStatusPanel workspaceId={workspaceId} tick={tick} onChanged={reload} />
        </>
      ) : (
        <GitConnectForm workspaceId={workspaceId} onConnected={reload} />
      )}
    </div>
  );
}

function GitConnectForm({ workspaceId, onConnected }: { workspaceId: string; onConnected: () => void }) {
  const styles = useStyles();
  const [provider, setProvider] = useState<'AzureDevOps' | 'GitHub'>('AzureDevOps');
  const [f, setF] = useState<Record<string, string>>({ branchName: 'main' });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const connect = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const body: any = { provider, branchName: f.branchName, directoryName: f.directoryName, repositoryName: f.repositoryName, connectionId: f.connectionId };
      if (provider === 'AzureDevOps') { body.organizationName = f.organizationName; body.projectName = f.projectName; }
      else { body.ownerName = f.ownerName; body.customDomainName = f.customDomainName; }
      const r = await fetch(`/api/deployment-pipelines/git/${workspaceId}/connection`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.gate) { setMsg({ kind: 'error', text: j.gate.message }); return; }
      if (!j.ok) { setMsg({ kind: 'error', text: j.error || 'Connect failed' }); return; }
      setMsg({ kind: 'success', text: 'Connected. Initialize the connection to complete the first sync.' });
      onConnected();
    } catch (e) { setMsg({ kind: 'error', text: String(e) }); } finally { setBusy(false); }
  }, [provider, f, workspaceId, onConnected]);

  return (
    <div className={styles.formGrid}>
      <Text weight="semibold">Connect to Git</Text>
      <Field label="Provider">
        <Dropdown value={provider} selectedOptions={[provider]} onOptionSelect={(_, d) => d.optionValue && setProvider(d.optionValue as any)} style={{ minWidth: 200 }}>
          <Option value="AzureDevOps" text="Azure DevOps">Azure DevOps</Option>
          <Option value="GitHub" text="GitHub">GitHub</Option>
        </Dropdown>
      </Field>
      {provider === 'AzureDevOps' ? (
        <>
          <Field label="Organization" required><Input value={f.organizationName || ''} onChange={(_, d) => set('organizationName', d.value)} /></Field>
          <Field label="Project" required><Input value={f.projectName || ''} onChange={(_, d) => set('projectName', d.value)} /></Field>
          <Field label="Repository" required><Input value={f.repositoryName || ''} onChange={(_, d) => set('repositoryName', d.value)} /></Field>
        </>
      ) : (
        <>
          <Field label="Owner" required><Input value={f.ownerName || ''} onChange={(_, d) => set('ownerName', d.value)} /></Field>
          <Field label="Repository" required><Input value={f.repositoryName || ''} onChange={(_, d) => set('repositoryName', d.value)} /></Field>
          <Field label="Enterprise domain (ghe.com, optional)"><Input value={f.customDomainName || ''} onChange={(_, d) => set('customDomainName', d.value)} /></Field>
        </>
      )}
      <Field label="Branch" required><Input value={f.branchName || ''} onChange={(_, d) => set('branchName', d.value)} /></Field>
      <Field label="Directory (optional)"><Input value={f.directoryName || ''} onChange={(_, d) => set('directoryName', d.value)} placeholder="/" /></Field>
      <Field label="Git credentials connection id (required for GitHub / SPN / UAMI)">
        <Input value={f.connectionId || ''} onChange={(_, d) => set('connectionId', d.value)} placeholder="Fabric connection (objectId)" />
      </Field>
      {msg && <MessageBar intent={msg.kind === 'success' ? 'success' : 'error'}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      <div><Button appearance="primary" icon={<Link20Regular />} onClick={connect} disabled={busy}>{busy ? 'Connecting…' : 'Connect and sync'}</Button></div>
    </div>
  );
}

function InitializeButton({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const init = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/deployment-pipelines/git/${workspaceId}/initialize`, { method: 'POST' });
      onDone();
    } finally { setBusy(false); }
  }, [workspaceId, onDone]);
  return <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={init} disabled={busy}>{busy ? 'Initializing…' : 'Initialize connection'}</Button>;
}

function DisconnectButton({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/deployment-pipelines/git/${workspaceId}/connection`, { method: 'DELETE' });
      onDone();
    } finally { setBusy(false); }
  }, [workspaceId, onDone]);
  return <Button appearance="subtle" icon={<PlugDisconnected20Regular />} onClick={disconnect} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button>;
}

function GitStatusPanel({ workspaceId, tick, onChanged }: { workspaceId: string; tick: number; onChanged: () => void }) {
  const styles = useStyles();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [notConnected, setNotConnected] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<'commit' | 'update' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [statusTick, setStatusTick] = useState(0);

  const idOf = (c: GitChange) => c.itemMetadata.itemIdentifier.objectId || c.itemMetadata.itemIdentifier.logicalId || c.itemMetadata.displayName;

  useEffect(() => {
    setStatus(null); setPending(false); setNotConnected(false); setErr(null);
    fetch(`/api/deployment-pipelines/git/${workspaceId}/status`).then(async (r) => {
      const j = await r.json();
      if (j.gate) { setErr(j.gate.message); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load Git status'); return; }
      if (j.data.pending) { setPending(true); return; }
      if (j.data.notConnected) { setNotConnected(true); return; }
      setStatus(j.data.status);
    }).catch((e) => setErr(String(e)));
  }, [workspaceId, tick, statusTick]);

  const commit = useCallback(async (mode: 'All' | 'Selective') => {
    setBusy('commit'); setMsg(null);
    try {
      const items = mode === 'Selective'
        ? (status?.changes || []).filter((c) => chosen[idOf(c)] && c.workspaceChange).map((c) => c.itemMetadata.itemIdentifier)
        : undefined;
      if (mode === 'Selective' && (!items || items.length === 0)) { setMsg({ kind: 'error', text: 'Select at least one workspace-changed item to commit.' }); setBusy(null); return; }
      const r = await fetch(`/api/deployment-pipelines/git/${workspaceId}/commit`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, comment: comment.trim() || undefined, workspaceHead: status?.workspaceHead, items }),
      });
      const j = await r.json();
      if (j.gate) { setMsg({ kind: 'error', text: j.gate.message }); return; }
      if (!j.ok) { setMsg({ kind: 'error', text: j.error || 'Commit failed' }); return; }
      setMsg({ kind: 'success', text: 'Commit started.' });
      setTimeout(() => { setStatusTick((t) => t + 1); onChanged(); }, 1500);
    } catch (e) { setMsg({ kind: 'error', text: String(e) }); } finally { setBusy(null); }
  }, [status, chosen, comment, workspaceId, onChanged]);

  const update = useCallback(async () => {
    setBusy('update'); setMsg(null);
    try {
      const r = await fetch(`/api/deployment-pipelines/git/${workspaceId}/update`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceHead: status?.workspaceHead, remoteCommitHash: status?.remoteCommitHash, allowOverrideItems: true }),
      });
      const j = await r.json();
      if (j.gate) { setMsg({ kind: 'error', text: j.gate.message }); return; }
      if (!j.ok) { setMsg({ kind: 'error', text: j.error || 'Update failed' }); return; }
      setMsg({ kind: 'success', text: 'Update from Git started.' });
      setTimeout(() => { setStatusTick((t) => t + 1); onChanged(); }, 1500);
    } catch (e) { setMsg({ kind: 'error', text: String(e) }); } finally { setBusy(null); }
  }, [status, workspaceId, onChanged]);

  if (notConnected) return <MessageBar intent="info"><MessageBarBody>Workspace is not connected to Git.</MessageBarBody></MessageBar>;
  if (err) return <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>;
  if (pending) return (
    <MessageBar intent="info">
      <MessageBarBody>Fabric is still computing Git status. <Button appearance="transparent" size="small" onClick={() => setStatusTick((t) => t + 1)}>Retry</Button></MessageBarBody>
    </MessageBar>
  );
  if (status === null) return <Spinner size="tiny" label="Loading Git status…" />;

  const changes = status.changes || [];
  const hasConflict = changes.some((c) => c.conflictType === 'Conflict');

  return (
    <Section
      title="Source control"
      actions={<Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} onClick={() => setStatusTick((t) => t + 1)}>Refresh status</Button>}
    >
      <div className={styles.gitMeta} style={{ marginBottom: 8 }}>
        <span className={styles.gitMetaKey}>Workspace head</span><span className={styles.mono}>{status.workspaceHead?.slice(0, 12) || '—'}</span>
        <span className={styles.gitMetaKey}>Remote commit</span><span className={styles.mono}>{status.remoteCommitHash?.slice(0, 12) || '—'}</span>
        <span className={styles.gitMetaKey}>Changes</span><span>{changes.length}</span>
      </div>

      {hasConflict && (
        <MessageBar intent="warning" style={{ marginBottom: 8 }}>
          <MessageBarBody>One or more items changed in both the workspace and the branch. Resolve conflicts in the Fabric portal / Git before updating.</MessageBarBody>
        </MessageBar>
      )}

      {changes.length === 0 ? (
        <MessageBar intent="success"><MessageBarBody>Workspace is in sync with the connected branch.</MessageBarBody></MessageBar>
      ) : (
        <Table aria-label="Git changes" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: 36 }} />
              <TableHeaderCell>Item</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Change</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {changes.map((c) => {
              const id = idOf(c);
              return (
                <TableRow key={id}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${c.itemMetadata.displayName}`}
                      checked={!!chosen[id]}
                      disabled={!c.workspaceChange}
                      onChange={(_, d) => setChosen((p) => ({ ...p, [id]: !!d.checked }))}
                    />
                  </TableCell>
                  <TableCell>{c.itemMetadata.displayName}</TableCell>
                  <TableCell><span className={styles.itemType}>{c.itemMetadata.itemType}</span></TableCell>
                  <TableCell>{gitChangeBadge(c)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div className={styles.formGrid} style={{ marginTop: 12 }}>
        <Field label="Commit comment">
          <Input value={comment} onChange={(_, d) => setComment(d.value.slice(0, 300))} placeholder="Describe your changes (max 300 chars)" />
        </Field>
        <div className={styles.toolbar}>
          <Button appearance="primary" icon={<ArrowUpload20Regular />} disabled={busy !== null || changes.length === 0} onClick={() => commit('All')}>
            {busy === 'commit' ? 'Committing…' : 'Commit all'}
          </Button>
          <Button appearance="secondary" icon={<ArrowUpload20Regular />} disabled={busy !== null} onClick={() => commit('Selective')}>Commit selected</Button>
          <Button appearance="secondary" icon={<ArrowDownload20Regular />} disabled={busy !== null || hasConflict} onClick={update}>
            {busy === 'update' ? 'Updating…' : 'Update from Git'}
          </Button>
        </div>
        {msg && <MessageBar intent={msg.kind === 'success' ? 'success' : 'error'}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Infra tab — ARM / bicep deployment history
// ---------------------------------------------------------------------------

function InfraTab({ onUnauth }: { onUnauth: () => void }) {
  const styles = useStyles();
  const [deployments, setDeployments] = useState<ArmDeployment[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setDeployments(null); setGate(null); setErr(null);
    fetch('/api/deployment-pipelines/arm').then(async (r) => {
      if (r.status === 401 || r.status === 403) { onUnauth(); setDeployments([]); return; }
      const j = await r.json();
      if (j.gate) { setGate(j.gate); setDeployments([]); return; }
      if (!j.ok) { setErr(j.error || 'Failed to load ARM deployments'); setDeployments([]); return; }
      setDeployments(j.data.deployments || []);
    }).catch((e) => { setErr(String(e)); setDeployments([]); });
  }, [tick, onUnauth]);

  if (deployments === null) return <Spinner label="Loading ARM deployment history…" />;

  const armCols: LoomColumn<ArmDeployment>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, width: 220, render: (d) => <strong title={d.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{d.name}</strong> },
    { key: 'resourceGroup', label: 'Resource group', sortable: true, filterable: true, width: 200 },
    {
      key: 'provisioningState', label: 'State', sortable: true, filterable: true, width: 160,
      getValue: (d) => d.provisioningState || '',
      render: (d) => <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>{provStateBadge(d.provisioningState)}{d.error ? <Text size={100} title={d.error}>{d.error.slice(0, 60)}</Text> : null}</span>,
    },
    {
      key: 'timestamp', label: 'Timestamp', sortable: true, filterable: false, width: 180,
      getValue: (d) => d.timestamp ? new Date(d.timestamp).getTime() : 0,
      render: (d) => d.timestamp ? new Date(d.timestamp).toLocaleString() : '—',
    },
    { key: 'durationSec', label: 'Duration', sortable: true, filterable: false, width: 110, getValue: (d) => d.durationSec ?? 0, render: (d) => d.durationSec != null ? `${Math.round(d.durationSec)}s` : '—' },
    { key: 'mode', label: 'Mode', sortable: true, filterable: true, width: 120, render: (d) => d.mode || '—' },
    { key: 'resourceCount', label: 'Resources', sortable: true, filterable: false, width: 110, getValue: (d) => d.resourceCount ?? 0, render: (d) => d.resourceCount != null ? String(d.resourceCount) : '—' },
  ];

  return (
    <div className={styles.section}>
      <MessageBar intent="info">
        <MessageBarBody>
          The platform's own ARM / bicep rollouts across the Loom resource groups
          (Azure <code>Microsoft.Resources/deployments</code> REST). Read-only history — the rollouts
          themselves run from the deploy pipeline (<code>az deployment sub create</code> + bootstrap).
        </MessageBarBody>
      </MessageBar>
      {gate && <GateBar gate={gate} subject="Infra deployments" />}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      <Section
        title="ARM / bicep rollouts"
        actions={<Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>}
      >
        <LoomDataTable
          ariaLabel="ARM deployment history"
          columns={armCols}
          rows={deployments}
          getRowId={(d) => d.id}
          empty="No ARM deployments found in the configured Loom resource groups."
        />
      </Section>
    </div>
  );
}
