/**
 * `CSA Loom: Manage MCP servers` — the explicit opt-in surface for the write /
 * admin Loom MCP servers (task security requirement). The two read-only servers
 * (catalog, query) are enabled by default; enabling `loom-author` / `loom-ops` /
 * `loom-admin` is a deliberate, confirmed choice made here (writes to the
 * `loom.mcp.enabledServers` setting), never automatic.
 */
import * as vscode from 'vscode';
import type { CommandContext } from './context';
import { MCP_SERVERS, coerceEnabledServers, type McpServerId } from '../mcp/server-definitions';

export async function manageMcpServers(cx: CommandContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('loom');
  const current = new Set(coerceEnabledServers(cfg.get('mcp.enabledServers')));

  const picks = MCP_SERVERS.map((s) => ({
    label: `${s.writes ? '$(pencil) ' : '$(shield) '}${s.label}`,
    description: s.id,
    detail: s.blastRadius,
    id: s.id,
    picked: current.has(s.id),
  }));

  const chosen = await vscode.window.showQuickPick(picks, {
    title: 'CSA Loom MCP servers — enable per blast radius',
    placeHolder: 'Read-only catalog + query are safe defaults; author/ops/admin are WRITE/ADMIN.',
    canPickMany: true,
  });
  if (!chosen) return; // cancelled — no change

  const nextIds = chosen.map((c) => c.id as McpServerId);

  // Confirm before enabling any WRITE/ADMIN server that was not already on.
  const newlyElevated = MCP_SERVERS.filter(
    (s) => s.writes && nextIds.includes(s.id) && !current.has(s.id),
  );
  if (newlyElevated.length > 0) {
    const names = newlyElevated.map((s) => s.id).join(', ');
    const ok = await vscode.window.showWarningMessage(
      `Enable write/admin MCP server(s): ${names}? These let an agent modify or provision Loom resources. ` +
        `They require a read-write (or admin) PAT and are audited server-side.`,
      { modal: true },
      'Enable',
    );
    if (ok !== 'Enable') return;
  }

  await cfg.update('mcp.enabledServers', nextIds, vscode.ConfigurationTarget.Global);
  cx.refreshMcp();
  void vscode.window.showInformationMessage(
    `CSA Loom MCP servers enabled: ${nextIds.length ? nextIds.join(', ') : '(none)'}.`,
  );
}
