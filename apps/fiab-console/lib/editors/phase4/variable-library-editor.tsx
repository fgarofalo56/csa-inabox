'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Variable Library editor (Cosmos, typed key/value with value sets).
 *
 * Extracted verbatim from phase4-editors.tsx (behavior-preserving split —
 * zero logic change). Only the sibling-import paths were re-rooted one level
 * deeper (./x -> ../x) and shared helpers now come from ./shared.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Card, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option, Switch,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Bot24Regular, Database20Regular, Add20Regular, Sparkle20Regular,
  Link20Regular, Flash20Regular, Dismiss16Regular,
  ShieldCheckmark20Regular, Mail16Regular, ArrowSync16Regular,
  DataUsage20Regular, ArrowUpload16Regular,
  Settings20Regular, Money20Regular, BranchFork20Regular,
  Table20Regular, ChartMultiple20Regular,
  ArrowDownload16Regular, ArrowSortUp16Regular, ArrowSortDown16Regular,
  Save16Regular, DataTrending20Regular, Play20Regular, Pulse20Regular,
  Cube20Regular, Calculator20Regular, Ruler20Regular, Layer20Regular,
  ChevronRight16Regular, ChevronDown16Regular, ChevronLeft16Regular,
  Add16Regular, Edit16Regular, CheckmarkCircle20Regular, ArrowUndo16Regular,
} from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { getItem } from '@/lib/api/workspaces';
import type { MonitorRuleRecord } from '@/lib/azure/activator-monitor';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemBrowseGate } from '../new-item-gate';
import { safeModelJson } from '../model-fetch';
import { DataAgentResultViz } from '../data-agent-result-viz';
import { DataAgentConfigCopilotPanel } from '../data-agent-config-copilot';
import { mergeSuggestionIntoSources } from '../_da-config-merge';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { ComputePicker } from '@/lib/components/compute-picker';
import { KeyValueRows } from '@/lib/components/ui/key-value-rows';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { ForceDirectedGraph } from '@/lib/components/graph/force-directed-graph';
import { type MapLayer, type MapLayerType } from '@/lib/components/graph/geojson-map';
import {
  AzureMapsCanvas, AZURE_MAPS_STYLES, DEFAULT_BASEMAP, DEFAULT_CONTROLS,
  featurePropertyKeys, type AzureMapsView, type AzureMapsControls,
} from '@/lib/components/graph/azure-maps-canvas';
import { GraphTypeEditor } from '@/lib/components/graph/graph-type-editor';
import { GraphSourceBinding, type SourceBindable } from '@/lib/components/graph/graph-source-binding';
// Ontology typed-model (Foundry object/link/action types) — pure logic + types
// shared with the BFF routes. The typed-modeling surface in OntologyEditor drives
// this model; deriveSourceFromObjectTypes() keeps state.source in sync so the AGE
// instance/link/action routes keep resolving the declared type names.
import {
  migrateOntologyState, deriveSourceFromObjectTypes, normalizeOntoActionTypes, isOntoIdent,
  ONTO_BASE_TYPES, ONTO_BASE_TYPE_LABELS, ONTO_KEY_ELIGIBLE_TYPES, ONTO_STATUSES, ONTO_COLORS,
  ONTO_CARDINALITIES, ONTO_CARDINALITY_LABELS, ONTO_PARAM_TYPES, ONTO_PARAM_TYPE_LABELS, ONTO_ACTION_KINDS,
  type OntoObjectType, type OntoProperty, type OntoLinkType, type OntoActionType, type OntoActionParam,
  type OntoBaseType, type OntoCardinality, type OntoParamType, type OntoStatus, type OntoColor, type OntoDatasource,
} from '../ontology-model';
// Pure-logic helpers extracted for vitest coverage. See
// `lib/editors/__tests__/family-utils.test.ts`.
import {
  validateVarValue,
  parseOntologyHierarchy,
  computeGeoBbox,
  bboxToZoom,
  parseUdfFunctions,
  normalizeDaSources,
  daSupportsExampleQueries,
  shapeDaHistory,
  canSendDaQuestion,
  type VarType,
  type UdfFunction,
  type DaSourceType,
  type OntologyEntityBinding,
  type DaSource,
} from '../_family-utils';
import {
  cellKey, getCell, rowTotal, periodTotal, grandTotal,
  cloneScenarioCells, dropScenarioCells, computeVariance, newId,
  defaultScenarios, defaultPlanningSheet,
  flattenPlanCells, filterPlanRows, sortPlanRows,
  periodSeries, forecastPeriods, linearFit, ganttLayout, planInsights,
  applyMappingsToActuals,
  // EPM core — cube model, member hierarchies, roll-ups, guided formulas.
  emptyPlanModel, defaultPlanModel, orderMembers,
  orderedLineItems, lineItemValueAt, lineItemRowTotal, leafInputItems,
  evalFormula, formulaToText, validateModel, validateFormulaRows,
  qfSum, qfAverage, qfDifference, qfRatioPct, qfGrowthPct,
  type PlanScenario, type PlanScenarioKind,
  type PlanningSheet, type PlanSemanticModelRef, type PlanBackingDb,
  type PlanCellRow, type PlanRowSortKey, type PeriodPoint, type GanttBar,
  type PlanSourceMapping, type PlanLineItem,
  type PlanModel, type PlanDimension, type PlanMember, type PlanMeasure,
  type PlanAggKind, type PlanDimensionAxis, type PlanFormulaToken,
  type PlanFormulaFn, type PlanFormulaOp, type ModelIssue,
} from '../_plan-model';
import { arr, useItemState, SaveBar, useStyles } from './shared';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
// `referencedVariableTokens` extracts every @{variables.NAME} reference from a
// text blob — used below to tell the user EXACTLY which names Resolve could
// not find, instead of a silent verbatim echo (#3575). expandVariables()
// itself is correct (unknown refs stay verbatim by design); the UI just never
// surfaced which refs those were.
import { referencedVariableTokens } from '@/lib/variables/resolve';

// ----- Variable Library (Cosmos, typed key/value with value sets) -----
// v3.27: extended to Fabric's 7 variable types — String/Integer/Number/
// Boolean/DateTime/Guid/ItemReference/ConnectionReference. Plus the
// Loom-native `secret-ref` for KV / env-var lookups.
// `VarType` is imported from `_family-utils` (see the top-of-file
// import block — it matches the vitest contract).
interface VarDef { name: string; type: VarType; default: string; dev?: string; test?: string; prod?: string; description?: string; }
// `activeValueSet` mirrors Fabric's per-workspace active value set (settings.json).
interface VlState { variables: VarDef[]; activeValueSet?: string; [k: string]: unknown }
const VL_VALUE_SETS: Array<'default' | 'dev' | 'test' | 'prod'> = ['default', 'dev', 'test', 'prod'];

const VAR_TYPE_LABELS: Record<VarType, string> = {
  string: 'String',
  integer: 'Integer',
  number: 'Number',
  bool: 'Boolean',
  datetime: 'DateTime',
  guid: 'Guid',
  'item-ref': 'ItemReference',
  'connection-ref': 'ConnectionReference',
  'secret-ref': 'SecretReference',
};
const VAR_TYPE_PLACEHOLDERS: Record<VarType, string> = {
  string: '',
  integer: '0',
  number: '0.0',
  bool: 'true | false',
  datetime: 'YYYY-MM-DDThh:mm:ssZ',
  guid: '00000000-0000-0000-0000-000000000000',
  'item-ref': 'Loom item id (Cosmos)',
  'connection-ref': 'connection id (ADF Linked Service / Power Platform connection)',
  'secret-ref': 'kv-uri or env var name',
};

// `validateVarValue` is imported from `_family-utils` (see top-of-file
// imports — vitest coverage at `lib/editors/__tests__/family-utils.test.ts`).

/** First occurrence per key, in source order. */
function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The reference syntax to quote back at the user. `VAR_REF` accepts BOTH
 * `@{variables.NAME}` and `${variables.NAME}`, so hard-coding `@{…}` in the
 * warning tells a user who wrote `${…}` that a form they did not use was left
 * verbatim — a small R7 violation of the same kind as the banner itself.
 * Echo the sigil(s) actually present, and only those.
 */
function refSyntaxHint(refs: string[]): string {
  const at = refs.some((r) => r.startsWith('@'));
  const dollar = refs.some((r) => r.startsWith('$'));
  if (at && dollar) return '@{variables.NAME} / ${variables.NAME}';
  return dollar ? '${variables.NAME}' : '@{variables.NAME}';
}

/** Comma-separated `<code>` list — one element per name so specs can match a name exactly. */
function NameList({ names }: { names: string[] }) {
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>
          <code>{n}</code>{i < names.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  );
}

export function VariableLibraryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty, lastSaveError } = useItemState<VlState>('variable-library', id, {
    variables: [
      { name: 'ENV', type: 'string', default: 'dev' },
      { name: 'BatchSize', type: 'number', default: '5000' },
      { name: 'EnableCopilot', type: 'bool', default: 'true' },
    ],
  });
  const [tab, setTab] = useState<typeof VL_VALUE_SETS[number]>('default');
  // v3.28 Phase 4.5: functional setState so concurrent edits + the auto-reload
  // from useItemState's PATCH response don't clobber rapid typing.
  const update = (idx: number, patch: Partial<VarDef>) => {
    setState((prev) => {
      const next = [...arr<VarDef>(prev.variables)];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, variables: next };
    });
  };
  const addRow = () => setState((prev) => {
    const cur = arr<VarDef>(prev.variables);
    return { ...prev, variables: [...cur, { name: `var${cur.length + 1}`, type: 'string', default: '' }] };
  });
  const deleteRow = (idx: number) => setState((prev) => ({
    ...prev,
    variables: arr<VarDef>(prev.variables).filter((_, i) => i !== idx),
  }));
  const valueKey = tab === 'default' ? 'default' : tab;

  // Resolve panel — calls the real dereference layer (/resolve), which pulls
  // secret-ref variables out of Key Vault and expands @{variables.NAME}.
  type ResolvedVarRow = { name: string; type: string; value: string; secret: boolean; resolvedFromKv?: boolean; error?: string };
  const [resolved, setResolved] = useState<ResolvedVarRow[] | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [expandText, setExpandText] = useState('@{variables.ENV}/batch?size=@{variables.BatchSize}');
  const [expandOut, setExpandOut] = useState<string | null>(null);
  // Names referenced in the resolved text that came back verbatim because no
  // matching variable existed in the resolved set — the ONLY signal that told
  // #3575's reporter Resolve wasn't a no-op. Populated only after a Resolve
  // click resolves (never on mount — a freshly created item must show no
  // banners per ux-baseline.md's "clean first-open" rule). Each entry carries
  // the reference VERBATIM so the copy can echo the sigil the user actually
  // wrote (`${…}` is as valid as `@{…}`) rather than asserting one of the two.
  const [unresolvedRefs, setUnresolvedRefs] = useState<Array<{ name: string; ref: string }>>([]);
  // References whose NAME `expandVariables()` can never match (`Order-Count`,
  // `2fa`, an empty name). These are reported separately because saving the
  // library cannot fix them — claiming otherwise would be the same false cause
  // this banner exists to remove (deploy-integrity.md R7).
  const [invalidRefs, setInvalidRefs] = useState<string[]>([]);
  // The value set the banner above is ALLOWED to name. It is the one the server
  // actually resolved against (the route echoes it back), NOT the live `tab` —
  // nothing disables the ribbon/TabList while a resolve is in flight, and
  // switching tabs afterwards does not re-resolve, so rendering `tab` would
  // assert "no variable named X exists in the prod value set" about a set that
  // was never diffed (deploy-integrity.md R7 — a message states only what the
  // code established).
  const [resolvedValueSet, setResolvedValueSet] = useState<string | null>(null);
  // Monotonic resolve id. A response may only write state if it is still the
  // LATEST request — otherwise a slow earlier call lands after a newer one and
  // repaints the banner from a library state that has since been superseded
  // (e.g. "X is not in the saved library" about an X the newer resolve just
  // proved IS saved). That is the same R7 false-cause this banner exists to
  // remove, so the ordering guard belongs here and not only on the buttons:
  // `disabled` closes the click path, this closes the in-flight path.
  const resolveSeq = useRef(0);
  // A soft-navigation between two items of the same type changes `id` WITHOUT
  // remounting this editor: app/items/[type]/[id]/page.tsx renders
  // `<Editor item={item} id={id} …/>` with no `key={id}`, which is precisely
  // why useItemState's own load effect is keyed on `[slug, id]`. Every piece of
  // Resolve output below therefore belongs to the PREVIOUS id and must be
  // dropped, or the next library opens carrying another item's warning banner
  // (ux-baseline.md — no error banners on a freshly opened, untouched item).
  useEffect(() => {
    // Bump FIRST: any resolve still in flight belongs to the previous item and
    // is now abandoned, so its response must not land on this one.
    resolveSeq.current += 1;
    setResolved(null);
    setResolveErr(null);
    setExpandOut(null);
    setUnresolvedRefs([]);
    setInvalidRefs([]);
    setResolvedValueSet(null);
    // The abandoned request will never clear this itself (its `finally` is
    // seq-guarded), and leaving it true would wedge Resolve on the new item.
    setResolveBusy(false);
  }, [id]);
  const runResolve = useCallback(async () => {
    if (id === 'new') { setResolveErr('Save the library before resolving.'); return; }
    const seq = resolveSeq.current + 1;
    resolveSeq.current = seq;
    setResolveBusy(true); setResolveErr(null); setUnresolvedRefs([]); setInvalidRefs([]); setResolvedValueSet(null);
    const textSent = expandText;
    const valueSetSent = tab;
    try {
      const r = await clientFetch(`/api/items/variable-library/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ valueSet: valueSetSent, text: textSent }),
      });
      const j = await r.json();
      // Superseded while in flight — drop the whole response. Writing ANY of it
      // (expanded, resolved, or the banner) would mix two different reads of
      // the library into one surface.
      if (seq !== resolveSeq.current) return;
      if (!j.ok) { setResolveErr(j.error || 'resolve failed'); setResolved([]); return; }
      const resolvedList: ResolvedVarRow[] = j.resolved || [];
      setResolved(resolvedList);
      setExpandOut(j.expanded ?? null);
      // Prefer the value set the ROUTE reports it resolved against — it applies
      // its own allow-list fallback — and fall back to the one this call posted.
      // Both are facts this call established; the live `tab` is not.
      setResolvedValueSet(typeof j.valueSet === 'string' ? j.valueSet : valueSetSent);
      // Diff what was REFERENCED in the input against what actually came back
      // resolved — anything referenced but absent from the resolved set is
      // exactly what expandVariables() left verbatim.
      const resolvedNames = new Set(resolvedList.map((rv) => rv.name));
      const tokens = referencedVariableTokens(textSent);
      // Split BEFORE the resolved-set diff: a reference whose name the
      // expansion regex rejects was never a candidate for substitution, so
      // "it isn't in the resolved set" is true but irrelevant — the reason it
      // came back verbatim is the name shape, and that is what we must say.
      // De-duplicated by NAME like the group below, so the title's count means
      // the same thing for every group: `@{variables.a-b} ${variables.a-b}` is
      // ONE unresolved variable, not two. The first ref seen is what we show.
      setInvalidRefs(dedupeBy(tokens.filter((t) => !t.substitutable), (t) => t.name).map((t) => t.ref));
      // De-duplicated NAMES — `@{variables.X}@{variables.X}` is one variable.
      setUnresolvedRefs(
        dedupeBy(
          tokens.filter((t) => t.substitutable && !resolvedNames.has(t.name)),
          (t) => t.name,
        ).map((t) => ({ name: t.name, ref: t.ref })),
      );
    } catch (e: any) {
      if (seq !== resolveSeq.current) return;
      setResolveErr(e?.message || String(e)); setResolved([]);
    } finally {
      // Only the LATEST request owns the busy flag — an abandoned earlier call
      // clearing it would re-enable Resolve while a newer one is still running.
      if (seq === resolveSeq.current) setResolveBusy(false);
    }
  }, [id, tab, expandText]);

  // ---- Why a reference came back verbatim: THREE distinct causes -----------
  // Resolve reads COSMOS (app/api/items/variable-library/[id]/resolve/route.ts
  // → loadOwnedItem), never this editor's in-memory table. useItemState seeds
  // `state` from a client-side `fallback` whose sample rows (ENV / BatchSize /
  // EnableCopilot) are NOT persisted until the user saves, and a freshly
  // created library's `state` is `{}` — so on EVERY new library the table shows
  // three variables the resolver has never seen (#3687, systemic across the
  // editors sharing this hook).
  //
  // The old copy collapsed that into "No variable named ENV exists in the
  // default value set" printed directly under a table row named ENV: a cause
  // the code never established, contradicted by what the user is looking at
  // (deploy-integrity.md R7). Splitting against the LOCAL table is what makes
  // each sentence true, and it is computed at RENDER time so the banner
  // re-classifies itself the moment the user adds the row or saves.
  const localNames = useMemo(
    () => new Set(arr<VarDef>(state.variables).map((v) => v.name)),
    [state.variables],
  );
  /** In the table the user is looking at, but absent from the SAVED library. */
  const unsavedRefs = useMemo(() => unresolvedRefs.filter((u) => localNames.has(u.name)), [unresolvedRefs, localNames]);
  /** Not in the table either — genuinely undefined, or a typo. */
  const unknownRefs = useMemo(() => unresolvedRefs.filter((u) => !localNames.has(u.name)), [unresolvedRefs, localNames]);
  const unresolvedCount = unresolvedRefs.length + invalidRefs.length;

  /**
   * G2 Fix-it #1 — the library is what Resolve reads, so persist the table and
   * re-run in one click rather than telling the user to go do it.
   */
  const saveAndResolve = useCallback(async () => {
    const ok = await save();
    if (!ok) {
      // Say what actually happened. Re-resolving after a failed save would
      // reproduce the identical banner and read as the button doing nothing.
      setResolveErr(lastSaveError() || 'Save failed — the library was not saved, so Resolve would return the same result.');
      return;
    }
    await runResolve();
  }, [save, lastSaveError, runResolve]);

  /**
   * G2 Fix-it #2 — add a row PRE-NAMED for each reference that resolved to
   * nothing, so the user only supplies the value. `addRow()`'s generic `varN`
   * would not match the reference and so would not clear the warning.
   */
  const addUnknownRows = useCallback((names: string[]) => {
    setState((prev) => {
      const cur = arr<VarDef>(prev.variables);
      const have = new Set(cur.map((v) => v.name));
      const add = names.filter((n) => !have.has(n)).map((n): VarDef => ({ name: n, type: 'string', default: '' }));
      return add.length ? { ...prev, variables: [...cur, ...add] } : prev;
    });
  }, [setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Variables', actions: [
        { label: 'New variable', onClick: addRow },
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
      { label: 'Value sets', actions: [
        { label: 'dev', onClick: () => setTab('dev'), appearance: tab === 'dev' ? 'primary' : 'subtle' },
        { label: 'test', onClick: () => setTab('test'), appearance: tab === 'test' ? 'primary' : 'subtle' },
        { label: 'prod', onClick: () => setTab('prod'), appearance: tab === 'prod' ? 'primary' : 'subtle' },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, tab, addRow]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            {VL_VALUE_SETS.map((v) => <Tab key={v} value={v}>{v}</Tab>)}
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          {/* Teaching banner (SC-6) — Fabric-grade guidance, keyed per surface with
              a persistent dismiss and a Learn-more link (UX-409). */}
          <TeachingBanner
            surfaceKey="variable-library-authoring"
            title="Parameterize once, switch per environment"
            message="Define typed variables and give each a value per value set (default / dev / test / prod). Reference them as @{variables.NAME} in pipelines and notebooks; secret-ref variables resolve from Key Vault at runtime."
            learnMoreHref="https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview"
          />
          <MessageBar intent="info">
            <MessageBarBody>
              Reference variables in pipelines / notebooks as <code>@{'{'}variables.NAME{'}'}</code>. The active value set is resolved at runtime by the executor.
            </MessageBarBody>
          </MessageBar>
          {/* Active value set — mirrors Fabric's per-workspace active set. The
              runtime executor reads state.activeValueSet to resolve values. */}
          <Field label="Active value set (resolved at runtime)">
            <Dropdown
              value={state.activeValueSet || 'default'}
              selectedOptions={[state.activeValueSet || 'default']}
              onOptionSelect={(_, d) => d.optionValue && setState((p) => ({ ...p, activeValueSet: d.optionValue }))}
            >
              {VL_VALUE_SETS.map((v) => <Option key={v} value={v}>{`${v}${v === (state.activeValueSet || 'default') ? ' (active)' : ''}`}</Option>)}
            </Dropdown>
          </Field>
          {arr<VarDef>(state.variables).length === 0 ? (
            <GuidedEmptyState
              heroIcon={Cube20Regular}
              title="No variables yet"
              intro="Add a typed variable, then give it a value for each value set. Reference it as @{variables.NAME} from pipelines, notebooks, and dataflows."
              columns={1}
              paths={[{
                key: 'add-variable',
                title: 'Add your first variable',
                body: 'Create a typed key/value entry (String, Integer, Boolean, DateTime, Guid, references, or a Key Vault secret-ref).',
                icon: Add20Regular,
                onClick: addRow,
              }]}
              learnMoreHref="https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview"
              ariaLabel="Variable library empty state"
            />
          ) : (
          <Table aria-label="Variables" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Value ({tab})</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell />
            </TableRow></TableHeader>
            <TableBody>
              {arr<VarDef>(state.variables).map((v, i) => {
                const val = (v as any)[valueKey] ?? '';
                const validationErr = validateVarValue(v.type, val);
                return (
                  <TableRow key={i}>
                    <TableCell><Input value={v.name} onChange={(_, d) => update(i, { name: d.value })} /></TableCell>
                    <TableCell>
                      <select value={v.type} onChange={(e) => update(i, { type: e.target.value as VarType })}
                        style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                        {Object.entries(VAR_TYPE_LABELS).map(([t, label]) => (
                          <option key={t} value={t}>{label}</option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                        <Input value={val} onChange={(_, d) => update(i, { [valueKey]: d.value } as any)}
                          placeholder={VAR_TYPE_PLACEHOLDERS[v.type]} />
                        {validationErr && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{validationErr}</Caption1>}
                      </div>
                    </TableCell>
                    <TableCell><Input value={v.description ?? ''} onChange={(_, d) => update(i, { description: d.value })} placeholder="optional" /></TableCell>
                    <TableCell><Button size="small" onClick={() => deleteRow(i)}>Delete</Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          )}
          <Button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ New variable</Button>

          {/* Resolve / dereference — the real substitution layer. */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalM }}><Play20Regular className={s.secHeadIcon} /><Subtitle2>Resolve values ({tab})</Subtitle2></div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Resolves every variable for the <strong>{tab}</strong> value set and expands <code>@{'{'}variables.NAME{'}'}</code> below.
            <code> secret-ref</code> variables are dereferenced from Key Vault (value masked).
          </Caption1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Textarea value={expandText} onChange={(_, d) => setExpandText(d.value)} rows={2} placeholder="@{variables.ENV}/path" />
            {/* `saving` gates this too: Save-and-resolve leaves `saving` true
                while `resolveBusy` is still false, and a Resolve fired in that
                window runs against the PRE-save library — whose response would
                then claim a just-saved variable "is not in the saved library". */}
            <Button appearance="primary" onClick={runResolve} disabled={resolveBusy || saving || id === 'new'} style={{ alignSelf: 'flex-start' }}>
              {resolveBusy ? 'Resolving…' : 'Resolve'}
            </Button>
            {resolveErr && <MessageBar intent="error"><MessageBarBody>{resolveErr}</MessageBarBody></MessageBar>}
            {expandOut != null && (
              <>
                <Caption1>Expanded</Caption1>
                <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 120 }}>{expandOut || '(empty)'}</div>
              </>
            )}
            {/* Gated on `resolvedValueSet` as well as the names: the banner
                names a value set, so it may not render before the resolve that
                established which one. Each paragraph below states ONE cause and
                only that cause — see the three-way split above. */}
            {unresolvedCount > 0 && resolvedValueSet && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>
                    {/* De-duplicated NAMES, not reference occurrences —
                        `@{variables.X}@{variables.X}` is one variable. */}
                    {unresolvedCount === 1 ? '1 variable left unresolved' : `${unresolvedCount} variables left unresolved`}
                  </MessageBarTitle>
                  {unsavedRefs.length > 0 && (
                    <div>
                      <NameList names={unsavedRefs.map((u) => u.name)} />{' '}
                      {unsavedRefs.length === 1 ? 'is' : 'are'} in the table above but not in the <strong>saved</strong> library.
                      Resolve runs against the saved copy, so {unsavedRefs.length === 1 ? 'its' : 'their'}{' '}
                      <code>{refSyntaxHint(unsavedRefs.map((u) => u.ref))}</code> reference{unsavedRefs.length === 1 ? ' was' : 's were'} left
                      verbatim in the expanded text above. Save the library, then resolve again.
                    </div>
                  )}
                  {unknownRefs.length > 0 && (
                    <div>
                      No variable named <NameList names={unknownRefs.map((u) => u.name)} /> exists in the{' '}
                      <strong>{resolvedValueSet}</strong> value set, so {unknownRefs.length === 1 ? 'its' : 'their'}{' '}
                      <code>{refSyntaxHint(unknownRefs.map((u) => u.ref))}</code> reference{unknownRefs.length === 1 ? ' was' : 's were'} left
                      verbatim in the expanded text above. Add {unknownRefs.length === 1 ? 'it' : 'them'} to the table and save, or check the name for a typo.
                    </div>
                  )}
                  {invalidRefs.length > 0 && (
                    <div>
                      <NameList names={invalidRefs} /> {invalidRefs.length === 1 ? 'is not a valid reference' : 'are not valid references'} —
                      a variable name must start with a letter or underscore and contain only letters, digits and underscores.
                      Saving the library cannot fix {invalidRefs.length === 1 ? 'this one' : 'these'}: the name shape alone is why{' '}
                      {invalidRefs.length === 1 ? 'it was' : 'they were'} left verbatim. Rename the variable and the reference
                      (for example <code>Order_Count</code> rather than <code>Order-Count</code>).
                    </div>
                  )}
                </MessageBarBody>
                {/* G2 — an inline Fix-it per cause, never a bare remediation
                    paragraph. Both actions are things the platform can do. */}
                {(unsavedRefs.length > 0 || unknownRefs.length > 0) && (
                  <MessageBarActions>
                    {unsavedRefs.length > 0 && (
                      <Button appearance="transparent" icon={<Save16Regular />} disabled={saving || resolveBusy} onClick={saveAndResolve}>
                        {saving ? 'Saving…' : 'Save and resolve'}
                      </Button>
                    )}
                    {unknownRefs.length > 0 && (
                      <Button appearance="transparent" icon={<Add16Regular />} onClick={() => addUnknownRows(unknownRefs.map((u) => u.name))}>
                        {unknownRefs.length === 1 ? 'Add it to the table' : 'Add them to the table'}
                      </Button>
                    )}
                  </MessageBarActions>
                )}
              </MessageBar>
            )}
            {resolved && resolved.length > 0 && (
              <Table size="small" aria-label="Resolved values">
                <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Resolved value</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {resolved.map((rv) => (
                    <TableRow key={rv.name}>
                      <TableCell><strong>{rv.name}</strong></TableCell>
                      <TableCell>{rv.type}{rv.secret && rv.resolvedFromKv ? <> <Badge appearance="tint" color="success">Key Vault</Badge></> : null}</TableCell>
                      <TableCell style={{ fontFamily: 'monospace' }}>
                        {rv.error ? <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{rv.error}</Caption1> : (rv.value || '(empty)')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
      </>
    } />
  );
}

