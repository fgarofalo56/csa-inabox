'use client';

/**
 * databricks-editors.tsx — BARREL.
 *
 * The former ~7800-line implementation was decomposed into ./databricks/*
 * (one file per exported editor + a shared-helpers module + the Unity Catalog
 * governance dialogs). This module now re-exports the four public editors so
 * registry.ts and every existing importer keep working unchanged.
 * Behavior-preserving split — zero logic change.
 */

export { DatabricksSqlWarehouseEditor } from './databricks/sql-warehouse-editor';
export { DatabricksNotebookEditor } from './databricks/databricks-notebook-editor';
export { DatabricksJobEditor } from './databricks/job-editor';
export { DatabricksClusterEditor } from './databricks/cluster-editor';
