'use client';

/**
 * The ADF-Studio-parity RIBBON for the shared pipeline editor — its own bounded
 * context, extracted from `pipeline-editor-core.tsx` (WS-E E3 monolith-creep
 * ratchet; siblings `pipeline-autobind-surfaces.tsx` and
 * `pipeline-create-factory-form.tsx` were carved out the same way).
 *
 * It is a PURE builder: every affordance it renders is handed in as a callback,
 * so the toolbar's shape lives here while all state, IO, and the designer handle
 * stay in the editor. `PipelineEditorCore` wraps the call in the same `useMemo`
 * over the same dependency list it had inline, so identity/memoization is
 * byte-for-byte unchanged.
 *
 * Toolbar contents (Fabric/ADF Studio parity): Save · Insert (Copy data /
 * Dataflow / Notebook / Lookup / Invoke pipeline) · Authoring (Check errors) ·
 * Validate (ADF only) · Manage (quick panel + linked services / datasets /
 * integration runtimes hub) · Run (Debug / Trigger now / Add trigger) · Layout
 * (Auto align / Zoom to fit). Activities are added from the designer's left
 * palette pane, matching ADF Studio — no activity buttons in the toolbar.
 */

import {
  Play20Regular, Server20Regular, Save20Regular, Bug20Regular, Checkmark20Regular,
  Clock20Regular, Settings20Regular, PlugConnected20Regular, Database20Regular,
  DocumentArrowRight20Regular, Notebook20Regular, SearchInfo20Regular,
  Flow20Regular, ErrorCircle20Regular, DataArea20Regular,
} from '@fluentui/react-icons';
import type { RibbonTab } from '@/lib/components/ribbon';
import type { PipelineDesignerHandle } from '@/lib/components/pipeline/pipeline-designer';

/** Which pane of the Manage hub a ribbon button opens. */
export type ManageHubTab = 'linked-services' | 'datasets' | 'integration-runtimes';

export interface PipelineRibbonArgs {
  /** ADF exposes a server-side Validate action; Synapse doesn't. */
  supportsValidate: boolean;
  /** Runtime family — only changes the Manage button's tooltip wording. */
  isAdf: boolean;
  /** An action is in flight (save / validate / run / debug). */
  busy: boolean;
  /** The bound ADF/Synapse pipeline name, or null when unbound. */
  bound: string | null;
  /** The spec differs from what was last loaded/saved. */
  dirty: boolean;
  /**
   * #3549 — the item is BOUND to a real pipeline whose authored graph could not
   * be written into it, so the live pipeline is EMPTY.
   *
   * This gates Run and Debug, and it is not cosmetic: an empty ADF/Synapse
   * pipeline is genuinely runnable, so a run returns **Succeeded** having
   * executed nothing. That "successful" no-op is the whole defect — 36 of 41
   * pipelines in the live factory were in exactly this state and every trigger
   * reported success. The editor's `PipelineSeedIncomplete` gate carries the
   * Fix-it that clears it.
   *
   * Optional so the ribbon's own tests can omit it; absent means "not in that
   * state", which is the pre-#3549 behaviour.
   */
  seedIncomplete?: boolean;
  save: () => void | Promise<void>;
  kick: (action: 'run' | 'debug') => void | Promise<void>;
  validate: () => void | Promise<void>;
  openTriggers: () => void;
  /** Opens the quick Manage panel (the compact linked-services/datasets flyout). */
  openManagePanel: () => void;
  openManageHub: (tab: ManageHubTab) => void;
  quickInsert: (activityKey: string) => void;
  checkAuthoringErrors: () => void;
  designerRef: { current: PipelineDesignerHandle | null };
}

const BIND_FIRST = 'Bind a pipeline first';

export function buildPipelineRibbon(a: PipelineRibbonArgs): RibbonTab[] {
  const { bound, busy, dirty, designerRef } = a;
  // #3549 — see `PipelineRibbonArgs.seedIncomplete`. `runBlocked` is what Run
  // and Debug actually gate on, so the empty-pipeline case cannot be added to
  // one of the two and forgotten on the other.
  const seedIncomplete = a.seedIncomplete === true;
  const runBlocked = busy || !bound || dirty || seedIncomplete;
  const EMPTY_PIPELINE = 'This pipeline is empty — its activities were not published';
  const runTitle = seedIncomplete
    ? EMPTY_PIPELINE
    : (dirty ? 'Save the spec first' : (!bound ? BIND_FIRST : undefined));

  const validateGroup: RibbonTab['groups'] = a.supportsValidate ? [{
    label: 'Validate', actions: [
      { label: busy ? 'Validating…' : 'Validate', icon: <Checkmark20Regular />, onClick: !busy && bound ? a.validate : undefined, disabled: busy || !bound, title: !bound ? BIND_FIRST : undefined },
    ],
  }] : [];
  // Manage hub — linked services / datasets (+ integration runtimes for ADF).
  // Available for BOTH ADF and Synapse pipelines, regardless of pipeline
  // binding. Synapse pipelines reach their own /api/synapse/* resources; the
  // backend is selected on the ManagePanel the editor renders.
  const manageGroup: RibbonTab['groups'] = [{
    label: 'Manage', actions: [
      { label: 'Manage', icon: <Settings20Regular />, onClick: a.openManagePanel, title: a.isAdf ? 'Linked services, datasets and integration runtimes (quick)' : 'Linked services and datasets (quick)' },
      { label: 'Linked services', icon: <PlugConnected20Regular />, onClick: () => a.openManageHub('linked-services'), title: 'Connector gallery — browse 30+ connectors, create, edit and delete connections' },
      { label: 'Datasets', icon: <Database20Regular />, onClick: () => a.openManageHub('datasets'), title: 'Dataset wizard — create, edit and delete datasets (connector → connection → shape → schema)' },
      { label: 'Integration runtimes', icon: <Server20Regular />, onClick: () => a.openManageHub('integration-runtimes'), title: 'Azure auto-resolve / Self-Hosted / Azure-SSIS integration runtimes' },
    ],
  }];
  // Quick-insert activity buttons (Fabric Home ribbon parity): drop the most
  // common activities straight from the ribbon. Enabled once bound; each routes
  // through the designer's insertActivityByKey handle.
  const insertGroup: RibbonTab['groups'] = [{
    label: 'Insert', actions: [
      { label: 'Copy data', icon: <DocumentArrowRight20Regular />, onClick: bound ? () => a.quickInsert('Copy') : undefined, disabled: !bound, title: !bound ? BIND_FIRST : 'Add a Copy data activity' },
      { label: 'Dataflow', icon: <DataArea20Regular />, onClick: bound ? () => a.quickInsert('DataflowGen2') : undefined, disabled: !bound, title: !bound ? BIND_FIRST : 'Add a Dataflow Gen2 activity' },
      { label: 'Notebook', icon: <Notebook20Regular />, onClick: bound ? () => a.quickInsert('Notebook') : undefined, disabled: !bound, title: !bound ? BIND_FIRST : 'Add a Notebook activity' },
      { label: 'Lookup', icon: <SearchInfo20Regular />, onClick: bound ? () => a.quickInsert('Lookup') : undefined, disabled: !bound, title: !bound ? BIND_FIRST : 'Add a Lookup activity' },
      { label: 'Invoke pipeline', icon: <Flow20Regular />, onClick: bound ? () => a.quickInsert('ExecutePipeline') : undefined, disabled: !bound, title: !bound ? BIND_FIRST : 'Add an Invoke pipeline (Execute Pipeline) activity' },
    ],
  }];
  return [
    { id: 'home', label: 'Home', groups: [
      { label: 'Save', actions: [
        { label: busy ? 'Saving…' : 'Save', icon: <Save20Regular />, onClick: !busy && bound && dirty ? a.save : undefined, disabled: busy || !bound || !dirty, title: !bound ? BIND_FIRST : (!dirty ? 'No changes' : undefined) },
      ] },
      ...insertGroup,
      { label: 'Authoring', actions: [
        { label: 'Check errors', icon: <ErrorCircle20Regular />, onClick: bound ? a.checkAuthoringErrors : undefined, disabled: !bound, title: !bound ? BIND_FIRST : 'List activities with unmet required fields (pre-run)' },
      ] },
      ...validateGroup,
      ...manageGroup,
      { label: 'Run', actions: [
        { label: busy ? 'Running…' : 'Debug', icon: <Bug20Regular />, onClick: !runBlocked ? () => a.kick('debug') : undefined, disabled: runBlocked, title: runTitle },
        { label: busy ? 'Running…' : 'Trigger now', icon: <Play20Regular />, onClick: !runBlocked ? () => a.kick('run') : undefined, disabled: runBlocked, title: runTitle },
        { label: 'Add trigger', icon: <Clock20Regular />, onClick: bound ? a.openTriggers : undefined, disabled: !bound, title: !bound ? BIND_FIRST : undefined },
      ] },
      { label: 'Layout', actions: [
        { label: 'Auto align', onClick: bound ? () => designerRef.current?.autoAlign() : undefined, disabled: !bound },
        { label: 'Zoom to fit', onClick: bound ? () => designerRef.current?.fitToScreen() : undefined, disabled: !bound },
      ] },
    ] },
  ];
}
