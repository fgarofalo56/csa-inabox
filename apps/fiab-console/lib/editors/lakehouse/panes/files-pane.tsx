'use client';
import {
  Caption1, Body1, Spinner, Badge, Button, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Breadcrumb, BreadcrumbItem, BreadcrumbButton, BreadcrumbDivider,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from '@fluentui/react-components';
import {
  ArrowUpload20Regular, FolderArrowUp20Regular, FolderAdd20Regular, ArrowSync20Regular,
  Database20Regular, Eye20Regular, Play20Regular, BookOpen20Regular, TableSimple20Regular,
  ArrowDownload20Regular, ShieldTask20Regular, CloudArrowUp20Regular, Delete20Regular,
  MoreHorizontal20Regular,
} from '@fluentui/react-icons';
import { Fragment } from 'react';
import { useStyles, formatBytes, leafName, FileGlyph } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

export function FilesPane() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    activeContainer, currentPrefix, goToPrefix, onUploadClick, onFolderUploadClick,
    onNewFolder, refreshActive,
    uploading, runningUploads, uploadQueue, isDragOver, setIsDragOver, onDragOver, onDragLeave, onDrop,
    currentListing, activePath, selectFile, openContextMenu, openTierDialog,
    mipStatus, mipLabelName,
    actionError, actionStatus,
    fileTiers, lakehouseName,
    setTab, onDownload, onOpenInNotebook, onLoadToTables, openLabelDialog,
  } = ctx;

  return (
    <>
      {/* F10 — visually-hidden live region so screen readers announce
          background upload progress to the active lakehouse, polled
          independent of which tab the sighted user is on. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', clipPath: 'inset(50%)' }}
      >
        {uploading ? `Uploading ${runningUploads.length} file${runningUploads.length === 1 ? '' : 's'} to ${lakehouseName} lakehouse, please wait…` : ''}
      </div>
      <div className={s.toolbar}>
        {/* Breadcrumb path bar — container root + one clickable segment
            per folder (Fabric OneLake-explorer parity). Every crumb is
            a real navigation: it re-lists that prefix via loadPaths. */}
        <Breadcrumb aria-label="Lakehouse path" size="small" className={s.breadcrumbBar}>
          <BreadcrumbItem>
            <BreadcrumbButton
              icon={<Database20Regular />}
              onClick={() => goToPrefix('')}
              current={!currentPrefix}
              disabled={!activeContainer}
            >
              {activeContainer || 'no container'}
            </BreadcrumbButton>
          </BreadcrumbItem>
          {currentPrefix.split('/').filter(Boolean).map((seg, i, segs) => {
            const prefixUpTo = segs.slice(0, i + 1).join('/');
            const isLast = i === segs.length - 1;
            return (
              <Fragment key={prefixUpTo}>
                <BreadcrumbDivider />
                <BreadcrumbItem>
                  <BreadcrumbButton onClick={() => goToPrefix(prefixUpTo)} current={isLast}>
                    {seg}
                  </BreadcrumbButton>
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </Breadcrumb>
        <Button appearance="primary" icon={<ArrowUpload20Regular />} disabled={!activeContainer} onClick={onUploadClick}>
          {uploading ? `Uploading (${runningUploads.length})…` : 'Upload file'}
        </Button>
        <Button appearance="outline" icon={<FolderArrowUp20Regular />} disabled={!activeContainer || uploading} onClick={onFolderUploadClick}>
          Upload folder
        </Button>
        <Button appearance="outline" icon={<FolderAdd20Regular />} disabled={!activeContainer} onClick={onNewFolder}>
          New folder
        </Button>
        <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!activeContainer} onClick={refreshActive}>
          Refresh
        </Button>
      </div>
      {actionError && (
        <MessageBar intent="error">
          <MessageBarBody>{actionError}</MessageBarBody>
        </MessageBar>
      )}
      {actionStatus && !actionError && (
        <MessageBar intent="success">
          <MessageBarBody>{actionStatus}</MessageBarBody>
        </MessageBar>
      )}
      {uploading && uploadQueue && (
        <MessageBar intent="info">
          <MessageBarBody>
            <Spinner size="tiny" />{' '}Uploading {uploadQueue.done} / {uploadQueue.total} file{uploadQueue.total === 1 ? '' : 's'}…
          </MessageBarBody>
        </MessageBar>
      )}
      {/* MIP sensitivity-label-on-download outcome (F5). The proxy
          echoes x-loom-mip-status; map it to an honest MessageBar.
          The download itself always succeeds regardless of status. */}
      {mipStatus === 'stamped' && (
        <MessageBar intent="success" icon={<ShieldTask20Regular />}>
          <MessageBarBody>
            <MessageBarTitle>Sensitivity label applied</MessageBarTitle>
            {mipLabelName ? <>"{mipLabelName}" was </> : 'The label was '}
            embedded in the downloaded file (MSIP metadata). Reopen the file in Office/Acrobat to verify the label bar.
          </MessageBarBody>
        </MessageBar>
      )}
      {mipStatus === 'no-label' && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>No sensitivity label</MessageBarTitle>
            This file has no sensitivity label in the Microsoft Purview catalog (it may not have been scanned yet). Use <b>Download with label</b> to choose one explicitly. The file was downloaded as-is.
          </MessageBarBody>
        </MessageBar>
      )}
      {mipStatus === 'not-configured' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>MIP label lookup unavailable</MessageBarTitle>
            Microsoft Purview is not wired in this deployment, so no catalog label could be looked up. Set <code>LOOM_PURVIEW_ACCOUNT</code> (see <code>platform/fiab/bicep/modules/admin-plane/catalog.bicep</code>) and grant the Console UAMI a Purview <em>Data Reader</em> role (<code>scripts/csa-loom/grant-purview-datamap-role.sh ROLE=data-reader</code>), or use <b>Download with label</b> to stamp a chosen label. The file downloaded without a stamp.
          </MessageBarBody>
        </MessageBar>
      )}
      {(mipStatus === 'no-xmp-stream' || mipStatus === 'pdf-insufficient-xmp-padding' || mipStatus === 'ooxml-zip64-unsupported' || mipStatus === 'ooxml-parse-failed') && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Label could not be embedded in this file</MessageBarTitle>
            {mipStatus === 'no-xmp-stream' && 'This PDF has no XMP metadata packet to stamp into. '}
            {mipStatus === 'pdf-insufficient-xmp-padding' && 'This PDF\'s XMP packet has no spare padding to stamp into without re-flowing the file. '}
            {mipStatus === 'ooxml-zip64-unsupported' && 'This Office file uses the ZIP64 container, which the in-proxy stamper does not modify. '}
            {mipStatus === 'ooxml-parse-failed' && 'This Office file could not be parsed as a standard OPC package. '}
            The file downloaded unchanged — no partial or fake stamp was written.
          </MessageBarBody>
        </MessageBar>
      )}
      {mipStatus === 'error' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Label lookup failed</MessageBarTitle>
            Purview is configured but the label lookup failed (the file still downloaded). Confirm the Console UAMI holds a Purview <em>Data Reader</em> role on the root collection (<code>scripts/csa-loom/grant-purview-datamap-role.sh ROLE=data-reader</code>).
          </MessageBarBody>
        </MessageBar>
      )}
      {currentListing === 'loading' && <Spinner size="small" label="Listing paths…" labelPosition="after" />}
      {currentListing && !Array.isArray(currentListing) && currentListing !== 'loading' && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>List failed</MessageBarTitle>
            {(currentListing as { error: string }).error}
          </MessageBarBody>
        </MessageBar>
      )}
      {Array.isArray(currentListing) && (
        <div
          className={s.tableWrap}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          style={isDragOver ? {
            outline: `2px dashed ${tokens.colorBrandStroke1}`,
            outlineOffset: -2,
            backgroundColor: tokens.colorNeutralBackground2,
          } : undefined}
        >
          {isDragOver && (
            <div style={{ padding: tokens.spacingVerticalS, textAlign: 'center', color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold }}>
              Drop files or a folder to upload into /{currentPrefix || ''} (folder tree preserved)
            </div>
          )}
          <Table aria-label="Lakehouse paths" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Tier (preview)</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {currentListing.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <div style={{ padding: tokens.spacingVerticalXXL, textAlign: 'center' }}>
                      <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
                        No files in <strong>/{currentPrefix || ''}</strong> yet.
                      </Body1>
                      <Caption1 style={{ display: 'block' }}>
                        Use the toolbar above to <b>Upload file</b> or create a <b>New folder</b>.
                        Once you have files, right-click any one for <b>Preview · Query · Open in notebook · Load to Tables · Delete</b>.
                      </Caption1>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {currentListing.map((entry) => (
                <TableRow
                  key={entry.name}
                  className={`${s.rowHover} ${activePath?.name === entry.name ? s.rowSelected : ''}`}
                  onClick={() => selectFile(entry)}
                  onContextMenu={(e) => openContextMenu(e, entry)}
                >
                  <TableCell>
                    <span className={s.nameCell}>
                      <FileGlyph name={entry.name} isDirectory={entry.isDirectory} />
                      <span className={s.nameLabel} title={leafName(entry.name)}>{leafName(entry.name)}</span>
                    </span>
                  </TableCell>
                  <TableCell className={s.cell}>
                    {!entry.isDirectory && (() => {
                      const t = fileTiers[`${activeContainer}::${entry.name}`] ?? entry.tier;
                      if (!t) return <Badge appearance="outline" size="small" color="subtle">—</Badge>;
                      const color = t === 'Hot' ? 'brand' : t === 'Cool' ? 'informative' : t === 'Cold' ? 'subtle' : 'warning';
                      return <Badge appearance="tint" size="small" color={color}>{t}</Badge>;
                    })()}
                  </TableCell>
                  <TableCell className={s.cell}>{entry.isDirectory ? '—' : formatBytes(entry.size)}</TableCell>
                  <TableCell className={s.cell}>{entry.lastModified?.replace('T', ' ').replace(/\..*/, '') ?? '—'}</TableCell>
                  <TableCell>
                    {/* Secondary actions reveal on row hover/focus
                        (Fabric hover-row-action parity; class styled
                        in shared.tsx rowHover). */}
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button className="lh-row-actions" appearance="subtle" size="small"
                          icon={<MoreHorizontal20Regular />}
                          aria-label={`Actions for ${leafName(entry.name)}`} />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          {!entry.isDirectory && (
                            <MenuItem icon={<Eye20Regular />} onClick={() => { selectFile(entry); setTab('preview'); }}>
                              Preview
                            </MenuItem>
                          )}
                          {!entry.isDirectory && (
                            <MenuItem icon={<Play20Regular />} onClick={() => { selectFile(entry); setTab('sql'); }}>
                              Query this file
                            </MenuItem>
                          )}
                          {!entry.isDirectory && (
                            <MenuItem icon={<BookOpen20Regular />} onClick={() => onOpenInNotebook(entry)}>
                              Open in notebook
                            </MenuItem>
                          )}
                          {!entry.isDirectory && (
                            <MenuItem icon={<TableSimple20Regular />} onClick={() => onLoadToTables(entry)}>
                              Load to Tables (Delta)
                            </MenuItem>
                          )}
                          {!entry.isDirectory && (
                            <MenuItem icon={<ArrowDownload20Regular />} onClick={() => onDownload(entry)}>
                              Download
                            </MenuItem>
                          )}
                          {!entry.isDirectory && (
                            <MenuItem icon={<ShieldTask20Regular />} onClick={() => openLabelDialog(entry)}>
                              Download with label…
                            </MenuItem>
                          )}
                          {!entry.isDirectory && (
                            <MenuItem icon={<CloudArrowUp20Regular />} onClick={() => openTierDialog(entry)}>
                              Change tier…
                            </MenuItem>
                          )}
                          <MenuItem icon={<Delete20Regular />} onClick={() => ctx.onDelete(entry)}>
                            Delete
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
      )}
    </>
  );
}
