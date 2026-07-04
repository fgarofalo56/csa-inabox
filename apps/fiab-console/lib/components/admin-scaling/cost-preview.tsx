'use client';

import { Caption1, tokens, makeStyles } from '@fluentui/react-components';

/**
 * Best-effort monthly cost estimate from a lookup table. The numbers are
 * derived from Azure list prices (East US 2, USD, on-demand). They DO NOT
 * include reserved instance discounts, region differential, or the SLA
 * surcharges (Premium APIM, ADX Optimized AutoScale, etc.) — and the UI
 * surfaces that disclaimer.
 *
 * For exact billing the admin should run the Cost Management cost-analysis
 * blade (link in service-card). Per .claude/rules/no-vaporware.md we keep
 * the data honest — no AI-hallucinated prices.
 */

const PRICE_USD_PER_MONTH: Record<string, Record<string, number>> = {
  'fabric-capacity': {
    F2: 263, F4: 526, F8: 1051, F16: 2103, F32: 4205, F64: 8410, F128: 16819,
    F256: 33638, F512: 67277, F1024: 134554, F2048: 269107,
    P1: 4995, P2: 9990, P3: 19980,
  },
  'synapse-dwu': {
    DW100c: 879, DW200c: 1759, DW300c: 2638, DW400c: 3518, DW500c: 4397,
    DW1000c: 8795, DW1500c: 13193, DW2000c: 17590, DW2500c: 21988,
    DW3000c: 26386, DW5000c: 43976, DW6000c: 52771, DW7500c: 65964,
    DW10000c: 87952, DW15000c: 131928, DW30000c: 263856,
  },
  'adx': {
    'Dev(No SLA)_Standard_E2a_v4': 79,
    'Standard_E2ads_v5': 320, 'Standard_E4ads_v5': 640,
    'Standard_E8ads_v5': 1281, 'Standard_E16ads_v5': 2562,
    'Standard_E64ads_v5': 10247,
  },
  'databricks-warehouse': {
    '2X-Small': 220, 'X-Small': 440, 'Small': 880, 'Medium': 1760, 'Large': 3520,
    'X-Large': 7040, '2X-Large': 14080, '3X-Large': 28160, '4X-Large': 56320,
  },
  'ai-search': {
    free: 0, basic: 76, standard: 251, standard2: 1005, standard3: 4017,
    storage_optimized_l1: 2014, storage_optimized_l2: 4028,
  },
  'apim': {
    Developer: 49, Basic: 152, Standard: 705, Premium: 2796,
    BasicV2: 78, StandardV2: 715, PremiumV2: 2901, Consumption: 0,
  },
};

const useStyles = makeStyles({
  box: {
    padding: '8px 10px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
});

export function CostPreview({
  family, currentSku, targetSku, multiplier,
}: {
  family: keyof typeof PRICE_USD_PER_MONTH;
  currentSku?: string;
  targetSku?: string;
  multiplier?: number;
}) {
  const styles = useStyles();
  const table = PRICE_USD_PER_MONTH[family];
  if (!table) return null;
  const current = currentSku ? table[currentSku] : undefined;
  const target = targetSku ? table[targetSku] : undefined;
  const mult = multiplier && multiplier > 0 ? multiplier : 1;
  const delta = current !== undefined && target !== undefined ? (target - current) * mult : undefined;
  return (
    <div className={styles.box}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Estimated monthly cost (East US 2, list price, USD)
      </Caption1>
      <Caption1>
        Current: {current !== undefined ? `$${(current * mult).toLocaleString()}` : '—'}
        {target !== undefined && (
          <>
            {' '}→ <strong>${(target * mult).toLocaleString()}</strong>
            {delta !== undefined && (
              <span style={{ marginLeft: tokens.spacingHorizontalSNudge, color: delta > 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>
                ({delta > 0 ? '+' : ''}${delta.toLocaleString()}/mo)
              </span>
            )}
          </>
        )}
      </Caption1>
      <Caption1 style={{ color: tokens.colorNeutralForeground3, fontStyle: 'italic' }}>
        Excludes reserved-instance discounts, regional differential, and SLA surcharges.
      </Caption1>
    </div>
  );
}
