/**
 * N4 — `transformation-project` editor: SQLMesh ALONGSIDE dbt.
 *
 * One item, one model graph, a BACKEND SELECTOR (dbt default for continuity,
 * SQLMesh opt-in), and five tabs:
 *
 *   Build           — the guided model graph + engine selector (ModelBuilder).
 *   Plan & apply    — the N4 wizard: environment → impact-diff grid → apply.
 *   Model DAG       — the software-defined-asset canvas (canvas-node-kit).
 *   Generated files — the REAL project files that get sent to the runner.
 *   History         — every plan previewed and every apply authorized.
 *
 * FLAG0: the Plan & apply + Model DAG surfaces read the `n4-transform-plan-apply`
 * runtime flag (default ON, admin-flippable) — flipping it off reverts to
 * authoring + file preview with a guided notice, no roll required.
 *
 * A freshly-created item opens CLEAN: guided empty states, no red banners. The
 * honest runner gate only appears after an engine call is actually attempted.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, Subtitle2, Tab, TabList, Table, TableBody, TableCell, TableHeader,
  TableHeaderCell, TableRow, Text, makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import { BranchFork20Regular } from '@fluentui/react-icons';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { ItemEditorChrome } from '@/lib/editors/item-editor-chrome';
import { NewItemCreateGate } from '@/lib/editors/new-item-gate';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ModelBuilder } from '@/lib/components/transform/model-builder';
import { ModelDagCanvas } from '@/lib/components/transform/model-dag-canvas';
import { PlanApplyWizard } from '@/lib/components/transform/plan-apply-wizard';
import type { PlanImpact } from '@/lib/transform/plan-impact';
import { buildTransformDag } from '@/lib/transform/transform-dag';
import { generateTransformProject } from '@/lib/transform/transform-codegen';
import {
  emptyTransformProject, projectHasContent, resolveTransformBackend,
  validateTransformProject, type TransformProject,
} from '@/lib/transform/transform-project-model';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, minHeight: 0 },
  tabBar: { ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2) },
  files: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  file: {
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  pre: {
    margin: 0, overflowX: 'auto', fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2,
  },
  grid: { overflowX: 'auto', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

interface PlanHistoryRow {
  id: string;
  backend: string;
  environment: string;
  plannedAt: string;
  plannedByUpn: string;
  summary: { breaking: number; added: number; modified: number; removed: number };
  applied?: { at: string; byUpn: string; ok: boolean };
}

interface ItemDTO {
  id: string;
  displayName: string;
  state?: Record<string, unknown>;
}

export function TransformationProjectEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const planApplyEnabled = useRuntimeFlag('n4-transform-plan-apply', true);

  const [tab, setTab] = useState('build');
  const [project, setProject] = useState<TransformProject>(() => emptyTransformProject());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [impact, setImpact] = useState<PlanImpact | null>(null);
  const [artifacts, setArtifacts] = useState<{ manifest?: unknown; catalog?: unknown }>({});
  const [history, setHistory] = useState<PlanHistoryRow[] | null>(null);
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!id || id === 'new') return;
    setBusy(true); setLoadError(null);
    try {
      const r = await clientFetch(`/api/items/transformation-project/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      const dto = j.item as ItemDTO;
      setDisplayName(dto.displayName);
      const state = (dto.state || {}) as { project?: unknown; lastManifest?: unknown; lastCatalog?: unknown };
      const raw = state.project as TransformProject | undefined;
      setProject(raw && Array.isArray(raw.models)
        ? { ...raw, backend: resolveTransformBackend({ project: raw }) }
        : emptyTransformProject(dto.displayName || 'loom_transform_project'));
      setArtifacts({ manifest: state.lastManifest, catalog: state.lastCatalog });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const loadHistory = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await clientFetch(`/api/transform/${encodeURIComponent(id)}/history`);
      const j = await r.json();
      setHistory(j.ok ? (j.plans as PlanHistoryRow[]) : []);
    } catch {
      setHistory([]);
    }
  }, [id]);

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  const save = useCallback(async (extra?: Record<string, unknown>) => {
    if (!id || id === 'new') return;
    setBusy(true); setSaveMsg('Saving…');
    try {
      const r = await clientFetch(`/api/items/transformation-project/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: { project, ...(extra || {}) } }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setSaveMsg(null);
    } finally { setBusy(false); }
  }, [id, project]);

  const onProjectChange = useCallback((next: TransformProject) => {
    setProject(next);
    setDirty(true);
    setImpact(null); // an edited graph invalidates the previewed plan
  }, []);

  const files = useMemo(() => (projectHasContent(project) ? generateTransformProject(project) : []), [project]);
  const dag = useMemo(() => buildTransformDag(project, impact), [project, impact]);
  const validation = useMemo(() => validateTransformProject(project), [project]);

  const onPlanned = useCallback((next: PlanImpact, art: { manifest?: unknown; catalog?: unknown }) => {
    setImpact(next);
    if (art.manifest || art.catalog) setArtifacts(art);
  }, []);

  const onApplied = useCallback((next: PlanImpact, art: { manifest?: unknown; catalog?: unknown }) => {
    setImpact(next);
    setArtifacts(art);
    // Persist the deployed-state artifacts so the NEXT dbt plan diffs against
    // what is actually deployed (dbt has no server-side state store).
    void save({ lastManifest: art.manifest, lastCatalog: art.catalog });
    void loadHistory();
  }, [save, loadHistory]);

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'Edit',
          actions: [{ label: dirty ? 'Save' : 'Saved', onClick: dirty && !busy ? () => save() : undefined, disabled: !dirty || busy }],
        },
        {
          label: 'Plan',
          actions: [
            { label: 'Plan & apply', onClick: () => setTab('plan'), disabled: !planApplyEnabled },
            { label: 'Model DAG', onClick: () => setTab('dag'), disabled: !planApplyEnabled },
          ],
        },
        {
          label: 'Project',
          actions: [
            { label: 'Generated files', onClick: () => setTab('files') },
            { label: 'History', onClick: () => setTab('history') },
          ],
        },
      ],
    },
  ], [dirty, busy, save, planApplyEnabled]);

  if (id === 'new') {
    return (
      <NewItemCreateGate
        item={item}
        createLabel="Create transformation project"
        intro="A transformation project models your warehouse with dbt (default) or SQLMesh — the same model graph, either engine. Create it, build the graph, then preview a plan (breaking vs non-breaking, column-level, downstream) before anything is applied."
      />
    );
  }

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      commandSearch
      dirty={dirty}
      displayName={displayName}
      splitKeyPrefix="transformation-project"
      main={(
        <div className={s.body}>
          <div className={s.tabBar}>
            <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as string)}>
              <Tab value="build">Build</Tab>
              <Tab value="plan">Plan &amp; apply</Tab>
              <Tab value="dag">Model DAG</Tab>
              <Tab value="files">Generated files</Tab>
              <Tab value="history">History</Tab>
            </TabList>
          </div>

          <TeachingBanner
            surfaceKey="transformation-project"
            title="Two engines, one project"
            message="dbt is the default so your existing ecosystem keeps working. Switch the engine to SQLMesh and the same model graph gains virtual data environments, a Terraform-style plan/apply with real breaking vs non-breaking categorization, and column-level model diff. Both run in your own VNet — no Fabric, no dbt Cloud, no Tobiko Cloud."
          />

          {loadError && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Could not complete that action</MessageBarTitle>
                {loadError}
              </MessageBarBody>
            </MessageBar>
          )}
          {saveMsg && (
            <MessageBar intent="success"><MessageBarBody>{saveMsg}</MessageBarBody></MessageBar>
          )}
          {busy && <Spinner size="tiny" label="Working…" labelPosition="after" />}

          {tab === 'build' && (
            <ModelBuilder project={project} onChange={onProjectChange} />
          )}

          {tab === 'plan' && (
            !planApplyEnabled ? (
              <EmptyState
                icon={<BranchFork20Regular />}
                title="Plan & apply is turned off"
                body="An administrator has disabled the n4-transform-plan-apply runtime flag. Building the model graph and generating project files still work; re-enable the flag on /admin/runtime-flags to bring the wizard back."
              />
            ) : validation.length > 0 ? (
              <EmptyState
                icon={<BranchFork20Regular />}
                title="Finish the model graph first"
                body={`Add at least one model on the Build tab before planning. ${validation.map((v) => `${v.field}: ${v.message}`).join('; ')}`}
                primaryAction={{ label: 'Go to Build', onClick: () => setTab('build'), appearance: 'primary' }}
              />
            ) : (
              <PlanApplyWizard
                itemId={id}
                project={project}
                backend={project.backend}
                previousManifest={artifacts.manifest}
                previousCatalog={artifacts.catalog}
                onPlanned={onPlanned}
                onApplied={onApplied}
              />
            )
          )}

          {tab === 'dag' && (
            !planApplyEnabled ? (
              <EmptyState
                icon={<BranchFork20Regular />}
                title="Model DAG is turned off"
                body="An administrator has disabled the n4-transform-plan-apply runtime flag, which also covers this canvas. Re-enable it on /admin/runtime-flags."
              />
            ) : (
              <ModelDagCanvas dag={dag} />
            )
          )}

          {tab === 'files' && (
            files.length === 0 ? (
              <EmptyState
                icon={<BranchFork20Regular />}
                title="No project files yet"
                body="Add a model on the Build tab. Loom then generates the real project files for the selected engine — dbt_project.yml + profiles.yml + models for dbt, or config.yaml + MODEL(...) files for SQLMesh — and sends exactly these to the runner."
                primaryAction={{ label: 'Go to Build', onClick: () => setTab('build'), appearance: 'primary' }}
              />
            ) : (
              <div className={s.files}>
                <Caption1 className={s.muted}>
                  {files.length} file{files.length === 1 ? '' : 's'} generated for{' '}
                  {project.backend === 'sqlmesh' ? 'SQLMesh' : 'dbt'} — this is exactly what the runner executes.
                </Caption1>
                {files.map((f) => (
                  <div key={f.path} className={s.file}>
                    <Subtitle2>{f.path}</Subtitle2>
                    <pre className={s.pre}>{f.content}</pre>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'history' && (
            history === null ? (
              <Spinner size="tiny" label="Loading history…" labelPosition="after" />
            ) : history.length === 0 ? (
              <EmptyState
                icon={<BranchFork20Regular />}
                title="No plans yet"
                body="Every plan you preview and every apply you authorize is recorded here — who, which environment, and the exact impact rows that were shown. Run a plan on the Plan & apply tab to start the record."
                primaryAction={{ label: 'Plan & apply', onClick: () => setTab('plan'), appearance: 'primary' }}
              />
            ) : (
              <div className={s.grid}>
                <Table size="small" aria-label="Plan history">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Planned</TableHeaderCell>
                      <TableHeaderCell>Engine</TableHeaderCell>
                      <TableHeaderCell>Environment</TableHeaderCell>
                      <TableHeaderCell>Impact</TableHeaderCell>
                      <TableHeaderCell>By</TableHeaderCell>
                      <TableHeaderCell>Applied</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell><Text>{new Date(h.plannedAt).toLocaleString()}</Text></TableCell>
                        <TableCell><Text>{h.backend === 'sqlmesh' ? 'SQLMesh' : 'dbt'}</Text></TableCell>
                        <TableCell><Text>{h.environment}</Text></TableCell>
                        <TableCell>
                          <Body1>
                            {h.summary.breaking > 0 && <Badge appearance="tint" color="danger">{h.summary.breaking} breaking</Badge>}{' '}
                            {h.summary.added}+ / {h.summary.modified}~ / {h.summary.removed}−
                          </Body1>
                        </TableCell>
                        <TableCell><Text>{h.plannedByUpn}</Text></TableCell>
                        <TableCell>
                          {h.applied
                            ? <Badge appearance="tint" color={h.applied.ok ? 'success' : 'danger'}>{h.applied.ok ? 'Applied' : 'Failed'}</Badge>
                            : <Caption1 className={s.muted}>Preview only</Caption1>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          )}
        </div>
      )}
    />
  );
}
