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
  Tab, TabList, Spinner, Badge, Button, Dropdown, Option, Textarea, Checkbox,
  MessageBar, MessageBarBody, MessageBarTitle, Text,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Rocket20Regular, ArrowRight20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';

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

// ---- styles ----------------------------------------------------------------

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' },
  section: { display: 'flex', flexDirection: 'column', gap: '12px' },
  gap: { marginBottom: '12px' },
  stages: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '16px',
    alignItems: 'stretch',
  },
  stageCard: {
    display: 'flex', flexDirection: 'column', gap: '10px',
    padding: '16px', borderRadius: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minHeight: '160px',
  },
  stageHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
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
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th: {
    textAlign: 'left', padding: '8px 10px', borderBottom: `2px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', color: tokens.colorNeutralForeground3,
    position: 'sticky', top: 0, backgroundColor: tokens.colorNeutralBackground1,
  },
  td: { padding: '8px 10px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, verticalAlign: 'top', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tableWrap: { maxHeight: '520px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '8px' },
  empty: {
    padding: '32px', borderRadius: '12px', border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
    fontSize: '14px', textAlign: 'center', lineHeight: 1.6,
  },
  dialogItems: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflow: 'auto', marginTop: '8px' },
  historyTitle: { fontSize: '15px', fontWeight: 600, marginTop: '8px' },
});

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

type TabKey = 'pipelines' | 'infra';

export function DeploymentPipelinesPane() {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('pipelines');
  const [unauth, setUnauth] = useState(false);

  return (
    <div>
      {unauth && <SignInRequired subject="deployment pipelines" />}
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabKey)} className={styles.gap}>
        <Tab value="pipelines">Deployment pipelines</Tab>
        <Tab value="infra">Infra deployments (ARM)</Tab>
      </TabList>
      {tab === 'pipelines' && <PipelinesTab onUnauth={() => setUnauth(true)} />}
      {tab === 'infra' && <InfraTab onUnauth={() => setUnauth(true)} />}
    </div>
  );
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
        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>
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

  return (
    <div className={styles.section}>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      <div className={styles.stages}>
        {stages.map((st, i) => {
          const next = stages[i + 1];
          const items = stageItems[st.id];
          return (
            <div key={st.id} className={styles.stageCard}>
              <div className={styles.stageHead}>
                <span className={styles.stageName}>{st.displayName}</span>
                {st.isPublic && <Badge appearance="outline" size="small">Public</Badge>}
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
                <div className={styles.stageMeta}>
                  Assign a workspace to this stage in Fabric to populate it.
                </div>
              )}

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
            </div>
          );
        })}
      </div>

      <div className={styles.historyTitle}>Deployment history</div>
      {operations === null ? (
        <Spinner size="tiny" label="Loading deployment history…" />
      ) : operations.length === 0 ? (
        <div className={styles.empty}>No deployments recorded for this pipeline yet.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Started</th>
                <th className={styles.th}>From → To</th>
                <th className={styles.th}>Status</th>
                <th className={styles.th}>By</th>
                <th className={styles.th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((o) => (
                <tr key={o.id}>
                  <td className={styles.td}>{o.executionStartTime ? new Date(o.executionStartTime).toLocaleString() : '—'}</td>
                  <td className={styles.td}>{stageName(o.sourceStageId)} → {stageName(o.targetStageId)}</td>
                  <td className={styles.td}>{opStatusBadge(o.status)}</td>
                  <td className={styles.td} title={o.performedBy}>{o.performedBy || '—'}</td>
                  <td className={styles.td} title={o.note}>{o.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deploy dialog — Deploy all OR selective deploy of specific items, + note
// ---------------------------------------------------------------------------

function DeployDialog({
  pipelineId, source, target, items, onDeployed,
}: {
  pipelineId: string; source: Stage; target: Stage; items: StageItem[]; onDeployed: () => void;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [selective, setSelective] = useState(false);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

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
  }, [pipelineId, source.id, target.id, note, selective, chosenList, onDeployed]);

  const canDeploy = !!source.workspaceId; // must have content to deploy

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button
          appearance="primary"
          icon={<Rocket20Regular />}
          disabled={!canDeploy}
          title={canDeploy ? `Deploy ${source.displayName} → ${target.displayName}` : 'Assign a workspace to the source stage first'}
        >
          Deploy to {target.displayName}
        </Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            Deploy <ArrowRight20Regular style={{ verticalAlign: 'middle' }} /> {source.displayName} → {target.displayName}
          </DialogTitle>
          <DialogContent>
            <Text block>
              Content from <strong>{source.displayName}</strong> will be copied to{' '}
              <strong>{target.displayName}</strong>
              {target.workspaceName ? <> ({target.workspaceName})</> : null}. Paired items in the target stage are overwritten.
            </Text>

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

  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setTick((t) => t + 1)}>Refresh</Button>
      </div>
      <MessageBar intent="info">
        <MessageBarBody>
          The platform's own ARM / bicep rollouts across the Loom resource groups
          (Azure <code>Microsoft.Resources/deployments</code> REST). Read-only history — the rollouts
          themselves run from the deploy pipeline (<code>az deployment sub create</code> + bootstrap).
        </MessageBarBody>
      </MessageBar>
      {gate && <GateBar gate={gate} subject="Infra deployments" />}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {deployments.length === 0 && !gate && !err ? (
        <div className={styles.empty}>No ARM deployments found in the configured Loom resource groups.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Name</th>
                <th className={styles.th}>Resource group</th>
                <th className={styles.th}>State</th>
                <th className={styles.th}>Timestamp</th>
                <th className={styles.th}>Duration</th>
                <th className={styles.th}>Mode</th>
                <th className={styles.th}>Resources</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td className={styles.td} title={d.name}>{d.name}</td>
                  <td className={styles.td}>{d.resourceGroup}</td>
                  <td className={styles.td}>{provStateBadge(d.provisioningState)}{d.error ? <Text size={100} block title={d.error}> {d.error.slice(0, 60)}</Text> : null}</td>
                  <td className={styles.td}>{d.timestamp ? new Date(d.timestamp).toLocaleString() : '—'}</td>
                  <td className={styles.td}>{d.durationSec != null ? `${Math.round(d.durationSec)}s` : '—'}</td>
                  <td className={styles.td}>{d.mode || '—'}</td>
                  <td className={styles.td}>{d.resourceCount != null ? d.resourceCount : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
