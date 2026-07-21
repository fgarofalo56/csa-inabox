'use client';
import {
  Caption1, Badge, Button, Spinner, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Input, Dropdown, Option,
} from '@fluentui/react-components';
import {
  SHORTCUT_SOURCE_CARDS, ShortcutSourceLogo, ExternalCredsForm, RemoteBrowseTree, SharePointBrowser,
  type CredSourceType,
} from '@/lib/components/onelake/shortcut-wizard';
import { useLakehouseCtx } from '../lakehouse-editor-context';
import type { ShortcutKind } from '../types';

export function ShortcutWizardDialog() {
  const ctx = useLakehouseCtx();
  const {
    scWizardOpen, setScWizardOpen, scStep, setScStep,
    scType, setScType,
    scAdlsMode, setScAdlsMode,
    scAcctHost, setScAcctHost, storageAccts, storageAcctsLoading,
    scAdlsContainer, setScAdlsContainer, scAdlsPath, setScAdlsPath,
    scInternalContainer, setScInternalContainer, scInternalPath, setScInternalPath, containers,
    scTargetUri, setScTargetUri,
    scExtSas, setScExtSas, scExtSasBusy, scExtSasErr, stashExternalSas,
    scKvSecret, setScKvSecret,
    extCreds, setExtCreds,
    scSpSelection, setScSpSelection,
    scKind, setScKind,
    scParentPath, setScParentPath,
    scName, setScName,
    scFormat, setScFormat,
    scTargetSchema, setScTargetSchema,
    scSubmitError, scSubmitting, submitShortcut,
    shortcutLakehouseId, schemas, schemasEnabled,
  } = ctx;

  return (
    <Dialog open={scWizardOpen} onOpenChange={(_, d) => setScWizardOpen(d.open)}>
      <DialogSurface style={{ maxWidth: '720px', width: '90vw' }}>
        <DialogBody>
          <DialogTitle>New shortcut — step {scStep} of 3</DialogTitle>
          <DialogContent>
            {scStep === 1 && (
              <>
                <Caption1>Choose the source to virtualize into <strong>{shortcutLakehouseId}</strong>. ADLS Gen2 and internal Loom lakehouse work on the Console UAMI; external clouds (S3, GCS, Dataverse) store credentials in Key Vault.</Caption1>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM }}>
                  {SHORTCUT_SOURCE_CARDS.map((src) => (
                    <Button
                      key={src.type}
                      appearance={scType === src.type ? 'primary' : 'outline'}
                      onClick={() => setScType(src.type)}
                      style={{ justifyContent: 'flex-start', height: 'auto', padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`, textAlign: 'left' }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' }}>
                        <ShortcutSourceLogo type={src.type} size={28} />
                        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: tokens.spacingVerticalXXS, minWidth: 0 }}>
                          <span style={{ fontWeight: tokens.fontWeightSemibold }}>{src.label}</span>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3, whiteSpace: 'normal' }}>{src.blurb}</Caption1>
                          <Badge appearance="tint" color={src.uamiReady ? 'success' : 'warning'} size="small">
                            {src.uamiReady ? 'UAMI-ready' : 'Key Vault credential'}
                          </Badge>
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              </>
            )}

            {scStep === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalMNudge }}>
                {scType === 'internal' && (
                  <>
                    <Field label="Source container (Loom lakehouse)" required>
                      <Dropdown
                        selectedOptions={scInternalContainer ? [scInternalContainer] : []}
                        value={scInternalContainer}
                        placeholder="Select a container"
                        onOptionSelect={(_, d) => setScInternalContainer(d.optionValue || '')}
                      >
                        {(containers || []).map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Source sub-path" hint="Relative to the container root, e.g. silver/partner_products">
                      <Input value={scInternalPath} onChange={(_, d) => setScInternalPath(d.value)} placeholder="folder/subfolder" />
                    </Field>
                  </>
                )}
                {scType === 'adls' && (
                  <>
                    <Field label="Source">
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                        <Button size="small" appearance={scAdlsMode === 'picker' ? 'primary' : 'outline'} onClick={() => setScAdlsMode('picker')}>In-tenant account</Button>
                        <Button size="small" appearance={scAdlsMode === 'external' ? 'primary' : 'outline'} onClick={() => setScAdlsMode('external')}>External (URI + SAS/key)</Button>
                      </div>
                    </Field>
                    {scAdlsMode === 'picker' ? (
                      <>
                        <Field label="Storage account" required hint={storageAcctsLoading ? 'Discovering accounts…' : 'ADLS Gen2 / Blob accounts you can access across the tenant'}>
                          <Dropdown
                            value={scAcctHost ? (storageAccts.find((a) => (a.dfsHost || a.blobHost) === scAcctHost)?.name || scAcctHost) : ''}
                            selectedOptions={scAcctHost ? [scAcctHost] : []}
                            placeholder={storageAcctsLoading ? 'Loading…' : 'Select a storage account'}
                            onOptionSelect={(_, d) => setScAcctHost(d.optionValue || '')}>
                            {storageAccts.map((a) => {
                              const host = a.dfsHost || (a.blobHost ? a.blobHost.replace(/\.blob\./i, '.dfs.') : '');
                              return <Option key={a.name} value={host} text={a.name}>{a.name}{a.isHns ? ' (ADLS Gen2)' : ' (Blob)'}{a.resourceGroup ? ` · ${a.resourceGroup}` : ''}</Option>;
                            })}
                          </Dropdown>
                        </Field>
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                          <Field label="Container / filesystem" required style={{ flex: 1 }}>
                            <Input value={scAdlsContainer} onChange={(_, d) => setScAdlsContainer(d.value)} placeholder="landing" />
                          </Field>
                          <Field label="Path" hint="folder under the container (optional)" style={{ flex: 1 }}>
                            <Input value={scAdlsPath} onChange={(_, d) => setScAdlsPath(d.value)} placeholder="eventhub-capture" />
                          </Field>
                        </div>
                        {scAcctHost && scAdlsContainer && (
                          <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                            abfss://{scAdlsContainer}@{scAcctHost}/{(extCreds.selectedPath || scAdlsPath).replace(/^\/+/, '')}
                          </Caption1>
                        )}
                        {scAcctHost && scAdlsContainer && (
                          <Field label="Browse remote objects" hint="Click a folder or file to set the path (runs on the Console UAMI).">
                            <RemoteBrowseTree
                              sourceType="adls"
                              account={scAcctHost.split('.')[0]}
                              container={scAdlsContainer}
                              onSelect={(path) => { setExtCreds((c) => ({ ...c, selectedPath: path })); setScAdlsPath(path); }}
                              selectedPath={extCreds.selectedPath}
                            />
                          </Field>
                        )}
                      </>
                    ) : (
                      <>
                        <Field label="Target URI" required
                          hint="abfss://<container>@<account>.dfs.core.windows.net/<path> — an external account the Console UAMI cannot read">
                          <Input value={scTargetUri} onChange={(_, d) => setScTargetUri(d.value)}
                            placeholder="abfss://data@acct.dfs.core.windows.net/partner/exports" />
                        </Field>
                        <Field label="SAS token" hint="Paste the account/service SAS (read+list). Saved to Key Vault — never stored on the shortcut row or echoed.">
                          <Input type="password" value={scExtSas} onChange={(_, d) => setScExtSas(d.value)}
                            placeholder="?sv=2024-…&ss=b&srt=co&sp=rl&sig=…"
                            contentAfter={
                              <Button size="small" appearance="primary" disabled={!scExtSas.trim() || scExtSasBusy}
                                icon={scExtSasBusy ? <Spinner size="tiny" /> : undefined} onClick={stashExternalSas}>
                                {scExtSasBusy ? 'Saving…' : 'Save to Key Vault'}
                              </Button>
                            } />
                        </Field>
                        {scExtSasErr && <MessageBar intent="error"><MessageBarBody>{scExtSasErr}</MessageBarBody></MessageBar>}
                        <Field label="Key Vault secret name" required hint="admin-plane Key Vault secret holding the external account's SAS/key.">
                          <Input value={scKvSecret} onChange={(_, d) => setScKvSecret(d.value)} placeholder="shortcut-ext-adls-sas" />
                        </Field>
                        {scKvSecret && (
                          <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>
                            Using Key Vault secret <code>{scKvSecret}</code> — the SAS is read server-side at create/test time.
                          </Caption1>
                        )}
                      </>
                    )}
                  </>
                )}
                {(scType === 's3' || scType === 'gcs' || scType === 'dataverse') && (
                  <>
                    <Field label="Shortcut name" required hint="Used to name the Key Vault secret and the shortcut.">
                      <Input value={scName} onChange={(_, d) => setScName(d.value)} placeholder={scType === 's3' ? 'partner_products' : scType === 'gcs' ? 'gcs_exports' : 'dataverse_accounts'} />
                    </Field>
                    <ExternalCredsForm
                      sourceType={scType as CredSourceType}
                      lakehouseId={shortcutLakehouseId}
                      shortcutName={scName}
                      value={extCreds}
                      onChange={setExtCreds}
                    />
                    <Field label="Browse remote objects" hint="Click a folder or file to set the shortcut target.">
                      <RemoteBrowseTree
                        sourceType={scType as CredSourceType}
                        bucket={extCreds.bucket}
                        region={extCreds.region}
                        kvSecret={extCreds.secretName}
                        onSelect={(path) => setExtCreds((c) => ({ ...c, selectedPath: path }))}
                        selectedPath={extCreds.selectedPath}
                      />
                    </Field>
                    {(scType === 's3' || scType === 'gcs') && extCreds.bucket && (
                      <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                        {scType === 's3' ? 's3' : 'gs'}://{extCreds.bucket}/{(extCreds.selectedPath || '').replace(/^\/+/, '')}
                      </Caption1>
                    )}
                  </>
                )}
                {scType === 'delta_sharing' && (
                  <>
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Delta Sharing (cross-tenant)</MessageBarTitle>
                        Authenticates with a credential file the share owner gives you via an activation link.
                        Store the raw JSON (<code>shareCredentialsVersion</code>, <code> endpoint</code>,{' '}
                        <code>bearerToken</code>, <code>expirationTime</code>) as a Key Vault secret and name it below.
                        Bearer tokens expire after at most 1 year — if the share goes <strong>Broken</strong>, update the
                        secret with a fresh file and use <strong>Retry</strong>.
                      </MessageBarBody>
                    </MessageBar>
                    <Field label="Share / table path" required hint="delta-sharing://<share>/<schema>/<table> — from the data provider">
                      <Input value={scTargetUri} onChange={(_, d) => setScTargetUri(d.value)}
                        placeholder="delta-sharing://agency_a_perf/analytics/metrics_monthly" />
                    </Field>
                    <Field label="Key Vault secret name (credential file JSON)" required hint="Holds the full credential JSON">
                      <Input value={scKvSecret} onChange={(_, d) => setScKvSecret(d.value)}
                        placeholder="delta-sharing-agency-a-cred" />
                    </Field>
                  </>
                )}
                {scType === 'sharepoint' && (
                  <>
                    <Field label="Shortcut name" required hint="Names the Files shortcut that surfaces this SharePoint/OneDrive content.">
                      <Input value={scName} onChange={(_, d) => { setScName(d.value); setScKind('files'); }} placeholder="finance_reports" />
                    </Field>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Browse Microsoft Graph on the Console identity — pick a SharePoint document library
                      folder/file or a OneDrive item. Content is virtualized zero-copy under <strong>Files</strong>;
                      no bytes are copied. SharePoint/OneDrive shortcuts are Files-only (Graph is a file API).
                    </Caption1>
                    <SharePointBrowser
                      onSelect={(sel) => {
                        setScSpSelection(sel);
                        setScKind('files');
                        if (!scName.trim() && sel.path) {
                          setScName((sel.path.split('/').filter(Boolean).pop() || '').replace(/[^A-Za-z0-9 _.-]/g, '_'));
                        }
                      }}
                      selected={scSpSelection ? { driveId: scSpSelection.driveId, path: scSpSelection.path } : undefined}
                    />
                  </>
                )}
              </div>
            )}

            {scStep === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalMNudge }}>
                <Field label="Section" required hint={scType === 'sharepoint' ? 'SharePoint / OneDrive content surfaces under Files (Graph is a file API).' : undefined}>
                  <Dropdown
                    selectedOptions={[scKind]}
                    value={scKind === 'tables' ? 'Tables' : 'Files'}
                    disabled={scType === 'sharepoint'}
                    onOptionSelect={(_, d) => setScKind((d.optionValue as ShortcutKind) || 'files')}
                  >
                    <Option value="files">Files</Option>
                    {scType !== 'sharepoint' && <Option value="tables">Tables</Option>}
                  </Dropdown>
                </Field>
                <Field label="Sub-folder" hint="Folder under the section, blank for top-level.">
                  <Input value={scParentPath} onChange={(_, d) => setScParentPath(d.value)} placeholder="optional/subfolder" />
                </Field>
                <Field label="Shortcut name" required>
                  <Input value={scName} onChange={(_, d) => setScName(d.value)} placeholder="partner_products" />
                </Field>
                {scKind === 'tables' && (
                  <Field label="Format" hint="Tables shortcuts register a real external table on Synapse Serverless or Databricks UC.">
                    <Dropdown selectedOptions={[scFormat]} value={scFormat}
                      onOptionSelect={(_, d) => setScFormat((d.optionValue as typeof scFormat) || 'delta')}>
                      <Option value="delta">Delta</Option>
                      <Option value="parquet">Parquet</Option>
                      <Option value="csv">CSV</Option>
                      <Option value="json">JSON</Option>
                    </Dropdown>
                  </Field>
                )}
                {scKind === 'tables' && schemasEnabled && (
                  <Field label="Target schema"
                    hint="The schema-enabled lakehouse places this Tables shortcut under the chosen schema (Tables/<schema>/). 'dbo' is the default.">
                    <Dropdown
                      selectedOptions={[scTargetSchema || 'dbo']}
                      value={scTargetSchema || 'dbo'}
                      onOptionSelect={(_, d) => setScTargetSchema(d.optionValue || 'dbo')}
                    >
                      {(schemas || []).map((sch) => (
                        <Option key={sch.name} value={sch.name}>{`${sch.name}${sch.isDefault ? ' (default)' : ''}`}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                )}
                <MessageBar intent="info">
                  <MessageBarBody>
                    Will create <strong>{scKind === 'tables' ? 'Tables' : 'Files'}/{[scParentPath.trim(), scName.trim()].filter(Boolean).join('/')}</strong>
                    {' '}pointing at <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{scType === 'internal' ? `internal://${scInternalContainer}${scInternalPath ? `/${scInternalPath.replace(/^\/+/, '')}` : ''}` : scType === 'sharepoint' ? (scSpSelection ? `sharepoint://${scSpSelection.driveId}/${scSpSelection.path}` : '(select a SharePoint/OneDrive item)') : (scTargetUri || '(set the target)')}</code>.
                    {scKind === 'tables' && ' A real external table is registered and queryable from the SQL tab.'}
                  </MessageBarBody>
                </MessageBar>
                {scSubmitError && (
                  <MessageBar intent="error"><MessageBarBody>{scSubmitError}</MessageBarBody></MessageBar>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setScWizardOpen(false)} disabled={scSubmitting}>Cancel</Button>
            {scStep > 1 && <Button appearance="outline" onClick={() => setScStep((scStep - 1) as 1 | 2 | 3)} disabled={scSubmitting}>Back</Button>}
            {scStep < 3 && <Button appearance="primary" onClick={() => setScStep((scStep + 1) as 1 | 2 | 3)}>Next</Button>}
            {scStep === 3 && (
              <Button appearance="primary" onClick={submitShortcut} disabled={scSubmitting || !scName.trim()}>
                {scSubmitting ? 'Creating…' : 'Create'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
