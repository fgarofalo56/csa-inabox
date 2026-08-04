/**
 * The `@loom` chat participant (Phase 4 / PRP M3) — a native Copilot Chat
 * participant that answers Loom questions by calling the REAL backend (catalog
 * search, item get, bounded query / preview) against the ACTIVE deployment and
 * streaming grounded results. Backed by Loom's own data plane, NOT GitHub
 * Copilot's model, so it works with no Copilot licence (Government coverage).
 *
 * All routing + grounding lives in the pure `chat-core.ts`; this file only
 * adapts VS Code's `ChatRequestHandler` + `ChatResponseStream` onto it and maps
 * the extension's `LoomApi` onto the read-only `ChatApi` surface.
 *
 * Capability-guarded: on a VS Code without the chat API this no-ops (PRP T-5).
 */
import * as vscode from 'vscode';
import type { LoomApi } from '../api/loom-client';
import type { ActiveDeploymentStore } from '../mcp/active-deployment';
import { runChatTurn, type ChatApi, type ChatStream } from './chat-core';
import { log } from '../logger';

export const CHAT_PARTICIPANT_ID = 'csa-loom.loom';

interface ChatDeps {
  context: vscode.ExtensionContext;
  activeDeployment: ActiveDeploymentStore;
  /** Resolve a deployment id → its authenticated LoomApi (undefined = signed out). */
  resolveApi: (deploymentId: string) => Promise<LoomApi | undefined>;
}

/** True when this VS Code exposes the finalized chat-participant API. */
export function chatApiAvailable(): boolean {
  const chat = (vscode as unknown as { chat?: { createChatParticipant?: unknown } }).chat;
  return typeof chat?.createChatParticipant === 'function';
}

/** Adapt the extension's LoomApi onto the read-only ChatApi the core grounds on. */
function adaptApi(api: LoomApi): ChatApi {
  return {
    catalogSearch: (query, opts) => api.catalogSearch(query, opts),
    getItem: (type, id) => api.getItem(type, id),
    querySql: (type, id, sql) => api.querySql(type, id, sql),
    preview: (type, id, top) => api.preview(type, id, top),
  };
}

export function registerLoomChatParticipant(deps: ChatDeps): boolean {
  if (!chatApiAvailable()) {
    log('Chat participant API unavailable on this VS Code — @loom chat not contributed.');
    return false;
  }

  const handler: vscode.ChatRequestHandler = async (request, _chatContext, response, token) => {
    const dep = deps.activeDeployment.get();
    const stream: ChatStream = {
      markdown: (md) => response.markdown(md),
      progress: (msg) => response.progress(msg),
      button: (action) =>
        response.button({ command: action.command, title: action.title, arguments: action.arguments }),
    };
    const result = await runChatTurn({
      command: request.command,
      prompt: request.prompt,
      deployment: dep ? { id: dep.id, name: dep.name, cloud: dep.cloud } : undefined,
      resolveApi: async () => {
        if (!dep) return undefined;
        const api = await deps.resolveApi(dep.id);
        return api ? adaptApi(api) : undefined;
      },
      stream,
      isCancelled: () => token.isCancellationRequested,
    });
    return { metadata: { command: request.command ?? '', kind: result.kind, grounded: result.grounded } };
  };

  const chat = (vscode as unknown as {
    chat: { createChatParticipant: (id: string, h: vscode.ChatRequestHandler) => vscode.ChatParticipant };
  }).chat;
  const participant = chat.createChatParticipant(CHAT_PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(deps.context.extensionUri, 'media', 'loom.png');
  deps.context.subscriptions.push(participant);
  log('@loom chat participant registered (grounded on the live backend).');
  return true;
}
