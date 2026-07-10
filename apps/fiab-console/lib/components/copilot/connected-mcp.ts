/**
 * connected-mcp — PURE derivation behind the CTS-09 per-conversation MCP panel.
 *
 * The per-CALL "via <server>" badge already lives in TurnDetailPanel. CTS-09's
 * missing half is the per-CONVERSATION view: "which MCP servers + tools were
 * live across this whole conversation, and how often". This folds every turn's
 * tool roll-up (Turn.turnDetail.tools[], each carrying an optional serverName)
 * into a de-duplicated server → tools map with call counts + success tallies.
 *
 * Kept import-free (no React/Azure) so it is unit-testable and shared by the
 * panel. Native always-on Loom tools (no serverName) are excluded — this panel
 * is specifically the MCP-server surface.
 */

import type { Turn } from './types';

/** One tool observed on an MCP server this conversation. */
export interface McpToolStat {
  name: string;
  calls: number;
  ok: number;
  failed: number;
}

/** One MCP server that backed at least one tool call this conversation. */
export interface McpServerStat {
  name: string;
  calls: number;
  ok: number;
  failed: number;
  tools: McpToolStat[];
}

export interface ConnectedMcp {
  servers: McpServerStat[];
  /** Total MCP-backed tool calls across all servers. */
  totalCalls: number;
}

/**
 * Fold the conversation's turns into the connected-MCP summary. Servers are
 * sorted by call count (desc) then name; tools within a server likewise.
 */
export function deriveConnectedMcp(turns: readonly Turn[]): ConnectedMcp {
  // serverName → (toolName → stat). Maps (not objects) so a tool literally
  // named "__proto__" can never pollute a prototype.
  const servers = new Map<string, Map<string, McpToolStat>>();
  let totalCalls = 0;

  for (const turn of turns) {
    for (const t of turn.turnDetail?.tools ?? []) {
      const server = (t.serverName || '').trim();
      if (!server) continue; // native built-in tool — not an MCP server.
      const toolName = (t.name || 'tool').trim() || 'tool';
      let tools = servers.get(server);
      if (!tools) {
        tools = new Map();
        servers.set(server, tools);
      }
      let stat = tools.get(toolName);
      if (!stat) {
        stat = { name: toolName, calls: 0, ok: 0, failed: 0 };
        tools.set(toolName, stat);
      }
      stat.calls += 1;
      if (t.ok) stat.ok += 1;
      else stat.failed += 1;
      totalCalls += 1;
    }
  }

  const out: McpServerStat[] = [];
  for (const [name, toolMap] of servers) {
    const tools = [...toolMap.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    out.push({
      name,
      tools,
      calls: tools.reduce((n, t) => n + t.calls, 0),
      ok: tools.reduce((n, t) => n + t.ok, 0),
      failed: tools.reduce((n, t) => n + t.failed, 0),
    });
  }
  out.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return { servers: out, totalCalls };
}
