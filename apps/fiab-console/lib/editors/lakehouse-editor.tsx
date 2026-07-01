'use client';

/**
 * lakehouse-editor.tsx — BARREL.
 *
 * The former ~5150-line implementation was decomposed into ./lakehouse/* —
 * a shared-helpers module (useStyles / types / formatBytes / leafName /
 * collectEntries / formatCell / parseJsonOrError) plus the LakehouseEditor
 * shell component. This module now re-exports the public editor so
 * registry.ts and every existing importer keep working unchanged.
 * Behavior-preserving split — zero logic change.
 */

export { LakehouseEditor } from './lakehouse/lakehouse-editor-shell';
