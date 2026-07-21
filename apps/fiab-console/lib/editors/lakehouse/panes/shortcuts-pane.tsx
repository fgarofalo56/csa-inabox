'use client';
import {
  Caption1, Spinner, Badge, Button, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, CloudLink20Regular,
  CheckmarkCircle20Filled, ErrorCircle20Filled, Clock20Regular,
  Play20Regular, Delete20Regular,
} from '@fluentui/react-icons';
import { useStyles } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

export function ShortcutsPane() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    shortcutLakehouseId, shortcuts, shortcutsBusy, shortcutsError, loadShortcuts,
    selectedShortcut, setSelectedShortcut,
    openShortcutWizard, testShortcut, deleteShortcutRow, queryShortcut,
    bundleShortcuts, regBusy, registerBundleShortcut, registerAllBundleShortcuts,
    setSqlText, setTab,
  } = ctx;

  return (
    <div
      onKeyDown={(e) => {
        // F11 retries the selected broken shortcut (re-test/restore).
        if (e.key === 'F11' && selectedShortcut && selectedShortcut.status === 'error' && !shortcutsBusy) {
          e.preventDefault();
          testShortcut(selectedShortcut);
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 }}
    >
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">{shortcutLakehouseId || 'no lakehouse'}</Badge>
        <Caption1>Shortcuts — virtualize external storage into the lakehouse without copying data (zero-copy)</Caption1>
        <Button appearance="primary" icon={<Add20Regular />} disabled={!shortcutLakehouseId}
          onClick={() => openShortcutWizard()} style={{ marginLeft: 'auto' }}>
          New shortcut
        </Button>
        <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!shortcutLakehouseId || shortcutsBusy}
          onClick={loadShortcuts}>
          Refresh
        </Button>
      </div>

      {shortcutsError && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Shortcuts error</MessageBarTitle>{shortcutsError}</MessageBarBody></MessageBar>
      )}
      {shortcutsBusy && shortcuts === null && <Spinner size="small" label="Loading shortcuts…" labelPosition="after" />}

      {shortcuts !== null && shortcuts.length === 0 && !shortcutsBusy && (
        <>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>No shortcuts registered yet</MessageBarTitle>
              Click <strong>New shortcut</strong> to virtualize an ADLS Gen2 path, another
              Loom lakehouse, S3, GCS, or Dataverse into this lakehouse — without copying data.
              ADLS Gen2 and internal Loom lakehouse work today on the Console UAMI;
              external clouds prompt for a Key Vault credential.
            </MessageBarBody>
          </MessageBar>
          {bundleShortcuts.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM }}>
                <Caption1 style={{ display: 'block' }}>
                  <strong>Planned shortcuts from the installed app bundle</strong> — register each into the live backend.
                </Caption1>
                <Button size="small" appearance="primary" style={{ marginLeft: 'auto' }}
                  onClick={registerAllBundleShortcuts} disabled={!!regBusy}>
                  {regBusy ? 'Registering…' : 'Register all'}
                </Button>
              </div>
              <div className={s.tableWrap}>
                <Table aria-label="Planned shortcuts" size="small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Target</TableHeaderCell>
                      <TableHeaderCell>Description</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bundleShortcuts.map((sc) => {
                      const live = (shortcuts || []).some((x) => x.name === sc.name);
                      return (
                        <TableRow key={sc.name}>
                          <TableCell>
                            <CloudLink20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                            <strong>{sc.name}</strong>
                          </TableCell>
                          <TableCell><code style={{ fontSize: tokens.fontSizeBase100, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{sc.target}</code></TableCell>
                          <TableCell>{sc.description || '—'}</TableCell>
                          <TableCell>
                            {live ? (
                              <Badge appearance="tint" color="success">Registered</Badge>
                            ) : (
                              <Button size="small" appearance="outline" onClick={() => registerBundleShortcut(sc)} disabled={regBusy === sc.name}>
                                {regBusy === sc.name ? 'Registering…' : 'Register'}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      )}

      {shortcuts !== null && shortcuts.length > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Lakehouse shortcuts" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Path</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Engine</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shortcuts.map((sc) => (
                <TableRow
                  key={sc.id}
                  tabIndex={0}
                  onClick={() => setSelectedShortcut(sc)}
                  onFocus={() => setSelectedShortcut(sc)}
                  style={selectedShortcut?.id === sc.id ? { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: -2 } : undefined}
                >
                  <TableCell>
                    <CloudLink20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                    <strong>{sc.name}</strong>
                  </TableCell>
                  <TableCell><code style={{ fontSize: tokens.fontSizeBase100, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{sc.fullPath}</code></TableCell>
                  <TableCell>
                    <Badge appearance="outline" color={sc.targetType === 'adls' || sc.targetType === 'internal' ? 'brand' : 'warning'}>
                      {sc.targetType}
                    </Badge>
                  </TableCell>
                  <TableCell>{sc.engine && sc.engine !== 'none' ? sc.engine : '—'}</TableCell>
                  <TableCell>
                    {sc.status === 'active' && <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Filled aria-hidden="true" />}>active</Badge>}
                    {sc.status === 'pending' && <Badge appearance="tint" color="warning" icon={<Clock20Regular aria-hidden="true" />} title={sc.statusDetail}>pending</Badge>}
                    {sc.status === 'error' && <Badge appearance="tint" color="danger" icon={<ErrorCircle20Filled aria-hidden="true" />} title={sc.statusDetail}>Broken</Badge>}
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                      {sc.status === 'error' && (
                        <Button size="small" appearance="outline" icon={<ArrowSync20Regular />}
                          onClick={() => testShortcut(sc)} disabled={shortcutsBusy}
                          title={`Retry — re-test the shortcut after fixing ${sc.targetType === 'delta_sharing' ? 'the Key Vault credential file' : 'the underlying issue'} (F11 on the selected row)`}>
                          Retry
                        </Button>
                      )}
                      <Menu>
                        <MenuTrigger disableButtonEnhancement>
                          <Button appearance="subtle" size="small">…</Button>
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            {sc.kind === 'tables' && sc.engineObject && (
                              <MenuItem icon={<Play20Regular />} onClick={() => {
                                setSqlText(`SELECT TOP 100 * FROM ${sc.engineObject};`);
                                setTab('sql');
                              }}>Query (SQL)</MenuItem>
                            )}
                            {!(sc.kind === 'tables' && sc.engineObject) && (
                              <MenuItem icon={<Play20Regular />} onClick={() => queryShortcut(sc)}>Query (SQL)</MenuItem>
                            )}
                            <MenuItem icon={<ArrowSync20Regular />} onClick={() => testShortcut(sc)}>Test</MenuItem>
                            <MenuItem icon={<Delete20Regular />} onClick={() => deleteShortcutRow(sc)}>Delete</MenuItem>
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
