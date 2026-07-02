'use client';

/**
 * phase4-editors.tsx — BARREL.
 *
 * The former ~6800-line implementation (Data Science / APIs-Functions /
 * Fabric IQ editors) was decomposed into ./phase4/* — one file per exported
 * editor plus a shared-helpers module (arr / useStyles / useItemState /
 * SaveBar / ItemDoc). This module now re-exports every public editor so
 * registry.ts and every existing importer keep working unchanged.
 * Behavior-preserving split — zero logic change.
 */

// MlModelEditor (+ stage transitions, register-from-run, run lineage) lives in
// its own module; re-exported here so the editor registry import stays stable.
export { MlModelEditor } from './ml-model-editor';

export { GraphqlApiEditor } from './phase4/graphql-api-editor';
export { UserDataFunctionEditor } from './phase4/user-data-function-editor';
export { VariableLibraryEditor } from './phase4/variable-library-editor';
export { OntologyEditor } from './phase4/ontology-editor';
export { GraphModelEditor } from './phase4/graph-model-editor';
export { PlanEditor } from './phase4/plan-editor';
export { MapEditor } from './phase4/map-editor';
export { OperationsAgentEditor } from './phase4/operations-agent-editor';
export { DataAgentEditor } from './phase4/data-agent-editor';
