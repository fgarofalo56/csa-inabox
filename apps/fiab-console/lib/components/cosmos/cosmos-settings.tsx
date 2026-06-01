'use client';

/**
 * CosmosSettings — the Data Explorer studio's container **Settings** tab
 * (Scale & Settings): throughput / RU scale, Time to Live (TTL), indexing
 * policy, and conflict resolution.
 *
 * The studio surfaces these as editable sub-sections. Loom renders the full
 * surface with the REAL current values (throughput mode/RU, partition key,
 * default TTL) sourced from the container's control-plane shape
 * (/api/cosmos/containers, already loaded by the tree). Because no
 * throughput-update / TTL-update / indexing-policy-update WRITE route exists
 * yet, each editable section shows an honest Fluent MessageBar (intent
 * "warning") naming the exact ARM route + role needed to make it writable —
 * per no-vaporware.md (real values or an honest gate, never fake editors).
 */

import {
  Caption1, Subtitle2, Body1, Badge, Divider, Input, Field,
  RadioGroup, Radio, Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { useMemo } from 'react';

interface ThroughputInfo {
  mode: 'manual' | 'autoscale' | 'serverless' | 'unknown';
  ru?: number;
  maxRu?: number;
  minRu?: number;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 4px', overflow: 'auto', height: '100%' },
  head: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', alignItems: 'center' },
  k: { color: tokens.colorNeutralForeground3 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  readonlyNote: { color: tokens.colorNeutralForeground3 },
});

export interface CosmosSettingsProps {
  db: string;
  container: string;
  partitionKey?: string;
  defaultTtl?: number | null;
  throughput?: ThroughputInfo;
}

function ttlLabel(ttl?: number | null): string {
  if (ttl === undefined || ttl === null) return 'Off';
  if (ttl === -1) return 'On (no default — per-item ttl only)';
  return `On — ${ttl} second(s)`;
}

export function CosmosSettings({ db, container, partitionKey, defaultTtl, throughput }: CosmosSettingsProps) {
  const s = useStyles();

  const mode = throughput?.mode ?? 'unknown';
  const ruDisplay = useMemo(() => {
    if (mode === 'serverless') return 'Serverless (per-request billed RU)';
    if (mode === 'autoscale' && throughput?.maxRu) return `Autoscale — max ${throughput.maxRu} RU/s`;
    if (mode === 'manual' && throughput?.ru) return `Manual — ${throughput.ru} RU/s`;
    return 'Shared (database throughput) or unknown';
  }, [mode, throughput]);

  const ttlInitial: 'off' | 'on' = (defaultTtl === undefined || defaultTtl === null) ? 'off' : 'on';

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Subtitle2>Scale &amp; Settings</Subtitle2>
        <Badge appearance="tint">{db} / {container}</Badge>
        {mode !== 'unknown' && <Badge appearance="outline">{mode}</Badge>}
      </div>

      <Accordion multiple collapsible defaultOpenItems={['scale', 'ttl']}>
        {/* ---- Scale (throughput) ---- */}
        <AccordionItem value="scale">
          <AccordionHeader>Scale</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <div className={s.kv}>
                <span className={s.k}>Current throughput</span><span><Body1>{ruDisplay}</Body1></span>
                {throughput?.minRu !== undefined && (<><span className={s.k}>Min RU/s</span><span>{throughput.minRu}</span></>)}
              </div>
              {mode !== 'serverless' && (
                <Field label={mode === 'autoscale' ? 'Max RU/s' : 'RU/s'}>
                  <Input
                    type="number" readOnly
                    value={String(mode === 'autoscale' ? (throughput?.maxRu ?? '') : (throughput?.ru ?? ''))}
                  />
                </Field>
              )}
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Throughput scaling is read-only</MessageBarTitle>
                  The current RU/s is read live from the container&apos;s
                  <code> throughputSettings/default</code>. To make this editable, wire a
                  <code> PUT …/sqlDatabases/{db}/containers/{container}/throughputSettings/default</code>{' '}
                  route (ARM <code>Microsoft.DocumentDB/databaseAccounts</code>, the Console
                  UAMI needs <strong>Cosmos DB Operator</strong> or
                  <strong> DocumentDB Account Contributor</strong> at the account scope).
                  Serverless accounts have no provisioned throughput to scale.
                </MessageBarBody>
              </MessageBar>
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Time to Live ---- */}
        <AccordionItem value="ttl">
          <AccordionHeader>Time to Live</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <RadioGroup value={ttlInitial} disabled>
                <Radio value="off" label="Off" />
                <Radio value="on" label={`On (${ttlLabel(defaultTtl)})`} />
              </RadioGroup>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>TTL is read-only</MessageBarTitle>
                  Current default TTL: <strong>{ttlLabel(defaultTtl)}</strong> (from the container
                  resource&apos;s <code>defaultTtl</code>). Editing requires a container-update route
                  (<code>PUT …/containers/{container}</code> with the new
                  <code> properties.resource.defaultTtl</code>).
                </MessageBarBody>
              </MessageBar>
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Partition key (immutable, informational) ---- */}
        <AccordionItem value="pk">
          <AccordionHeader>Partition key</AccordionHeader>
          <AccordionPanel>
            <div className={s.kv}>
              <span className={s.k}>Partition key path</span>
              <span><code>{partitionKey || '/id'}</code></span>
            </div>
            <Caption1 className={s.readonlyNote}>
              The partition key is fixed at container creation time and cannot be changed (Azure parity).
            </Caption1>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Indexing policy ---- */}
        <AccordionItem value="indexing">
          <AccordionHeader>Indexing Policy</AccordionHeader>
          <AccordionPanel>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Indexing policy editor not yet wired</MessageBarTitle>
                The studio edits <code>includedPaths</code> / <code>excludedPaths</code> / composite
                &amp; spatial indexes on <code>properties.resource.indexingPolicy</code>. This needs a
                container-read+update route returning and persisting the indexing policy; not wired yet.
              </MessageBarBody>
            </MessageBar>
          </AccordionPanel>
        </AccordionItem>

        {/* ---- Conflict resolution ---- */}
        <AccordionItem value="conflict">
          <AccordionHeader>Conflict Resolution</AccordionHeader>
          <AccordionPanel>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Conflict-resolution policy not yet wired</MessageBarTitle>
                Last-Writer-Wins vs custom stored-procedure conflict resolution applies to multi-region
                write accounts (<code>properties.resource.conflictResolutionPolicy</code>); a
                container-update route is required to edit it. Not wired yet.
              </MessageBarBody>
            </MessageBar>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <Divider />
      <Caption1 className={s.readonlyNote}>
        Values above are read live from the real ARM control plane
        (<code>Microsoft.DocumentDB/databaseAccounts</code>). Write paths for scale / TTL / indexing /
        conflict resolution are honest-gated until their update routes are wired (per no-vaporware.md).
      </Caption1>
    </div>
  );
}

export default CosmosSettings;
