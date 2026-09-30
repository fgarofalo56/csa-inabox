'use client';
/**
 * The lakehouse editor's ribbon, moved out of lakehouse-editor-shell.tsx so the
 * shell stays under its line ceiling. The shell passes the state and handlers
 * the ribbon reads; nothing here fetches or holds state of its own.
 *
 * Actions that change the lakehouse close when the caller's role is read-only
 * (LAKEHOUSE_READ_ONLY_TITLE is their title). Refresh and the navigation items
 * stay open: they change nothing.
 */
import { useMemo } from 'react';
import {
  ArrowSync20Regular, ArrowUpload20Regular, Database20Regular, Eye20Regular, FolderAdd20Regular,
  Play20Regular, BookOpen20Regular, TableSimple20Regular, ArrowDownload20Regular, Info20Regular,
  LinkMultiple20Regular, Add20Regular, FolderArrowUp20Regular, ShieldTask20Regular, Wrench20Regular,
  Sparkle20Regular, DatabaseLink20Regular, PlugConnected20Regular,
} from '@fluentui/react-icons';
import type { RibbonTab } from '@/lib/components/ribbon';
import { checkVariablesRibbonAction } from './dialogs/check-variables-dialog';
import { LAKEHOUSE_READ_ONLY_TITLE } from './hooks/use-lakehouse-access';
import type { PathEntry } from './shared';

export interface LakehouseRibbonInput {
  activeContainer: string | null;
  activePath: PathEntry | null;
  isReferenceLakehouse: boolean;
  readOnly: boolean;
  uploading: boolean;
  runningUploadCount: number;
  tab: string;
  maintainTable: string;
  workspaceId: string | undefined;
  interopTabOn: boolean;
  connectTabOn: boolean;
  router: { push: (href: string) => void };
  setTab: (tab: string) => void;
  refreshActive: () => void;
  onUploadClick: () => void;
  onFolderUploadClick: () => void;
  onNewFolder: () => void;
  openShortcutWizard: () => void;
  selectFile: (entry: PathEntry) => unknown;
  onLoadToTables: (entry: PathEntry) => void;
  openLabelDialog: (entry: PathEntry) => unknown;
  setSemanticModelGateOpen: (open: boolean) => void;
  openCheckVariables: () => unknown;
  openSettings: () => void;
  openPerms: () => void;
  setShareError: (v: string | null) => void;
  setShareSuccess: (v: string | null) => void;
  setShareOpen: (open: boolean) => void;
  setMaintainOpen: (open: boolean) => void;
  openAddToAgent: () => unknown;
}

export function useLakehouseRibbon(p: LakehouseRibbonInput): RibbonTab[] {
  const {
    activeContainer, activePath, isReferenceLakehouse, readOnly, uploading, runningUploadCount, tab,
    maintainTable, workspaceId, interopTabOn, connectTabOn, router, setTab, refreshActive, onUploadClick,
    onFolderUploadClick, onNewFolder, openShortcutWizard, selectFile, onLoadToTables, openLabelDialog,
    setSemanticModelGateOpen, openCheckVariables, openSettings, openPerms, setShareError, setShareSuccess,
    setShareOpen, setMaintainOpen, openAddToAgent,
  } = p;
  return useMemo(() => {
    const canFileAction = !!activeContainer;
    const hasFile = !!activePath && !activePath.isDirectory;
    const writeBlocked = !canFileAction || isReferenceLakehouse;
    const writeTitle = isReferenceLakehouse
      ? 'Read-only — reference lakehouse (write operations disabled)'
      : !canFileAction ? 'Select a container first' : undefined;
    const editBlocked = writeBlocked || readOnly;
    const editTitle = readOnly ? LAKEHOUSE_READ_ONLY_TITLE : writeTitle;
    const notebookHref = activeContainer ? `/items/notebook/new?lakehouse=${encodeURIComponent(activeContainer)}` : '/items/notebook/new';
    const maintainReady = tab === 'tables' && !!maintainTable;
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'Refresh', actions: [{ label: 'Refresh', icon: <ArrowSync20Regular />, onClick: writeBlocked ? undefined : refreshActive, disabled: writeBlocked, title: writeTitle }] },
        { label: 'Get data', actions: [{ label: 'Get data', disabled: writeBlocked, title: writeTitle, dropdownItems: [
          { label: uploading ? `Uploading (${runningUploadCount})…` : 'Upload', icon: <ArrowUpload20Regular />, onClick: editBlocked ? undefined : onUploadClick, disabled: editBlocked, title: editTitle },
          { label: 'Upload folder', icon: <FolderArrowUp20Regular />, onClick: editBlocked ? undefined : onFolderUploadClick, disabled: editBlocked, title: editTitle },
          { label: 'New folder', icon: <FolderAdd20Regular />, onClick: editBlocked ? undefined : onNewFolder, disabled: editBlocked, title: editTitle },
          { label: 'New shortcut', icon: <LinkMultiple20Regular />, onClick: editBlocked ? undefined : () => { setTab('shortcuts'); openShortcutWizard(); }, disabled: editBlocked, title: editTitle },
          { label: 'New dataflow', icon: <Database20Regular />, onClick: () => router.push('/items/dataflow/new') },
          { label: 'New pipeline', icon: <Database20Regular />, onClick: () => router.push('/items/data-pipeline/new') },
          { label: 'New notebook', icon: <BookOpen20Regular />, onClick: () => router.push(notebookHref) },
          { label: 'Copy activity', icon: <ArrowDownload20Regular />, onClick: () => router.push('/items/copy-job/new') },
        ]}] },
        { label: 'Analyze data', actions: [{ label: 'Analyze data', dropdownItems: [
          { label: 'SQL endpoint', icon: <Database20Regular />, onClick: () => setTab('sql') },
          { label: 'New notebook', icon: <BookOpen20Regular />, onClick: () => router.push(notebookHref) },
          { label: 'Existing notebook', icon: <BookOpen20Regular />, onClick: () => router.push('/items/notebook/new') },
        ]}] },
        { label: 'Data model', actions: [
          { label: 'New semantic model', icon: <TableSimple20Regular />, onClick: () => setSemanticModelGateOpen(true), title: 'DirectLake semantic model requires Power BI / Fabric capacity — see the dialog for the Azure-native path' },
          checkVariablesRibbonAction({ workspaceId, onOpen: () => { void openCheckVariables(); } }),
        ] },
        { label: 'Query', actions: [
          { label: 'Preview', icon: <Eye20Regular />, onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('preview'); } } : undefined, disabled: !hasFile },
          { label: 'Query this file', icon: <Play20Regular />, onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('sql'); } } : undefined, disabled: !hasFile },
        ] },
        { label: 'Tables', actions: [{ label: 'Load to table', onClick: hasFile && !readOnly ? () => { if (activePath) onLoadToTables(activePath); } : undefined, disabled: !hasFile || readOnly, title: readOnly ? LAKEHOUSE_READ_ONLY_TITLE : hasFile ? 'Load this file into a managed Delta table (F6)' : 'Select a file first' }] },
        { label: 'Protect', actions: [{ label: 'Download with label', onClick: hasFile ? () => { if (activePath) openLabelDialog(activePath); } : undefined, disabled: !hasFile, title: hasFile ? 'Stamp a MIP sensitivity label on download' : 'Select a file first' }] },
        { label: 'Manage', actions: [
          { label: 'Settings', icon: <Info20Regular />, onClick: writeBlocked ? undefined : openSettings, disabled: writeBlocked, title: writeTitle },
          { label: 'Permissions', icon: <LinkMultiple20Regular />, onClick: activeContainer ? openPerms : undefined, disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined },
          { label: 'Share', icon: <Add20Regular />, onClick: activeContainer ? () => { setShareError(null); setShareSuccess(null); setShareOpen(true); } : undefined, disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined },
          { label: 'Maintain…', icon: <Wrench20Regular />, onClick: (maintainReady && !readOnly) ? () => setMaintainOpen(true) : undefined, disabled: readOnly || !maintainReady, title: readOnly ? LAKEHOUSE_READ_ONLY_TITLE : !maintainReady ? 'Select a table in the Tables tab first' : 'OPTIMIZE / VACUUM / ZORDER BY' },
          { label: 'OneLake security', icon: <ShieldTask20Regular />, onClick: () => setTab('security'), title: 'Manage OneLake data-access roles + row/column security for this lakehouse' },
          ...(interopTabOn ? [{ label: 'Interop (Iceberg)', icon: <DatabaseLink20Regular />, onClick: () => setTab('interop'), title: 'Expose Delta tables to Trino / Spark / DuckDB / Snowflake as Apache Iceberg — zero copy, same files' }] : []),
          ...(connectTabOn ? [{ label: 'Connect (ADBC / Flight)', icon: <PlugConnected20Regular />, onClick: () => setTab('connect'), title: 'Mint a short-lived access ticket and get ADBC / Arrow Flight SQL / JDBC snippets — Arrow batches, not row-by-row ODBC' }] : []),
        ] },
        { label: 'AI', actions: [{ label: 'Add to data agent', icon: <Sparkle20Regular />, onClick: () => { void openAddToAgent(); }, title: 'Ground a data agent on this lakehouse (Fabric "Add to AI skill")' }] },
      ] },
    ];
  }, [
    activeContainer, activePath, isReferenceLakehouse, readOnly, uploading, runningUploadCount, tab,
    maintainTable, workspaceId, interopTabOn, connectTabOn, router, setTab, refreshActive, onUploadClick,
    onFolderUploadClick, onNewFolder, openShortcutWizard, selectFile, onLoadToTables, openLabelDialog,
    setSemanticModelGateOpen, openCheckVariables, openSettings, openPerms, setShareError, setShareSuccess,
    setShareOpen, setMaintainOpen, openAddToAgent,
  ]);
}
