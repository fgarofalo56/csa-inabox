'use client';
import {
  Caption1, Spinner, Badge, Button, Subtitle2, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Database20Regular, Folder20Regular, Eye20Regular, Play20Regular,
  TableSimple20Regular, TableSimple20Filled, History20Regular, Wrench20Regular,
  ArrowUpload20Regular, DocumentTable20Regular,
  CheckmarkCircle20Filled, ErrorCircle20Filled, Clock20Regular,
} from '@fluentui/react-icons';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { useStyles, formatBytes, leafName } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';
import type { LiveCatalogTable } from '../types';
import type { PathEntry } from '../shared';

export function TablesPane() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    activeContainer, schemasEnabled, shortcutLakehouseId,
    liveTables, liveTablesLoading, liveTablesError, liveTablesGate, loadLiveTables,
    seededTableInfo, bundleDeltaTables,
    openPrefixes, cacheKey, loadPaths,
    previewTable, setSqlText, setTab, openTableHistory, setMaintainTable, setMaintainOpen, openMoveTable,
  } = ctx;

  return (
    <>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">{activeContainer || 'no container'}</Badge>
        <Caption1>Live Delta catalog — real <code>_delta_log</code> scan of <code>/Tables/</code></Caption1>
        <Button appearance="outline" icon={<ArrowSync20Regular />}
          disabled={!activeContainer || liveTablesLoading}
          onClick={() => loadLiveTables()}>
          Refresh
        </Button>
      </div>
      {(() => {
        if (!activeContainer) return <Caption1>Select a container.</Caption1>;
        if (liveTablesLoading && liveTables === null) {
          return <Spinner size="small" label="Scanning Delta catalog…" labelPosition="after" />;
        }
        if (liveTablesError) {
          return (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Could not scan tables</MessageBarTitle>
                {liveTablesError}
              </MessageBarBody>
            </MessageBar>
          );
        }
        if (liveTablesGate) {
          return (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Lakehouse storage not configured</MessageBarTitle>
                {liveTablesGate}
              </MessageBarBody>
            </MessageBar>
          );
        }
        const tables = liveTables ?? [];
        if (tables.length === 0) {
          // Honest empty — no fabricated rows. Offer the bundle's planned
          // tables (if any) as a "what to materialize" reference only.
          return (
            <>
              {/* App-install seeded tables — REAL seed CSVs the install
                  provisioner wrote under a nested lakehouse path the
                  root `/Tables/` scan doesn't reach. Honest: name +
                  seeded row count + the CSV path. */}
              {seededTableInfo && seededTableInfo.length > 0 && (
                <>
                  <MessageBar intent="success">
                    <MessageBarBody>
                      <MessageBarTitle>App-seeded tables</MessageBarTitle>
                      This lakehouse was seeded by the installed app. These tables live under{' '}
                      <code>/{activeContainer}/{seededTableInfo[0].csvPath.replace(/\/Tables\/.*$/, '')}/Tables/</code> as
                      CSV seed data; run the Gold/Silver notebook to materialize them as managed Delta.
                    </MessageBarBody>
                  </MessageBar>
                  <div className={s.tableWrap}>
                    <Table aria-label="App-seeded tables" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Table</TableHeaderCell>
                          <TableHeaderCell>Seeded rows</TableHeaderCell>
                          <TableHeaderCell>CSV path</TableHeaderCell>
                          <TableHeaderCell></TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {seededTableInfo.map((t) => (
                          <TableRow key={t.name}>
                            <TableCell><strong>{t.name}</strong></TableCell>
                            <TableCell className={s.cell}>{t.rowCount ?? '—'}</TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100, overflowWrap: 'anywhere' }}>{t.container}/{t.csvPath}</code></TableCell>
                            <TableCell>
                              <Button appearance="subtle" size="small" icon={<Play20Regular />}
                                onClick={() => {
                                  setSqlText(`-- Read the app-seeded CSV for ${t.name}\nSELECT TOP 100 *\nFROM OPENROWSET(BULK 'https://__account__.dfs.core.windows.net/${t.container}/${t.csvPath}', FORMAT='CSV', PARSER_VERSION='2.0', HEADER_ROW=TRUE) AS r;`);
                                  setTab('sql');
                                }}>
                                Query CSV
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
              {/* Guided empty state (SC-4) — Fabric's "This database is
                  empty. Get data" launcher. Each path is a real action. */}
              <GuidedEmptyState
                variant="block"
                heroIcon={TableSimple20Regular}
                title="This lakehouse has no tables yet"
                intro={<>No Delta tables under <strong>/{activeContainer}/Tables/</strong>. Bring in data, then materialize it as a Delta table.</>}
                ariaLabel="Get data into this lakehouse"
                paths={[
                  {
                    key: 'upload', title: 'Upload data files',
                    body: 'Go to the Files tab to upload Parquet, CSV, or JSON — then Load to Tables (Delta).',
                    icon: ArrowUpload20Regular, onClick: () => setTab('files'),
                  },
                  {
                    key: 'load', title: 'Load an existing file to Delta',
                    body: 'Right-click a file in Files and choose Load to Tables (Delta) to materialize a table.',
                    icon: DocumentTable20Regular, onClick: () => setTab('files'),
                  },
                ]}
                learnMoreHref="https://learn.microsoft.com/azure/databricks/delta/"
              />
              {bundleDeltaTables.length > 0 && (
                <>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalM }}>
                    <strong>Planned tables from the installed app bundle</strong> — run the load/DDL in a
                    notebook against the live lakehouse to materialize these.
                  </Caption1>
                  <div className={s.tableWrap}>
                    <Table aria-label="Planned Delta tables" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Table</TableHeaderCell>
                          <TableHeaderCell>DDL</TableHeaderCell>
                          <TableHeaderCell>Sample rows</TableHeaderCell>
                          <TableHeaderCell></TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bundleDeltaTables.map((t) => (
                          <TableRow key={t.name}>
                            <TableCell><strong>{t.name}</strong></TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.ddl}</code></TableCell>
                            <TableCell className={s.cell}>{t.sampleRows?.length ?? 0}</TableCell>
                            <TableCell>
                              <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                  <Button appearance="subtle" size="small">…</Button>
                                </MenuTrigger>
                                <MenuPopover>
                                  <MenuList>
                                    <MenuItem icon={<Play20Regular />}
                                      onClick={() => {
                                        setSqlText(`-- Read Delta table (once materialized under Tables/${t.name})\nSELECT TOP 100 *\nFROM OPENROWSET(BULK 'https://__account__.dfs.core.windows.net/${activeContainer || '<container>'}/Tables/${t.name}', FORMAT='DELTA') AS r;`);
                                        setTab('sql');
                                      }}>
                                      Query template
                                    </MenuItem>
                                    <MenuItem icon={<History20Regular />}
                                      disabled={!activeContainer}
                                      onClick={() => openTableHistory(`Tables/${t.name}`)}>
                                      History (time travel)
                                    </MenuItem>
                                    <MenuItem icon={<Wrench20Regular />}
                                      disabled={!activeContainer}
                                      title={!activeContainer ? 'Select a container first' : 'OPTIMIZE / VACUUM / ZORDER BY'}
                                      onClick={() => { setMaintainTable(t.name); setMaintainOpen(true); }}>
                                      Maintain…
                                    </MenuItem>
                                  </MenuList>
                                </MenuPopover>
                              </Menu>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </>
          );
        }
        // F9 — schema-enabled lakehouse: the Tables/ children are
        // schema folders; tables live one level deeper under
        // Tables/<schema>/. Render schema groups, each lazily loading
        // its tables, with a "Move to schema…" action per table.
        if (schemasEnabled) {
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1>
                Schema-enabled lakehouse — tables are grouped by schema. Manage schemas in the <strong>Schemas</strong> tab.
              </Caption1>
              {tables.map((schemaDir) => {
                const schemaName = leafName(schemaDir.name);
                const childKey = cacheKey(activeContainer, schemaDir.name);
                const childListing = openPrefixes[childKey];
                const childTables = childListing && childListing !== 'loading' && !('error' in (childListing as object))
                  ? (childListing as PathEntry[]).filter((e) => e.isDirectory) : [];
                return (
                  <div key={schemaDir.name} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS }}>
                      <Database20Regular />
                      <Subtitle2>{schemaName}</Subtitle2>
                      {schemaName === 'dbo' && <Badge appearance="tint" color="informative" size="small">default</Badge>}
                      <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />}
                        onClick={() => loadPaths(activeContainer, schemaDir.name)} style={{ marginLeft: 'auto' }}>
                        {childListing ? 'Refresh' : 'Load tables'}
                      </Button>
                    </div>
                    {childListing === 'loading' && <Spinner size="tiny" label="Listing tables…" labelPosition="after" />}
                    {childListing && childListing !== 'loading' && 'error' in (childListing as object) && (
                      <Caption1>{(childListing as { error: string }).error}</Caption1>
                    )}
                    {childListing && childListing !== 'loading' && !('error' in (childListing as object)) && (
                      childTables.length === 0
                        ? <Caption1>No tables in this schema yet.</Caption1>
                        : (
                          <Table aria-label={`Tables in ${schemaName}`} size="small">
                            <TableHeader>
                              <TableRow>
                                <TableHeaderCell>Table</TableHeaderCell>
                                <TableHeaderCell>4-part name</TableHeaderCell>
                                <TableHeaderCell></TableHeaderCell>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {childTables.map((t) => {
                                const tableName = leafName(t.name);
                                return (
                                  <TableRow key={t.name}>
                                    <TableCell><strong>{tableName}</strong></TableCell>
                                    <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{shortcutLakehouseId}.{schemaName}.{tableName}</code></TableCell>
                                    <TableCell>
                                      <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalS }}>
                                        <Button size="small" appearance="primary" icon={<Eye20Regular />}
                                          title="Sample 1,000 rows"
                                          onClick={() => previewTable(t.name)}>
                                          Preview
                                        </Button>
                                        <Button size="small" appearance="outline"
                                          onClick={() => {
                                            setSqlText(`-- 4-part name: ${shortcutLakehouseId}.${schemaName}.${tableName}\n-- Serverless view (if registered): SELECT TOP 100 * FROM loom_lakehouse.${schemaName}.${tableName};\nSELECT TOP 100 *\nFROM OPENROWSET(BULK 'https://__account__.dfs.core.windows.net/${activeContainer}/${t.name}', FORMAT='DELTA') AS r;`);
                                            setTab('sql');
                                          }}>
                                          Query
                                        </Button>
                                        <Button size="small" appearance="outline" icon={<TableSimple20Regular />}
                                          onClick={() => openMoveTable(tableName, schemaName)}>
                                          Move to schema…
                                        </Button>
                                        <Button size="small" appearance="outline" icon={<History20Regular />}
                                          onClick={() => openTableHistory(t.name)}>
                                          History
                                        </Button>
                                        <Button size="small" appearance="outline" icon={<Wrench20Regular />}
                                          disabled={!activeContainer}
                                          title={!activeContainer ? 'Select a container first' : 'OPTIMIZE / VACUUM / ZORDER BY'}
                                          onClick={() => { setMaintainTable(t.name); setMaintainOpen(true); }}>
                                          Maintain…
                                        </Button>
                                      </span>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        )
                    )}
                  </div>
                );
              })}
            </div>
          );
        }
        // Group by schema (container) for a Fabric-explorer-style layout.
        const bySchema = tables.reduce<Record<string, LiveCatalogTable[]>>((acc, t) => {
          (acc[t.schema] ??= []).push(t); return acc;
        }, {});
        const statusIcon = (st: LiveCatalogTable['status']) =>
          st === 'ok' ? <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />
          : st === 'broken' ? <ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />
          : <Clock20Regular style={{ color: tokens.colorPaletteYellowForeground1 }} />;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
            {Object.entries(bySchema).map(([schema, schemaTables]) => (
              <div key={schema}>
                <Subtitle2 style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS }}>
                  <Database20Regular /> {schema} <Caption1>({schemaTables.length})</Caption1>
                </Subtitle2>
                <div className={s.tableWrap}>
                  <Table aria-label={`Tables in ${schema}`} size="small">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Table</TableHeaderCell>
                        <TableHeaderCell>Format</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Version</TableHeaderCell>
                        <TableHeaderCell>Rows</TableHeaderCell>
                        <TableHeaderCell>Size</TableHeaderCell>
                        <TableHeaderCell>Modified</TableHeaderCell>
                        <TableHeaderCell></TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {schemaTables.map((t) => (
                        <TableRow key={t.adlsPath}>
                          <TableCell>
                            {t.format === 'delta'
                              ? <TableSimple20Filled style={{ color: tokens.colorPaletteBlueForeground2, verticalAlign: 'text-bottom' }} />
                              : <Folder20Regular style={{ color: tokens.colorPaletteMarigoldForeground2, verticalAlign: 'text-bottom' }} />}{' '}
                            <strong>{t.name}</strong>
                          </TableCell>
                          <TableCell>
                            <Badge appearance={t.format === 'delta' ? 'filled' : 'outline'}
                              color={t.format === 'delta' ? 'brand' : 'informative'} size="small">
                              {t.format}
                            </Badge>
                          </TableCell>
                          <TableCell title={t.status}>{statusIcon(t.status)}</TableCell>
                          <TableCell className={s.cell}>{typeof t.latestVersion === 'number' ? `v${t.latestVersion}` : '—'}</TableCell>
                          <TableCell className={s.cell}>{typeof t.rowCount === 'number' ? t.rowCount.toLocaleString() : '—'}</TableCell>
                          <TableCell className={s.cell}>{typeof t.sizeBytes === 'number' ? formatBytes(t.sizeBytes) : '—'}</TableCell>
                          <TableCell className={s.cell}>{t.lastModified ? new Date(t.lastModified).toLocaleString() : '—'}</TableCell>
                          <TableCell>
                            <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalS }}>
                              <Button size="small" appearance="primary"
                                disabled={t.format !== 'delta'}
                                icon={<Eye20Regular />}
                                title={t.format !== 'delta' ? 'Preview available for Delta tables' : 'Sample 1,000 rows'}
                                onClick={() => previewTable(t.adlsPath)}>
                                Preview
                              </Button>
                              <Button size="small" appearance="outline"
                                disabled={t.format !== 'delta'}
                                title={t.format !== 'delta' ? 'OPENROWSET DELTA query available for Delta tables' : undefined}
                                onClick={() => {
                                  setSqlText(`-- Read Delta table ${t.schema}.${t.name}\nSELECT TOP 100 *\nFROM OPENROWSET(BULK '${t.bulkUrl}', FORMAT='DELTA') AS r;`);
                                  setTab('sql');
                                }}>
                                Query
                              </Button>
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))}
          </div>
        );
      })()}
    </>
  );
}
