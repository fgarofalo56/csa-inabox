/**
 * SetupServiceChoices — the Setup Wizard's pre-deploy scan-and-choose step.
 *
 * The in-console twin of `scripts/csa-loom/scan-and-deploy.sh`: it calls
 * GET /api/setup/discover-services (Azure Resource Graph over every visible
 * subscription) and renders, per Loom-integrable Azure service, a 3-way choice
 * — **Use existing / New / Disable** — defaulted to the route's RECOMMENDATION.
 * The operator confirms the wiring before the deploy, so a fresh deploy is
 * everything-ON (opt-out) with reuse where it makes sense.
 *
 * No free-form input (loom-no-freeform-config.md): the choice is a closed
 * SegmentedControl + a Dropdown of discovered candidates — never a text box.
 * No mock data (no-vaporware.md): candidates come straight from Resource Graph;
 * an honest MessageBar renders when the identity can't scan (503 not_configured).
 *
 * Controlled: the parent (setup-wizard) owns the `value` map and gets updates
 * via `onChange`, then threads it into the deploy POST as `serviceChoices`.
 */
'use client';

import * as React from 'react';
import { useEffect, useState, useCallback } from 'react';
import {
  makeStyles,
  tokens,
  Subtitle2,
  Body1,
  Body1Strong,
  Caption1,
  Badge,
  Spinner,
  Dropdown,
  Option,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Button,
} from '@fluentui/react-components';
import { ArrowClockwise20Regular } from '@fluentui/react-icons';

/** One service row returned by GET /api/setup/discover-services. */
export interface DiscoveredService {
  service: string;
  label: string;
  armType: string;
  enableFlag: string | null;
  recommendation: 'new' | 'use-existing';
  recommendedCandidate: number | null;
  candidates: { name: string; rg: string; sub: string; region: string }[];
  envVars: { name: string; rg: string; sub: string };
}

/** The operator's decision for one service. */
export interface ServiceChoice {
  /** 'new' provisions fresh; 'use-existing' reuses a candidate; 'disable' turns the feature off. */
  mode: 'new' | 'use-existing' | 'disable';
  /** When mode='use-existing': the chosen candidate (name/rg/sub). */
  existing?: { name: string; rg: string; sub: string };
}

export type ServiceChoiceMap = Record<string, ServiceChoice>;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rowHead: { display: 'flex', flexDirection: 'column', rowGap: '2px', minWidth: 0 },
  labelLine: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  controls: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', justifyContent: 'flex-end' },
  seg: { display: 'inline-flex', borderRadius: tokens.borderRadiusMedium, overflow: 'hidden', border: `1px solid ${tokens.colorNeutralStroke1}` },
  segBtn: {
    border: 'none',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
  },
  segBtnOn: { backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand },
  segBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  dd: { minWidth: '220px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalM },
});

/** Map the route recommendation → an initial ServiceChoice. */
function initialChoice(svc: DiscoveredService): ServiceChoice {
  if (svc.recommendation === 'use-existing' && svc.recommendedCandidate) {
    const c = svc.candidates[svc.recommendedCandidate - 1];
    if (c) return { mode: 'use-existing', existing: { name: c.name, rg: c.rg, sub: c.sub } };
  }
  return { mode: 'new' };
}

interface Props {
  /** Controlled choice map (service key → choice). */
  value: ServiceChoiceMap;
  /** Called with the full updated map on any change (incl. after the scan loads defaults). */
  onChange: (next: ServiceChoiceMap) => void;
}

export function SetupServiceChoices({ value, onChange }: Props) {
  const styles = useStyles();
  const [services, setServices] = useState<DiscoveredService[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string; missing?: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/discover-services', { cache: 'no-store' });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setError({ message: j.error || `discover-services ${res.status}`, hint: j.hint, missing: j.missing });
        setServices([]);
        return;
      }
      const list = (j.services || []) as DiscoveredService[];
      setServices(list);
      // Seed any not-yet-decided services with their recommended default.
      const next: ServiceChoiceMap = { ...value };
      let changed = false;
      for (const svc of list) {
        if (!next[svc.service]) {
          next[svc.service] = initialChoice(svc);
          changed = true;
        }
      }
      if (changed) onChange(next);
    } catch (e: any) {
      setError({ message: e?.message ?? String(e) });
      setServices([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setMode = (svc: DiscoveredService, mode: ServiceChoice['mode']) => {
    const next: ServiceChoiceMap = { ...value };
    if (mode === 'use-existing') {
      const cur = value[svc.service]?.existing;
      const pick = cur || svc.candidates[(svc.recommendedCandidate || 1) - 1];
      next[svc.service] = { mode, existing: pick ? { name: pick.name, rg: pick.rg, sub: pick.sub } : undefined };
    } else {
      next[svc.service] = { mode };
    }
    onChange(next);
  };

  const setExisting = (svc: DiscoveredService, name: string) => {
    const c = svc.candidates.find((x) => x.name === name);
    if (!c) return;
    onChange({ ...value, [svc.service]: { mode: 'use-existing', existing: { name: c.name, rg: c.rg, sub: c.sub } } });
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <Subtitle2>Scan & choose backends</Subtitle2>
          <Body1 as="p">
            Loom scanned every subscription you can see. The default is everything-ON — keep the recommendation,
            reuse an existing service, or disable what you don&apos;t want. Nothing is left unconfigured.
          </Body1>
        </div>
        <Button
          appearance="subtle"
          icon={<ArrowClockwise20Regular />}
          onClick={() => void load()}
          disabled={loading}
        >
          Re-scan
        </Button>
      </div>

      {loading && <Spinner label="Scanning subscriptions via Azure Resource Graph…" />}

      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Scan unavailable</MessageBarTitle>
            {error.message}
            {error.missing?.length ? <> — missing: {error.missing.join(', ')}.</> : null}
            {error.hint ? <> {error.hint}</> : null} You can still deploy with the everything-NEW default, or run{' '}
            <code>scripts/csa-loom/scan-and-deploy.sh</code> locally with <code>az login</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      {services?.map((svc) => {
        const choice = value[svc.service] ?? initialChoice(svc);
        const hasCandidates = svc.candidates.length > 0;
        const canDisable = !!svc.enableFlag;
        const recLabel =
          svc.recommendation === 'use-existing' && svc.recommendedCandidate
            ? `Reuse ${svc.candidates[svc.recommendedCandidate - 1]?.name ?? 'existing'}`
            : 'New';
        return (
          <div key={svc.service} className={styles.row}>
            <div className={styles.rowHead}>
              <div className={styles.labelLine}>
                <Body1Strong>{svc.label}</Body1Strong>
                <Badge appearance="outline" size="small">
                  Recommended: {recLabel}
                </Badge>
                {svc.service === 'purview' && (
                  <Caption1>Only one Enterprise Purview per tenant — reuse is recommended.</Caption1>
                )}
              </div>
              <Caption1>
                {hasCandidates
                  ? `${svc.candidates.length} existing candidate${svc.candidates.length === 1 ? '' : 's'} found`
                  : 'No existing instance found — a fresh one will be provisioned'}
                {!canDisable ? ' · provisioned with the platform (no disable toggle)' : ''}
              </Caption1>
            </div>

            <div className={styles.controls}>
              <div className={styles.seg} role="group" aria-label={`${svc.label} choice`}>
                <button
                  type="button"
                  className={`${styles.segBtn} ${choice.mode === 'use-existing' ? styles.segBtnOn : ''} ${!hasCandidates ? styles.segBtnDisabled : ''}`}
                  onClick={() => hasCandidates && setMode(svc, 'use-existing')}
                  disabled={!hasCandidates}
                  aria-pressed={choice.mode === 'use-existing'}
                >
                  Use existing
                </button>
                <button
                  type="button"
                  className={`${styles.segBtn} ${choice.mode === 'new' ? styles.segBtnOn : ''}`}
                  onClick={() => setMode(svc, 'new')}
                  aria-pressed={choice.mode === 'new'}
                >
                  New
                </button>
                <button
                  type="button"
                  className={`${styles.segBtn} ${choice.mode === 'disable' ? styles.segBtnOn : ''} ${!canDisable ? styles.segBtnDisabled : ''}`}
                  onClick={() => canDisable && setMode(svc, 'disable')}
                  disabled={!canDisable}
                  aria-pressed={choice.mode === 'disable'}
                >
                  Disable
                </button>
              </div>

              {choice.mode === 'use-existing' && hasCandidates && (
                <Dropdown
                  className={styles.dd}
                  aria-label={`${svc.label} existing instance`}
                  value={choice.existing?.name ?? ''}
                  selectedOptions={choice.existing?.name ? [choice.existing.name] : []}
                  onOptionSelect={(_e, d) => d.optionValue && setExisting(svc, d.optionValue)}
                >
                  {svc.candidates.map((c) => (
                    <Option key={`${c.sub}/${c.rg}/${c.name}`} value={c.name} text={c.name}>
                      {c.name} · {c.rg || '—'}
                    </Option>
                  ))}
                </Dropdown>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SetupServiceChoices;
