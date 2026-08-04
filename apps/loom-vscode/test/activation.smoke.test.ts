/**
 * Bundle smoke test — loads the REAL built `dist/extension.js` (the CJS bundle
 * that ships in the .vsix) with a fake `vscode` module, calls `activate()`, and
 * asserts it registers everything: the auth provider, every P1 + P2 command, the
 * `loom:` FileSystemProvider, a FileDecorationProvider, AND the new "CSA Loom
 * Spark" NotebookController on the built-in `jupyter-notebook` type.
 *
 * This exercises the shipped artifact end-to-end (not the TS source), so a wiring
 * regression that survives tsc/unit tests is still caught.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(dir, '..');
const distPath = path.resolve(appRoot, 'dist/extension.js');

interface Registry {
  commands: string[];
  fsSchemes: string[];
  decorationProviders: number;
  authProviders: string[];
  controllers: Array<{ id: string; notebookType: string }>;
}

function fakeVscode(reg: Registry): Record<string, unknown> {
  class EventEmitter<T = unknown> {
    private ls: Array<(e: T) => void> = [];
    event = (fn: (e: T) => void) => {
      this.ls.push(fn);
      return { dispose() {} };
    };
    fire(e: T) {
      for (const fn of this.ls) fn(e);
    }
    dispose() {}
  }
  class Disposable {
    constructor(private fn?: () => void) {}
    dispose() {
      this.fn?.();
    }
    static from() {
      return new Disposable();
    }
  }
  class Uri {
    constructor(
      readonly scheme: string,
      readonly path: string,
      private readonly _fsPath: string,
    ) {}
    get fsPath() {
      return this._fsPath;
    }
    toString() {
      return `${this.scheme}:${this.path}`;
    }
    with() {
      return this;
    }
    static from(c: { scheme: string; path?: string }) {
      return new Uri(c.scheme, c.path ?? '', c.path ?? '');
    }
    static file(p: string) {
      return new Uri('file', p, p);
    }
    static parse(s: string) {
      const i = s.indexOf(':');
      return new Uri(s.slice(0, i), s.slice(i + 1), s.slice(i + 1));
    }
    static joinPath(base: Uri, ...segs: string[]) {
      const p = [base.path, ...segs].join('/');
      return new Uri(base.scheme, p, p);
    }
  }
  const statusBarItem = () => ({
    text: '',
    tooltip: '',
    command: '',
    name: '',
    show() {},
    hide() {},
    dispose() {},
  });
  return {
    EventEmitter,
    Disposable,
    Uri,
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    MarkdownString: class {
      constructor(public value = '') {}
    },
    TreeItem: class {
      constructor(
        public label: unknown,
        public collapsibleState?: unknown,
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 0, Created: 1, Deleted: 2 },
    ProgressLocation: { Notification: 15 },
    FileSystemError: {
      FileNotFound: (m?: unknown) => new Error(`FileNotFound: ${String(m)}`),
      FileNotADirectory: (m?: unknown) => new Error(`FileNotADirectory: ${String(m)}`),
      NoPermissions: (m?: unknown) => new Error(`NoPermissions: ${String(m)}`),
    },
    authentication: {
      registerAuthenticationProvider: (id: string) => {
        reg.authProviders.push(id);
        return new Disposable();
      },
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {}, name: 'CSA Loom' }),
      createTreeView: () => ({ dispose() {} }),
      createStatusBarItem: () => statusBarItem(),
      registerFileDecorationProvider: () => {
        reg.decorationProviders++;
        return new Disposable();
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, def: unknown) => def }),
      registerFileSystemProvider: (scheme: string) => {
        reg.fsSchemes.push(scheme);
        return new Disposable();
      },
      onDidChangeConfiguration: () => new Disposable(),
    },
    commands: {
      registerCommand: (id: string) => {
        reg.commands.push(id);
        return new Disposable();
      },
      executeCommand: async () => undefined,
    },
    notebooks: {
      createNotebookController: (id: string, notebookType: string, label: string) => {
        reg.controllers.push({ id, notebookType });
        return {
          id,
          notebookType,
          label,
          supportedLanguages: [] as string[],
          supportsExecutionOrder: false,
          description: '',
          detail: '',
          executeHandler: undefined,
          interruptHandler: undefined,
          createNotebookCellExecution: () => ({}),
          dispose() {},
        };
      },
    },
  };
}

function loadExtension(vs: Record<string, unknown>): { activate: (c: unknown) => void; deactivate?: () => void } {
  const source = fs.readFileSync(distPath, 'utf8');
  const req = createRequire(import.meta.url);
  const mod = { exports: {} as Record<string, unknown> };
  const customRequire = (id: string) => (id === 'vscode' ? vs : req(id));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
  wrapper(mod.exports, customRequire, mod, distPath, appRoot);
  return mod.exports as { activate: (c: unknown) => void };
}

function fakeContext() {
  return {
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: { get: (_k: string, def: unknown) => def, update: async () => undefined },
    workspaceState: { get: (_k: string, def: unknown) => def, update: async () => undefined },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
}

describe('activate() — shipped bundle registers everything (P1 + P2)', () => {
  beforeAll(() => {
    if (!fs.existsSync(distPath)) {
      execFileSync(process.execPath, ['build.mjs'], { cwd: appRoot, stdio: 'inherit' });
    }
  });

  it('registers the auth provider, FS scheme, decoration provider, notebook controller, and all commands', async () => {
    const reg: Registry = { commands: [], fsSchemes: [], decorationProviders: 0, authProviders: [], controllers: [] };
    const ext = loadExtension(fakeVscode(reg));
    const context = fakeContext();
    ext.activate(context);
    // Let the fire-and-forget syncAuthState settle (no throw expected).
    await new Promise((r) => setTimeout(r, 10));

    // Auth + tree + status bar + FS + decorations wired.
    expect(reg.authProviders).toContain('loom');
    expect(reg.fsSchemes).toContain('loom');
    expect(reg.decorationProviders).toBeGreaterThanOrEqual(1);

    // The new "CSA Loom Spark" controller on the built-in jupyter-notebook type.
    expect(reg.controllers).toEqual([{ id: 'csa-loom-spark', notebookType: 'jupyter-notebook' }]);

    // Every P2 command has a handler (a package.json command without one is vaporware).
    const p2 = [
      'loom.openDefinition',
      'loom.createNotebook',
      'loom.setWorkFolder',
      'loom.downloadItem',
      'loom.deleteDownloaded',
      'loom.publish',
      'loom.update',
      'loom.runOnSpark',
      'loom.setSparkCompute',
      'loom.viewRecentRuns',
    ];
    for (const id of p2) expect(reg.commands).toContain(id);
    // P1 commands still registered.
    for (const id of ['loom.signIn', 'loom.createItem', 'loom.refresh']) expect(reg.commands).toContain(id);

    expect(context.subscriptions.length).toBeGreaterThan(0);
  });
});
