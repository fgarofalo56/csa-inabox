'use client';
import {
  Caption1, Spinner, Badge, Button, Subtitle2, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Input, Field,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Add20Regular, Delete20Regular, Database20Regular } from '@fluentui/react-icons';
import { useStyles } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

export function SchemasPane() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    shortcutLakehouseId, schemasEnabled, schemas, schemasBusy, schemasError,
    loadSchemas, deleteSchema,
    newSchemaOpen, setNewSchemaOpen, newSchemaName, setNewSchemaName,
    newSchemaDesc, setNewSchemaDesc, newSchemaBusy, newSchemaError, createSchema,
  } = ctx;

  return (
    <>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">{shortcutLakehouseId || 'no lakehouse'}</Badge>
        <Caption1>
          Multi-schema namespace — <code>workspace.lakehouse.schema.table</code>. <strong>dbo</strong> is the default (immutable).
        </Caption1>
        <Button appearance="primary" icon={<Add20Regular />}
          disabled={!schemasEnabled || !shortcutLakehouseId}
          onClick={() => { setNewSchemaName(''); setNewSchemaDesc(''); setNewSchemaOpen(true); }}
          style={{ marginLeft: 'auto' }}>
          New schema
        </Button>
        <Button appearance="outline" icon={<ArrowSync20Regular />}
          disabled={schemasBusy || !shortcutLakehouseId} onClick={loadSchemas}>
          Refresh
        </Button>
      </div>
      {!schemasEnabled && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Schemas are disabled for this lakehouse</MessageBarTitle>
            Enable <strong>Schemas enabled</strong> in the Settings dialog (gear icon) to use
            multi-schema namespaces. Schema DDL runs on a Synapse Spark pool via Livy — set
            <code> LOOM_SYNAPSE_WORKSPACE</code> (and grant the Console UAMI Synapse Administrator)
            to execute it. The catalog still records schemas without it.
          </MessageBarBody>
        </MessageBar>
      )}
      {schemasError && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Schemas error</MessageBarTitle>{schemasError}</MessageBarBody></MessageBar>
      )}
      {schemasBusy && schemas === null && <Spinner size="small" label="Loading schemas…" labelPosition="after" />}
      {schemas !== null && (
        <div className={s.tableWrap}>
          <Table aria-label="Lakehouse schemas" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Schema</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Description</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schemas.map((sc) => (
                <TableRow key={sc.name}>
                  <TableCell>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                      <Database20Regular />
                      <strong>{sc.name}</strong>
                      {sc.isDefault && <Badge appearance="tint" color="informative" size="small">default</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>
                    {sc.status === 'active' && <Badge appearance="tint" color="success" size="small">active</Badge>}
                    {sc.status === 'pending' && <Badge appearance="tint" color="warning" size="small" title={sc.statusDetail}>pending</Badge>}
                    {sc.status === 'error' && <Badge appearance="tint" color="danger" size="small" title={sc.statusDetail}>error</Badge>}
                  </TableCell>
                  <TableCell><Caption1>{sc.description || '—'}</Caption1></TableCell>
                  <TableCell>
                    {!sc.isDefault && (
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                        disabled={schemasBusy} onClick={() => deleteSchema(sc.name)}>
                        Delete
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* New schema dialog (F9) */}
      <Dialog open={newSchemaOpen} onOpenChange={(_, d) => setNewSchemaOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 480 }}>
          <DialogBody>
            <DialogTitle>New schema</DialogTitle>
            <DialogContent>
              <Field label="Schema name" required
                hint="Letters, digits, and underscores only. 'dbo' is reserved (the immutable default).">
                <Input
                  value={newSchemaName}
                  onChange={(_, d) => setNewSchemaName(d.value)}
                  placeholder="marketing"
                />
              </Field>
              <Field label="Description">
                <Input value={newSchemaDesc} onChange={(_, d) => setNewSchemaDesc(d.value)} placeholder="Marketing-domain tables" />
              </Field>
              <MessageBar intent="info">
                <MessageBarBody>
                  Runs <code>CREATE SCHEMA IF NOT EXISTS</code> on the Synapse Spark pool via Livy and adds it to the catalog.
                  Tables placed here are addressable as <code>{shortcutLakehouseId}.{newSchemaName || '<schema>'}.&lt;table&gt;</code>.
                </MessageBarBody>
              </MessageBar>
              {newSchemaError && <MessageBar intent="error"><MessageBarBody>{newSchemaError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setNewSchemaOpen(false)} disabled={newSchemaBusy}>Cancel</Button>
              <Button appearance="primary" onClick={createSchema}
                disabled={newSchemaBusy || !newSchemaName.trim() || !/^[A-Za-z0-9_]+$/.test(newSchemaName) || newSchemaName === 'dbo'}>
                {newSchemaBusy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
