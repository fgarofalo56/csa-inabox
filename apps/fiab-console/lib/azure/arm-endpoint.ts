/**
 * Sovereign-cloud-aware ARM endpoint resolver — LEGACY SHIM.
 *
 * The canonical implementation now lives in `cloud-endpoints.ts` (the single
 * source of truth for every sovereign-cloud suffix + AAD scope). This module
 * used to re-declare `armBase()` with its own `https://management.azure.com`
 * literal, which duplicated the truth table and tripped the cloud-endpoint grep
 * gate. It now re-exports the canonical helpers so existing importers keep
 * working while there is exactly ONE place the ARM host literal exists.
 *
 * New code should import from `./cloud-endpoints` directly.
 */
export { armBase, armScope, armHost } from './cloud-endpoints';
