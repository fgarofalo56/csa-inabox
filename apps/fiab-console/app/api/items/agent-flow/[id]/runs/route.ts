/**
 * GET /api/items/agent-flow/[id]/runs   → the persisted run history (W9).
 *
 * Returns `item.state.runs[]` (newest first, up to 50). Owner-scoped via
 * `withWorkspaceOwner` (WS-D1) — the wrapper runs the exact `loadOwnedItem`
 * owner/workspace-ACL check (read-role allowed) the route-guard recognizes.
 */
import { apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import type { AgentFlowState } from '@/lib/azure/agent-flow-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, (_req, { item }) => {
  const state = (item.state || {}) as AgentFlowState;
  return apiOk({ runs: Array.isArray(state.runs) ? state.runs : [] });
});
