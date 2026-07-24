'use client';

/**
 * N5 — per-asset FRESHNESS POLICY editor.
 *
 * Four dropdowns and nothing else (loom_no_freeform_config — there is no cron
 * box, no JSON, no free text anywhere on this surface):
 *
 *   Cadence   how often the asset is expected to be materialized
 *   Grace     how long past the cadence is tolerated before it is overdue
 *   Mode      Auto (the reconciler may materialize it) vs Manual
 *   Alert     the O1 severity used when the asset goes overdue
 *
 * Every option set comes from the LEAF model module, so the dropdown values and
 * the server-side `coerceAssetPolicy` validation can never drift.
 *
 * Save is explicit (draft → Save), and the surface opens CLEAN on an asset with
 * no saved policy — a guided caption, never a red banner (ux-baseline).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Body1, Button, Caption1, Divider, Dropdown, Field, Option, Spinner, Subtitle2,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import { CheckmarkCircle20Regular, Clock20Regular } from '@fluentui/react-icons';
import {
  ALERT_OPTIONS, CADENCE_OPTIONS, GRACE_OPTIONS, MODE_OPTIONS,
  type AssetAlertSeverity, type AssetFreshnessPolicy, type FreshnessCadence,
  type FreshnessGrace, type MaterializationMode,
} from '@/lib/azure/asset-registry-model';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    minWidth: 0,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  saved: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteGreenForeground1,
    minWidth: 0,
  },
  card: {
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
});

export interface FreshnessPolicyEditorProps {
  assetKey: string;
  assetName: string;
  /** The asset's current policy (the default when it has none saved yet). */
  policy: AssetFreshnessPolicy;
  /** True once the operator has saved a policy for this asset. */
  configured: boolean;
  /** Declared refresh cadence the N4 model advertised — shown as guidance. */
  cadenceHint?: string;
  /** Persist. Resolves with the saved policy; rejects with an honest message. */
  onSave: (policy: AssetFreshnessPolicy) => Promise<void>;
  disabled?: boolean;
}

function labelOf(options: ReadonlyArray<{ id: string; label: string }>, id: string): string {
  return options.find((o) => o.id === id)?.label ?? id;
}

export function FreshnessPolicyEditor({
  assetKey, assetName, policy, configured, cadenceHint, onSave, disabled,
}: FreshnessPolicyEditorProps) {
  const s = useStyles();
  const [draft, setDraft] = useState<AssetFreshnessPolicy>(policy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-seed when the selection changes so the editor always shows the SELECTED
  // asset's policy, never a stale draft from the previously selected node.
  useEffect(() => {
    setDraft(policy);
    setError(null);
    setSavedAt(null);
  }, [assetKey, policy]);

  const dirty = useMemo(
    () =>
      draft.cadence !== policy.cadence ||
      draft.grace !== policy.grace ||
      draft.mode !== policy.mode ||
      draft.alertSeverity !== policy.alertSeverity,
    [draft, policy],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error)?.message || 'Could not save the freshness policy.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={s.card} aria-label={`Freshness policy for ${assetName}`}>
      <Subtitle2>Freshness policy</Subtitle2>
      {!configured && (
        <Caption1 className={s.hint}>
          This asset has no policy yet. Pick a cadence to start tracking freshness — until then it
          stays <strong>Unmanaged</strong> and is never flagged, alerted, or auto-materialized.
        </Caption1>
      )}
      {cadenceHint && (
        <Caption1 className={s.hint}>
          <Clock20Regular aria-hidden /> The transformation model declares a{' '}
          <code>{cadenceHint}</code> refresh — a matching cadence keeps the policy honest.
        </Caption1>
      )}

      <div className={s.fields}>
        <Field label="Cadence" hint="How often this asset is expected to be materialized.">
          <Dropdown
            aria-label="Freshness cadence"
            disabled={disabled || saving}
            selectedOptions={[draft.cadence]}
            value={labelOf(CADENCE_OPTIONS, draft.cadence)}
            onOptionSelect={(_e, d) =>
              setDraft((p) => ({ ...p, cadence: (d.optionValue as FreshnessCadence) || p.cadence }))
            }
          >
            {CADENCE_OPTIONS.map((o) => (
              <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="Grace" hint="Tolerated lateness before the asset counts as overdue.">
          <Dropdown
            aria-label="Freshness grace"
            disabled={disabled || saving || draft.cadence === 'none'}
            selectedOptions={[draft.grace]}
            value={labelOf(GRACE_OPTIONS, draft.grace)}
            onOptionSelect={(_e, d) =>
              setDraft((p) => ({ ...p, grace: (d.optionValue as FreshnessGrace) || p.grace }))
            }
          >
            {GRACE_OPTIONS.map((o) => (
              <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="Materialization" hint="Whether the reconciler may run this asset for you.">
          <Dropdown
            aria-label="Materialization mode"
            disabled={disabled || saving}
            selectedOptions={[draft.mode]}
            value={labelOf(MODE_OPTIONS, draft.mode)}
            onOptionSelect={(_e, d) =>
              setDraft((p) => ({ ...p, mode: (d.optionValue as MaterializationMode) || p.mode }))
            }
          >
            {MODE_OPTIONS.map((o) => (
              <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="Overdue alert" hint="Routed through the shared Loom action group.">
          <Dropdown
            aria-label="Overdue alert severity"
            disabled={disabled || saving || draft.cadence === 'none'}
            selectedOptions={[draft.alertSeverity]}
            value={labelOf(ALERT_OPTIONS, draft.alertSeverity)}
            onOptionSelect={(_e, d) =>
              setDraft((p) => ({
                ...p,
                alertSeverity: (d.optionValue as AssetAlertSeverity) || p.alertSeverity,
              }))
            }
          >
            {ALERT_OPTIONS.map((o) => (
              <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>
            ))}
          </Dropdown>
        </Field>
      </div>

      <Divider />
      <div className={s.actions}>
        <Button
          appearance="primary"
          disabled={disabled || saving || !dirty}
          onClick={save}
        >
          Save policy
        </Button>
        {saving && <Spinner size="tiny" label="Saving" />}
        {!saving && savedAt !== null && !dirty && (
          <span className={s.saved}>
            <CheckmarkCircle20Regular aria-hidden />
            <Caption1>Policy saved</Caption1>
          </span>
        )}
        {!saving && dirty && <Caption1 className={s.hint}>Unsaved changes</Caption1>}
      </div>
      {error && <Body1 role="alert">{error}</Body1>}
    </div>
  );
}
