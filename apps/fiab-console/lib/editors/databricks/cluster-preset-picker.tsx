'use client';

/**
 * ClusterPresetPicker — the tiered, best-practice SIZE picker shown when
 * creating a new Databricks cluster in the cluster editor. Cards for each
 * CLUSTER_TIER (XS single-node … XL Photon) with a size + relative-cost hint,
 * plus a workload-flavor toggle (Interactive vs Jobs). Picking a card applies
 * the tier's shape + curated spark_conf + Loom tags to the editor form via
 * onApply — the expert can then fine-tune every field below (advanced override).
 *
 * No freeform JSON (loom-no-freeform-config): the picker is structured cards +
 * a toggle. Web3/UX baseline: TileGrid + elevated cards + icons + LearnPopover.
 */

import * as React from 'react';
import {
  Card, Text, Subtitle2, Body1, Caption1, Badge, Radio, RadioGroup, Field,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Laptop20Regular, Cube20Regular, DataBarVertical20Regular,
  Server20Regular, Storage20Regular, Flash16Regular, Timer16Regular,
} from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { CLUSTER_TIERS, type ClusterTier, type WorkloadFlavor } from '@/lib/databricks/cluster-presets';

const TIER_ICON: Record<string, React.ReactElement> = {
  'std-xs-single-node': <Laptop20Regular />,
  'std-s': <Cube20Regular />,
  'std-m-photon': <DataBarVertical20Regular />,
  'std-l-photon': <Server20Regular />,
  'std-xl-photon': <Storage20Regular />,
};

const useStyles = makeStyles({
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  headerText: { flex: 1, minWidth: 0 },
  flavor: { marginTop: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalS },
  card: {
    cursor: 'pointer',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, border-color, transform',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardSelected: {
    boxShadow: tokens.shadow16,
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    outlineOffset: '-1px',
  },
  cardTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  icon: { color: tokens.colorBrandForeground1, display: 'flex' },
  cost: { marginLeft: 'auto', color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold, letterSpacing: '1px' },
  size: { color: tokens.colorNeutralForeground3 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXXS },
  when: { color: tokens.colorNeutralForeground3 },
});

function sizeLine(t: ClusterTier): string {
  if (t.singleNode) return 'Single node · driver only';
  return `Autoscale ${t.minWorkers}–${t.maxWorkers} workers · ${t.nodeTypeId}`;
}

export interface ClusterPresetPickerProps {
  /** Currently-applied tier id (highlights the card). */
  selectedTierId?: string | null;
  flavor: WorkloadFlavor;
  onFlavorChange: (f: WorkloadFlavor) => void;
  /** Apply a tier's shape + confs to the editor form. */
  onApply: (tier: ClusterTier, flavor: WorkloadFlavor) => void;
}

export function ClusterPresetPicker({ selectedTierId, flavor, onFlavorChange, onApply }: ClusterPresetPickerProps) {
  const s = useStyles();
  return (
    <div>
      <div className={s.header}>
        <Subtitle2 className={s.headerText}>Start from a sized preset</Subtitle2>
        <LearnPopover
          title="Best-practice cluster sizes"
          content="Pick a T-shirt-sized, pre-configured cluster instead of hand-filling every field. Each tier sets a right-sized node type, autoscale bounds, Photon where it pays, an always-on auto-terminate window, and a curated Spark config (Adaptive Query Execution, skew-join handling). You can fine-tune everything below after applying."
          tips={[
            'XS single node — dev, tests, small data',
            'S — interactive analytics & light ETL',
            'M/L/XL Photon — production ETL, big shuffles, ML',
            'Interactive = all-purpose; Jobs = spot workers + tighter auto-terminate',
          ]}
          learnMoreHref="https://learn.microsoft.com/azure/databricks/compute/cluster-config-best-practices"
        />
      </div>
      <Field label="Workload" className={s.flavor} hint="Interactive clusters stay warm for exploration; Jobs clusters use fault-tolerant Spot workers and auto-terminate sooner.">
        <RadioGroup layout="horizontal" value={flavor} onChange={(_, d) => onFlavorChange(d.value as WorkloadFlavor)}>
          <Radio value="interactive" label="Interactive" />
          <Radio value="jobs" label="Jobs (batch)" />
        </RadioGroup>
      </Field>
      <TileGrid minTileWidth={240}>
        {CLUSTER_TIERS.map((t) => {
          const selected = t.id === selectedTierId;
          return (
            <Card
              key={t.id}
              className={mergeClasses(s.card, selected && s.cardSelected)}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`Apply ${t.label} preset`}
              onClick={() => onApply(t, flavor)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onApply(t, flavor); } }}
            >
              <div className={s.cardTop}>
                <span className={s.icon}>{TIER_ICON[t.id]}</span>
                <Text weight="semibold">{t.label}</Text>
                <span className={s.cost} aria-label={`relative cost ${t.costHint.length} of 5`}>{t.costHint}</span>
              </div>
              <Caption1 className={s.size}>{sizeLine(t)}</Caption1>
              <Body1>{t.summary}</Body1>
              <div className={s.badges}>
                {t.photon && <Badge appearance="tint" color="brand" icon={<Flash16Regular />}>Photon</Badge>}
                <Badge appearance="tint" color="informative" icon={<Timer16Regular />}>
                  {t.autoterminationMinutes}m auto-terminate
                </Badge>
              </div>
              <Caption1 className={s.when}>{t.whenToUse}</Caption1>
            </Card>
          );
        })}
      </TileGrid>
    </div>
  );
}
