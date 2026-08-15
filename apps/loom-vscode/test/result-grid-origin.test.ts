/**
 * result-grid.js — webview message-origin guard (CodeQL js/missing-origin-check
 * #766 / CWE-940).
 *
 * The real media/result-grid.js is loaded and executed here, in a `node:vm`
 * sandbox carrying the smallest DOM the script actually touches. Nothing is
 * re-implemented: the handler under test is the one that ships in the .vsix.
 *
 * WHAT IS BEING PROVED. The panel is driven entirely by the extension host. A
 * window that is not same-origin must not be able to repaint it — a fabricated
 * "rows 0" over a query the user really ran is a lie the UI cannot detect.
 *
 * The accepted shape is asserted as a CONTROL so a future tightening cannot
 * silently break the host path. It is not a guess: in the pinned VS Code 1.102
 * host (pre/index.html) both posts into this document supply
 * `targetOrigin = window.origin` (lines 1126, 1242 — no wildcard anywhere) and
 * the frame's sandbox ALWAYS carries `allow-same-origin`, so the browser's own
 * delivery rule guarantees `event.origin === window.origin` on the real path.
 *
 * The opaque-origin cases have their own test because that is the one way a
 * same-origin comparison degenerates into "accept anyone": `window.origin` and
 * `event.origin` both serialize to the string 'null', so `===` holds between
 * two UNRELATED opaque origins.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'result-grid.js');

interface FakeNode {
  tag: string;
  className: string;
  textContent: string;
  children: FakeNode[];
  firstChild: FakeNode | null;
  appendChild(c: FakeNode): FakeNode;
  removeChild(c: FakeNode): FakeNode;
}

function makeNode(tag: string): FakeNode {
  const node: FakeNode = {
    tag,
    className: '',
    textContent: '',
    children: [],
    get firstChild() {
      return node.children[0] ?? null;
    },
    appendChild(c) {
      node.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i >= 0) node.children.splice(i, 1);
      return c;
    },
  };
  return node;
}

/** Every string rendered under `node`, in document order. */
function text(node: FakeNode): string {
  return [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
}

function loadPanel(ownOrigin = 'vscode-webview://11111111-2222-3333-4444-555555555555') {
  const statusbar = makeNode('div');
  const content = makeNode('div');
  const listeners: Array<(e: unknown) => void> = [];
  const posted: unknown[] = [];

  const parentWindow = { name: 'vscode-webview-host-frame' };
  const foreignWindow = { name: 'a-window-that-is-not-an-ancestor' };

  const win: Record<string, unknown> = {
    parent: parentWindow,
    top: parentWindow,
    origin: ownOrigin,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.push(fn);
    },
  };

  const sandbox = {
    window: win,
    document: {
      getElementById: (id: string) => (id === 'statusbar' ? statusbar : content),
      createElement: (tag: string) => makeNode(tag),
      createTextNode: (t: string) => {
        const n = makeNode('#text');
        n.textContent = String(t);
        return n;
      },
    },
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(m) }),
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MEDIA, 'utf8'), sandbox, { filename: MEDIA });

  const send = (source: unknown, origin: string, data: unknown) => {
    for (const fn of listeners) fn({ source, origin, data });
  };

  return { statusbar, content, posted, parentWindow, foreignWindow, send, win };
}

const RESULT = {
  type: 'result',
  title: 'FORGED',
  engine: 'sql',
  columns: [{ name: 'c1' }],
  rows: [['injected-by-a-foreign-window']],
  meta: { rowCount: 1, elapsedMs: 1 },
};

describe('result-grid webview — postMessage origin guard (#766)', () => {
  it('registers exactly one message listener and signals ready to the host', () => {
    const p = loadPanel();
    expect(p.posted).toEqual([{ type: 'ready' }]);
  });

  it('CONTROL — the real host post DOES render (parent frame, matching origin)', () => {
    // The shape VS Code 1.102 actually delivers: relayed from the embedding
    // frame with targetOrigin = window.origin, so the origins match. Without
    // this the rejection assertions below would also pass on a handler that
    // renders nothing at all, ever.
    const p = loadPanel();
    p.send(p.parentWindow, p.win.origin as string, RESULT);
    expect(text(p.content)).toContain('injected-by-a-foreign-window');
    expect(text(p.statusbar)).toContain('FORGED');
  });

  it('REJECTS a cross-origin post even when it comes from the ancestor frame', () => {
    // Embedder identity is NOT the credential; the origin is. A post that
    // claims a foreign origin is refused no matter which window sent it.
    const p = loadPanel();
    p.send(p.parentWindow, 'https://evil.example', RESULT);
    expect(text(p.content)).toBe('');
    expect(text(p.statusbar)).toBe('');
  });

  it('REJECTS a cross-origin post from a window that is not an ancestor', () => {
    const p = loadPanel();
    p.send(p.foreignWindow, 'https://evil.example', RESULT);
    expect(text(p.content)).toBe('');
    expect(text(p.statusbar)).toBe('');
  });

  it('a forged post cannot overwrite a real result already on screen', () => {
    // The damaging case is not a blank panel, it is a believable wrong one: a
    // fabricated "rows 0" replacing the rows the user's query actually returned.
    const p = loadPanel();
    p.send(p.parentWindow, p.win.origin as string, {
      type: 'result',
      title: 'Real query',
      engine: 'sql',
      columns: [{ name: 'secret' }],
      rows: [['real-row-from-the-backend']],
      meta: { rowCount: 1, elapsedMs: 7 },
    });
    p.send(p.foreignWindow, 'https://evil.example', {
      type: 'message',
      title: 'Real query',
      engine: 'sql',
      message: 'The query returned no rows.',
      isError: false,
    });
    expect(text(p.content)).toContain('real-row-from-the-backend');
    expect(text(p.content)).not.toContain('no rows');
  });

  it('rejects the loading and message states from a foreign origin too', () => {
    for (const forged of [
      { type: 'loading', title: 'FORGED', engine: 'sql' },
      { type: 'message', title: 'FORGED', engine: 'sql', message: 'FORGED', isError: true },
    ]) {
      const p = loadPanel();
      p.send(p.foreignWindow, 'https://evil.example', forged);
      expect(text(p.content)).toBe('');
      expect(text(p.statusbar)).toBe('');
    }
  });

  it('an OPAQUE origin does not turn the same-origin test into "accept anyone"', () => {
    // If this document ever loads with an opaque origin (a sandboxed frame
    // without `allow-same-origin`), `window.origin` is the STRING 'null' — and
    // so is `event.origin` for every other opaque-origin window in existence.
    // A bare `event.origin === window.origin` would then be true for a sender
    // that shares nothing with us. Rejected regardless of which window sent it.
    const opaque = loadPanel('null');
    opaque.send(opaque.foreignWindow, 'null', RESULT);
    opaque.send(opaque.parentWindow, 'null', RESULT);
    expect(text(opaque.content)).toBe('');
    expect(text(opaque.statusbar)).toBe('');

    // CONTROL — the identical payload DOES render on a panel with a real
    // origin, so the assertions above are the guard rejecting, not the fixture
    // being inert or the payload being malformed.
    const real = loadPanel();
    real.send(real.parentWindow, real.win.origin as string, RESULT);
    expect(text(real.content)).toContain('injected-by-a-foreign-window');
  });

  it('an empty-string origin is rejected the same way', () => {
    const p = loadPanel('');
    p.send(p.foreignWindow, '', RESULT);
    p.send(p.parentWindow, '', RESULT);
    expect(text(p.content)).toBe('');
  });
});
