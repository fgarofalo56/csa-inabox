'use client';

/**
 * PipelineManageHub — the catalog-driven "Manage" hub dialog (Wave-2 pipeline
 * authoring foundation), themed for Loom (Fluent UI v9 + Loom design tokens).
 *
 * This is an ADDITIVE surface that wires the three Wave-1 catalog-driven
 * components into the pipeline editors WITHOUT rewriting the editor or the older
 * `ManagePanel`:
 *
 *   • Linked services      → <LinkedServiceGallery/>  (connector gallery + the
 *                            per-connector structured config form, real upsert)
 *   • Datasets             → <DatasetWizard/> launched from a "New dataset" CTA
 *                            (the 4-step gallery → connection → shape → schema
 *                            wizard) + a live list of the factory/workspace
 *                            datasets (real GET)
 *   • Integration runtimes → <IntegrationRuntimeManager/> (Azure / Self-Hosted /
 *                            Azure-SSIS, structured wizard, lifecycle + keys)
 *
 * Every action routes to the real BFF (`/api/adf/*`, `/api/synapse/*`,
 * `/api/items/data-pipeline/[id]/integration-runtimes`) which calls the real
 * ARM / Synapse dev-plane REST — no mocks (per no-vaporware.md). The honest
 * infra-gate (Console env var not set → 503) is surfaced by each component.
 *
 * The Integration-runtimes tab is item-scoped (needs the pipeline item id +
 * workspace), and is ADF-only — Synapse pipelines manage IRs at the workspace
 * level, so the tab is hidden when `engine === 'synapse'` or no item is bound.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, TabList, Tab, Caption1, Subtitle2, Text, Spinner, Badge, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss24Regular, Add20Regular, ArrowClockwise20Regular,
  PlugConnected24Regular, Database24Regular, Server24Regular, Settings24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { LinkedServiceGallery, type LinkedServiceEngine } from '@/lib/components/pipeline/linked-service-gallery';
import { DatasetWizard } from '@/lib/components/pipeline/dataset-wizard';
import { IntegrationRuntimeManager } from '@/lib/components/pipeline/integration-runtime-manager';

type HubTab = 'linked-services' | 'datasets' | 'integration-runtimes';

const useStyles = makeStyles({
  surface: { maxWidth: '960px', width: '94vw' },
  title: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  intro: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalS },
  tabs: { borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, marginBottom: tokens.spacingVerticalM },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, minHeight: '420px' },
  headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  headActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexShrink: 0 },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
  },
});

export interface PipelineManageHubProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Backend: 'adf' (default) → Azure Data Factory; 'synapse' → Synapse workspace. */
  engine?: LinkedServiceEngine;
  /** The data-pipeline item id — required to surface the (ADF-only) IR tab. */
  itemId?: string;
  /** The workspace (Cosmos partition key) the item lives in. */
  workspaceId?: string;
  /** Which tab to open on. Defaults to 'linked-services'. */
  initialTab?: HubTab;
}

// A dataset row from either BFF (ADF carries full props; Synapse returns {name,type}).
interface DatasetRow { name: string; type?: string; linkedService?: string }

function datasetRoute(engine: LinkedServiceEngine): string {
  return engine === 'synapse' ? '/api/synapse/datasets' : '/api/adf/datasets';
}

/** Datasets tab — a live list (real GET) + the catalog-driven DatasetWizard. */
function DatasetsTab({ engine }: { engine: LinkedServiceEngine }) {
  const s = useStyles();
  const [rows, setRows] = useState<DatasetRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async () => {
    setErr(null); setGate(null);
    try {
      const r = await clientFetch(datasetRoute(engine), { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && (j?.code === 'not_configured' || j?.missing)) { setGate(String(j.error || 'Backend not configured.')); setRows([]); return; }
      if (!r.ok || !j?.ok) { setErr(String(j?.error || `HTTP ${r.status}`)); setRows([]); return; }
      const list: DatasetRow[] = Array.isArray(j.datasets)
        ? j.datasets.map((d: any) => ({
            name: d.name,
            type: d.properties?.type ?? d.type,
            linkedService: d.properties?.linkedServiceName?.referenceName,
          }))
        : [];
      setRows(list);
    } catch (e: any) { setErr(e?.message || String(e)); setRows([]); }
  }, [engine]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className={s.body}>
      <div className={s.headRow}>
        <Subtitle2>Datasets{rows ? ` (${rows.length})` : ''}</Subtitle2>
        <div className={s.headActions}>
          <Tooltip content="Refresh" relationship="label">
            <Button appearance="subtle" icon={<ArrowClockwise20Regular />} aria-label="Refresh datasets"
              onClick={() => { setRows(null); void load(); }} disabled={!!gate} />
          </Tooltip>
          <Button appearance="primary" icon={<Add20Regular />} disabled={!!gate} onClick={() => setWizardOpen(true)}>
            New dataset
          </Button>
        </div>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{engine === 'synapse' ? 'Synapse workspace' : 'Data Factory'} not configured</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}
      {err && !gate && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {rows === null && !gate && <Spinner size="tiny" label="Loading datasets…" />}

      {rows !== null && rows.length === 0 && !gate && !err && (
        <div className={s.empty}>
          <Database24Regular />
          <Subtitle2>No datasets yet</Subtitle2>
          <Caption1>Create one to define the shape a Copy / Data Flow activity reads or writes.</Caption1>
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => setWizardOpen(true)}>New dataset</Button>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <Table aria-label="Datasets" size="medium">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Linked service</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.name}>
                <TableCell><Text weight="semibold">{d.name}</Text></TableCell>
                <TableCell>{d.type ? <Badge appearance="tint" color="brand">{d.type}</Badge> : '—'}</TableCell>
                <TableCell><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.linkedService || '—'}</Caption1></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <DatasetWizard
        open={wizardOpen}
        provider={engine}
        onClose={() => setWizardOpen(false)}
        onCreated={() => { setWizardOpen(false); void load(); }}
      />
    </div>
  );
}

export function PipelineManageHub({
  open, onOpenChange, engine = 'adf', itemId, workspaceId, initialTab = 'linked-services',
}: PipelineManageHubProps) {
  const s = useStyles();
  const [tab, setTab] = useState<HubTab>(initialTab);

  // The item-scoped IR surface is ADF-only and needs a bound pipeline item.
  const showIr = engine === 'adf' && !!itemId && !!workspaceId;
  const backendLabel = engine === 'synapse' ? 'Synapse workspace' : 'Data Factory';

  // Honor the requested tab each time the dialog is (re)opened.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  // If the IR tab is hidden but selected (engine flips to synapse), fall back.
  useEffect(() => {
    if (tab === 'integration-runtimes' && !showIr) setTab('linked-services');
  }, [tab, showIr]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={() => onOpenChange(false)} />}>
            <span className={s.title}><Settings24Regular /> Manage — {backendLabel} resources</span>
          </DialogTitle>
          <DialogContent>
            <Caption1 className={s.intro}>
              Factory / workspace resources your pipeline activities reference. Every action here calls real{' '}
              {engine === 'synapse' ? 'Synapse workspace dev REST.' : 'Azure Data Factory REST (api-version 2018-06-01).'}
            </Caption1>

            <TabList className={s.tabs} selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as HubTab)}>
              <Tab value="linked-services" icon={<PlugConnected24Regular />}>Linked services</Tab>
              <Tab value="datasets" icon={<Database24Regular />}>Datasets</Tab>
              {showIr && <Tab value="integration-runtimes" icon={<Server24Regular />}>Integration runtimes</Tab>}
            </TabList>

            {tab === 'linked-services' && (
              <div className={s.body}>
                <LinkedServiceGallery engine={engine} />
              </div>
            )}

            {tab === 'datasets' && <DatasetsTab engine={engine} />}

            {tab === 'integration-runtimes' && showIr && (
              <div className={s.body}>
                <IntegrationRuntimeManager
                  itemId={itemId!}
                  workspaceId={workspaceId!}
                  engine={engine}
                />
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default PipelineManageHub;
