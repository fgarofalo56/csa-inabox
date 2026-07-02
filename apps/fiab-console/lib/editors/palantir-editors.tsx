'use client';

/**
 * palantir-editors.tsx — BARREL.
 *
 * The former ~3400-line implementation was decomposed into ./palantir/*
 * (one file per exported editor + a shared-helpers module). This module now
 * re-exports the six public editors so registry.ts and every existing importer
 * (including tests) keep working unchanged. Behavior-preserving split — zero
 * logic change.
 *
 * Six Azure-native surfaces that supersede the doc-only mappings in
 * docs/migrations/palantir-foundry/:
 *   - WorkshopAppEditor       (Workshop  → Atelier)  ontology-bound low-code app
 *   - OntologySdkEditor       (OSDK)                typed SDK over an ontology (DAB)
 *   - SlateAppEditor          (Slate)               custom HTML/JS app → Azure SWA
 *   - ReleaseEnvironmentEditor(Apollo    → Shuttle)  promotion + ARM deploy history
 *   - HealthCheckEditor       (Checks)              Azure Monitor scheduledQueryRules
 *   - AipLogicEditor          (AIP-Logic → Spindle)  no-code typed LLM function
 */

export { WorkshopAppEditor } from './palantir/workshop-app-editor';
export { OntologySdkEditor } from './palantir/ontology-sdk-editor';
export { SlateAppEditor } from './palantir/slate-app-editor';
export { ReleaseEnvironmentEditor } from './palantir/release-environment-editor';
export { HealthCheckEditor } from './palantir/health-check-editor';
export { AipLogicEditor } from './palantir/aip-logic-editor';
