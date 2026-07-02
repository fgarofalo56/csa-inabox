'use client';

/**
 * SqlScalePanel — the "Compute & Storage" scale surface for Azure SQL Database,
 * one-for-one with the portal's "Compute + storage" blade (per ui-parity.md).
 *
 * Renders a purchasing-model radio (DTU / vCore provisioned / Serverless),
 * tier + family + capacity dropdowns, a max-storage slider, serverless
 * auto-pause-delay + min-vCore controls, and a directional cost-estimate hint.
 * "Apply" POSTs to /api/items/azure-sql-database/[id]/scale, which performs a
 * REAL ARM PATCH on Microsoft.Sql/servers/databases, polls the LRO to done,
 * and returns a before/after SKU receipt rendered here.
 *
 * The only non-functional state is an honest Fluent MessageBar gate: a 403
 * (UAMI lacks "SQL DB Contributor") surfaces the role to grant / bicep module
 * to deploy. Azure-native only — no Fabric / Power BI dependency.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Field, Dropdown, Option,
  Slider, Label, RadioGroup, Radio,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { TopSpeed20Regular, Save20Regular } from '@fluentui/react-icons';

// ── content-type guarded fetch (mirrors the unified editor's helper) ──
async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(input, init);
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    return {
      ok: false,
      status: r.status,
      error:
        `Expected JSON from ${input} but received ${ct || 'an unknown content type'} (HTTP ${r.status}). ` +
        (r.status === 401 || r.status === 403
          ? 'Your session may have expired — sign in again.'
          : `First bytes: ${text.slice(0, 120)}`),
    };
  }
  try { return await r.json(); }
  catch (e: any) { return { ok: false, status: r.status, error: `Malformed JSON from ${input}: ${e?.message || String(e)}` }; }
}

// ── DTU service objectives (parity with the portal DTU blade) ──
interface DtuSku { skuName: string; dtu: number; maxGb: number }
const DTU_TIERS: Record<string, DtuSku[]> = {
  Basic: [{ skuName: 'Basic', dtu: 5, maxGb: 2 }],
  Standard: [
    { skuName: 'S0', dtu: 10, maxGb: 250 },
    { skuName: 'S1', dtu: 20, maxGb: 250 },
    { skuName: 'S2', dtu: 50, maxGb: 250 },
    { skuName: 'S3', dtu: 100, maxGb: 1024 },
    { skuName: 'S4', dtu: 200, maxGb: 1024 },
    { skuName: 'S6', dtu: 400, maxGb: 1024 },
    { skuName: 'S7', dtu: 800, maxGb: 1024 },
    { skuName: 'S9', dtu: 1600, maxGb: 1024 },
    { skuName: 'S12', dtu: 3000, maxGb: 1024 },
  ],
  Premium: [
    { skuName: 'P1', dtu: 125, maxGb: 1024 },
    { skuName: 'P2', dtu: 250, maxGb: 1024 },
    { skuName: 'P4', dtu: 500, maxGb: 1024 },
    { skuName: 'P6', dtu: 1000, maxGb: 1024 },
    { skuName: 'P11', dtu: 1750, maxGb: 4096 },
    { skuName: 'P15', dtu: 4000, maxGb: 4096 },
  ],
};
const DTU_TIER_NAMES = ['Basic', 'Standard', 'Premium'];

// ── vCore (provisioned) ──
const VCORE_TIERS = ['GeneralPurpose', 'BusinessCritical', 'Hyperscale'];
const VCORE_CAPACITIES = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80];

// ── Serverless (GeneralPurpose only) ──
const SERVERLESS_MAX_VCORES = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40];
const SERVERLESS_MIN_VCORES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24];
const AUTO_PAUSE_OPTIONS = [
  { label: '60 minutes', value: 60 },
  { label: '2 hours', value: 120 },
  { label: '4 hours', value: 240 },
  { label: '8 hours', value: 480 },
  { label: '24 hours', value: 1440 },
  { label: 'Do not auto-pause (disabled)', value: -1 },
];

// ── Max storage (GiB) — common provisioned ceilings ──
const MAX_SIZE_GB_OPTIONS = [1, 2, 5, 10, 20, 32, 50, 100, 150, 200, 250, 500, 1024, 2048, 4096];

// ── Directional monthly cost (Commercial cloud; varies by region) ──
const COST_HINT: Record<string, string> = {
  Basic: '~$4.90/mo',
  S0: '~$14.72/mo', S1: '~$29.43/mo', S2: '~$73.58/mo', S3: '~$147.16/mo',
  S4: '~$294.32/mo', S6: '~$588.64/mo', S7: '~$1,177/mo', S9: '~$2,354/mo', S12: '~$4,414/mo',
  P1: '~$465.11/mo', P2: '~$930.23/mo', P4: '~$1,860/mo', P6: '~$3,721/mo',
  P11: '~$7,001/mo', P15: '~$16,003/mo',
  GP_Gen5_2: '~$369/mo', GP_Gen5_4: '~$738/mo', GP_Gen5_6: '~$1,107/mo', GP_Gen5_8: '~$1,476/mo',
  GP_Gen5_16: '~$2,952/mo', GP_Gen5_32: '~$5,904/mo',
  BC_Gen5_2: '~$1,017/mo', BC_Gen5_4: '~$2,033/mo', BC_Gen5_8: '~$4,067/mo',
  HS_Gen5_2: '~$417/mo + storage', HS_Gen5_4: '~$833/mo + storage',
  GP_S_Gen5_1: '~$0.000145/vCore·s + storage', GP_S_Gen5_2: '~$0.000145/vCore·s + storage',
  GP_S_Gen5_4: '~$0.000145/vCore·s + storage', GP_S_Gen5_8: '~$0.000145/vCore·s + storage',
};

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingVerticalM },
  sliderRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  costRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  receiptGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center', marginTop: tokens.spacingVerticalXS },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
});

export interface SqlScalePanelProps {
  id: string;
  server: string;
  database: string;
  /** Current SKU of the selected database (from the inventory / databases list). */
  currentSku?: { name?: string; tier?: string; family?: string; capacity?: number };
  /** True in Gov clouds (GCC-High / IL5 / DoD) — gates Hyperscale serverless. */
  isGovCloud?: boolean;
}

type Model = 'dtu' | 'vcore' | 'serverless';

interface ScaleReceipt {
  ok?: boolean;
  beforeSku?: { name?: string; tier?: string; family?: string; capacity?: number };
  afterSku?: { name?: string; tier?: string; family?: string; capacity?: number };
  beforeAutoPauseDelay?: number; afterAutoPauseDelay?: number;
  beforeMinCapacity?: number; afterMinCapacity?: number;
  provisioningState?: string;
  lroStatus?: string;
  error?: string;
  hint?: string;
  status?: number;
}

function skuLabel(sku?: { name?: string; tier?: string; capacity?: number }): string {
  if (!sku || !sku.name) return '(none)';
  const cap = typeof sku.capacity === 'number' ? ` · ${sku.capacity}` : '';
  return `${sku.name}${sku.tier ? ` (${sku.tier})` : ''}${cap}`;
}

export function SqlScalePanel({ id, server, database, currentSku, isGovCloud }: SqlScalePanelProps) {
  const s = useStyles();

  const [model, setModel] = useState<Model>('vcore');
  // DTU
  const [dtuTier, setDtuTier] = useState('Standard');
  const [dtuSku, setDtuSku] = useState('S1');
  // vCore
  const [vcoreTier, setVcoreTier] = useState('GeneralPurpose');
  const [vcoreCapacity, setVcoreCapacity] = useState(4);
  // serverless
  const [slMaxVcore, setSlMaxVcore] = useState(4);
  const [slMinVcore, setSlMinVcore] = useState(0.5);
  const [autoPauseDelay, setAutoPauseDelay] = useState(60);
  // storage
  const [maxSizeIdx, setMaxSizeIdx] = useState(8); // default index → 150 GiB
  const maxSizeGb = MAX_SIZE_GB_OPTIONS[maxSizeIdx];

  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ScaleReceipt | null>(null);

  // Resolve the request payload (skuName/tier/family/capacity) for the model.
  const payload = useMemo(() => {
    if (model === 'dtu') {
      const tier = dtuTier;
      return { skuName: dtuSku, tier, family: undefined as string | undefined, capacity: undefined as number | undefined };
    }
    if (model === 'vcore') {
      const prefix = vcoreTier === 'GeneralPurpose' ? 'GP' : vcoreTier === 'BusinessCritical' ? 'BC' : 'HS';
      return { skuName: `${prefix}_Gen5_${vcoreCapacity}`, tier: vcoreTier, family: 'Gen5', capacity: vcoreCapacity };
    }
    // serverless — GeneralPurpose serverless Gen5
    return { skuName: `GP_S_Gen5_${slMaxVcore}`, tier: 'GeneralPurpose', family: 'Gen5', capacity: slMaxVcore };
  }, [model, dtuTier, dtuSku, vcoreTier, vcoreCapacity, slMaxVcore]);

  const costHint = COST_HINT[payload.skuName] ?? 'See Azure SQL Database pricing';

  const applyScale = useCallback(async () => {
    setBusy(true); setReceipt(null);
    const body: any = {
      server, database,
      skuName: payload.skuName,
      tier: payload.tier,
    };
    if (payload.family) body.family = payload.family;
    if (typeof payload.capacity === 'number') body.capacity = payload.capacity;
    if (maxSizeGb) body.maxSizeBytes = maxSizeGb * 1_073_741_824;
    if (model === 'serverless') {
      body.autoPauseDelay = autoPauseDelay;
      body.minCapacity = slMinVcore;
    }
    const r = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/scale`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    setReceipt(r);
    setBusy(false);
  }, [id, server, database, payload, maxSizeGb, model, autoPauseDelay, slMinVcore]);

  const ready = !!server && !!database;
  // Hyperscale serverless auto-pause is unsupported; Gov clouds don't offer HS serverless.
  const hyperscaleServerless = false; // serverless model is GP-only in this surface

  return (
    <div className={s.pad}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Compute &amp; Storage — ARM PATCH Microsoft.Sql/servers/databases</MessageBarTitle>
          Change the purchasing model (DTU / vCore / serverless), tier, compute size, and max storage of a
          live database. Each Apply is a real control-plane PATCH performed as the console UAMI; the operation
          is long-running and the before/after SKU receipt is shown when ARM settles. Requires the UAMI to hold{' '}
          <code>SQL DB Contributor</code> on the server&apos;s resource group.
        </MessageBarBody>
      </MessageBar>

      {!ready && (
        <Caption1>Pick a server <strong>and</strong> database on the <strong>Connect</strong> tab to change its compute &amp; storage.</Caption1>
      )}

      {currentSku?.name && (
        <Caption1>Current SKU: <span className={s.mono}>{skuLabel(currentSku)}</span></Caption1>
      )}

      <div className={s.card}>
        <Subtitle2>Service tier &amp; purchasing model</Subtitle2>
        <RadioGroup value={model} onChange={(_, d) => setModel(d.value as Model)} layout="horizontal">
          <Radio value="dtu" label="DTU-based (Basic / Standard / Premium)" />
          <Radio value="vcore" label="vCore — provisioned" />
          <Radio value="serverless" label="vCore — serverless (auto-pause)" />
        </RadioGroup>

        {/* DTU */}
        {model === 'dtu' && (
          <div className={s.grid}>
            <Field label="Tier">
              <Dropdown
                selectedOptions={[dtuTier]} value={dtuTier}
                onOptionSelect={(_, d) => { const t = d.optionValue || dtuTier; setDtuTier(t); setDtuSku(DTU_TIERS[t][0].skuName); }}
                aria-label="DTU tier"
              >
                {DTU_TIER_NAMES.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Service objective (DTUs)">
              <Dropdown
                selectedOptions={[dtuSku]} value={dtuSku}
                onOptionSelect={(_, d) => setDtuSku(d.optionValue || dtuSku)}
                aria-label="DTU service objective"
              >
                {(DTU_TIERS[dtuTier] || []).map((o) => <Option key={o.skuName} value={o.skuName}>{`${o.skuName} — ${o.dtu} DTU (max ${o.maxGb} GB)`}</Option>)}
              </Dropdown>
            </Field>
          </div>
        )}

        {/* vCore provisioned */}
        {model === 'vcore' && (
          <div className={s.grid}>
            <Field label="Tier">
              <Dropdown
                selectedOptions={[vcoreTier]} value={vcoreTier}
                onOptionSelect={(_, d) => setVcoreTier(d.optionValue || vcoreTier)}
                aria-label="vCore tier"
              >
                {VCORE_TIERS.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Hardware family"><Dropdown selectedOptions={['Gen5']} value="Gen5" disabled aria-label="Hardware family"><Option value="Gen5">Standard-series (Gen5)</Option></Dropdown></Field>
            <Field label="vCores">
              <Dropdown
                selectedOptions={[String(vcoreCapacity)]} value={String(vcoreCapacity)}
                onOptionSelect={(_, d) => setVcoreCapacity(Number(d.optionValue) || vcoreCapacity)}
                aria-label="vCores"
              >
                {VCORE_CAPACITIES.map((c) => <Option key={c} value={String(c)}>{`${c} vCores`}</Option>)}
              </Dropdown>
            </Field>
          </div>
        )}

        {/* Serverless */}
        {model === 'serverless' && (
          <>
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Serverless — General Purpose, auto-pause enabled</MessageBarTitle>
                Compute auto-scales between min and max vCores and pauses after the inactivity delay (you pay storage only while paused).
              </MessageBarBody>
            </MessageBar>
            <div className={s.grid}>
              <Field label="Max vCores">
                <Dropdown
                  selectedOptions={[String(slMaxVcore)]} value={String(slMaxVcore)}
                  onOptionSelect={(_, d) => setSlMaxVcore(Number(d.optionValue) || slMaxVcore)}
                  aria-label="Max vCores"
                >
                  {SERVERLESS_MAX_VCORES.map((c) => <Option key={c} value={String(c)}>{`${c} vCores`}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Min vCores">
                <Dropdown
                  selectedOptions={[String(slMinVcore)]} value={String(slMinVcore)}
                  onOptionSelect={(_, d) => setSlMinVcore(Number(d.optionValue) || slMinVcore)}
                  aria-label="Min vCores"
                >
                  {SERVERLESS_MIN_VCORES.filter((c) => c <= slMaxVcore).map((c) => <Option key={c} value={String(c)}>{`${c} vCores`}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Auto-pause delay">
                <Dropdown
                  selectedOptions={[String(autoPauseDelay)]}
                  value={AUTO_PAUSE_OPTIONS.find((o) => o.value === autoPauseDelay)?.label || ''}
                  onOptionSelect={(_, d) => setAutoPauseDelay(Number(d.optionValue))}
                  aria-label="Auto-pause delay"
                >
                  {AUTO_PAUSE_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
                </Dropdown>
              </Field>
            </div>
            {isGovCloud && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Verify serverless availability in this cloud</MessageBarTitle>
                  General Purpose serverless is available in Commercial and most Gov regions; Hyperscale serverless is not yet
                  available in GCC-High / IL5. Confirm the target region supports serverless before applying.
                </MessageBarBody>
              </MessageBar>
            )}
          </>
        )}

        {/* Max storage slider (all models) */}
        <div className={s.sliderRow}>
          <Label>Max storage — <strong>{maxSizeGb} GiB</strong></Label>
          <Slider
            min={0} max={MAX_SIZE_GB_OPTIONS.length - 1} step={1} value={maxSizeIdx}
            onChange={(_, d) => setMaxSizeIdx(d.value)} aria-label="Max storage (GiB)"
          />
          <Caption1>Storage is billed per GiB-month; the ceiling must be valid for the selected tier.</Caption1>
        </div>

        {/* Cost estimate hint */}
        <div className={s.costRow}>
          <Badge appearance="outline" color="brand">Target SKU: <span className={s.mono}>{payload.skuName}</span></Badge>
          <Caption1>
            Estimated compute: <strong>{costHint}</strong> · Commercial cloud, varies by region —{' '}
            <a href="https://azure.microsoft.com/pricing/details/azure-sql-database/" target="_blank" rel="noreferrer">Azure SQL Database pricing</a>
          </Caption1>
        </div>

        <Button
          appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Save20Regular />}
          disabled={busy || !ready || hyperscaleServerless} onClick={applyScale}
        >
          {busy ? 'Applying scale (LRO)…' : 'Apply'}
        </Button>
      </div>

      {/* Receipt — before/after SKU when ARM settled, or honest gate on failure */}
      {receipt && (
        receipt.ok ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>
                Scaled — {receipt.lroStatus || 'completed'} · state {receipt.provisioningState || 'Online'}
              </MessageBarTitle>
              <div className={s.receiptGrid}>
                <Body1></Body1><Caption1><strong>Before</strong></Caption1><Caption1><strong>After</strong></Caption1>
                <Caption1>SKU</Caption1>
                <span className={s.mono}>{skuLabel(receipt.beforeSku)}</span>
                <span className={s.mono}>{skuLabel(receipt.afterSku)}</span>
                {(receipt.beforeAutoPauseDelay !== undefined || receipt.afterAutoPauseDelay !== undefined) && (
                  <>
                    <Caption1>Auto-pause (min)</Caption1>
                    <span className={s.mono}>{receipt.beforeAutoPauseDelay ?? '—'}</span>
                    <span className={s.mono}>{receipt.afterAutoPauseDelay ?? '—'}</span>
                  </>
                )}
                {(receipt.beforeMinCapacity !== undefined || receipt.afterMinCapacity !== undefined) && (
                  <>
                    <Caption1>Min vCores</Caption1>
                    <span className={s.mono}>{receipt.beforeMinCapacity ?? '—'}</span>
                    <span className={s.mono}>{receipt.afterMinCapacity ?? '—'}</span>
                  </>
                )}
              </div>
            </MessageBarBody>
          </MessageBar>
        ) : receipt.hint ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Scale permission missing</MessageBarTitle>
              {receipt.error}
              {' — '}{receipt.hint} Grant the console UAMI <code>SQL DB Contributor</code>{' '}
              (role id <code>9b7fa17d-e63e-47b0-bb0a-15c516ac86ec</code>) on the server&apos;s resource group, or deploy{' '}
              <code>platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep</code> by setting <code>loomAzureSqlServerRg</code>.
            </MessageBarBody>
          </MessageBar>
        ) : (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Scale failed</MessageBarTitle>
              {receipt.error || 'Unknown error'}
            </MessageBarBody>
          </MessageBar>
        )
      )}

      <Caption1>
        <TopSpeed20Regular style={{ verticalAlign: 'middle' }} /> Scaling is online; the database stays available
        during most SKU changes (a brief reconnect can occur at the end of the operation).
      </Caption1>
    </div>
  );
}
