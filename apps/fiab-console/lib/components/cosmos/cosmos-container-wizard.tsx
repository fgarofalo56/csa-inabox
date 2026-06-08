'use client';

/**
 * CosmosContainerWizard — the Data Explorer studio's **New Container** dialog,
 * one-for-one with the portal wizard but with the full Loom theme. Four logical
 * steps: Basics → Throughput → Indexing → Advanced (TTL + unique keys) + review.
 *
 * Every field maps to a real ARM `properties.resource` field on the container
 * PUT (lib/azure/cosmos-account-client.ts → createContainer). No raw JSON: the
 * indexing policy and unique keys are built from the form-row editors in
 * cosmos-policy-editors.tsx (loom_no_freeform_config).
 *
 * On submit → POST /api/cosmos/containers with the full body; the route's
 * createContainer polls ARM until the container provisions, then re-reads it.
 */

import { useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, RadioGroup, Radio, Caption1, Body1,
  Badge, Divider, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PathRowsEditor, CompositeIndexEditor, UniqueKeysEditor,
} from './cosmos-policy-editors';
import type {
  CosmosIndexingPolicy, CosmosUniqueKeyPolicy, CompositePath, ContainerSummary,
} from '@/lib/azure/cosmos-account-client';

const CONTAINER_ROUTE = '/api/cosmos/containers';

const useStyles = makeStyles({
  steps: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 },
  body: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 320 },
  ttlRow: { display: 'flex', flexDirection: 'column', gap: 8 },
  summary: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: 10, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px' },
  k: { color: tokens.colorNeutralForeground3 },
  note: { color: tokens.colorNeutralForeground3 },
});

type TpMode = 'shared' | 'manual' | 'autoscale';
type TtlMode = 'off' | 'onNoDefault' | 'onDefault';

const STEP_LABELS = ['Basics', 'Throughput', 'Indexing', 'Advanced'];

function defaultIndexingPolicy(): CosmosIndexingPolicy {
  return {
    indexingMode: 'consistent',
    automatic: true,
    includedPaths: [{ path: '/*' }],
    excludedPaths: [{ path: '/"_etag"/?' }],
    compositeIndexes: [],
  };
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

export interface CosmosContainerWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Databases to target (the wizard creates the container inside one). */
  databases: { name: string }[];
  defaultDb?: string;
  onCreated?: (container: ContainerSummary, db: string) => void;
}

export function CosmosContainerWizard({
  open, onOpenChange, databases, defaultDb, onCreated,
}: CosmosContainerWizardProps) {
  const s = useStyles();

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — basics
  const [db, setDb] = useState(defaultDb || databases[0]?.name || '');
  const [id, setId] = useState('');
  const [pk, setPk] = useState('/id');

  // Step 2 — throughput
  const [tpMode, setTpMode] = useState<TpMode>('autoscale');
  const [tpValue, setTpValue] = useState('4000');

  // Step 3 — indexing
  const [indexing, setIndexing] = useState<CosmosIndexingPolicy>(defaultIndexingPolicy());

  // Step 4 — TTL + unique keys
  const [ttlMode, setTtlMode] = useState<TtlMode>('off');
  const [ttlSeconds, setTtlSeconds] = useState('86400');
  const [uniqueKeys, setUniqueKeys] = useState<CosmosUniqueKeyPolicy>({ uniqueKeys: [] });

  const reset = () => {
    setStep(0); setBusy(false); setError(null);
    setDb(defaultDb || databases[0]?.name || '');
    setId(''); setPk('/id');
    setTpMode('autoscale'); setTpValue('4000');
    setIndexing(defaultIndexingPolicy());
    setTtlMode('off'); setTtlSeconds('86400');
    setUniqueKeys({ uniqueKeys: [] });
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const indexingNone = indexing.indexingMode === 'none';
  const ttlDisabled = indexingNone; // ARM: TTL requires indexingMode !== 'none'

  const tpLabel = tpMode === 'autoscale' ? 'Max RU/s' : 'RU/s';
  const tpHint = tpMode === 'autoscale'
    ? 'Autoscale minimum is 1000 max RU/s (scales 10%–100% of the max).'
    : 'Manual minimum is 400 RU/s.';

  const basicsValid = !!db.trim() && !!id.trim() && !!pk.trim();
  const tpValid = tpMode === 'shared' || Number(tpValue) > 0;

  const effectiveTtl = useMemo<number | undefined>(() => {
    if (ttlDisabled || ttlMode === 'off') return undefined;
    if (ttlMode === 'onNoDefault') return -1;
    const n = parseInt(ttlSeconds, 10);
    return n > 0 ? n : undefined;
  }, [ttlDisabled, ttlMode, ttlSeconds]);

  const ttlSummary = ttlDisabled || ttlMode === 'off'
    ? 'Off'
    : ttlMode === 'onNoDefault'
      ? 'On — per-item ttl only (no default)'
      : `On — ${ttlSeconds} second(s)`;

  const compositeCount = indexing.compositeIndexes.filter((g) => g.some((p) => p.path.trim())).length;
  const uniqueCount = uniqueKeys.uniqueKeys.filter((k) => k.paths.some((p) => p.trim())).length;

  const submit = async () => {
    if (!basicsValid) { setStep(0); return; }
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        db: db.trim(),
        id: id.trim(),
        partitionKey: pk.trim(),
        indexingPolicy: indexing,
      };
      if (tpMode === 'manual') body.throughput = parseInt(tpValue, 10);
      else if (tpMode === 'autoscale') body.maxThroughput = parseInt(tpValue, 10);
      if (typeof effectiveTtl === 'number') body.defaultTtl = effectiveTtl;
      if (uniqueCount > 0) body.uniqueKeyPolicy = uniqueKeys;

      const r = await fetch(CONTAINER_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(readJson);
      if (!r.ok) { setError(r.error || r.hint || 'Container creation failed.'); setBusy(false); return; }
      onCreated?.(r.container as ContainerSummary, db.trim());
      close(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!busy) close(d.open); }}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>New container</DialogTitle>
          <DialogContent>
            <div className={s.steps}>
              {STEP_LABELS.map((label, i) => (
                <Badge
                  key={label}
                  appearance={i === step ? 'filled' : i < step ? 'tint' : 'outline'}
                  color={i === step ? 'brand' : i < step ? 'success' : 'informational'}
                >
                  {i + 1}. {label}
                </Badge>
              ))}
            </div>

            <div className={s.body}>
              {/* ---- Step 1: Basics ---- */}
              {step === 0 && (
                <>
                  <Field label="Database" required>
                    <Dropdown
                      value={db}
                      selectedOptions={db ? [db] : []}
                      placeholder="Select a database"
                      onOptionSelect={(_, d) => setDb(d.optionValue || '')}
                    >
                      {databases.map((x) => <Option key={x.name} value={x.name} text={x.name}>{x.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Container id" required>
                    <Input value={id} onChange={(_, d) => setId(d.value)} placeholder="my-container" />
                  </Field>
                  <Field label="Partition key" required>
                    <Input value={pk} onChange={(_, d) => setPk(d.value)} placeholder="/id" />
                    <Caption1 className={s.note}>
                      A leading slash is added if omitted. The partition key is fixed at creation
                      and cannot be changed afterwards (Azure parity).
                    </Caption1>
                  </Field>
                </>
              )}

              {/* ---- Step 2: Throughput ---- */}
              {step === 1 && (
                <>
                  <Field label="Throughput mode">
                    <Dropdown
                      value={tpMode === 'shared' ? 'Shared (database RU/s)' : tpMode === 'manual' ? 'Manual RU/s' : 'Autoscale (max RU/s)'}
                      selectedOptions={[tpMode]}
                      onOptionSelect={(_, d) => setTpMode((d.optionValue as TpMode) || 'autoscale')}
                    >
                      <Option value="shared" text="Shared (database RU/s)">Shared (database RU/s)</Option>
                      <Option value="manual" text="Manual RU/s">Manual RU/s</Option>
                      <Option value="autoscale" text="Autoscale (max RU/s)">Autoscale (max RU/s)</Option>
                    </Dropdown>
                  </Field>
                  {tpMode === 'shared' ? (
                    <Caption1 className={s.note}>
                      The container shares its database&apos;s provisioned throughput. The database
                      must already have shared RU/s for this to apply.
                    </Caption1>
                  ) : (
                    <Field label={tpLabel}>
                      <Input type="number" value={tpValue} onChange={(_, d) => setTpValue(d.value)} />
                      <Caption1 className={s.note}>{tpHint}</Caption1>
                    </Field>
                  )}
                </>
              )}

              {/* ---- Step 3: Indexing ---- */}
              {step === 2 && (
                <>
                  <Field label="Indexing mode">
                    <RadioGroup
                      value={indexing.indexingMode}
                      onChange={(_, d) => setIndexing((p) => ({ ...p, indexingMode: d.value as CosmosIndexingPolicy['indexingMode'] }))}
                    >
                      <Radio value="consistent" label="Consistent (index every write automatically)" />
                      <Radio value="none" label="None (no index — point reads + full scans only)" />
                    </RadioGroup>
                  </Field>
                  {indexingNone ? (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Indexing is off</MessageBarTitle>
                        With indexing mode <code>none</code>, included/excluded paths, composite
                        indexes, and TTL are unavailable (TTL requires an index). Choose
                        <strong> Consistent</strong> to configure them.
                      </MessageBarBody>
                    </MessageBar>
                  ) : (
                    <>
                      <PathRowsEditor
                        label="Included paths"
                        placeholder="/*"
                        paths={indexing.includedPaths}
                        onChange={(includedPaths) => setIndexing((p) => ({ ...p, includedPaths }))}
                      />
                      <PathRowsEditor
                        label="Excluded paths"
                        placeholder={'/"_etag"/?'}
                        paths={indexing.excludedPaths}
                        onChange={(excludedPaths) => setIndexing((p) => ({ ...p, excludedPaths }))}
                      />
                      <Divider />
                      <CompositeIndexEditor
                        groups={indexing.compositeIndexes}
                        onChange={(compositeIndexes: CompositePath[][]) => setIndexing((p) => ({ ...p, compositeIndexes }))}
                      />
                    </>
                  )}
                </>
              )}

              {/* ---- Step 4: Advanced (TTL + unique keys) + review ---- */}
              {step === 3 && (
                <>
                  <Field label="Time to Live (TTL)">
                    <div className={s.ttlRow}>
                      <RadioGroup
                        value={ttlMode}
                        disabled={ttlDisabled}
                        onChange={(_, d) => setTtlMode(d.value as TtlMode)}
                      >
                        <Radio value="off" label="Off" />
                        <Radio value="onNoDefault" label="On (no default — items expire only when they set a ttl)" />
                        <Radio value="onDefault" label="On (with default seconds)" />
                      </RadioGroup>
                      {ttlMode === 'onDefault' && !ttlDisabled && (
                        <Field label="Default TTL (seconds)">
                          <Input type="number" value={ttlSeconds} onChange={(_, d) => setTtlSeconds(d.value)} />
                        </Field>
                      )}
                      {ttlDisabled && (
                        <Caption1 className={s.note}>
                          TTL requires an index. It is disabled because the indexing mode is
                          <code> none</code> (Azure constraint).
                        </Caption1>
                      )}
                    </div>
                  </Field>

                  <Divider />

                  <UniqueKeysEditor
                    policy={uniqueKeys}
                    onChange={setUniqueKeys}
                  />

                  <Divider />

                  <Body1>Review</Body1>
                  <div className={s.summary}>
                    <div className={s.kv}>
                      <span className={s.k}>Database</span><span>{db || '—'}</span>
                      <span className={s.k}>Container</span><span>{id || '—'}</span>
                      <span className={s.k}>Partition key</span><span><code>{pk || '/id'}</code></span>
                      <span className={s.k}>Throughput</span>
                      <span>{tpMode === 'shared' ? 'Shared (database RU/s)' : `${tpMode === 'autoscale' ? 'Autoscale max' : 'Manual'} ${tpValue} RU/s`}</span>
                      <span className={s.k}>Indexing</span>
                      <span>{indexingNone ? 'None' : `Consistent · ${compositeCount} composite index(es)`}</span>
                      <span className={s.k}>TTL</span><span>{ttlSummary}</span>
                      <span className={s.k}>Unique keys</span><span>{uniqueCount}</span>
                    </div>
                  </div>
                </>
              )}

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{error}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy} onClick={() => close(false)}>Cancel</Button>
            {step > 0 && <Button appearance="secondary" disabled={busy} onClick={() => setStep((x) => x - 1)}>Back</Button>}
            {step < STEP_LABELS.length - 1 ? (
              <Button
                appearance="primary"
                disabled={(step === 0 && !basicsValid) || (step === 1 && !tpValid)}
                onClick={() => setStep((x) => x + 1)}
              >
                Next
              </Button>
            ) : (
              <Button appearance="primary" disabled={busy || !basicsValid} onClick={submit}>
                {busy ? <Spinner size="tiny" label="Creating…" labelPosition="after" /> : 'Create'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default CosmosContainerWizard;
