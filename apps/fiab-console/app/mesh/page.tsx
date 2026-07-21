/**
 * /mesh — WS-9 Sovereign Agent Mesh + MCP/A2A hub.
 *
 * The governed, in-VNet multi-agent mesh surface. Renders the client console
 * (lib/mesh/agent-mesh-console) which is wired end-to-end to /api/mesh/*.
 */
import { AgentMeshConsole } from '@/lib/mesh/agent-mesh-console';

export const dynamic = 'force-dynamic';

export default function MeshPage() {
  return <AgentMeshConsole />;
}
