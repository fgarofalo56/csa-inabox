/**
 * R30 fragment — the 'ai-copilot' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/ai-copilot.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const AI_COPILOT_GATE_META: Record<string, GateMeta> = {
  'svc-learning-hub': {
    surfaces: [{ path: '/learn', label: 'Learning Hub — help agent' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_ENDPOINT: L.aoaiEndpoint },
  },
  'svc-mcp-catalog': {
    surfaces: [{ path: '/admin/mcp-servers', label: 'MCP Servers — built-in server' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-agent-mesh': {
    surfaces: [
      { path: '/mesh', label: 'Sovereign Agent Mesh — registry + governed run' },
      { path: '/api/mesh/run', label: 'Mesh task run (egress profile enforcement)' },
    ],
    // Fix-it: set LOOM_MESH_PROFILE (commercial | gov | air-gap) — and optionally
    // LOOM_A2A_EGRESS_ALLOW for approved external hops — through the shared
    // env-apply write path. The mesh runs on the cloud-default profile when unset.
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the mesh runs on the cloud-default egress profile (Gov cloud → gov, else commercial) with an empty external allow-list — fully functional in-boundary (default-ON / opt-out). Set LOOM_MESH_PROFILE=air-gap to pin a sovereign/disconnected boundary (fail-closed egress); set LOOM_A2A_EGRESS_ALLOW to permit specific approved external hops.',
    legacyCodes: [],
  },
  'svc-aoai-embeddings': {
    surfaces: [
      { path: '/items/ai-search-index', label: 'Index my data (embeddings)' },
      { path: '/api/ai-search/index-my-data/*', label: 'Vector index routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_EMBED_DEPLOYMENT: L.aoaiDeployment },
    legacyCodes: ['embedding_not_configured'],
  },
  'svc-model-reasoning-tier': {
    surfaces: [
      { path: '/copilot', label: 'Copilot — reasoning-tier routing' },
      { path: '/admin/copilot', label: 'Copilot & Agents — Model tiers' },
      { path: '/items/*', label: 'Data agents / item Copilots (hard-turn routing)' },
    ],
    // Fix-it: pick a real deployed reasoning/mini model from the account's live
    // AOAI deployments (the aoai-deployments loader lists deployments across the
    // subscription's OpenAI/AIServices accounts), then it's written via the one
    // shared env-apply write path.
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_STRONG_DEPLOYMENT: L.aoaiDeployment, LOOM_AOAI_MINI_DEPLOYMENT: L.aoaiDeployment },
    autoResolveNote: 'Unset → the tier router silently rides the single default AOAI deployment for every turn (fully functional, just no hard-turn upshift). A push-button deploy wires the mini/strong tiers from the Foundry project (best model per cloud) — set them here to enable best-per-task routing on an existing deployment.',
    legacyCodes: [],
  },
  'svc-iq-mcp': {
    surfaces: [{ path: '/admin/mcp-servers', label: 'IQ MCP bridge' }],
    fixit: { kind: 'env-picker' },
  },
};
