'use client';

/**
 * CapacityEquivalencePanel — guided F-SKU → Azure-native compute mapping.
 *
 * Rendered in the Setup Wizard's "Capacity sizing" step (and reusable on the
 * Admin → Capacity page). For the selected F-SKU it shows:
 *   - the Microsoft-official equivalences (CU, Spark vCores, Warehouse SQL
 *     vCores, Power BI v-cores), badged "Microsoft-official" with a Learn link;
 *   - the Loom sizing guidelines (Databricks worker shape, ADX cluster SKU,
 *     Synapse dedicated SQL DWU), badged "Loom guideline";
 *   - a relative cost tier + a deep link to the official Fabric Capacity
 *     Estimator (no fabricated dollar amounts — per no-vaporware.md).
 *
 * Pure presentation over `getCapacityEquivalence` — no backend call.
 */

import * as React from 'react';
import {
  Body1,
  Body1Strong,
  Caption1,
  Subtitle2,
  Badge,
  Link,
  MessageBar,
  MessageBarBody,
  Divider,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { getCapacityEquivalence, CAPACITY_LEARN_REFS } from '@/lib/setup/capacity-equivalence';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalL,
  },
  headerRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  groupHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalXS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalM,
  },
  cell: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  iconChip: {
    width: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusSmall,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cellBody: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  cellLabel: { color: tokens.colorNeutralForeground3 },
  costRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  pips: { display: 'inline-flex', gap: '3px', alignItems: 'center' },
  pip: { width: '10px', height: '10px', borderRadius: '2px', backgroundColor: tokens.colorNeutralStroke2 },
  pipOn: { backgroundColor: tokens.colorBrandBackground },
  learnRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
});

/** A single label/value metric cell with an optional service icon. */
function Metric({ label, value, itemType }: { label: string; value: string; itemType?: string }) {
  const styles = useStyles();
  const v = itemType ? itemVisual(itemType) : undefined;
  const Icon = v?.icon;
  return (
    <div className={styles.cell}>
      {Icon && (
        <span className={styles.iconChip} style={{ backgroundColor: `${v!.color}1f`, color: v!.color }} aria-hidden>
          <Icon />
        </span>
      )}
      <div className={styles.cellBody}>
        <Caption1 className={styles.cellLabel}>{label}</Caption1>
        <Body1Strong>{value}</Body1Strong>
      </div>
    </div>
  );
}

export function CapacityEquivalencePanel({ sku }: { sku?: string }) {
  const styles = useStyles();
  const eq = sku ? getCapacityEquivalence(sku) : null;

  if (!eq) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>Select a capacity above to see the Azure-native compute it provisions.</MessageBarBody>
      </MessageBar>
    );
  }

  const pbi = eq.powerBiVCores < 1 ? eq.powerBiVCores.toFixed(2) : String(eq.powerBiVCores);

  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <Subtitle2>What {eq.sku} provisions</Subtitle2>
        <Badge appearance="tint" color="brand">{eq.cu} Capacity Units</Badge>
      </div>

      {/* ── Microsoft-official equivalences ─────────────────────────────── */}
      <div>
        <div className={styles.groupHead}>
          <Body1Strong>Compute equivalence</Body1Strong>
          <Badge appearance="filled" color="success" size="small">Microsoft-official</Badge>
        </div>
        <div className={styles.grid}>
          <Metric label="Fabric Capacity Units" value={`${eq.cu} CU`} />
          <Metric label="Synapse Spark (CU × 2)" value={`${eq.sparkVCores} vCores`} itemType="synapse-spark-pool" />
          <Metric label="Warehouse SQL" value={`${eq.warehouseSqlVCoresPerSec} vCores/sec`} itemType="warehouse" />
          <Metric label="Power BI (CU ÷ 8)" value={`${pbi} v-cores`} itemType="semantic-model" />
        </div>
      </div>

      <Divider />

      {/* ── Loom sizing guidelines ──────────────────────────────────────── */}
      <div>
        <div className={styles.groupHead}>
          <Body1Strong>Recommended Azure-native resources</Body1Strong>
          <Badge appearance="tint" color="warning" size="small">Loom sizing guideline</Badge>
        </div>
        <div className={styles.grid}>
          <Metric label="Databricks" value={eq.databricksGuideline} itemType="databricks-cluster" />
          <Metric label="Azure Data Explorer (ADX)" value={eq.adxGuideline} itemType="kql-database" />
          <Metric label="Synapse dedicated SQL" value={eq.synapseDwuGuideline} itemType="synapse-dedicated-sql-pool" />
        </div>
      </div>

      {/* ── Cost ────────────────────────────────────────────────────────── */}
      <div className={styles.costRow}>
        <Caption1 className={styles.cellLabel}>Relative cost</Caption1>
        <span className={styles.pips} aria-label={`Relative cost tier ${eq.costTier} of 5`}>
          {[1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={`${styles.pip} ${i <= eq.costTier ? styles.pipOn : ''}`} aria-hidden />
          ))}
        </span>
        <Link href={CAPACITY_LEARN_REFS.estimator} target="_blank">
          Estimate exact cost in the Fabric Capacity Estimator <Open16Regular />
        </Link>
      </div>

      <MessageBar intent="warning">
        <MessageBarBody>
          Databricks DBU and ADX cluster SKUs have <strong>no official Fabric F-SKU equivalence</strong> — the
          recommended resources above are Loom sizing guidelines derived from the official Spark-vCore figure. Use
          the <Link href={CAPACITY_LEARN_REFS.estimator} target="_blank">Fabric Capacity Estimator</Link> and{' '}
          <Link href={CAPACITY_LEARN_REFS.azurePricing} target="_blank">Azure pricing</Link> for authoritative sizing
          and cost. CU figures are official (<Link href={CAPACITY_LEARN_REFS.planCapacity} target="_blank">plan-capacity</Link>,{' '}
          <Link href={CAPACITY_LEARN_REFS.optimizeCapacity} target="_blank">Spark vCores</Link>,{' '}
          <Link href={CAPACITY_LEARN_REFS.licenses} target="_blank">Power BI v-cores</Link>).
        </MessageBarBody>
      </MessageBar>
    </div>
  );
}
