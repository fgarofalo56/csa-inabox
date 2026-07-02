'use client';

/**
 * CosmosSettingsPanel — the Data Explorer studio's container **Scale & Settings**
 * tab, now fully editable (one-for-one with the portal): live throughput with
 * mode migration, Time to Live, and a form-driven indexing-policy builder. The
 * unique-key policy and partition key are shown read-only because they are
 * immutable after creation (Azure parity — not a gate, a correct constraint).
 *
 * Every control hits a real ARM route through the BFF (no JSON textareas,
 * loom_no_freeform_config / no-vaporware):
 *   GET   /api/cosmos/container-settings     → ContainerDetail (indexing+unique+ttl)
 *   PATCH /api/cosmos/container-settings      → TTL + indexing policy (container PUT)
 *   PATCH /api/cosmos/container-throughput    → RU/s value + manual↔autoscale migrate
 *
 * Serverless accounts have no provisioned throughput — the Scale section then
 * shows an honest informational note instead of editable RU dials.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Divider, Input, Field, Spinner,
  RadioGroup, Radio, Dropdown, Option, Button,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { PathRowsEditor, CompositeIndexEditor, ConflictResolutionPolicyEditor } from './cosmos-policy-editors';
import type {
  ThroughputInfo, CosmosIndexingPolicy, CosmosUniqueKeyPolicy, ContainerDetail, CompositePath,
  CosmosConflictResolutionPolicy,
} from '@/lib/azure/cosmos-account-client';

const SETTINGS_ROUTE = '/api/cosmos/container-settings';
const THROUGHPUT_ROUTE = '/api/cosmos/container-throughput';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, padding: '8px 4px', overflow: 'auto', height: '100%' },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', alignItems: 'center' },
  k: { color: tokens.colorNeutralForeground3 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS },
  actionRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS },
  note: { color: tokens.colorNeutralForeground3 },
});

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

function ttlToMode(ttl?: number | null): 'off' | 'onNoDefault' | 'onDefault' {
  if (ttl === undefined || ttl === null) return 'off';
  if (ttl === -1) return 'onNoDefault';
  return 'onDefault';
}

function emptyIndexing(): CosmosIndexingPolicy {
  return { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [], compositeIndexes: [] };
}

export interface CosmosSettingsPanelProps {
  db: string;
  container: string;
  partitionKey?: string;
  defaultTtl?: number | null;
  throughput?: ThroughputInfo;
}

export function CosmosSettingsPanel({ db, container, partitionKey, defaultTtl, throughput }: CosmosSettingsPanelProps) {
  const s = useStyles();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContainerDetail | null>(null);

  // live throughput (seeded from prop, refreshed from the detail fetch)
  const [tp, setTp] = useState<ThroughputInfo | undefined>(throughput);
  const [tpEditMode, setTpEditMode] = useState<'manual' | 'autoscale'>(throughput?.mode === 'autoscale' ? 'autoscale' : 'manual');
  const [tpValue, setTpValue] = useState<string>(String(throughput?.maxRu ?? throughput?.ru ?? 400));
  const [tpBusy, setTpBusy] = useState(false);
  const [tpMsg, setTpMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // TTL editor state
  const [ttlMode, setTtlMode] = useState<'off' | 'onNoDefault' | 'onDefault'>(ttlToMode(defaultTtl));
  const [ttlSeconds, setTtlSeconds] = useState<string>(typeof defaultTtl === 'number' && defaultTtl > 0 ? String(defaultTtl) : '86400');
  const [ttlBusy, setTtlBusy] = useState(false);
  const [ttlMsg, setTtlMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Indexing editor state
  const [indexing, setIndexing] = useState<CosmosIndexingPolicy>(emptyIndexing());
  const [idxBusy, setIdxBusy] = useState(false);
  const [idxMsg, setIdxMsg] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);

  const [uniqueKeyPolicy, setUniqueKeyPolicy] = useState<CosmosUniqueKeyPolicy | undefined>(undefined);

  // Conflict-resolution editor state
  const [conflictPolicy, setConflictPolicy] = useState<CosmosConflictResolutionPolicy>({ mode: 'LastWriterWins', conflictResolutionPath: '/_ts' });
  const [crpBusy, setCrpBusy] = useState(false);
  const [crpMsg, setCrpMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const hydrate = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch(`${SETTINGS_ROUTE}?db=${encodeURIComponent(db)}&container=${encodeURIComponent(container)}`).then(readJson);
      if (!r.ok) { setLoadError(r.error || r.hint || 'Failed to load container settings.'); setLoading(false); return; }
      const d = r.container as ContainerDetail;
      setDetail(d);
      if (d.throughput) {
        setTp(d.throughput);
        setTpEditMode(d.throughput.mode === 'autoscale' ? 'autoscale' : 'manual');
        setTpValue(String(d.throughput.maxRu ?? d.throughput.ru ?? 400));
      }
      setTtlMode(ttlToMode(d.defaultTtl));
      if (typeof d.defaultTtl === 'number' && d.defaultTtl > 0) setTtlSeconds(String(d.defaultTtl));
      setIndexing(d.indexingPolicy ?? emptyIndexing());
      setUniqueKeyPolicy(d.uniqueKeyPolicy);
      setConflictPolicy(
        d.conflictResolutionPolicy ?? { mode: 'LastWriterWins', conflictResolutionPath: '/_ts' },
      );
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [db, container]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  const mode = tp?.mode ?? 'unknown';
  const serverless = mode === 'serverless';
  const indexingNone = indexing.indexingMode === 'none';

  const ruDisplay = useMemo(() => {
    if (serverless) return 'Serverless (per-request billed RU)';
    if (mode === 'autoscale' && tp?.maxRu) return `Autoscale — max ${tp.maxRu} RU/s`;
    if (mode === 'manual' && tp?.ru) return `Manual — ${tp.ru} RU/s`;
    return 'Shared (database throughput) or unknown';
  }, [serverless, mode, tp]);

  // ---- Save throughput (with optional manual↔autoscale migration) ----
  const saveThroughput = useCallback(async () => {
    setTpBusy(true); setTpMsg(null);
    try {
      const currentMode = tp?.mode;
      // A mode switch needs the migrate action first; same-mode is a direct value PUT.
      if (currentMode && currentMode !== 'serverless' && currentMode !== tpEditMode) {
        const migrate = tpEditMode === 'autoscale' ? 'migrateToAutoscale' : 'migrateToManual';
        const mr = await fetch(THROUGHPUT_ROUTE, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ db, container, mode: migrate }),
        }).then(readJson);
        if (!mr.ok) { setTpMsg({ intent: 'error', text: mr.error || 'Throughput migration failed.' }); setTpBusy(false); return; }
        if (mr.throughput) setTp(mr.throughput);
      }
      const value = parseInt(tpValue, 10);
      if (!(value > 0)) { setTpMsg({ intent: 'error', text: 'Enter a positive RU/s value.' }); setTpBusy(false); return; }
      const r = await fetch(THROUGHPUT_ROUTE, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ db, container, mode: tpEditMode, value }),
      }).then(readJson);
      if (!r.ok) { setTpMsg({ intent: 'error', text: r.error || 'Throughput update failed.' }); setTpBusy(false); return; }
      if (r.throughput) {
        setTp(r.throughput);
        setTpValue(String(r.throughput.maxRu ?? r.throughput.ru ?? value));
      }
      setTpMsg({ intent: 'success', text: 'Throughput updated.' });
    } catch (e: any) {
      setTpMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setTpBusy(false);
    }
  }, [db, container, tp, tpEditMode, tpValue]);

  // ---- Save TTL ----
  const saveTtl = useCallback(async () => {
    setTtlBusy(true); setTtlMsg(null);
    try {
      let value: number | null;
      if (ttlMode === 'off') value = null;
      else if (ttlMode === 'onNoDefault') value = -1;
      else {
        const n = parseInt(ttlSeconds, 10);
        if (!(n > 0)) { setTtlMsg({ intent: 'error', text: 'Enter a positive number of seconds.' }); setTtlBusy(false); return; }
        value = n;
      }
      const r = await fetch(SETTINGS_ROUTE, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ db, container, defaultTtl: value }),
      }).then(readJson);
      if (!r.ok) { setTtlMsg({ intent: 'error', text: r.error || 'TTL update failed.' }); setTtlBusy(false); return; }
      if (r.container) { setDetail(r.container); setTtlMode(ttlToMode(r.container.defaultTtl)); }
      setTtlMsg({ intent: 'success', text: 'TTL updated.' });
    } catch (e: any) {
      setTtlMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setTtlBusy(false);
    }
  }, [db, container, ttlMode, ttlSeconds]);

  // ---- Save indexing policy ----
  const saveIndexing = useCallback(async () => {
    // Guard: turning indexing off while TTL is on is rejected by ARM.
    if (indexingNone && ttlMode !== 'off') {
      setIdxMsg({ intent: 'error', text: 'Turn TTL off before setting indexing mode to None (TTL requires an index).' });
      return;
    }
    setIdxBusy(true); setIdxMsg(null);
    try {
      const r = await fetch(SETTINGS_ROUTE, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ db, container, indexingPolicy: indexing }),
      }).then(readJson);
      if (!r.ok) { setIdxMsg({ intent: 'error', text: r.error || 'Indexing policy update failed.' }); setIdxBusy(false); return; }
      if (r.container?.indexingPolicy) setIndexing(r.container.indexingPolicy);
      setIdxMsg({ intent: 'info', text: 'Index transformation started — adding paths may take time on large containers. Reads remain available during transformation.' });
    } catch (e: any) {
      setIdxMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setIdxBusy(false);
    }
  }, [db, container, indexing, indexingNone, ttlMode]);

  // ---- Save conflict-resolution policy ----
  const saveConflictPolicy = useCallback(async () => {
    setCrpBusy(true); setCrpMsg(null);
    try {
      const payload: CosmosConflictResolutionPolicy = conflictPolicy.mode === 'Custom'
        ? { mode: 'Custom', conflictResolutionProcedure: (conflictPolicy.conflictResolutionProcedure || '').trim() }
        : { mode: 'LastWriterWins', conflictResolutionPath: (conflictPolicy.conflictResolutionPath || '').trim() || '/_ts' };
      const r = await fetch(SETTINGS_ROUTE, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ db, container, conflictResolutionPolicy: payload }),
      }).then(readJson);
      if (!r.ok) { setCrpMsg({ intent: 'error', text: r.error || 'Conflict-resolution policy update failed.' }); setCrpBusy(false); return; }
      if (r.container?.conflictResolutionPolicy) setConflictPolicy(r.container.conflictResolutionPolicy);
      setCrpMsg({ intent: 'success', text: 'Conflict-resolution policy updated.' });
    } catch (e: any) {
      setCrpMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setCrpBusy(false);
    }
  }, [db, container, conflictPolicy]);

  if (loading) {
    return <div className={s.root}><Spinner size="small" label="Loading container settings…" /></div>;
  }

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Subtitle2>Scale &amp; Settings</Subtitle2>
        <Badge appearance="tint">{db} / {container}</Badge>
        {mode !== 'unknown' && <Badge appearance="outline">{mode}</Badge>}
      </div>

      {loadError && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not load settings</MessageBarTitle>{loadError}</MessageBarBody></MessageBar>
      )}

      <Accordion multiple collapsible defaultOpenItems={['scale', 'ttl', 'indexing', 'conflict']}>
        {/* ---- Scale (throughput) ---- */}
        <AccordionItem value="scale">
          <AccordionHeader>Scale</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <div className={s.kv}>
                <span className={s.k}>Current throughput</span><span><Body1>{ruDisplay}</Body1></span>
                {tp?.minRu !== undefined && (<><span className={s.k}>Min RU/s</span><span>{tp.minRu}</span></>)}
              </div>
              {serverless ? (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Serverless account</MessageBarTitle>
                    Serverless accounts have no provisioned throughput to scale — requests are billed
                    per RU consumed.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <>
                  <Field label="Mode">
                    <Dropdown
                      value={tpEditMode === 'autoscale' ? 'Autoscale' : 'Manual'}
                      selectedOptions={[tpEditMode]}
                      onOptionSelect={(_, d) => setTpEditMode((d.optionValue as 'manual' | 'autoscale') || 'manual')}
                    >
                      <Option value="manual" text="Manual">Manual</Option>
                      <Option value="autoscale" text="Autoscale">Autoscale</Option>
                    </Dropdown>
                  </Field>
                  <Field label={tpEditMode === 'autoscale' ? 'Max RU/s' : 'RU/s'}>
                    <Input type="number" value={tpValue} onChange={(_, d) => setTpValue(d.value)} />
                    <Caption1 className={s.note}>
                      {tpEditMode === 'autoscale' ? 'Autoscale minimum is 1000 max RU/s.' : 'Manual minimum is 400 RU/s.'}
                      {tp?.mode && tp.mode !== 'serverless' && tp.mode !== tpEditMode && ' Saving will migrate the container to this mode first (long-running).'}
                    </Caption1>
                  </Field>
                  <div className={s.actionRow}>
                    <Button appearance="primary" disabled={tpBusy} onClick={saveThroughput}>
                      {tpBusy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save throughput'}
                    </Button>
                  </div>
                  {tpMsg && (
                    <MessageBar intent={tpMsg.intent}><MessageBarBody>{tpMsg.text}</MessageBarBody></MessageBar>
                  )}
                </>
              )}
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Time to Live ---- */}
        <AccordionItem value="ttl">
          <AccordionHeader>Time to Live</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <RadioGroup value={ttlMode} disabled={indexingNone} onChange={(_, d) => setTtlMode(d.value as typeof ttlMode)}>
                <Radio value="off" label="Off" />
                <Radio value="onNoDefault" label="On (no default — items expire only when they set a ttl)" />
                <Radio value="onDefault" label="On (with default seconds)" />
              </RadioGroup>
              {ttlMode === 'onDefault' && !indexingNone && (
                <Field label="Default TTL (seconds)">
                  <Input type="number" value={ttlSeconds} onChange={(_, d) => setTtlSeconds(d.value)} />
                </Field>
              )}
              {indexingNone && (
                <Caption1 className={s.note}>
                  TTL requires an index. It is disabled because the indexing mode is <code>none</code>.
                </Caption1>
              )}
              <div className={s.actionRow}>
                <Button appearance="primary" disabled={ttlBusy || indexingNone} onClick={saveTtl}>
                  {ttlBusy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save TTL'}
                </Button>
              </div>
              {ttlMsg && (
                <MessageBar intent={ttlMsg.intent}><MessageBarBody>{ttlMsg.text}</MessageBarBody></MessageBar>
              )}
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Partition key (immutable) ---- */}
        <AccordionItem value="pk">
          <AccordionHeader>Partition key</AccordionHeader>
          <AccordionPanel>
            <div className={s.kv}>
              <span className={s.k}>Partition key path</span>
              <span><code>{detail?.partitionKey || partitionKey || '/id'}</code></span>
            </div>
            <Caption1 className={s.note}>
              The partition key is fixed at container creation time and cannot be changed (Azure parity).
            </Caption1>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Indexing policy (editable) ---- */}
        <AccordionItem value="indexing">
          <AccordionHeader>Indexing Policy</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
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
                    Mode <code>none</code> removes all secondary indexes. TTL must be off first
                    (TTL requires an index). Saving will replace the current policy.
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
              <div className={s.actionRow}>
                <Button appearance="primary" disabled={idxBusy} onClick={saveIndexing}>
                  {idxBusy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save indexing policy'}
                </Button>
              </div>
              {idxMsg && (
                <MessageBar intent={idxMsg.intent}><MessageBarBody>{idxMsg.text}</MessageBarBody></MessageBar>
              )}
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Unique keys (read-only — immutable after creation) ---- */}
        <AccordionItem value="unique">
          <AccordionHeader>Unique keys</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              {uniqueKeyPolicy && uniqueKeyPolicy.uniqueKeys.length > 0 ? (
                uniqueKeyPolicy.uniqueKeys.map((k, i) => (
                  <div className={s.head} key={i}>
                    <Badge appearance="tint">Unique key {i + 1}</Badge>
                    {k.paths.map((p) => <Badge key={p} appearance="outline"><code>{p}</code></Badge>)}
                  </div>
                ))
              ) : (
                <Caption1 className={s.note}>No unique-key constraints on this container.</Caption1>
              )}
              <Caption1 className={s.note}>
                Unique key constraints are immutable and cannot be changed after container creation
                (Azure parity). To apply different constraints, create a new container with the
                wizard&apos;s Advanced step.
              </Caption1>
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Conflict resolution (editable — full container PUT) ---- */}
        <AccordionItem value="conflict">
          <AccordionHeader>Conflict Resolution</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <ConflictResolutionPolicyEditor
                policy={conflictPolicy}
                onChange={setConflictPolicy}
                disabled={crpBusy}
              />
              <div className={s.actionRow}>
                <Button appearance="primary" disabled={crpBusy} onClick={saveConflictPolicy}>
                  {crpBusy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save conflict resolution policy'}
                </Button>
              </div>
              {crpMsg && (
                <MessageBar intent={crpMsg.intent}><MessageBarBody>{crpMsg.text}</MessageBarBody></MessageBar>
              )}
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <Divider />
      <Caption1 className={s.note}>
        Throughput, TTL, indexing, and conflict-resolution changes are written to the real ARM
        control plane (<code>Microsoft.DocumentDB/databaseAccounts</code>) and re-read to confirm.
        Partition key and unique keys are immutable after creation (Azure parity).
      </Caption1>
    </div>
  );
}

export default CosmosSettingsPanel;
