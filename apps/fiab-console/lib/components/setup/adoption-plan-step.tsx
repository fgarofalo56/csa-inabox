/**
 * AdoptionPlanStep — the wizard's discovery result + per-service
 * adopt / deploy-new / skip decision surface (deploy-integrity.md R5.2–R5.5;
 * design §2.5–§2.7, §3).
 *
 * WHAT THIS SURFACE HAS TO GET RIGHT, and how:
 *
 *  R5.2 "present each candidate with what Loom would use it for and what it
 *       would CHANGE about it" — every row carries `usedFor`, and an adopt
 *       decision expands to the service's `mutations` list. An operator
 *       adopting a production Databricks workspace sees "assigns the workspace
 *       to a Unity Catalog metastore" BEFORE the deploy, not after.
 *
 *  R5.3 "ask per service: use the existing one, or deploy new? Never silently
 *       adopt, and never silently duplicate" — three explicit modes per row,
 *       pre-set to a recommendation that always shows its reason.
 *
 *  R5.5 "accept supplied values as a first-class input path" — every row, in
 *       every outcome, offers "I have one". Typed coordinates flow through the
 *       identical validation path as a discovered candidate, so brownfield does
 *       not depend on the scan having been able to see everything.
 *
 *  R7 — the three no-candidate outcomes are rendered as three different
 *       sentences and can never collapse:
 *         · none exist        "No existing X was found in any subscription you selected"
 *         · could not look    "No X was found, but N subscriptions could not be read"
 *         · not adoptable     the service's create-only reason, verbatim
 *
 * A KNOWN-IMPOSSIBLE CHOICE IS DISABLED, NOT OFFERED. A second Enterprise
 * Purview fails deterministically with EnterpriseTenantAlreadyExists, so
 * "Deploy new" on a tenant that has one is disabled with that explanation
 * rather than offered and then failed mid-deploy.
 *
 * Fluent v9 + Loom tokens only; no hard-coded px or hex (web3-ui.md).
 */
'use client';

import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Subtitle2,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  Checkmark16Filled,
  Dismiss16Regular,
  Info16Regular,
  LockClosed16Regular,
  Search24Regular,
} from '@fluentui/react-icons';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { EmptyState } from '@/lib/components/empty-state';
import { DiscoveryLedger } from './discovery-ledger';
import {
  allowedModes,
  candidateToTarget,
  noCandidateSentence,
  recommendFor,
  type AdoptionCandidate,
  type ServiceScanRow,
} from '@/lib/deploy/plan-builder';
import {
  coverageSummary,
  type DeploymentPlan,
  type ServiceMode,
  type ServiceTarget,
  type SubscriptionScanResult,
} from '@/lib/deploy/plan-model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL, minWidth: 0 },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    rowGap: tokens.spacingVerticalS,
  },
  list: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, minWidth: 0, overflowY: 'auto' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
    minWidth: 0,
  },
  cardHead: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'flex-start',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
  },
  title: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  // flexWrap + minWidth:0 so a badge row can never overlap at any width.
  badges: { display: 'flex', columnGap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  seg: {
    display: 'inline-flex',
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
  },
  segBtn: {
    border: 'none',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  segBtnOn: { backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand },
  segBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke2}`,
  },
  manual: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(0, 200px))',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
    alignItems: 'end',
  },
  mutations: { margin: 0, paddingLeft: tokens.spacingHorizontalL },
  dd: { minWidth: 0 },
});

export interface AdoptionPlanStepProps {
  /** null until the scan has run. */
  ledger: SubscriptionScanResult[] | null;
  rows: ServiceScanRow[] | null;
  plan: DeploymentPlan | null;
  loading: boolean;
  /** Honest error from the scan call itself — rendered, never swallowed. */
  error?: { title: string; message: string } | null;
  hubRegion: string;
  onRescan: () => void;
  onDecide: (serviceKey: string, mode: ServiceMode, target?: ServiceTarget) => void;
  /** Subscriptions the operator consented to, so manual coordinates use a picker. */
  scopeSubscriptions: { subscriptionId: string; displayName: string }[];
}

/** Which badge a row's recommendation earns. */
function recBadge(rec: 'adopt' | 'create' | 'adopt-required'): { text: string; color: 'brand' | 'informative' | 'important' } {
  if (rec === 'adopt-required') return { text: 'Must reuse', color: 'important' };
  if (rec === 'adopt') return { text: 'Reuse recommended', color: 'brand' };
  return { text: 'Deploy new', color: 'informative' };
}

export function AdoptionPlanStep(props: AdoptionPlanStepProps) {
  const styles = useStyles();
  const { ledger, rows, plan, loading, error, hubRegion, onRescan, onDecide, scopeSubscriptions } = props;
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});
  const [manualDraft, setManualDraft] = useState<Record<string, { name: string; rg: string; sub: string }>>({});

  const summary = ledger ? coverageSummary(ledger) : null;
  const adoptable = useMemo(() => (rows ?? []).filter((r) => r.candidates.length > 0).length, [rows]);

  const setManual = useCallback((key: string, patch: Partial<{ name: string; rg: string; sub: string }>) => {
    setManualDraft((d) => {
      const prev = d[key] ?? { name: '', rg: '', sub: '' };
      return { ...d, [key]: { ...prev, ...patch } };
    });
  }, []);

  if (loading) {
    return (
      <div className={styles.root}>
        <Spinner label="Analysing the subscriptions you selected…" />
        <Caption1>
          Loom is probing each subscription for readability, then running one Azure Resource Graph query across
          the ones it can read.
        </Caption1>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.root}>
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>{error.title}</MessageBarTitle>
            {error.message}
          </MessageBarBody>
        </MessageBar>
        <div>
          <Button appearance="primary" icon={<ArrowClockwise20Regular />} onClick={onRescan}>
            Run the analysis again
          </Button>
        </div>
        {ledger && ledger.length > 0 && <DiscoveryLedger ledger={ledger} />}
      </div>
    );
  }

  if (!ledger || !rows || !plan) {
    // First open of an untouched step is guided, never an error banner
    // (ux-baseline.md "clean first-open").
    return (
      <div className={styles.root}>
        <EmptyState
          icon={<Search24Regular />}
          title="Ready to analyse your Azure estate"
          body="Loom will read the subscriptions you selected and offer you any existing service it could use instead of deploying a duplicate. Nothing is written."
          primaryAction={{ label: 'Run the analysis', onClick: onRescan }}
        />
      </div>
    );
  }

  const nothingAdoptable = adoptable === 0;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <div>
          <Subtitle2>
            {nothingAdoptable
              ? 'Nothing adoptable was found — this will be a fresh deployment'
              : `${adoptable} service${adoptable === 1 ? '' : 's'} already exist that Loom can use`}
          </Subtitle2>
          <Caption1>
            {nothingAdoptable
              ? `Loom will deploy all ${rows.length} backing services new. Every row is still switchable — if you have a service Loom could not see, use “I have one”.`
              : 'Keep the recommendation, choose a different instance, or deploy new. Nothing here is applied until you review the plan on the next step.'}
          </Caption1>
        </div>
        <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={onRescan}>
          Re-run analysis
        </Button>
      </div>

      {/* G3: the coverage ledger and the decision list are independently
          resizable, persisted under a stable sizingKey. */}
      <SplitPane
        direction="vertical"
        defaultSize="38%"
        minSize={140}
        storageKey="setup-adoption-plan"
        dividerLabel="Resize the coverage table"
      >
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          <DiscoveryLedger ledger={ledger} />
        </div>

        <div className={styles.list}>
          {rows.map((row) => {
            const key = row.service.key;
            const decision = plan.services[key];
            const rec = recommendFor(row, hubRegion);
            const modes = allowedModes(row, !!row.service.class && row.service.class !== 'create-only');
            const mode: ServiceMode = decision?.mode ?? 'create';
            const badge = recBadge(rec.recommendation);
            const noCand = noCandidateSentence(row, decision ?? { mode: 'create', source: 'default', decidedBy: '', decidedAt: '' }, ledger);
            const draft = manualDraft[key] ?? { name: '', rg: '', sub: '' };
            const manualReady = draft.name.trim() && draft.rg.trim() && draft.sub.trim();

            return (
              <div key={key} className={styles.card}>
                <div className={styles.cardHead}>
                  <div style={{ minWidth: 0 }}>
                    <div className={styles.title}>
                      <Body1Strong>{row.service.label}</Body1Strong>
                      <div className={styles.badges}>
                        <Badge appearance="tint" color={badge.color} size="small">
                          {badge.text}
                        </Badge>
                        {row.service.class === 'create-only' && (
                          <Badge appearance="outline" size="small" icon={<LockClosed16Regular />}>
                            Loom deploys its own
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Caption1>{row.service.usedFor}</Caption1>
                  </div>

                  <div className={styles.seg} role="group" aria-label={`${row.service.label} decision`}>
                    <Tooltip
                      content={modes.adoptDisabledReason ?? (row.candidates.length === 0 ? 'Nothing was discovered — use “I have one” to point at an existing resource.' : 'Bind Loom to an existing instance.')}
                      relationship="description"
                    >
                      <button
                        type="button"
                        className={`${styles.segBtn} ${mode === 'adopt' ? styles.segBtnOn : ''} ${!modes.adopt || (row.candidates.length === 0 && !decision?.target) ? styles.segBtnDisabled : ''}`}
                        aria-pressed={mode === 'adopt'}
                        disabled={!modes.adopt || (row.candidates.length === 0 && !decision?.target)}
                        onClick={() => {
                          const idx = rec.candidateIndex ?? 0;
                          const c = decision?.target ? undefined : row.candidates[idx];
                          onDecide(key, 'adopt', decision?.target ?? (c ? candidateToTarget(c) : undefined));
                        }}
                      >
                        Use existing
                      </button>
                    </Tooltip>
                    <Tooltip content={modes.createDisabledReason ?? 'Loom deploys a new one.'} relationship="description">
                      <button
                        type="button"
                        className={`${styles.segBtn} ${mode === 'create' ? styles.segBtnOn : ''} ${!modes.create ? styles.segBtnDisabled : ''}`}
                        aria-pressed={mode === 'create'}
                        disabled={!modes.create}
                        onClick={() => onDecide(key, 'create')}
                      >
                        Deploy new
                      </button>
                    </Tooltip>
                    <Tooltip content="Neither deploy nor bind. The surfaces that need it will explain what is missing." relationship="description">
                      <button
                        type="button"
                        className={`${styles.segBtn} ${mode === 'skip' ? styles.segBtnOn : ''} ${!modes.skip ? styles.segBtnDisabled : ''}`}
                        aria-pressed={mode === 'skip'}
                        disabled={!modes.skip}
                        onClick={() => onDecide(key, 'skip')}
                      >
                        Skip
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {/* The recommendation always shows its reason — never a bare label. */}
                <Caption1>
                  <Info16Regular style={{ verticalAlign: 'text-bottom' }} /> {rec.reason}
                </Caption1>

                {/* The three no-candidate outcomes, kept apart in prose. */}
                {row.candidates.length === 0 && noCand && (
                  <Caption1>{noCand}</Caption1>
                )}

                {mode === 'adopt' && row.candidates.length > 0 && (
                  <Field label="Which one" hint="Only resources Loom could actually read are listed.">
                    <Dropdown
                      className={styles.dd}
                      value={decision?.target?.name ?? ''}
                      selectedOptions={decision?.target?.name ? [decision.target.name] : []}
                      onOptionSelect={(_e, d) => {
                        const c = row.candidates.find((x: AdoptionCandidate) => x.name === d.optionValue);
                        if (c) onDecide(key, 'adopt', candidateToTarget(c));
                      }}
                    >
                      {row.candidates.map((c: AdoptionCandidate) => (
                        <Option key={c.id || `${c.subscriptionId}/${c.resourceGroup}/${c.name}`} value={c.name} text={c.name}>
                          {c.name} · {c.resourceGroup || '—'} · {c.location} · {c.subscriptionName}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                )}

                {mode === 'adopt' && decision?.target && (
                  <div className={styles.detail}>
                    <Body1Strong>What Loom will change about {decision.target.name}</Body1Strong>
                    {row.service.mutations.length === 0 ? (
                      <Caption1>Nothing — Loom only reads this resource.</Caption1>
                    ) : (
                      <ul className={styles.mutations}>
                        {row.service.mutations.map((m) => (
                          <li key={m}>
                            <Caption1>{m}</Caption1>
                          </li>
                        ))}
                      </ul>
                    )}
                    {row.service.roleName && (
                      <Caption1>
                        Loom will grant its managed identity <b>{row.service.roleName}</b> on this resource. If it
                        cannot, it will tell you the exact role and scope instead of failing mid-deploy.
                      </Caption1>
                    )}
                  </div>
                )}

                {/* R5.5 — supplying values is a first-class input path, offered on
                    EVERY row in EVERY outcome, not an undocumented env override. */}
                {row.service.class !== 'create-only' && (
                  <div>
                    {!manualOpen[key] ? (
                      <Button
                        appearance="subtle"
                        size="small"
                        onClick={() => setManualOpen((o) => ({ ...o, [key]: true }))}
                      >
                        I have one — point Loom at it
                      </Button>
                    ) : (
                      <div className={styles.detail}>
                        <div className={styles.manual}>
                          <Field label="Subscription">
                            <Dropdown
                              className={styles.dd}
                              value={scopeSubscriptions.find((s) => s.subscriptionId === draft.sub)?.displayName ?? ''}
                              selectedOptions={draft.sub ? [draft.sub] : []}
                              onOptionSelect={(_e, d) => setManual(key, { sub: d.optionValue })}
                            >
                              {scopeSubscriptions.map((s) => (
                                <Option key={s.subscriptionId} value={s.subscriptionId} text={s.displayName}>
                                  {s.displayName}
                                </Option>
                              ))}
                            </Dropdown>
                          </Field>
                          <Field label="Resource group">
                            <Input value={draft.rg} onChange={(_e, d) => setManual(key, { rg: d.value })} />
                          </Field>
                          <Field label="Resource name">
                            <Input value={draft.name} onChange={(_e, d) => setManual(key, { name: d.value })} />
                          </Field>
                        </div>
                        <Caption1>
                          These are typed rather than picked because Loom could not read the scope they live in —
                          it has nothing to offer you a list from. They are validated exactly like a discovered
                          resource before anything is deployed.
                        </Caption1>
                        <div style={{ display: 'flex', columnGap: tokens.spacingHorizontalS }}>
                          <Button
                            appearance="primary"
                            size="small"
                            icon={<Checkmark16Filled />}
                            disabled={!manualReady}
                            onClick={() => {
                              onDecide(key, 'adopt', { name: draft.name.trim(), rg: draft.rg.trim(), sub: draft.sub });
                              setManualOpen((o) => ({ ...o, [key]: false }));
                            }}
                          >
                            Use this one
                          </Button>
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<Dismiss16Regular />}
                            onClick={() => setManualOpen((o) => ({ ...o, [key]: false }))}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SplitPane>

      {summary?.incomplete && (
        <Caption1>
          Because part of the estate could not be read, some rows above say &quot;not found in what Loom could
          read&quot;. That is deliberate — Loom does not claim a service is absent from a subscription it never
          opened.
        </Caption1>
      )}
    </div>
  );
}

export default AdoptionPlanStep;
