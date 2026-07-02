/**
 * Type declaration for the plain-JS pylsp WebSocket bridge (pylsp-bridge.mjs).
 * The bridge is authored in JS (it patches the Node http singleton and must
 * load natively, not through the TS/webpack pipeline), so this sidecar gives
 * `instrumentation.ts` a typed import surface instead of an implicit-any.
 */
import type { Server } from 'node:http';

/**
 * Attach the Pylance/pylsp WebSocket upgrade handler to a running HTTP server.
 * Returns once the bridge's upgrade listener is registered.
 */
export function attachPylspBridge(server: Server): Promise<void>;

/** Pure helpers exported for unit tests only. */
export const __test: {
  frame: (payload: string) => string;
  makeStdoutParser: (onMessage: (msg: unknown) => void) => (chunk: Buffer) => void;
  readCookie: (header: string | undefined, name: string) => string | undefined;
};
