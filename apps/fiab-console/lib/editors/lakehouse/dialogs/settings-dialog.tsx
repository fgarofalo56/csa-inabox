'use client';
import {
  Caption1, Badge, Button, Spinner, Subtitle2, tokens, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Input, Textarea, Switch, Dropdown, Option,
} from '@fluentui/react-components';
import { Copy20Regular } from '@fluentui/react-icons';
import { sparkConfigWarnings, cloudFabricNote } from '../../lakehouse-spark-conf';
import { useStyles, leafName } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

export function SettingsDialog() {
  const ctx = useLakehouseCtx();
  const {
    settingsOpen, setSettingsOpen, settings, setSettings,
    settingsBusy, settingsError, saveSettings, sparkPools,
    openPrefixes, cacheKey, bundleDeltaTables, activeContainer, schemasEnabled,
    lcTableName, setLcTableName, lcColumns, setLcColumns, lcGate, lcError, lcApplied, lcSql,
    icebergEnabled, setIcebergEnabled, icebergSchema, setIcebergSchema, icebergTable, setIcebergTable,
    icebergEndpoint, icebergGate, icebergError, icebergApplied, icebergSql,
    settingsSparkConfText, setSettingsSparkConfText, setActionStatus, cloud,
  } = ctx;

  return (
    <Dialog open={settingsOpen} onOpenChange={(_, d) => setSettingsOpen(d.open)}>
      <DialogSurface style={{ maxWidth: '720px', width: '90vw' }}>
        <DialogBody>
          <DialogTitle>Lakehouse settings — {activeContainer}</DialogTitle>
          <DialogContent>
            {settingsBusy && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
            {settingsError && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Settings error</MessageBarTitle>{settingsError}</MessageBarBody></MessageBar>
            )}
            <Field label="Display name (override)">
              <Input value={settings.displayName || ''} onChange={(_, d) => setSettings((s) => ({ ...s, displayName: d.value }))} />
            </Field>
            <Field label="Description">
              <Textarea value={settings.description || ''} onChange={(_, d) => setSettings((s) => ({ ...s, description: d.value }))} />
            </Field>
            <Field
              label="Default Spark pool (Synapse)"
              hint={sparkPools !== null && sparkPools.length === 0
                ? 'No Synapse Spark pools discovered. Provision a pool in the Synapse workspace (LOOM_SYNAPSE_WORKSPACE) to populate this list.'
                : 'Notebooks attached to this lakehouse default to this pool.'}
            >
              {sparkPools === null ? (
                <Spinner size="tiny" label="Loading pools…" labelPosition="after" />
              ) : (
                <Dropdown
                  selectedOptions={settings.defaultSparkPool ? [settings.defaultSparkPool] : []}
                  value={settings.defaultSparkPool || ''}
                  placeholder={sparkPools.length === 0 ? 'No Spark pools deployed' : 'Select a Spark pool'}
                  disabled={sparkPools.length === 0}
                  onOptionSelect={(_, d) => setSettings((s) => ({ ...s, defaultSparkPool: d.optionValue || '' }))}
                >
                  {sparkPools.map((p) => (
                    <Option key={p.name} value={p.name}>{p.name}</Option>
                  ))}
                </Dropdown>
              )}
            </Field>
            <Field label="Time-travel retention (days)">
              <Input type="number" min={0} value={String(settings.timeTravelDays ?? 7)} onChange={(_, d) => setSettings((s) => ({ ...s, timeTravelDays: Math.max(0, Number(d.value) || 0) }))} />
            </Field>
            <Field label="Delta auto-optimize default">
              <Switch
                checked={settings.deltaDefaults?.autoOptimize ?? true}
                onChange={(_, d) => setSettings((s) => ({ ...s, deltaDefaults: { ...(s.deltaDefaults || {}), autoOptimize: d.checked } }))}
                label={settings.deltaDefaults?.autoOptimize ?? true ? 'Enabled' : 'Disabled'}
              />
            </Field>
            <Field
              label="Schemas enabled"
              hint="Multi-schema namespace (workspace.lakehouse.schema.table). Tables live under Tables/<schema>/. Schema DDL runs on a Synapse Spark pool via Livy (LOOM_SYNAPSE_WORKSPACE). 'dbo' is always the immutable default."
            >
              <Switch
                checked={settings.schemasEnabled ?? false}
                onChange={(_, d) => setSettings((s) => ({ ...s, schemasEnabled: d.checked }))}
                label={settings.schemasEnabled ? 'Enabled' : 'Disabled'}
              />
            </Field>

            {/* ---- Liquid clustering (Fabric F12 parity → real ALTER TABLE … CLUSTER BY) ---- */}
            <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Liquid clustering</Subtitle2>
            <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalXS }}>
              <MessageBarBody>
                Liquid clustering replaces static partitioning and ZORDER. On save, Loom runs a
                real <code>ALTER TABLE delta.`abfss://…` CLUSTER BY (&lt;columns&gt;)</code> on the
                named Delta table via a Databricks SQL Warehouse — no Fabric dependency. Run{' '}
                <code>OPTIMIZE</code> in a notebook afterward to re-cluster existing rows. Requires{' '}
                <strong>LOOM_DATABRICKS_HOSTNAME</strong> to be set.
              </MessageBarBody>
            </MessageBar>
            <Field label="Table to cluster" hint="Delta table under /Tables/ in this container.">
              {(() => {
                const listing = activeContainer ? openPrefixes[cacheKey(activeContainer, 'Tables')] : undefined;
                const liveNames = Array.isArray(listing)
                  ? listing.filter((e) => e.isDirectory).map((e) => leafName(e.name))
                  : [];
                const bundleNames = bundleDeltaTables.map((t) => t.name);
                const allNames = Array.from(new Set([...liveNames, ...bundleNames])).sort();
                if (allNames.length > 0) {
                  return (
                    <Dropdown
                      selectedOptions={lcTableName ? [lcTableName] : []}
                      value={lcTableName}
                      placeholder="Select a Delta table"
                      onOptionSelect={(_, d) => setLcTableName(d.optionValue || '')}
                    >
                      {allNames.map((n) => (<Option key={n} value={n}>{n}</Option>))}
                    </Dropdown>
                  );
                }
                return (
                  <Input
                    value={lcTableName}
                    onChange={(_, d) => setLcTableName(d.value)}
                    placeholder="bronze_player_profile"
                  />
                );
              })()}
            </Field>
            <Field label="Clustering columns" hint="Comma-separated, e.g. player_id, filing_timestamp. Order does not matter.">
              <Input
                value={lcColumns}
                onChange={(_, d) => setLcColumns(d.value)}
                placeholder="player_id, filing_timestamp"
              />
            </Field>
            {lcGate && (
              <MessageBar intent="warning">
                <MessageBarBody><MessageBarTitle>Liquid clustering gate</MessageBarTitle>{lcGate}</MessageBarBody>
              </MessageBar>
            )}
            {lcError && (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>ALTER TABLE failed</MessageBarTitle>{lcError}</MessageBarBody>
              </MessageBar>
            )}
            {lcApplied && (
              <MessageBar intent="success">
                <MessageBarBody>
                  <MessageBarTitle>Clustering applied</MessageBarTitle>
                  ALTER TABLE … CLUSTER BY ran. Run OPTIMIZE in a notebook to re-cluster existing rows.
                  {lcSql ? <><br /><code style={{ fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', display: 'block' }}>{lcSql}</code></> : null}
                </MessageBarBody>
              </MessageBar>
            )}

            {/* ---- Expose as Iceberg (OneLake "Iceberg V2 endpoint" parity → Delta UniForm) ---- */}
            <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>
              Expose as Iceberg{' '}
              <Badge appearance="tint" color="brand" size="small">Iceberg V2</Badge>
            </Subtitle2>
            <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalXS }}>
              <MessageBarBody>
                Just like Fabric OneLake, your Delta table is read by Iceberg readers — there is no
                separate "Iceberg endpoint" to provision. On save, Loom enables{' '}
                <strong>Delta Lake UniForm</strong> with a real{' '}
                <code>ALTER TABLE … SET TBLPROPERTIES('delta.universalFormat.enabledFormats'='iceberg')</code>{' '}
                via a Databricks SQL Warehouse (Azure-native, no Fabric). Delta then generates Iceberg V2{' '}
                <code>metadata/*.metadata.json</code> alongside the Delta log. Requires{' '}
                <strong>LOOM_DATABRICKS_HOSTNAME</strong>.
              </MessageBarBody>
            </MessageBar>
            <Field
              label="Expose as Iceberg"
              hint="Generates Iceberg V2 metadata over the selected Delta table via UniForm."
            >
              <Switch
                checked={icebergEnabled}
                onChange={(_, d) => setIcebergEnabled(d.checked)}
                label={icebergEnabled ? 'Enabled' : 'Disabled'}
              />
            </Field>
            {schemasEnabled && (
              <Field label="Schema" hint="Schema-enabled lakehouse: the table lives under Tables/<schema>/. Defaults to dbo.">
                <Input
                  value={icebergSchema}
                  onChange={(_, d) => setIcebergSchema(d.value)}
                  placeholder="dbo"
                />
              </Field>
            )}
            <Field label="Delta table to expose" hint="Delta table under /Tables/ in this container.">
              {(() => {
                const listing = activeContainer ? openPrefixes[cacheKey(activeContainer, 'Tables')] : undefined;
                const liveNames = Array.isArray(listing)
                  ? listing.filter((e) => e.isDirectory).map((e) => leafName(e.name))
                  : [];
                const bundleNames = bundleDeltaTables.map((t) => t.name);
                const allNames = Array.from(new Set([...liveNames, ...bundleNames])).sort();
                if (allNames.length > 0) {
                  return (
                    <Dropdown
                      selectedOptions={icebergTable ? [icebergTable] : []}
                      value={icebergTable}
                      placeholder="Select a Delta table"
                      onOptionSelect={(_, d) => setIcebergTable(d.optionValue || '')}
                    >
                      {allNames.map((n) => (<Option key={n} value={n}>{n}</Option>))}
                    </Dropdown>
                  );
                }
                return (
                  <Input
                    value={icebergTable}
                    onChange={(_, d) => setIcebergTable(d.value)}
                    placeholder="bronze_player_profile"
                  />
                );
              })()}
            </Field>
            {icebergEndpoint && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalSNudge, padding: `${tokens.spacingVerticalMNudge} ${tokens.spacingHorizontalM}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}` }}>
                <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Iceberg endpoint (metadata path readers point at)</Caption1>
                {([
                  ['ADLS path (abfss)', icebergEndpoint.abfss],
                  ['Iceberg catalog / metadata folder (HTTPS)', icebergEndpoint.httpsMetadataFolder],
                  ['Snowflake EXTERNAL VOLUME base (azure://)', icebergEndpoint.azureMetadataFolder],
                ] as [string, string][]).map(([label, val]) => (
                  <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{label}</Caption1>
                    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}>
                      <code style={{ fontSize: tokens.fontSizeBase100, wordBreak: 'break-all', flex: 1 }}>{val}</code>
                      <Tooltip content={`Copy ${label}`} relationship="label">
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Copy20Regular />}
                          onClick={() => { try { void navigator.clipboard?.writeText(val); setActionStatus('Copied to clipboard'); } catch { /* clipboard unavailable */ } }}
                        >
                          Copy
                        </Button>
                      </Tooltip>
                    </div>
                  </div>
                ))}
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Format: Apache Iceberg V2 · via Delta Lake UniForm.
                </Caption1>
              </div>
            )}
            {icebergGate && (
              <MessageBar intent="warning">
                <MessageBarBody><MessageBarTitle>Iceberg expose gate</MessageBarTitle>{icebergGate}</MessageBarBody>
              </MessageBar>
            )}
            {icebergError && (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>UniForm ALTER TABLE failed</MessageBarTitle>{icebergError}</MessageBarBody>
              </MessageBar>
            )}
            {icebergApplied && (
              <MessageBar intent="success">
                <MessageBarBody>
                  <MessageBarTitle>Iceberg endpoint enabled</MessageBarTitle>
                  UniForm is on. Delta generates Iceberg V2 metadata after the next write transaction.
                  {icebergSql ? <><br /><code style={{ fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', display: 'block' }}>{icebergSql}</code></> : null}
                </MessageBarBody>
              </MessageBar>
            )}

            {/* ---- Fabric-only acceleration (honest gate, F22) ---- */}
            <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Fabric-only acceleration (honest gate)</Subtitle2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
              <Switch
                checked={settings.fabricToggles?.vorder ?? false}
                onChange={(_, d) => setSettings((s) => ({ ...s, fabricToggles: { vorder: d.checked, autotune: s.fabricToggles?.autotune ?? false, nativeExecution: s.fabricToggles?.nativeExecution ?? false } }))}
                label="V-Order (spark.sql.parquet.vorder.default)"
              />
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Fabric Spark only</MessageBarTitle>
                  V-Order is a write-time Parquet layout optimization available exclusively on Fabric
                  Spark runtimes. On the Azure-native path, OPTIMIZE runs standard Delta compaction without
                  V-Order encoding — this toggle is persisted but has no effect on Azure.{cloudFabricNote(cloud)}
                </MessageBarBody>
              </MessageBar>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
              <Switch
                checked={settings.fabricToggles?.autotune ?? false}
                onChange={(_, d) => setSettings((s) => ({ ...s, fabricToggles: { vorder: s.fabricToggles?.vorder ?? false, autotune: d.checked, nativeExecution: s.fabricToggles?.nativeExecution ?? false } }))}
                label="Autotune (spark.ms.autotune.enabled)"
              />
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Fabric Spark only</MessageBarTitle>
                  Autotune is a Fabric ML-based query optimizer compatible only with Fabric Runtime 1.2.
                  The key <code>spark.ms.autotune.enabled</code> is silently ignored on Azure Synapse
                  Spark pools and Databricks clusters.{cloudFabricNote(cloud)}
                </MessageBarBody>
              </MessageBar>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
              <Switch
                checked={settings.fabricToggles?.nativeExecution ?? false}
                onChange={(_, d) => setSettings((s) => ({ ...s, fabricToggles: { vorder: s.fabricToggles?.vorder ?? false, autotune: s.fabricToggles?.autotune ?? false, nativeExecution: d.checked } }))}
                label="Native execution engine (Velox / Apache Gluten)"
              />
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Fabric Spark only</MessageBarTitle>
                  The native execution engine (Velox + Apache Gluten vectorized C++) is exclusive to
                  Fabric Spark Runtime 1.3 and 2.0. It has no effect on Azure Synapse Spark or
                  Databricks. This toggle records intent for when the lakehouse is accessed from a Fabric
                  Spark session.{cloudFabricNote(cloud)}
                </MessageBarBody>
              </MessageBar>
            </div>

            <Field
              label="Spark conf (one KEY=VALUE per line)"
              hint="Keys under spark.ms.* or spark.sql.parquet.vorder.* are Fabric-only and have no effect on the Azure-native Spark path."
            >
              <Textarea
                rows={6}
                value={settingsSparkConfText}
                onChange={(_, d) => setSettingsSparkConfText(d.value)}
                placeholder={'spark.sql.shuffle.partitions=200\nspark.executor.memory=4g'}
              />
            </Field>
            {sparkConfigWarnings(settingsSparkConfText).map((w, i) => (
              <MessageBar key={`${w.intent}-${i}`} intent={w.intent}>
                <MessageBarBody><MessageBarTitle>{w.title}</MessageBarTitle>{w.body}</MessageBarBody>
              </MessageBar>
            ))}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setSettingsOpen(false)} disabled={settingsBusy}>Cancel</Button>
            <Button appearance="primary" onClick={saveSettings} disabled={settingsBusy}>
              {settingsBusy ? 'Saving…' : 'Save settings'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
