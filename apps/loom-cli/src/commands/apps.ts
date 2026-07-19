/**
 * `loom apps` — the Loom App Runtime dev loop (APP-W4).
 *
 *   build <id> [--template t | --git url] [--port N] [--watch]
 *   status <id> --run <runId>
 *   deploy <id> [--image ref] [--min N] [--max N]     (image defaults to the
 *                                                      latest succeeded build)
 *   logs <id> [--tail N]
 *   start | stop <id>
 *   run-local <id> [--dir path] [--run]                fetch the REAL build
 *                                                      context and run it in
 *                                                      local docker
 *   export <id> [--out app.loomapp]                    portable app bundle
 *   ci-template <id> [--out loom-app-ci.yml]           GitHub Actions workflow
 *                                                      (build → deploy → gate)
 *
 * Everything wraps the same BFF routes the editor uses — no parallel API.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireAuth, CliError } from './context.js';
import type { GlobalOptions } from '../config.js';
import { flagStr, flagBool, type ParsedArgs } from '../args.js';
import { printResult } from '../output.js';

interface BuildStatus { runId: string; status: string; finished: boolean; succeeded?: boolean }
interface BuildStart { ok: boolean; build?: { runId: string; image?: string; imageName?: string; source?: string } }
interface RuntimeShape {
  templateId?: string; port?: number;
  env?: Array<{ name: string; value?: string; secretRef?: string }>;
  builds?: Array<{ runId: string; image?: string; imageName?: string; status?: string }>;
  containerAppName?: string; url?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runApps(sub: string, args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  const { client, output } = await requireAuth(opts);
  const id = args.positionals[0];
  const api = (p: string) => `/api/items/loom-app-runtime/${encodeURIComponent(id)}${p}`;
  if (!id && sub !== '') throw new CliError(`Usage: loom apps ${sub || '<command>'} <itemId> [...]`);

  switch (sub) {
    case 'build': {
      const body: Record<string, unknown> = {};
      const template = flagStr(args.flags, 'template');
      const git = flagStr(args.flags, 'git');
      const port = flagStr(args.flags, 'port');
      if (template) body.templateId = template;
      if (git) body.gitSource = git;
      if (port) body.port = Number(port);
      const started = await client.request<BuildStart>('POST', api('/build'), body);
      const runId = started.build?.runId;
      printResult({ ok: true, runId, image: started.build?.imageName, source: started.build?.source }, output);
      if (!flagBool(args.flags, 'watch') || !runId) return;
      for (;;) {
        await sleep(15_000);
        const s = await client.request<{ status?: BuildStatus }>('GET', api(`/build?runId=${encodeURIComponent(runId)}`));
        const st = s.status;
        process.stderr.write(`  ${st?.status || 'Unknown'}\n`);
        if (st?.finished) {
          if (!st.succeeded) throw new CliError(`Build ${runId} ${st.status}. Check the source + Dockerfile.`);
          printResult({ ok: true, runId, status: st.status }, output);
          return;
        }
      }
    }
    case 'status': {
      const runId = flagStr(args.flags, 'run');
      if (!runId) throw new CliError('Usage: loom apps status <itemId> --run <runId>');
      const s = await client.request<{ status?: BuildStatus }>('GET', api(`/build?runId=${encodeURIComponent(runId)}`));
      printResult(s.status || { runId, status: 'Unknown' }, output);
      return;
    }
    case 'deploy': {
      let image = flagStr(args.flags, 'image');
      const rt = await fetchRuntime(client, id);
      if (!image) {
        const ok = (rt.builds || []).filter((b) => b.status === 'Succeeded' && b.image);
        image = ok[0]?.image || ok[ok.length - 1]?.image;
        if (!image) throw new CliError('No succeeded build found — run `loom apps build` first or pass --image.');
      }
      const body: Record<string, unknown> = { image, port: rt.port, env: rt.env || [] };
      const min = flagStr(args.flags, 'min'); const max = flagStr(args.flags, 'max');
      if (min) body.minReplicas = Number(min);
      if (max) body.maxReplicas = Number(max);
      const out = await client.request<{ deployed?: Record<string, unknown> }>('POST', api('/deploy'), body);
      printResult(out.deployed || out, output);
      return;
    }
    case 'logs': {
      const tail = flagStr(args.flags, 'tail') || '200';
      const out = await client.request<{ lines?: string[] }>('GET', api(`/logs?tail=${encodeURIComponent(tail)}`));
      for (const l of out.lines || []) process.stdout.write(l + '\n');
      return;
    }
    case 'start':
    case 'stop': {
      const out = await client.request('POST', api('/lifecycle'), { action: sub });
      printResult(out as object, output);
      return;
    }
    case 'run-local': {
      const dir = resolve(flagStr(args.flags, 'dir') || `./loom-app-${id.slice(0, 8)}`);
      const ctx = await client.request<{ files: Array<{ path: string; content: string }> }>('GET', api('/context'));
      for (const f of ctx.files) {
        const p = join(dir, f.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.content, 'utf-8');
      }
      const rt = await fetchRuntime(client, id);
      const port = rt.port || 8000;
      process.stderr.write(`Wrote ${ctx.files.length} files to ${dir}\n`);
      if (flagBool(args.flags, 'run')) {
        const tag = `loom-app-local-${id.slice(0, 8)}`;
        const build = spawnSync('docker', ['build', '-t', tag, dir], { stdio: 'inherit' });
        if (build.status !== 0) throw new CliError('docker build failed (is Docker running?)');
        process.stderr.write(`\nStarting on http://localhost:${port} (Ctrl-C to stop)\n`);
        spawnSync('docker', ['run', '--rm', '-p', `${port}:${port}`, tag], { stdio: 'inherit' });
      } else {
        process.stderr.write(`Next: docker build -t myapp ${dir} && docker run --rm -p ${port}:${port} myapp\n`);
      }
      return;
    }
    case 'export': {
      const out = flagStr(args.flags, 'out') || `${id.slice(0, 8)}.loomapp`;
      const bundle = await client.request<Record<string, unknown>>('GET', api('/export'));
      writeFileSync(resolve(out), JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
      printResult({ ok: true, wrote: out }, output);
      return;
    }
    case 'ci-template': {
      const out = flagStr(args.flags, 'out') || 'loom-app-ci.yml';
      writeFileSync(resolve(out), ciTemplate(id), 'utf-8');
      printResult({ ok: true, wrote: out, note: 'Set repo secrets LOOM_API_URL + LOOM_CLIENT_ID/LOOM_CLIENT_SECRET (a service principal loom auth accepts).' }, output);
      return;
    }
    default:
      throw new CliError(`Unknown apps subcommand "${sub}". Use: build | status | deploy | logs | start | stop | run-local | export | ci-template`);
  }
}

async function fetchRuntime(client: { request<T>(m: string, p: string, b?: unknown): Promise<T> }, id: string): Promise<RuntimeShape> {
  // The item route returns { ok, runtime, infra, live } — runtime carries
  // templateId/port/env/builds (lib/apps/runtime-store.ts shape).
  const item = await client.request<{ runtime?: RuntimeShape }>('GET', `/api/items/loom-app-runtime/${encodeURIComponent(id)}`);
  return item.runtime || {};
}

/** GitHub Actions workflow: build → deploy → health-gate via this CLI. */
function ciTemplate(itemId: string): string {
  return `# Loom App CI — build + deploy on push (generated by \`loom apps ci-template\`).
# Secrets: LOOM_API_URL, LOOM_CLIENT_ID, LOOM_CLIENT_SECRET (+ optional LOOM_TENANT_ID).
# Runner: use the in-VNet self-hosted runner (loom-aca) when the console is VNet-internal.
name: loom-app-ci
on:
  push:
    branches: [main]
  workflow_dispatch: {}
jobs:
  build-deploy:
    runs-on: [self-hosted, loom-aca]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g @csa-loom/cli
      - name: Sign in
        run: |
          loom auth login --service-principal \\
            --api-url "\${{ secrets.LOOM_API_URL }}" \\
            --client-id "\${{ secrets.LOOM_CLIENT_ID }}" \\
            --client-secret "\${{ secrets.LOOM_CLIENT_SECRET }}" \\
            \${{ secrets.LOOM_TENANT_ID && format('--tenant-id "{0}"', secrets.LOOM_TENANT_ID) || '' }}
      - name: Build
        run: loom apps build ${itemId} --watch
      - name: Deploy
        run: loom apps deploy ${itemId}
      - name: Health gate
        run: loom apps logs ${itemId} --tail 50
`;
}
