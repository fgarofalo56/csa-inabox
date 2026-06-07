/**
 * Unit tests for the AML Compute-Instance Jupyter Server client.
 *
 *   - normalizeJupyterOutput (pure): stream / execute_result / error shaping
 *   - executeViaKernelWs: record/replay of the Jupyter kernel WebSocket. The
 *     global WebSocket is stubbed with a class that replays a canned kernel
 *     message sequence (a real `print(1+1)` transcript and a failing-cell
 *     transcript) as `onmessage` frames after the client sends execute_request.
 *
 * No network. The replay frames are the literal Jupyter messaging-protocol v5.3
 * shapes the AML CI kernel emits (status → stream/execute_result/error →
 * execute_reply), so this exercises the real correlation + accumulation logic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  normalizeJupyterOutput,
  executeViaKernelWs,
  type NotebookToken,
} from '../jupyter-server-client';

const TOKEN: NotebookToken = {
  accessToken: 'nb-token',
  hostName: 'abc123.notebooks.azure.net',
  expiresIn: 28800,
  scope: 'aznb_identity',
};

// --- Canned kernel transcripts (record/replay fixtures) ---------------------

// print(1+1)  → stdout stream "2\n" then execute_reply ok.
const PRINT_TRANSCRIPT = [
  { header: { msg_type: 'status' }, content: { execution_state: 'busy' } },
  { header: { msg_type: 'stream' }, content: { name: 'stdout', text: '2\n' } },
  { header: { msg_type: 'execute_reply' }, content: { status: 'ok', execution_count: 1 } },
];

// 1+1 as last expression → execute_result data text/plain "2".
const RESULT_TRANSCRIPT = [
  { header: { msg_type: 'status' }, content: { execution_state: 'busy' } },
  { header: { msg_type: 'execute_result' }, content: { execution_count: 1, data: { 'text/plain': '2' } } },
  { header: { msg_type: 'execute_reply' }, content: { status: 'ok', execution_count: 1 } },
];

// raise ValueError("bad") → error message with traceback then execute_reply error.
const ERROR_TRANSCRIPT = [
  { header: { msg_type: 'status' }, content: { execution_state: 'busy' } },
  { header: { msg_type: 'stream' }, content: { name: 'stderr', text: 'oops on stderr\n' } },
  {
    header: { msg_type: 'error' },
    content: {
      ename: 'ValueError',
      evalue: 'bad',
      traceback: ['Traceback (most recent call last):', 'ValueError: bad'],
    },
  },
  { header: { msg_type: 'error-reply-marker' }, content: {} }, // ignored type
  { header: { msg_type: 'execute_reply' }, content: { status: 'error' } },
];

/**
 * Mock global WebSocket that, on send(), echoes a canned transcript back through
 * onmessage with parent_header.msg_id correlated to the request, then closes.
 */
function installMockWebSocket(transcript: any[]) {
  class MockWS {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    onclose: (() => void) | null = null;
    url: string;
    constructor(url: string, _init?: unknown) {
      this.url = url;
      // open on next tick so handlers are wired first
      Promise.resolve().then(() => this.onopen?.());
    }
    send(raw: string) {
      const req = JSON.parse(raw);
      const msgId = req?.header?.msg_id;
      for (const frame of transcript) {
        const withParent = { ...frame, parent_header: { msg_id: msgId } };
        Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify(withParent) }));
      }
    }
    close() {
      Promise.resolve().then(() => this.onclose?.());
    }
  }
  vi.stubGlobal('WebSocket', MockWS as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeJupyterOutput', () => {
  it('shapes a print(1+1) stdout stream into textPlain 2', () => {
    const out = normalizeJupyterOutput(['2\n'], null, null);
    expect(out.status).toBe('ok');
    expect(out.textPlain).toBe('2\n');
  });

  it('shapes an execute_result text/plain into textPlain 2', () => {
    const out = normalizeJupyterOutput([], { data: { 'text/plain': '2' } }, null);
    expect(out.status).toBe('ok');
    expect(out.textPlain).toBe('2');
  });

  it('concatenates stream chunks and execute_result text', () => {
    const out = normalizeJupyterOutput(['hello\n'], { data: { 'text/plain': '42' } }, null);
    expect(out.textPlain).toBe('hello\n42');
  });

  it('joins array text/plain (notebook list form)', () => {
    const out = normalizeJupyterOutput([], { data: { 'text/plain': ['line1\n', 'line2'] } }, null);
    expect(out.textPlain).toBe('line1\nline2');
  });

  it('passes text/html and image/png through', () => {
    const out = normalizeJupyterOutput(
      [],
      { data: { 'text/html': '<b>hi</b>', 'image/png': 'data:image/png;base64,QUJD' } },
      null,
    );
    expect(out.textHtml).toBe('<b>hi</b>');
    expect(out.imageBase64).toBe('QUJD');
  });

  it('shapes an error with ename/evalue/traceback and keeps captured stderr', () => {
    const out = normalizeJupyterOutput(
      ['stderr text\n'],
      null,
      { ename: 'ValueError', evalue: 'bad', traceback: ['tb1', 'tb2'] },
    );
    expect(out.status).toBe('error');
    expect(out.ename).toBe('ValueError');
    expect(out.evalue).toBe('bad');
    expect(out.traceback).toEqual(['tb1', 'tb2']);
    expect(out.textPlain).toBe('stderr text\n');
  });
});

describe('executeViaKernelWs (record/replay)', () => {
  it('returns real output 2 for print(1+1) via stdout stream', async () => {
    installMockWebSocket(PRINT_TRANSCRIPT);
    const out = await executeViaKernelWs(TOKEN, 'kernel-1', 'sess-1', 'print(1+1)');
    expect(out.status).toBe('ok');
    expect(out.textPlain).toBe('2\n');
  });

  it('returns execute_result 2 when the cell is an expression', async () => {
    installMockWebSocket(RESULT_TRANSCRIPT);
    const out = await executeViaKernelWs(TOKEN, 'kernel-1', 'sess-1', '1+1');
    expect(out.status).toBe('ok');
    expect(out.textPlain).toBe('2');
  });

  it('captures stderr + traceback for a failing cell', async () => {
    installMockWebSocket(ERROR_TRANSCRIPT);
    const out = await executeViaKernelWs(TOKEN, 'kernel-1', 'sess-1', 'raise ValueError("bad")');
    expect(out.status).toBe('error');
    expect(out.ename).toBe('ValueError');
    expect(out.evalue).toBe('bad');
    expect(out.traceback).toEqual(['Traceback (most recent call last):', 'ValueError: bad']);
    expect(out.textPlain).toBe('oops on stderr\n');
  });

  it('ignores frames whose parent_header msg_id does not match the request', async () => {
    class NoiseWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() { Promise.resolve().then(() => this.onopen?.()); }
      send(raw: string) {
        const msgId = JSON.parse(raw)?.header?.msg_id;
        // A stale frame from a different request — must be ignored.
        Promise.resolve().then(() =>
          this.onmessage?.({ data: JSON.stringify({ header: { msg_type: 'stream' }, parent_header: { msg_id: 'OTHER' }, content: { text: 'IGNORED' } }) }),
        );
        // Then our real frames.
        Promise.resolve().then(() =>
          this.onmessage?.({ data: JSON.stringify({ header: { msg_type: 'stream' }, parent_header: { msg_id: msgId }, content: { text: 'kept\n' } }) }),
        );
        Promise.resolve().then(() =>
          this.onmessage?.({ data: JSON.stringify({ header: { msg_type: 'execute_reply' }, parent_header: { msg_id: msgId }, content: { status: 'ok' } }) }),
        );
      }
      close() { Promise.resolve().then(() => this.onclose?.()); }
    }
    vi.stubGlobal('WebSocket', NoiseWS as any);
    const out = await executeViaKernelWs(TOKEN, 'k', 's', 'print("kept")');
    expect(out.textPlain).toBe('kept\n');
  });
});
