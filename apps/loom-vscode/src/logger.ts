/**
 * A single shared output channel + safe logging. Never logs credential values,
 * cookie contents, PAT strings, or full URLs with query — only method + path +
 * status, matching the extension's telemetry posture (PRP §2.8).
 */
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('CSA Loom');
    context.subscriptions.push(channel);
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

export function log(message: string): void {
  channel?.appendLine(`[${ts()}] ${message}`);
}

export function logError(where: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  channel?.appendLine(`[${ts()}] ERROR ${where}: ${msg}`);
}
