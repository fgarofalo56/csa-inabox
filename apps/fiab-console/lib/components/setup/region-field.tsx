/**
 * RegionField — the wizard's region picker.
 *
 * Extracted from `lib/panes/setup-wizard.tsx`, where it was the one leaf
 * component in that file's tail that was already decoupled from the wizard's
 * own `useStyles` (it took `styles` as a prop, while `Footer` and `SummaryCell`
 * call `useStyles()` internally and would have needed the wizard to export its
 * style hook — an import cycle, which is worse than a long file).
 *
 * Its siblings already live here: `plan-review-step.tsx`,
 * `planner-step-bodies.tsx`. This one had simply been left behind in the
 * monolith.
 *
 * The `styles` prop is now typed STRUCTURALLY (`{ inlineLoad: string }`) rather
 * than as `ReturnType<typeof useStyles>`. That was the only remaining tie back
 * to the wizard module, and it named the entire style sheet to consume one
 * class — so the narrower type is both the decoupling and an honest statement
 * of what this component actually reads.
 *
 * BEHAVIOUR IS UNCHANGED. In particular the control stays a CLOSED dropdown:
 * `loom_no_freeform_config` / `.claude/rules` forbid a free-text box for a
 * value with a known, enumerable set. The hint distinguishes a live ARM
 * `/locations` list from the static per-boundary fallback, because "these are
 * the regions your subscription actually has" and "these are the regions this
 * cloud generally has" are different claims (deploy-integrity R7).
 */
'use client';

import * as React from 'react';
import { Caption1, Dropdown, Field, Option, Spinner } from '@fluentui/react-components';
import type { AzureRegion } from '@/lib/azure/azure-regions';

export function RegionField(props: {
  /** Only `inlineLoad` is read — see the module note on the structural type. */
  styles: { inlineLoad: string };
  regions: AzureRegion[];
  regionsLoading: boolean;
  regionSource: 'arm' | 'static';
  value?: string;
  isGov: boolean;
  onSelect: (v: string) => void;
}) {
  const { styles, regions, regionsLoading, regionSource, value, isGov, onSelect } = props;
  const selected = value ? regions.find((r) => r.name === value) : undefined;
  return (
    <Field
      label="Region"
      required
      hint={
        regionsLoading
          ? 'Loading regions…'
          : regionSource === 'arm'
            ? "Live list of regions enabled for the selected subscription (Azure Resource Manager)."
            : isGov
              ? 'Azure Government regions for this boundary.'
              : 'Azure Public regions for this boundary.'
      }
    >
      {regionsLoading ? (
        <div className={styles.inlineLoad}><Spinner size="tiny" /> <Caption1>Listing regions…</Caption1></div>
      ) : (
        <Dropdown
          placeholder="Select region"
          value={selected ? `${selected.display} (${selected.name})` : value}
          selectedOptions={value ? [value] : []}
          onOptionSelect={(_, d) => onSelect(d.optionValue as string)}
        >
          {regions.map((r) => (
            <Option key={r.name} value={r.name} text={`${r.display} (${r.name})`}>
              {r.display} — {r.name}
            </Option>
          ))}
        </Dropdown>
      )}
    </Field>
  );
}
