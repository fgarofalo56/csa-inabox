'use client';

/**
 * React context for LakehouseEditor — all shared state + callbacks
 * surfaced to panes, dialogs, and hooks without prop drilling.
 *
 * The shell provides the context; panes/dialogs consume it via
 * useLakehouseCtx(). This is a pure mechanical extraction — zero
 * behavior change from the original monolith.
 */

import { createContext, useContext } from 'react';
import type { PathEntry, ContainerInfo, ReferenceLakehouse, RefSelection, PreviewResponse, HistoryRow, MipLabelOption, UploadItem } from './shared';
import type {
  PermAssignment, PermRole, PermsTab, SqlGrant, SqlTableRef, SqlColRef, RlsPolicy, ResolvedPrincipal,
  LakehouseSettings, IcebergEndpoint, DaAgentRow, LiveCatalogTable,
  ShortcutTargetType, ShortcutKind, ShortcutRow, SchemaRow,
} from './types';
import type { ColStat } from '../components/delta-preview-grid';
import type { BlobAccessTier } from '@/lib/components/onelake/tier-dialog';
import type { ExternalCredsState, SharePointSelection } from '@/lib/components/onelake/shortcut-wizard';
import type { WorkspaceItem } from '@/lib/api/workspaces';
import type { LakehouseContent } from '@/lib/apps/content-bundles/types';
import type { UseQueryResult } from '@tanstack/react-query';

export interface LakehouseEditorCtx {
  // ---- Identity / item ----
  id: string;
  isNewItem: boolean;
  itemQ: UseQueryResult<WorkspaceItem>;
  lhContent: LakehouseContent | undefined;
  bundleFolders: NonNullable<LakehouseContent['folders']>;
  bundleDeltaTables: NonNullable<LakehouseContent['deltaTables']>;
  bundleShortcuts: NonNullable<LakehouseContent['shortcuts']>;
  hasBundle: boolean;
  seededTableInfo: Array<{ name: string; container: string; csvPath: string; rowCount: number | null }> | null;
  lakehouseName: string;
  shortcutLakehouseId: string;
  isReferenceLakehouse: boolean;

  // ---- Containers ----
  containers: ContainerInfo[] | null;
  containerError: string | null;
  activeContainer: string | null;
  setActiveContainer: (c: string | null) => void;

  // ---- File tree ----
  openPrefixes: Record<string, PathEntry[] | 'loading' | { error: string }>;
  activePath: PathEntry | null;
  setActivePath: (p: PathEntry | null) => void;

  // ---- Tab ----
  tab: string;
  setTab: (t: string) => void;

  // ---- Preview ----
  preview: PreviewResponse | null;
  setPreview: (p: PreviewResponse | null) => void;
  previewLoading: boolean;
  setPreviewLoading: (v: boolean) => void;
  previewMode: 'file' | 'table';
  setPreviewMode: (m: 'file' | 'table') => void;
  columnStats: Record<string, ColStat> | null;
  statsLoading: boolean;
  statsError: string | null;

  // ---- SQL ----
  sqlText: string;
  setSqlText: (t: string) => void;
  sqlResult: PreviewResponse | null;
  setSqlResult: (r: PreviewResponse | null) => void;
  sqlLoading: boolean;
  setSqlLoading: (v: boolean) => void;
  runSql: () => Promise<void>;

  // ---- Action feedback ----
  actionError: string | null;
  setActionError: (e: string | null) => void;
  actionStatus: string | null;
  setActionStatus: (s: string | null) => void;

  // ---- Upload ----
  fileInputRef: React.RefObject<HTMLInputElement>;
  folderInputRef: React.RefObject<HTMLInputElement>;
  isDragOver: boolean;
  setIsDragOver: (v: boolean) => void;
  uploadQueue: { done: number; total: number } | null;
  uploading: boolean;
  jobs: ReturnType<typeof import('@/lib/state/jobs-store').useJobsStore>; // job store snapshot
  startUpload: (p: { lakehouseName: string; container: string; path: string; file: File; onDone: (r: { ok: boolean; error?: string }) => void }) => void;
  recordLoadToTable: (p: { lakehouseName: string; container: string; tableName: string }) => void;
  runningUploads: unknown[];

  // ---- MIP sensitivity labels ----
  mipStatus: string | null;
  mipLabelName: string | null;
  labelDlgOpen: boolean;
  setLabelDlgOpen: (v: boolean) => void;
  labelDlgEntry: PathEntry | null;
  setLabelDlgEntry: (e: PathEntry | null) => void;
  mipLabels: MipLabelOption[] | null;
  mipLabelsLoading: boolean;
  mipLabelsError: string | null;
  chosenLabelId: string;
  setChosenLabelId: (id: string) => void;

  // ---- References ----
  references: ReferenceLakehouse[] | null;
  refsLoading: boolean;
  refsError: string | null;
  workspaceLakehouses: Array<{ id: string; displayName: string }>;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  refOpenPrefixes: Record<string, PathEntry[] | 'loading' | { error: string }>;
  refSelection: RefSelection | null;
  refPreview: PreviewResponse | null;
  refPreviewLoading: boolean;
  addReference: (refId: string) => Promise<void>;
  removeReference: (refId: string) => Promise<void>;
  loadRefPaths: (refId: string, container: string, prefix: string) => Promise<void>;
  selectRefFile: (ref: ReferenceLakehouse, container: string, entry: PathEntry) => Promise<void>;

  // ---- Permissions dialog ----
  permsOpen: boolean;
  setPermsOpen: (v: boolean) => void;
  openPerms: () => void;
  permsRows: PermAssignment[];
  setPermsRows: (r: PermAssignment[]) => void;
  permsRoles: PermRole[];
  setPermsRoles: (r: PermRole[]) => void;
  permsBusy: boolean;
  setPermsBusy: (v: boolean) => void;
  permsError: string | null;
  setPermsError: (e: string | null) => void;
  newPrincipalId: string;
  setNewPrincipalId: (v: string) => void;
  newPrincipalType: 'User' | 'Group' | 'ServicePrincipal';
  setNewPrincipalType: (v: 'User' | 'Group' | 'ServicePrincipal') => void;
  newRole: string;
  setNewRole: (v: string) => void;
  permsTab: PermsTab;
  setPermsTab: (t: PermsTab) => void;
  sqlGate: { missing: string; hint: string } | null;
  setSqlGate: (g: { missing: string; hint: string } | null) => void;
  sqlGrants: SqlGrant[];
  setSqlGrants: (g: SqlGrant[]) => void;
  sqlTables: SqlTableRef[];
  setSqlTables: (t: SqlTableRef[]) => void;
  selTableId: number | null;
  setSelTableId: (id: number | null) => void;
  sqlCols: SqlColRef[];
  setSqlCols: (c: SqlColRef[]) => void;
  selColIds: number[];
  setSelColIds: (ids: number[]) => void;
  rlsPolicies: RlsPolicy[];
  setRlsPolicies: (p: RlsPolicy[]) => void;
  rlsFilterColId: number | null;
  setRlsFilterColId: (id: number | null) => void;
  rlsSubject: 'USER_NAME()' | 'SUSER_SNAME()';
  setRlsSubject: (s: 'USER_NAME()' | 'SUSER_SNAME()') => void;
  principalQuery: string;
  setPrincipalQuery: (q: string) => void;
  principalResults: ResolvedPrincipal[];
  setPrincipalResults: (r: ResolvedPrincipal[]) => void;
  selectedPrincipal: ResolvedPrincipal | null;
  setSelectedPrincipal: (p: ResolvedPrincipal | null) => void;
  principalBusy: boolean;
  setPrincipalBusy: (v: boolean) => void;
  loadPerms: () => Promise<void>;
  grantPerm: () => Promise<void>;
  revokePerm: (armId: string) => Promise<void>;
  loadSqlPerms: (t: PermsTab) => Promise<void>;
  loadSqlColumns: (objectId: number) => Promise<void>;
  selectPermsTab: (t: PermsTab) => void;
  onPickTable: (objectId: number | null) => void;
  grantSqlTable: () => Promise<void>;
  grantSqlColumn: () => Promise<void>;
  createRls: () => Promise<void>;
  revokeSqlGrant: (g: SqlGrant) => Promise<void>;
  dropRls: (p: RlsPolicy) => Promise<void>;
  toggleCol: (columnId: number, checked: boolean) => void;
  renderPrincipalPicker: () => React.ReactElement;

  // ---- Settings dialog ----
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  openSettings: () => void;
  settings: LakehouseSettings;
  setSettings: (s: LakehouseSettings | ((prev: LakehouseSettings) => LakehouseSettings)) => void;
  settingsBusy: boolean;
  settingsError: string | null;
  settingsSparkConfText: string;
  setSettingsSparkConfText: (t: string) => void;
  lcTableName: string;
  setLcTableName: (v: string) => void;
  lcColumns: string;
  setLcColumns: (v: string) => void;
  lcApplied: boolean | null;
  lcSql: string | null;
  lcGate: string | null;
  lcError: string | null;
  icebergEnabled: boolean;
  setIcebergEnabled: (v: boolean) => void;
  icebergTable: string;
  setIcebergTable: (v: string) => void;
  icebergSchema: string;
  setIcebergSchema: (v: string) => void;
  icebergEndpoint: IcebergEndpoint | null;
  icebergApplied: boolean | null;
  icebergSql: string | null;
  icebergGate: string | null;
  icebergError: string | null;
  cloud: 'commercial' | 'gcc' | 'gcch' | 'il5';
  sparkPools: Array<{ name: string }> | null;
  saveSettings: () => Promise<void>;
  schemasEnabled: boolean;
  setSchemasEnabled: (v: boolean) => void;

  // ---- Share dialog ----
  shareOpen: boolean;
  setShareOpen: (v: boolean) => void;
  sharePrincipal: string;
  setSharePrincipal: (v: string) => void;
  sharePrincipalType: 'User' | 'Group' | 'ServicePrincipal';
  setSharePrincipalType: (v: 'User' | 'Group' | 'ServicePrincipal') => void;
  shareRole: string;
  setShareRole: (v: string) => void;
  shareBusy: boolean;
  shareError: string | null;
  setShareError: (e: string | null) => void;
  shareSuccess: string | null;
  setShareSuccess: (s: string | null) => void;
  grantShare: () => Promise<void>;

  // ---- Semantic model gate ----
  semanticModelGateOpen: boolean;
  setSemanticModelGateOpen: (v: boolean) => void;

  // ---- Data agent dialog ----
  daOpen: boolean;
  setDaOpen: (v: boolean) => void;
  openAddToAgent: () => void;
  daAgents: DaAgentRow[] | null;
  setDaAgents: (a: DaAgentRow[] | null) => void;
  daLoadErr: string | null;
  setDaLoadErr: (e: string | null) => void;
  daSel: string;
  setDaSel: (v: string) => void;
  daBusy: boolean;
  setDaBusy: (v: boolean) => void;
  daMsg: { intent: 'success' | 'error'; text: string } | null;
  setDaMsg: (m: { intent: 'success' | 'error'; text: string } | null) => void;
  addToAgent: () => Promise<void>;

  // ---- Delta maintenance ----
  maintainOpen: boolean;
  setMaintainOpen: (v: boolean) => void;
  maintainTable: string;
  setMaintainTable: (t: string) => void;
  maintainColumns: string[];

  // ---- Load-to-table (F6) ----
  lttOpen: boolean;
  setLttOpen: (v: boolean) => void;
  lttEntry: PathEntry | null;
  setLttEntry: (e: PathEntry | null) => void;
  lttToasterId: string;

  // ---- Properties dialog ----
  propsEntry: PathEntry | null;
  setPropsEntry: (e: PathEntry | null) => void;

  // ---- Storage tier ----
  tierDlgOpen: boolean;
  setTierDlgOpen: (v: boolean) => void;
  tierDlgEntry: PathEntry | null;
  fileTiers: Record<string, string>;

  // ---- Context menu ----
  ctxOpen: boolean;
  setCtxOpen: (v: boolean) => void;
  ctxEntry: PathEntry | null;
  setCtxEntry: (e: PathEntry | null) => void;
  ctxPos: { x: number; y: number };

  // ---- Live Delta catalog ----
  liveTables: LiveCatalogTable[] | null;
  liveTablesLoading: boolean;
  liveTablesError: string | null;
  liveTablesGate: string | null;
  loadLiveTables: () => Promise<void>;

  // ---- Schemas ----
  schemas: SchemaRow[] | null;
  schemasBusy: boolean;
  schemasError: string | null;
  newSchemaOpen: boolean;
  setNewSchemaOpen: (v: boolean) => void;
  newSchemaName: string;
  setNewSchemaName: (v: string) => void;
  newSchemaDesc: string;
  setNewSchemaDesc: (v: string) => void;
  newSchemaBusy: boolean;
  newSchemaError: string | null;
  moveTableOpen: boolean;
  setMoveTableOpen: (v: boolean) => void;
  moveTableName: string;
  moveTableFrom: string;
  moveTableTo: string;
  setMoveTableTo: (v: string) => void;
  moveTableBusy: boolean;
  moveTableError: string | null;
  moveTableStatus: string | null;
  loadSchemas: () => Promise<void>;
  createSchema: () => Promise<void>;
  deleteSchema: (name: string) => Promise<void>;
  openMoveTable: (tableName: string, fromSchema: string) => void;
  submitMoveTable: () => Promise<void>;

  // ---- Shortcuts ----
  scAdlsMode: 'picker' | 'external';
  setScAdlsMode: (m: 'picker' | 'external') => void;
  storageAccts: Array<{ name: string; dfsHost?: string; blobHost?: string; isHns: boolean; resourceGroup?: string }>;
  storageAcctsLoading: boolean;
  scAcctHost: string;
  setScAcctHost: (v: string) => void;
  scAdlsContainer: string;
  setScAdlsContainer: (v: string) => void;
  scAdlsPath: string;
  setScAdlsPath: (v: string) => void;
  shortcuts: ShortcutRow[] | null;
  shortcutsBusy: boolean;
  selectedShortcut: ShortcutRow | null;
  setSelectedShortcut: (s: ShortcutRow | null) => void;
  shortcutsError: string | null;
  scWizardOpen: boolean;
  setScWizardOpen: (v: boolean) => void;
  scStep: 1 | 2 | 3;
  setScStep: (s: 1 | 2 | 3) => void;
  scType: ShortcutTargetType;
  setScType: (t: ShortcutTargetType) => void;
  scTargetUri: string;
  setScTargetUri: (v: string) => void;
  scInternalContainer: string;
  setScInternalContainer: (v: string) => void;
  scInternalPath: string;
  setScInternalPath: (v: string) => void;
  scKvSecret: string;
  setScKvSecret: (v: string) => void;
  scExtSas: string;
  setScExtSas: (v: string) => void;
  scExtSasBusy: boolean;
  scExtSasErr: string | null;
  extCreds: ExternalCredsState;
  setExtCreds: (c: ExternalCredsState | ((prev: ExternalCredsState) => ExternalCredsState)) => void;
  scSpSelection: SharePointSelection | null;
  setScSpSelection: (s: SharePointSelection | null) => void;
  scName: string;
  setScName: (v: string) => void;
  scKind: ShortcutKind;
  setScKind: (k: ShortcutKind) => void;
  scParentPath: string;
  setScParentPath: (v: string) => void;
  scFormat: 'delta' | 'parquet' | 'csv' | 'json';
  setScFormat: (f: 'delta' | 'parquet' | 'csv' | 'json') => void;
  scSubmitting: boolean;
  scSubmitError: string | null;
  scTargetSchema: string;
  setScTargetSchema: (v: string) => void;
  regBusy: string | null;
  openShortcutWizard: (presetKind?: ShortcutKind, presetParent?: string) => void;
  loadShortcuts: () => Promise<void>;
  resetWizard: (presetKind?: ShortcutKind, presetParent?: string) => void;
  stashExternalSas: () => Promise<void>;
  submitShortcut: () => Promise<void>;
  registerBundleShortcut: (sc: NonNullable<LakehouseContent['shortcuts']>[number]) => Promise<void>;
  registerAllBundleShortcuts: () => Promise<void>;
  testShortcut: (row: ShortcutRow) => Promise<void>;
  deleteShortcutRow: (row: ShortcutRow) => Promise<void>;
  queryShortcut: (sc: ShortcutRow) => void;

  // ---- History ----
  historyTable: string | null;
  setHistoryTable: (t: string | null) => void;
  historyRows: HistoryRow[] | null;
  historyLoading: boolean;
  historyError: string | null;
  historyRestoring: number | null;
  historyRestoreMsg: { ok: boolean; text: string } | null;
  historyPreviewVersion: number | null;
  historyPreviewResult: PreviewResponse | null;
  historyPreviewLoading: boolean;
  loadHistory: (tablePath: string) => Promise<void>;
  restoreToVersion: (tablePath: string, version: number) => Promise<void>;
  previewAsOf: (tablePath: string, version: number) => Promise<void>;
  openTableHistory: (tablePath: string) => void;

  // ---- File operations ----
  onUploadClick: () => void;
  onFolderUploadClick: () => void;
  onNewFolder: () => Promise<void>;
  onDelete: (entry: PathEntry) => Promise<void>;
  onDownload: (entry: PathEntry, label?: MipLabelOption) => Promise<void>;
  onOpenInNotebook: (entry: PathEntry) => void;
  onLoadToTables: (entry: PathEntry) => void;
  openLabelDialog: (entry: PathEntry) => Promise<void>;
  confirmLabelDownload: () => Promise<void>;
  uploadOne: (targetPath: string, file: File) => Promise<string | null>;
  uploadItems: (items: UploadItem[]) => Promise<void>;
  onUploadChange: (ev: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onFolderInputChange: (ev: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => Promise<void>;

  // ---- Core navigation ----
  loadPaths: (container: string, prefix: string) => Promise<void>;
  cacheKey: (container: string, prefix: string) => string;
  refreshActive: () => void;
  selectFile: (entry: PathEntry, opts?: { tab?: string }) => Promise<void>;
  previewTable: (relPath: string) => void;
  goToPrefix: (prefix: string) => void;
  currentPrefix: string;
  currentListing: PathEntry[] | 'loading' | { error: string } | null;
  openContextMenu: (e: React.MouseEvent, entry: PathEntry) => void;
  openTierDialog: (entry: PathEntry) => void;
  onTierChanged: (entry: PathEntry, newTier: BlobAccessTier) => void;
}

const LakehouseEditorContext = createContext<LakehouseEditorCtx | null>(null);
export { LakehouseEditorContext };

export function useLakehouseCtx(): LakehouseEditorCtx {
  const ctx = useContext(LakehouseEditorContext);
  if (!ctx) throw new Error('useLakehouseCtx must be used inside LakehouseEditorContext.Provider');
  return ctx;
}
