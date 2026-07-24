/**
 * N4 part 2 — the plan/apply wizard.
 *
 * Three guided steps, dropdowns and pickers only (per `loom_no_freeform_config`
 * — the model SQL on the Build tab is the ONE freeform surface):
 *
 *   1. Environment  — pick the virtual data environment (SQLMesh) or dbt target
 *                     to plan against. Real environments come from the engine's
 *                     own state store via POST /api/transform/[id]/environments.
 *   2. Impact       — the diff grid: model, change type, breaking /
 *                     non-breaking, downstream blast radius, and the
 *                     column-level changes. Nothing has been written yet.
 *   3. Apply        — SQLMesh: the virtual-environment VIEW SWAP + only the
 *                     intervals that need backfilling. dbt: `dbt build` over the
 *                     modified models and their downstream (stated plainly).
 *                     Production requires an explicit second confirmation.
 *
 * First open is CLEAN: an unplanned project shows a guided EmptyState, never a
 * red banner. Errors only appear after an action actually fails.
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Checkbox, Divider, Dropdown, Field,
  MessageBar, MessageBarBody, MessageBarTitle, Option, Spinner, Subtitle2,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Tag, TagGroup,
  Text, makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  ArrowSyncCheckmark20Regular, Beaker20Regular, CheckmarkCircle20Regular,
  Play20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import type {
  ColumnImpact, ImpactRow, ImpactSeverity, PlanImpact,
} from '@/lib/transform/plan-impact';
import type { TransformBackend, TransformProject } from '@/lib/transform/transform-project-model';

const SEVERITY_META: Record<ImpactSeverity, {
  label: string; color: 'danger' | 'warning' | 'success' | 'informative'; hint: string;
}> = {
  breaking: {
    label: 'Breaking', color: 'danger',
    hint: 'A column was removed or retyped (or the model was removed). Downstream models must be rebuilt and consumers may break.',
  },
  'forward-only': {
    label: 'Forward-only', color: 'warning',
    hint: 'Applies to new data only — existing history is left as-is and nothing is backfilled.',
  },
  'non-breaking': {
    label: 'Additive', color: 'success',
    hint: 'Additive change. Downstream models keep their data; only this model rebuilds.',
  },
  metadata: {
    label: 'Metadata', color: 'informative',
    hint: 'Description / owner / tag change only. Nothing rebuilds.',
  },
};

const CHANGE_LABEL: Record<ImpactRow['changeType'], string> = {
  added: 'Added', modified: 'Modified', removed: 'Removed',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  steps: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center', minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    boxShadow: tokens.shadow4,
  },
  toolbar: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center', minWidth: 0 },
  summary: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0 },
  grid: { overflowX: 'auto', minWidth: 0 },
  cellStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  tags: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  field: { minWidth: '260px', maxWidth: '420px' },
});

/** Row of the environment picker — merges declared + engine-materialized envs. */
interface EnvOption {
  name: string;
  isProd: boolean;
  /** True when the engine's state store already has it. */
  materialized: boolean;
  models?: number;
  description?: string;
}

export interface PlanApplyWizardProps {
  itemId: string;
  project: TransformProject;
  backend: TransformBackend;
  /** Deployed-state dbt artifacts from the last apply (the plan diffs against them). */
  previousManifest?: unknown;
  previousCatalog?: unknown;
  /** Bubbles a fresh plan up so the host can paint the DAG + persist artifacts. */
  onPlanned?: (impact: PlanImpact, artifacts: { manifest?: unknown; catalog?: unknown }) => void;
  onApplied?: (impact: PlanImpact, artifacts: { manifest?: unknown; catalog?: unknown }) => void;
}

function columnSummary(columns: ColumnImpact[]): string {
  if (columns.length === 0) return 'No column metadata';
  const added = columns.filter((c) => c.change === 'added').length;
  const removed = columns.filter((c) => c.change === 'removed').length;
  const retyped = columns.filter((c) => c.change === 'type-changed').length;
  return [
    added ? `+${added}` : '',
    removed ? `-${removed}` : '',
    retyped ? `~${retyped}` : '',
  ].filter(Boolean).join(' ') || 'No column change';
}

export function PlanApplyWizard({
  itemId, project, backend, previousManifest, previousCatalog, onPlanned, onApplied,
}: PlanApplyWizardProps) {
  const s = useStyles();
  const declared = project.environments || [];
  const [environment, setEnvironment] = useState<string>(project.defaultEnvironment || 'dev');
  const [engineEnvs, setEngineEnvs] = useState<EnvOption[] | null>(null);
  const [envNote, setEnvNote] = useState<string | null>(null);
  const [impact, setImpact] = useState<PlanImpact | null>(null);
  const [busy, setBusy] = useState<'plan' | 'apply' | 'env' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; note?: string; log?: string } | null>(null);
  const [confirmProd, setConfirmProd] = useState(false);

  const options: EnvOption[] = useMemo(() => {
    const map = new Map<string, EnvOption>();
    for (const d of declared) {
      map.set(d.name, {
        name: d.name, isProd: !!d.isProd || d.name === 'prod',
        materialized: false, description: d.description,
      });
    }
    for (const e of engineEnvs || []) {
      map.set(e.name, { ...(map.get(e.name) || e), ...e, materialized: true });
    }
    return [...map.values()].sort((a, b) => Number(b.isProd) - Number(a.isProd) || a.name.localeCompare(b.name));
  }, [declared, engineEnvs]);

  const selected = options.find((o) => o.name === environment) || null;
  const isProd = !!selected?.isProd;

  const loadEnvironments = useCallback(async () => {
    setBusy('env'); setError(null);
    try {
      const r = await clientFetch(`/api/transform/${encodeURIComponent(itemId)}/environments`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'environment list failed'));
      setEngineEnvs((Array.isArray(j.environments) ? j.environments : []).map((e: Record<string, unknown>) => ({
        name: String(e.name), isProd: !!e.isProd, materialized: true,
        models: typeof e.models === 'number' ? e.models : undefined,
      })));
      setEnvNote(typeof j.note === 'string' ? j.note : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [itemId, project]);

  const runPlan = useCallback(async () => {
    setBusy('plan'); setError(null); setApplyResult(null);
    try {
      const r = await clientFetch(`/api/transform/${encodeURIComponent(itemId)}/plan`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, environment, previousManifest, previousCatalog }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'plan failed'));
      setImpact(j.impact as PlanImpact);
      onPlanned?.(j.impact as PlanImpact, { manifest: j.manifest, catalog: j.catalog });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [itemId, project, environment, previousManifest, previousCatalog, onPlanned]);

  const runApply = useCallback(async () => {
    setBusy('apply'); setError(null);
    try {
      const r = await clientFetch(`/api/transform/${encodeURIComponent(itemId)}/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, environment, confirmProd: isProd ? confirmProd : undefined }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'apply failed'));
      setApplyResult({ ok: true, note: j.note, log: j.log });
      if (j.impact) setImpact(j.impact as PlanImpact);
      onApplied?.(j.impact as PlanImpact, { manifest: j.manifest, catalog: j.catalog });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApplyResult({ ok: false });
    } finally { setBusy(null); }
  }, [itemId, project, environment, isProd, confirmProd, onApplied]);

  const canApply = !!impact && impact.hasChanges && busy === null && (!isProd || confirmProd);

  return (
    <div className={s.root}>
      {/* ── Step 1 — environment ───────────────────────────────────────── */}
      <div className={s.card}>
        <div className={s.steps}>
          <Badge appearance="filled" color="brand">1</Badge>
          <Subtitle2>Environment</Subtitle2>
          <Caption1 className={s.muted}>
            {backend === 'sqlmesh'
              ? 'A SQLMesh virtual environment is a set of views over shared physical tables — creating one is a view swap, not a rebuild.'
              : 'dbt has targets rather than virtual environments. Planning compares the compiled project against the deployed-state manifest.'}
          </Caption1>
        </div>
        <div className={s.toolbar}>
          <Field label="Plan against" className={s.field}>
            <Dropdown
              value={environment}
              selectedOptions={[environment]}
              onOptionSelect={(_e, d) => { setEnvironment(String(d.optionValue)); setImpact(null); setConfirmProd(false); setApplyResult(null); }}
              aria-label="Environment to plan against"
            >
              {options.map((o) => (
                <Option key={o.name} value={o.name} text={o.name}>
                  {o.name}
                  {o.isProd ? ' — production' : ''}
                  {o.materialized ? ` (${o.models ?? 0} models materialized)` : ' (not created yet — planning creates it)'}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Button
            appearance="secondary"
            icon={busy === 'env' ? <Spinner size="tiny" /> : <ArrowSyncCheckmark20Regular />}
            onClick={loadEnvironments}
            disabled={busy !== null}
          >
            Refresh from engine
          </Button>
        </div>
        {selected?.description && <Caption1 className={s.muted}>{selected.description}</Caption1>}
        {envNote && (
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>{envNote}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      {/* ── Step 2 — impact ────────────────────────────────────────────── */}
      <div className={s.card}>
        <div className={s.steps}>
          <Badge appearance="filled" color="brand">2</Badge>
          <Subtitle2>Impact</Subtitle2>
          <Caption1 className={s.muted}>Planning writes nothing. Review before you apply.</Caption1>
        </div>
        <div className={s.toolbar}>
          <Button
            appearance="primary"
            icon={busy === 'plan' ? <Spinner size="tiny" /> : <Beaker20Regular />}
            onClick={runPlan}
            disabled={busy !== null}
          >
            {busy === 'plan' ? 'Planning…' : 'Plan'}
          </Button>
          {impact && (
            <Caption1 className={s.muted}>
              {impact.engine === 'sqlmesh' ? 'SQLMesh' : 'dbt'} · {impact.environment}
            </Caption1>
          )}
        </div>

        {error && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Could not complete that step</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        )}

        {!impact && !error && (
          <EmptyState
            icon={<Beaker20Regular />}
            title="No plan yet"
            body="Choose an environment and select Plan. Loom compiles the project and shows every model that would change — whether the change is breaking or additive, which columns move, and how far downstream it propagates. Nothing is written to the warehouse until you apply."
            primaryAction={{ label: 'Plan', onClick: runPlan, appearance: 'primary' }}
          />
        )}

        {impact && !impact.hasChanges && (
          <MessageBar intent="success" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>No changes</MessageBarTitle>
              {`"${impact.environment}" already matches the project. There is nothing to apply.`}
            </MessageBarBody>
          </MessageBar>
        )}

        {impact?.noDeployedState && (
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>First plan for this project</MessageBarTitle>
              There is no deployed-state manifest to compare against yet, so every model reads as
              added. After the first apply, plans diff against what is actually deployed.
            </MessageBarBody>
          </MessageBar>
        )}

        {impact && impact.hasChanges && (
          <>
            <div className={s.summary}>
              <Badge appearance="tint" color="danger">{impact.summary.breaking} breaking</Badge>
              <Badge appearance="tint" color="success">{impact.summary.nonBreaking} additive</Badge>
              {impact.summary.forwardOnly > 0 && <Badge appearance="tint" color="warning">{impact.summary.forwardOnly} forward-only</Badge>}
              {impact.summary.metadata > 0 && <Badge appearance="tint" color="informative">{impact.summary.metadata} metadata</Badge>}
              <Badge appearance="outline">{impact.summary.added} added</Badge>
              <Badge appearance="outline">{impact.summary.modified} modified</Badge>
              <Badge appearance="outline">{impact.summary.removed} removed</Badge>
              <Badge appearance="outline">{impact.summary.downstreamImpacted} downstream impacted</Badge>
              {impact.summary.backfillIntervals > 0 && (
                <Badge appearance="outline">{impact.summary.backfillIntervals} intervals to backfill</Badge>
              )}
            </div>
            <div className={s.grid}>
              <Table size="small" aria-label="Plan impact">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Model</TableHeaderCell>
                    <TableHeaderCell>Change</TableHeaderCell>
                    <TableHeaderCell>Impact</TableHeaderCell>
                    <TableHeaderCell>Downstream</TableHeaderCell>
                    <TableHeaderCell>Columns</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {impact.rows.map((row) => {
                    const meta = SEVERITY_META[row.severity];
                    return (
                      <TableRow key={`${row.model}:${row.changeType}`}>
                        <TableCell>
                          <div className={s.cellStack}>
                            <Body1>{row.model}</Body1>
                            {!row.direct && <Caption1 className={s.muted}>Affected downstream</Caption1>}
                          </div>
                        </TableCell>
                        <TableCell>{CHANGE_LABEL[row.changeType]}</TableCell>
                        <TableCell>
                          <div className={s.cellStack}>
                            <Badge size="small" appearance="tint" color={meta.color} title={meta.hint}>
                              {meta.label}
                            </Badge>
                            {row.engineCategory && (
                              <Caption1 className={s.muted}>{row.engineCategory}</Caption1>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className={s.cellStack}>
                            <Text>{row.downstreamCount}</Text>
                            {row.downstream.length > 0 && (
                              <Caption1 className={s.muted} title={row.downstream.join(', ')}>
                                {row.downstream.slice(0, 3).join(', ')}
                                {row.downstream.length > 3 ? ` +${row.downstream.length - 3}` : ''}
                              </Caption1>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className={s.cellStack}>
                            <Text>{columnSummary(row.columns)}</Text>
                            {row.columns.length > 0 && (
                              <TagGroup className={s.tags} aria-label={`${row.model} column changes`}>
                                {row.columns.slice(0, 4).map((c) => (
                                  <Tag
                                    key={`${c.name}:${c.change}`}
                                    size="extra-small"
                                    appearance={c.change === 'removed' ? 'filled' : 'outline'}
                                    title={c.change === 'type-changed' ? `${c.fromType} → ${c.toType}` : (c.toType || c.fromType || c.change)}
                                  >
                                    {c.change === 'added' ? '+' : c.change === 'removed' ? '−' : '~'}{c.name}
                                  </Tag>
                                ))}
                                {row.columns.length > 4 && (
                                  <Tag size="extra-small" appearance="outline">+{row.columns.length - 4}</Tag>
                                )}
                              </TagGroup>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      {/* ── Step 3 — apply ─────────────────────────────────────────────── */}
      <div className={s.card}>
        <div className={s.steps}>
          <Badge appearance="filled" color="brand">3</Badge>
          <Subtitle2>Apply</Subtitle2>
          <Caption1 className={s.muted}>
            {backend === 'sqlmesh'
              ? 'Swaps the environment\'s views onto the new model versions and backfills only the intervals the plan listed.'
              : 'dbt has no view swap: apply runs `dbt deps` + `dbt build` over the modified models and their downstream.'}
          </Caption1>
        </div>
        {impact && impact.summary.breaking > 0 && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{impact.summary.breaking} breaking change{impact.summary.breaking === 1 ? '' : 's'}</MessageBarTitle>
              A column was removed or retyped (or a model was removed). Downstream models rebuild and
              consumers reading the old contract may break. Review the Impact grid before applying.
            </MessageBarBody>
          </MessageBar>
        )}
        {isProd && (
          <Checkbox
            checked={confirmProd}
            onChange={(_e, d) => setConfirmProd(!!d.checked)}
            label={`I understand this changes production ("${environment}").`}
          />
        )}
        <div className={s.toolbar}>
          <Button
            appearance="primary"
            icon={busy === 'apply' ? <Spinner size="tiny" /> : <Play20Regular />}
            onClick={runApply}
            disabled={!canApply}
          >
            {busy === 'apply' ? 'Applying…' : `Apply to ${environment}`}
          </Button>
          {!impact && <Caption1 className={s.muted}>Run a plan first.</Caption1>}
          {impact && !impact.hasChanges && <Caption1 className={s.muted}>Nothing to apply.</Caption1>}
          {isProd && !confirmProd && impact?.hasChanges && (
            <Caption1 className={s.muted}>Confirm the production checkbox to enable Apply.</Caption1>
          )}
        </div>
        {applyResult?.ok && (
          <MessageBar intent="success" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Applied to {environment}</MessageBarTitle>
              {applyResult.note || 'The environment now matches the project. The plan and its outcome are recorded in the project history and the audit trail.'}
            </MessageBarBody>
          </MessageBar>
        )}
        <Divider />
        <div className={s.steps}>
          {applyResult?.ok
            ? <CheckmarkCircle20Regular aria-hidden />
            : <Warning20Regular aria-hidden />}
          <Caption1 className={s.muted}>
            Every plan you preview and every apply you authorize is written to the project history and
            the audit trail — who, which environment, and the exact impact rows shown here.
          </Caption1>
        </div>
      </div>
    </div>
  );
}
