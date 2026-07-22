'use client';

/**
 * APIM editors — wired live to Azure API Management (apim-csa-loom-eastus2)
 * via the BFF (/api/items/apim-*). No mock data.
 *
 *   ApimApiEditor       — load operations + spec, edit displayName/path/protocols/subscriptionRequired, Save -> PUT
 *   ApimProductEditor   — load product, edit displayName/description/state/flags, Save -> PUT
 *   ApimPolicyEditor    — load policy XML for a scope, validate well-formed XML client-side, Save -> PUT
 *   DataProductEditor   — visual, but the Publish-to-APIM button POSTs a real product (idempotent upsert)
 *
 * APIM is the API-first glue per the CSA reference architecture: every Loom
 * function, ML endpoint, GraphQL API, and data-product surface is fronted
 * through APIM for auth, rate limiting, observability, and marketplace discovery.
 *
 * WS-E1 decomposition (behavior-preserving): the four editors + their shared
 * styles/StatusBar were split into sibling modules under ./apim-editors/. This
 * file is now a barrel that re-exports them so every existing import path
 * (`import { ApimApiEditor } from '.../apim-editors'`) keeps resolving.
 */

export { ApimApiEditor } from './apim-editors/api-editor';
export { ApimProductEditor } from './apim-editors/product-editor';
export { ApimPolicyEditor } from './apim-editors/policy-editor';
export { DataProductEditor } from './apim-editors/data-product-editor';
