'use client';
import {
  Caption1, Body1, Badge, Button, Spinner, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Input, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from '@fluentui/react-components';
import {
  Database20Regular, Eye20Regular, Play20Regular, BookOpen20Regular, TableSimple20Regular,
  ArrowDownload20Regular, ShieldTask20Regular, Folder20Regular, LinkMultiple20Regular,
  ArrowSync20Regular, Info20Regular, Delete20Regular, Add20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import { useStyles, leafName, formatBytes } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

// ── Context Menu ──────────────────────────────────────────────────────────────
export function ContextMenu() {
  const ctx = useLakehouseCtx();
  const {
    ctxOpen, setCtxOpen, ctxEntry, ctxPos,
    selectFile, setTab, onOpenInNotebook, onLoadToTables, onDownload, openLabelDialog,
    loadPaths, activeContainer, openShortcutWizard, onDelete, setPropsEntry,
  } = ctx;

  return (
    <Menu
      open={ctxOpen}
      onOpenChange={(_, d) => setCtxOpen(d.open)}
      positioning={{ target: { getBoundingClientRect: () => ({
        x: ctxPos.x, y: ctxPos.y, left: ctxPos.x, top: ctxPos.y,
        right: ctxPos.x, bottom: ctxPos.y, width: 0, height: 0,
        toJSON: () => ({}),
      }) } as any }}
    >
      <MenuTrigger disableButtonEnhancement>
        <span style={{ position: 'fixed', left: ctxPos.x, top: ctxPos.y, width: 0, height: 0 }} />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {ctxEntry && !ctxEntry.isDirectory && (
            <>
              <MenuItem icon={<Eye20Regular />} onClick={() => { if (ctxEntry) { selectFile(ctxEntry); setTab('preview'); } setCtxOpen(false); }}>Preview</MenuItem>
              <MenuItem icon={<Play20Regular />} onClick={() => { if (ctxEntry) { selectFile(ctxEntry); setTab('sql'); } setCtxOpen(false); }}>Query this file</MenuItem>
              <MenuItem icon={<BookOpen20Regular />} onClick={() => { if (ctxEntry) onOpenInNotebook(ctxEntry); setCtxOpen(false); }}>Open in notebook</MenuItem>
              <MenuItem icon={<TableSimple20Regular />} onClick={() => { if (ctxEntry) onLoadToTables(ctxEntry); setCtxOpen(false); }}>Load to Tables (Delta)</MenuItem>
              <MenuItem icon={<ArrowDownload20Regular />} onClick={() => { if (ctxEntry) onDownload(ctxEntry); setCtxOpen(false); }}>Download</MenuItem>
              <MenuItem icon={<ShieldTask20Regular />} onClick={() => { if (ctxEntry) openLabelDialog(ctxEntry); setCtxOpen(false); }}>Download with label…</MenuItem>
            </>
          )}
          {ctxEntry && ctxEntry.isDirectory && (
            <>
              <MenuItem icon={<Folder20Regular />} onClick={() => { if (ctxEntry && activeContainer) loadPaths(activeContainer, ctxEntry.name); setCtxOpen(false); }}>Open</MenuItem>
              <MenuItem icon={<LinkMultiple20Regular />} onClick={() => {
                const folder = ctxEntry?.name || '';
                const isTables = /(^|\/)Tables(\/|$)/i.test(folder);
                const parent = folder.replace(/^Tables\/?|^Files\/?/i, '').replace(/\/+$/, '');
                setTab('shortcuts');
                openShortcutWizard(isTables ? 'tables' : 'files', parent);
                setCtxOpen(false);
              }}>New shortcut…</MenuItem>
              <MenuItem icon={<ArrowSync20Regular />} onClick={() => { if (ctxEntry && activeContainer) loadPaths(activeContainer, ctxEntry.name); setCtxOpen(false); }}>Refresh</MenuItem>
            </>
          )}
          <MenuItem icon={<Info20Regular />} onClick={() => { setPropsEntry(ctxEntry); setCtxOpen(false); }}>Properties</MenuItem>
          <MenuItem icon={<Delete20Regular />} onClick={() => { if (ctxEntry) onDelete(ctxEntry); setCtxOpen(false); }}>Delete</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

// ── Label Dialog ──────────────────────────────────────────────────────────────
export function LabelDialog() {
  const ctx = useLakehouseCtx();
  const {
    labelDlgOpen, setLabelDlgOpen, labelDlgEntry,
    mipLabels, mipLabelsLoading, mipLabelsError,
    chosenLabelId, setChosenLabelId, confirmLabelDownload,
  } = ctx;

  return (
    <Dialog open={labelDlgOpen} onOpenChange={(_, d) => { if (!d.open) setLabelDlgOpen(false); }}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <DialogBody>
          <DialogTitle>Download with sensitivity label</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1>
                Stamp a Microsoft Information Protection sensitivity label onto{' '}
                <strong>{labelDlgEntry ? leafName(labelDlgEntry.name) : ''}</strong> as it downloads.
                Supported for Office (.docx/.xlsx/.pptx) and PDF — other types download unstamped.
              </Caption1>
              {mipLabelsLoading && <Spinner size="small" label="Loading sensitivity labels…" labelPosition="after" />}
              {mipLabelsError && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Sensitivity labels unavailable</MessageBarTitle>
                    {mipLabelsError}
                  </MessageBarBody>
                </MessageBar>
              )}
              {!mipLabelsLoading && !mipLabelsError && mipLabels && mipLabels.length > 0 && (
                <Field label="Sensitivity label">
                  <Dropdown
                    placeholder="Select a label"
                    selectedOptions={chosenLabelId ? [chosenLabelId] : []}
                    value={(mipLabels.find((l) => l.id === chosenLabelId)?.displayName) || (mipLabels.find((l) => l.id === chosenLabelId)?.name) || ''}
                    onOptionSelect={(_, d) => setChosenLabelId(d.optionValue || '')}
                  >
                    {mipLabels.map((l) => (
                      <Option key={l.id} value={l.id} text={l.displayName || l.name || l.id}>
                        {l.displayName || l.name || l.id}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setLabelDlgOpen(false)}>Cancel</Button>
            <Button
              appearance="primary"
              icon={<ShieldTask20Regular />}
              disabled={!chosenLabelId}
              onClick={confirmLabelDownload}
            >
              Download with label
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Reference Picker ──────────────────────────────────────────────────────────
export function ReferencePickerDialog() {
  const ctx = useLakehouseCtx();
  const { pickerOpen, setPickerOpen, references, workspaceLakehouses, refsError, addReference, id } = ctx;

  return (
    <Dialog open={pickerOpen} onOpenChange={(_, d) => setPickerOpen(d.open)}>
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>Add reference lakehouse</DialogTitle>
          <DialogContent>
            <Caption1>
              Browse another lakehouse from this workspace side-by-side. Read actions use pass-through
              RBAC — the Console UAMI must hold <strong>Storage Blob Data Reader</strong> on the referenced
              containers. Write actions stay disabled on references.
            </Caption1>
            {refsError && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>{refsError}</MessageBarBody></MessageBar>
            )}
            {(() => {
              const referenced = new Set((references ?? []).map((r) => r.id));
              const addable = workspaceLakehouses.filter((lh) => lh.id !== id && !referenced.has(lh.id));
              return (
                <Table size="small" style={{ marginTop: tokens.spacingVerticalM }} aria-label="Workspace lakehouses">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Lakehouse</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {addable.map((lh) => (
                      <TableRow key={lh.id}>
                        <TableCell>
                          <Database20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                          {lh.displayName}
                        </TableCell>
                        <TableCell>
                          <Button size="small" appearance="primary"
                            onClick={() => { addReference(lh.id); setPickerOpen(false); }}>
                            Add
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {addable.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={2}>
                          <Caption1>No other lakehouses in this workspace, or all are already referenced.</Caption1>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              );
            })()}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setPickerOpen(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Properties Dialog ─────────────────────────────────────────────────────────
export function PropertiesDialog() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const { propsEntry, setPropsEntry, activeContainer } = ctx;

  return (
    <Dialog open={!!propsEntry} onOpenChange={(_, d) => { if (!d.open) setPropsEntry(null); }}>
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>Properties — {propsEntry ? leafName(propsEntry.name) : ''}</DialogTitle>
          <DialogContent>
            {propsEntry && (
              <Table size="small">
                <TableBody>
                  <TableRow><TableCell><strong>Name</strong></TableCell><TableCell className={s.cell}>{leafName(propsEntry.name)}</TableCell></TableRow>
                  <TableRow><TableCell><strong>Path</strong></TableCell><TableCell className={s.cell} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>/{propsEntry.name}</TableCell></TableRow>
                  <TableRow><TableCell><strong>Container</strong></TableCell><TableCell className={s.cell}>{activeContainer}</TableCell></TableRow>
                  <TableRow><TableCell><strong>Type</strong></TableCell><TableCell>{propsEntry.isDirectory ? 'Directory' : 'File'}</TableCell></TableRow>
                  {!propsEntry.isDirectory && <TableRow><TableCell><strong>Size</strong></TableCell><TableCell className={s.cell}>{formatBytes(propsEntry.size)}</TableCell></TableRow>}
                  <TableRow><TableCell><strong>Last modified</strong></TableCell><TableCell className={s.cell}>{propsEntry.lastModified ? new Date(propsEntry.lastModified).toLocaleString() : '—'}</TableCell></TableRow>
                  {propsEntry.etag && <TableRow><TableCell><strong>ETag</strong></TableCell><TableCell className={s.cell} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{propsEntry.etag}</TableCell></TableRow>}
                </TableBody>
              </Table>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setPropsEntry(null)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Share Dialog ──────────────────────────────────────────────────────────────
export function ShareDialog() {
  const ctx = useLakehouseCtx();
  const {
    shareOpen, setShareOpen, sharePrincipal, setSharePrincipal,
    sharePrincipalType, setSharePrincipalType, shareRole, setShareRole,
    shareError, shareSuccess, setShareError, setShareSuccess, shareBusy, grantShare,
    activeContainer,
  } = ctx;

  return (
    <Dialog open={shareOpen} onOpenChange={(_, d) => {
      setShareOpen(d.open);
      if (!d.open) { setSharePrincipal(''); setShareError(null); setShareSuccess(null); }
    }}>
      <DialogSurface style={{ maxWidth: '560px' }}>
        <DialogBody>
          <DialogTitle>Share — {activeContainer || 'lakehouse'}</DialogTitle>
          <DialogContent>
            <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
              Grant a user, group, or service principal access to this lakehouse
              container via Azure RBAC. Provide the Entra ID object id of the
              recipient. Sharing is applied directly on the storage scope — no
              Fabric or Power BI workspace is involved.
            </Caption1>
            {shareError && (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>Share failed</MessageBarTitle>{shareError}</MessageBarBody>
              </MessageBar>
            )}
            {shareSuccess && (
              <MessageBar intent="success">
                <MessageBarBody>{shareSuccess}</MessageBarBody>
              </MessageBar>
            )}
            <Field label="Principal object id" required hint="Entra ID user, group, or service principal object id (GUID)">
              <Input
                value={sharePrincipal}
                onChange={(_, d) => setSharePrincipal(d.value)}
                placeholder="11111111-2222-3333-4444-555555555555"
              />
            </Field>
            <Field label="Principal type" style={{ marginTop: tokens.spacingVerticalS }}>
              <Dropdown
                selectedOptions={[sharePrincipalType]}
                value={sharePrincipalType}
                onOptionSelect={(_, d) => setSharePrincipalType((d.optionValue as any) || 'User')}
              >
                <Option value="User">User</Option>
                <Option value="Group">Group</Option>
                <Option value="ServicePrincipal">Service principal</Option>
              </Dropdown>
            </Field>
            <Field label="Permission level" style={{ marginTop: tokens.spacingVerticalS }}>
              <Dropdown
                selectedOptions={[shareRole]}
                value={shareRole}
                onOptionSelect={(_, d) => setShareRole(d.optionValue || shareRole)}
              >
                <Option value="Storage Blob Data Reader">Read (Storage Blob Data Reader)</Option>
                <Option value="Storage Blob Data Contributor">Read + Write (Storage Blob Data Contributor)</Option>
                <Option value="Storage Blob Data Owner">Full control (Storage Blob Data Owner)</Option>
              </Dropdown>
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={shareBusy} onClick={() => setShareOpen(false)}>Cancel</Button>
            <Button appearance="primary" disabled={shareBusy || !sharePrincipal.trim()} onClick={grantShare}>
              {shareBusy ? 'Granting…' : 'Grant access'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Data Agent Dialog ─────────────────────────────────────────────────────────
export function DataAgentDialog() {
  const ctx = useLakehouseCtx();
  const {
    daOpen, setDaOpen, daAgents, daLoadErr, daMsg, daSel, setDaSel, daBusy, addToAgent,
    id, itemQ,
  } = ctx;
  const router = useRouter();

  return (
    <Dialog open={daOpen} onOpenChange={(_, d) => setDaOpen(d.open)}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <DialogBody>
          <DialogTitle>Add lakehouse to a data agent</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Body1>
                Ground a data agent on <strong>{itemQ.data?.displayName || `lakehouse-${id}`}</strong> so it
                can answer natural-language questions over its Delta tables. Open the agent&apos;s Build tab
                after adding to pick tables and write grounding instructions.
              </Body1>
              {daLoadErr && (
                <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not list data agents</MessageBarTitle>{daLoadErr}</MessageBarBody></MessageBar>
              )}
              {daMsg && (
                <MessageBar intent={daMsg.intent}><MessageBarBody>{daMsg.text}</MessageBarBody></MessageBar>
              )}
              {daAgents === null && !daLoadErr && <Spinner size="tiny" label="Loading data agents…" labelPosition="after" />}
              {daAgents !== null && daAgents.length === 0 && (
                <MessageBar intent="info"><MessageBarBody>No data agents yet. Create one, then return to add this lakehouse as a source.</MessageBarBody></MessageBar>
              )}
              {daAgents !== null && daAgents.length > 0 && (
                <Field label="Data agent">
                  <Dropdown
                    placeholder="Select a data agent"
                    selectedOptions={daSel ? [daSel] : []}
                    value={daAgents.find((a) => a.id === daSel)?.displayName || ''}
                    onOptionSelect={(_, d) => setDaSel(d.optionValue || '')}
                  >
                    {daAgents.map((a) => <Option key={a.id} value={a.id}>{a.displayName}</Option>)}
                  </Dropdown>
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" icon={<Add20Regular />} onClick={() => router.push('/items/data-agent/new')}>New data agent</Button>
            <Button appearance="subtle" onClick={() => setDaOpen(false)}>Close</Button>
            <Button appearance="primary" disabled={!daSel || daBusy} icon={daBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={() => void addToAgent()}>Add as source</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Move Table to Schema ──────────────────────────────────────────────────────
export function MoveTableDialog() {
  const ctx = useLakehouseCtx();
  const {
    moveTableOpen, setMoveTableOpen,
    moveTableName, moveTableFrom, moveTableTo, setMoveTableTo,
    moveTableBusy, moveTableStatus, moveTableError, submitMoveTable, schemas,
  } = ctx;

  return (
    <Dialog open={moveTableOpen} onOpenChange={(_, d) => setMoveTableOpen(d.open)}>
      <DialogSurface style={{ maxWidth: 480 }}>
        <DialogBody>
          <DialogTitle>Move table to schema</DialogTitle>
          <DialogContent>
            <Field label="Table">
              <Input value={moveTableName} readOnly />
            </Field>
            <Field label="From schema">
              <Input value={moveTableFrom} readOnly />
            </Field>
            <Field label="To schema" required hint="Pick the destination schema. Create new schemas in the Schemas tab.">
              <Dropdown
                selectedOptions={moveTableTo ? [moveTableTo] : []}
                value={moveTableTo}
                placeholder="Select a schema"
                onOptionSelect={(_, d) => setMoveTableTo(d.optionValue || '')}
              >
                {(schemas || []).filter((sch) => sch.name !== moveTableFrom).map((sch) => (
                  <Option key={sch.name} value={sch.name}>{`${sch.name}${sch.isDefault ? ' (default)' : ''}`}</Option>
                ))}
              </Dropdown>
            </Field>
            <MessageBar intent="info">
              <MessageBarBody>
                Runs <code>ALTER TABLE {moveTableFrom}.{moveTableName} RENAME TO {moveTableTo || '<schema>'}.{moveTableName}</code> on the Spark pool.
                The table stays queryable via its new 4-part name.
              </MessageBarBody>
            </MessageBar>
            {moveTableStatus && <MessageBar intent="success"><MessageBarBody>{moveTableStatus}</MessageBarBody></MessageBar>}
            {moveTableError && <MessageBar intent="error"><MessageBarBody>{moveTableError}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setMoveTableOpen(false)} disabled={moveTableBusy}>Close</Button>
            <Button appearance="primary" onClick={submitMoveTable}
              disabled={moveTableBusy || !moveTableTo.trim() || moveTableTo === moveTableFrom}>
              {moveTableBusy ? 'Moving…' : 'Move'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Semantic Model Gate ───────────────────────────────────────────────────────
export function SemanticModelGateDialog() {
  const ctx = useLakehouseCtx();
  const { semanticModelGateOpen, setSemanticModelGateOpen, setTab } = ctx;

  return (
    <Dialog open={semanticModelGateOpen} onOpenChange={(_, d) => setSemanticModelGateOpen(d.open)}>
      <DialogSurface style={{ maxWidth: '600px' }}>
        <DialogBody>
          <DialogTitle>New semantic model</DialogTitle>
          <DialogContent>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Requires Power BI / Fabric capacity</MessageBarTitle>
                In Microsoft Fabric, a Lakehouse semantic model uses{' '}
                <strong>DirectLake</strong> storage mode — the model reads Delta
                Parquet directly from OneLake without import. That path needs a
                Fabric capacity (F2+) and the Lakehouse SQL analytics endpoint, so
                it has no Azure-native 1:1 and is intentionally not provisioned here.
                <br /><br />
                <strong>Azure-native path (no Fabric capacity):</strong> connect
                Power BI Desktop to this lakehouse over the Synapse Serverless SQL
                endpoint (<code>&lt;workspace&gt;-ondemand.sql.azuresynapse.net</code>)
                using Import or DirectQuery, then publish. Or use{' '}
                <strong>Analyze data → SQL endpoint</strong> on this ribbon to
                query the Delta tables with T-SQL and build reports from there.
              </MessageBarBody>
            </MessageBar>
            <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
              If your org runs a Fabric capacity alongside Loom, set{' '}
              <code>LOOM_LAKEHOUSE_BACKEND=fabric</code> with a bound workspace to
              enable the native "New semantic model" command — it stays strictly
              opt-in and never gates the default Azure-native lakehouse.
            </Caption1>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setSemanticModelGateOpen(false)}>Close</Button>
            <Button
              appearance="primary"
              icon={<Database20Regular />}
              onClick={() => { setSemanticModelGateOpen(false); setTab('sql'); }}
            >
              Open SQL endpoint
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
