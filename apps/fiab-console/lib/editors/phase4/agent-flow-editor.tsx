'use client';

/**
 * AgentFlowEditor — the standalone `agent-flow` item type (W9).
 *
 * A first-class version of the AIF-6 visual multi-agent workflow: the same
 * AgentFlowCanvas (grounded data-tool nodes + MCP/OpenAPI/function tools +
 * connected sub-agents) authoring a FlowDag that persists to this item's state
 * and RUNS through the Azure-native connected-agents runtime via the item's own
 * owner-scoped run route (POST /api/items/agent-flow/[id]/run). No Microsoft
 * Fabric / Foundry dependency on the default path (no-fabric-dependency.md);
 * every control hits a real backend (no-vaporware.md).
 *
 *   • Design tab  → orchestrator instructions + the AgentFlowCanvas (its
 *                   embedded run pane POSTs the item's run route → real grounded
 *                   orchestration over the bound Loom items + sub-agents).
 *   • Runs tab    → the persisted run history (GET …/runs).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Field, Textarea, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  FlowchartRegular, HistoryRegular, BotRegular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemCreateGate } from '../new-item-gate';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { AgentFlowCanvas } from './agent-flow-canvas';
import type { LayoutMap } from './agent-flow-layout';
import { useItemState, SaveBar } from './shared';
import { migrateLegacyTools, type AgentTool } from '@/lib/copilot/agent-tool-catalog';
import { normalizeSubAgents, type SubAgentRef } from '@/lib/copilot/connected-agents';
import type { AgentFlowRun } from '@/lib/azure/agent-flow-run';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

interface AgentFlowEditorState extends Record<string, unknown> {
  instructions?: string;
  tools?: AgentTool[];
  subAgents?: SubAgentRef[];
  flowLayout?: LayoutMap;
  runs?: AgentFlowRun[];
}

const useStyles = makeStyles({
  tabBar: {
    paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  tableWrap: { overflow: 'auto', maxHeight: '52vh' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
});

export function AgentFlowEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const {
    state, setState, loading, saving, error, savedAt, save, dirty, workspaceId,
  } = useItemState<AgentFlowEditorState>('agent-flow', id, { instructions: '', tools: [], subAgents: [], flowLayout: {} });

  const [tab, setTab] = useState<'design' | 'runs'>('design');
  const [runs, setRuns] = useState<AgentFlowRun[]>([]);

  const tools = useMemo(() => migrateLegacyTools(state.tools), [state.tools]);
  const subAgents = useMemo(() => normalizeSubAgents(state.subAgents), [state.subAgents]);

  const loadRuns = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/agent-flow/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (j.ok) setRuns(Array.isArray(j.runs) ? j.runs : []);
    } catch { /* honest: table stays empty */ }
  }, [id]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Flow', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: dirty && !saving ? () => save() : undefined, disabled: !dirty || saving },
      ]},
      { label: 'View', actions: [
        { label: 'Design', onClick: () => setTab('design') },
        { label: 'Runs', onClick: () => { setTab('runs'); loadRuns(); } },
      ]},
    ]},
  ], [saving, dirty, save, loadRuns]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create agent flow"
        intro="An agent flow is a standalone visual multi-agent workflow: chain grounded data tools (lakehouse / warehouse / KQL / AI Search), capability tools (MCP servers, OpenAPI, functions), and connected sub-agents on a canvas, then run the flow against your real Azure backends. Azure-native (Azure OpenAI + your bound Loom items) — no Microsoft Fabric required. Create it, then design and run the flow." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => { const v = d.value as 'design' | 'runs'; setTab(v); if (v === 'runs') loadRuns(); }}>
            <Tab value="design" icon={<FlowchartRegular />}>Design</Tab>
            <Tab value="runs" icon={<HistoryRegular />}>Runs{runs.length ? ` (${runs.length})` : ''}</Tab>
          </TabList>
        </div>

        <div className={s.body}>
          <TeachingBanner
            surfaceKey="agent-flow-editor"
            icon={BotRegular}
            title="Design a multi-agent flow"
            message="Write the orchestrator's instructions, then drop grounded data tools, capability tools (MCP / OpenAPI / function), and connected sub-agents on the canvas. Ask a question in the run pane to execute the flow against your real Azure backends — Azure OpenAI grounds over the bound items and delegates to each sub-agent. No Microsoft Fabric required."
            learnMoreHref="https://learn.microsoft.com/azure/ai-services/agents/concepts/connected-agents"
          />
          {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

          {tab === 'design' && (
            <>
              <div className={s.card}>
                <span className={s.sectionHeader}><BotRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Orchestrator instructions</Subtitle2></span>
                <Field hint="What the flow should do, and how it should combine its tools and sub-agents. Grounds the Azure OpenAI orchestrator at run time.">
                  <Textarea value={String(state.instructions || '')} rows={4} resize="vertical"
                    placeholder="e.g. You are a supply-chain analyst. Use the warehouse tool for order data and the KQL tool for live telemetry, delegate pricing questions to the pricing sub-agent, and always cite the source."
                    onChange={(_, d) => setState((p) => ({ ...p, instructions: d.value }))} />
                </Field>
              </div>

              {loading ? (
                <Caption1>Loading flow…</Caption1>
              ) : (
                <AgentFlowCanvas
                  id={id}
                  workspaceId={workspaceId}
                  agentName={item.displayName || 'Orchestrator'}
                  sources={[]}
                  tools={tools}
                  subAgents={subAgents}
                  layout={(state.flowLayout || {}) as LayoutMap}
                  onPatch={(patch) => setState((p) => ({
                    ...p,
                    ...(patch.tools ? { tools: patch.tools } : {}),
                    ...(patch.subAgents ? { subAgents: patch.subAgents } : {}),
                    ...(patch.layout ? { flowLayout: patch.layout } : {}),
                  }))}
                  dirty={dirty}
                  save={save}
                  runEndpoint={`/api/items/agent-flow/${encodeURIComponent(id)}/run`}
                />
              )}

              <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
            </>
          )}

          {tab === 'runs' && (
            <div className={s.card}>
              <span className={s.sectionHeader}><HistoryRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Run history</Subtitle2></span>
              {!runs.length ? (
                <Caption1>No runs yet. Switch to Design and ask a question in the run pane.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Agent flow run history">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Started</TableHeaderCell>
                        <TableHeaderCell>Question</TableHeaderCell>
                        <TableHeaderCell>Grounded</TableHeaderCell>
                        <TableHeaderCell>Tools</TableHeaderCell>
                        <TableHeaderCell>Sub-agents</TableHeaderCell>
                        <TableHeaderCell>Tokens</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((rn) => (
                        <TableRow key={rn.id}>
                          <TableCell>{new Date(rn.startedAt).toLocaleString()}</TableCell>
                          <TableCell><span className={s.mono}>{rn.question.slice(0, 80)}</span></TableCell>
                          <TableCell>{rn.groundedSources}</TableCell>
                          <TableCell>{rn.capabilityTools}</TableCell>
                          <TableCell>{rn.subAgents}{rn.delegated ? ' ✓' : ''}</TableCell>
                          <TableCell>{rn.totalTokens || '—'}</TableCell>
                          <TableCell>
                            <Badge appearance="tint" color={rn.status === 'failed' ? 'danger' : 'success'}>{rn.status}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Divider />
              <Caption1>Runs are persisted with the item and survive reloads. Newest first; up to 50 retained.</Caption1>
            </div>
          )}
        </div>
      </div>
    } />
  );
}
