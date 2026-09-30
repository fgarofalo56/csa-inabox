/**
 * #4798 — the image build date: the reader, the Dockerfile that writes it, and
 * the runtime that joins them.
 *
 * `artifact.test.ts` covers what `resolveSecurityGraph` DOES with a date. This
 * file covers whether a real deployed image HAS one: the Dockerfile must write
 * the exact file the reader opens, in the directory the server runs from, as a
 * user that can do it. Each of those is a place the refusal could silently stop
 * applying in every cloud at once while every unit test stayed green.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_BUILD_DATE_FILE, IMAGE_CONTEXT_MARKERS, readImageBuildDate } from '../build-date';
import { ageInDays } from '../artifact';
import { loadExtractedSecurityGraph } from '../runtime';

const CONSOLE_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const DOCKERFILE = join(CONSOLE_ROOT, 'Dockerfile');
const DAY_MS = 86_400_000;

/** A timestamp `days` ago, in the Dockerfile's exact shape (no milliseconds). */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const made: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-build-date-'));
  made.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readImageBuildDate — four states, because "no file" means two things', () => {
  it('PRESENT: returns the trimmed file text (the Dockerfile writes a trailing newline)', () => {
    const d = scratch();
    writeFileSync(join(d, IMAGE_BUILD_DATE_FILE), '2026-09-01T00:00:00Z\n');
    // Breaks if the value is not trimmed ('...Z\n') or the wrong file is read (absent).
    expect(readImageBuildDate(d)).toEqual({ state: 'present', value: '2026-09-01T00:00:00Z' });
  });

  it('ABSENT: a directory with no date and no image marker is absent, not unreadable', () => {
    // Breaks if ENOENT is folded into `unreadable` — every local build would
    // then be REFUSED, and the refusal would be learned as noise.
    expect(readImageBuildDate(scratch())).toEqual({ state: 'absent' });
  });

  it('MISSING: no date beside EITHER image marker is missing, naming the marker found', () => {
    // Breaks if a marker is dropped from IMAGE_CONTEXT_MARKERS, or the marker
    // check is removed (both would read a built image as a dev run).
    for (const marker of IMAGE_CONTEXT_MARKERS) {
      const d = scratch();
      mkdirSync(join(d, marker, '..'), { recursive: true });
      writeFileSync(join(d, marker), 'x');
      expect(readImageBuildDate(d), marker).toEqual({ state: 'missing', markers: [marker] });
    }
  });

  it('UNREADABLE: a path that exists and cannot be read as a file is unreadable, with its code', () => {
    const d = scratch();
    mkdirSync(join(d, IMAGE_BUILD_DATE_FILE)); // a directory: reading it fails with EISDIR
    const got = readImageBuildDate(d);
    // Breaks if every error is reported as absent — which would turn an image
    // whose date cannot be read into a quietly unchecked one.
    expect(got.state).toBe('unreadable');
    if (got.state === 'unreadable') expect(got.detail).toMatch(/^E[A-Z]+$/);
  });
});

describe('the console Dockerfile writes the date the runtime reads', () => {
  const lines = readFileSync(DOCKERFILE, 'utf8').split(/\r?\n/);
  const lastFrom = lines.map((l, i) => (/^FROM\s/.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const runner = lines.slice(lastFrom);
  const code = runner.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  // The file name is LIFTED from build-date.ts, never transcribed.
  const writeCmd = `date -u +%Y-%m-%dT%H:%M:%SZ > /app/${IMAGE_BUILD_DATE_FILE}`;

  it('the runner stage writes the lifted file name, in code rather than a comment', () => {
    // Fixture control: the runner stage was found at all.
    expect(runner[0]).toMatch(/^FROM node:\S+ AS runner$/);
    // Breaks if the Dockerfile line is deleted, commented out, or writes a
    // different name than `IMAGE_BUILD_DATE_FILE` (the refusal would then be
    // silently "absent" in every deployed image, in every cloud).
    expect(code.some((l) => l.includes(writeCmd))).toBe(true);
  });

  it('into /app, which is the directory the server runs from', () => {
    // `readImageBuildDate()` defaults to process.cwd(). Breaks if the runner's
    // WORKDIR or CMD moves the server out of /app.
    expect(code).toContain('WORKDIR /app');
    expect(code).toContain('CMD ["node", "server.js"]');
  });

  it('before USER drops root, so the write can succeed at all', () => {
    // /app is root-owned; after `USER nextjs` the redirect fails and the build
    // breaks — or, with `|| true` added to "fix" it, silently writes nothing.
    const write = code.findIndex((l) => l.includes(writeCmd));
    const user = code.findIndex((l) => /^USER\s/.test(l));
    expect(write).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(write);
  });

  it('the format it writes is one ageInDays parses', () => {
    // `date -u +%Y-%m-%dT%H:%M:%SZ` on 2026-09-29 12:00 UTC prints this.
    // Breaks if ageInDays stops accepting the Dockerfile's format.
    expect(ageInDays('2026-09-29T12:00:00Z', new Date('2026-09-30T12:00:00Z'))).toBe(1);
  });

  it('every image marker is produced by the image, and one by the SAME RUN as the date', () => {
    // A marker the image does not produce would make every deployed image read
    // as a dev run (absent → available). Breaks if the build-marker write moves
    // out of the date's RUN instruction, or a marker is added that the image
    // never creates. Markers are LIFTED from build-date.ts.
    const cmd = code.find((l) => /^CMD\s/.test(l)) ?? '';
    const write = code.findIndex((l) => l.includes(writeCmd));
    let start = write;
    while (start > 0 && code[start - 1].endsWith('\\')) start--;
    const runInstruction = code.slice(start, write + 1).join(' ');
    expect(write).toBeGreaterThan(-1);
    for (const m of IMAGE_CONTEXT_MARKERS) {
      expect(cmd.includes(`"${m}"`) || runInstruction.includes(`> /app/${m}`), m).toBe(true);
    }
    expect(IMAGE_CONTEXT_MARKERS.some((m) => runInstruction.includes(`> /app/${m}`))).toBe(true);
  });
});

describe('the runtime joins them: a checkout has no image date, and says so', () => {
  it('loadExtractedSecurityGraph() under vitest is available with an age-NOT-checked note', () => {
    // Fixture controls: the test process's cwd really has no date file and no
    // image marker, so this is the absent path.
    expect(existsSync(join(process.cwd(), IMAGE_BUILD_DATE_FILE))).toBe(false);
    for (const m of IMAGE_CONTEXT_MARKERS) expect(existsSync(join(process.cwd(), m)), m).toBe(false);
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);
    // Pins the absent path end to end. Breaks if the runtime hard-codes a fresh
    // date or drops the note. It does NOT catch a runtime that reads the WRONG
    // directory, because that also finds nothing here; the seam tests below do.
    expect(source.ageNote).toContain("the graph's age was NOT checked");
    expect(source.ageChecked).toBe(false);
  });
});

describe('the runtime reads the date from the directory the server runs in (seam)', () => {
  // `loadExtractedSecurityGraph` caches the date at module scope, so each test
  // loads a FRESH module with `process.cwd()` pointed at a scratch directory.
  // Every case below is RED against a runtime that reads any other directory
  // (the round-3 review's M1), because that runtime finds nothing and serves the
  // graph as an unchecked dev run.
  async function runtimeIn(dir: string) {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.resetModules();
    return import('../runtime');
  }

  it('a STALE date in the server directory is REFUSED', async () => {
    const d = scratch();
    writeFileSync(join(d, IMAGE_BUILD_DATE_FILE), `${isoDaysAgo(200)}\n`);
    const r = (await runtimeIn(d)).loadExtractedSecurityGraph();
    if (r.available) throw new Error(`expected a refusal, got available (${r.ageNote ?? 'no note'})`);
    expect(r.reason).toContain('built 200 days ago');
    expect(r.reason).toContain('STALE');
  });

  it('a FRESH date in the server directory is AVAILABLE and checked', async () => {
    const d = scratch();
    const built = isoDaysAgo(2);
    writeFileSync(join(d, IMAGE_BUILD_DATE_FILE), `${built}\n`);
    const r = (await runtimeIn(d)).loadExtractedSecurityGraph();
    if (!r.available) throw new Error(`expected available, got refusal: ${r.reason}`);
    expect(r.ageNote).toContain(`Image built ${built}`);
    expect(r.ageChecked).toBe(true);
  });

  it('a built image with NO date in the server directory is REFUSED, not served unchecked', async () => {
    const d = scratch();
    writeFileSync(join(d, 'server.js'), '// standalone entry\n');
    const r = (await runtimeIn(d)).loadExtractedSecurityGraph();
    if (r.available) throw new Error(`expected a refusal, got available (${r.ageNote ?? 'no note'})`);
    expect(r.reason).toContain('found server.js');
  });

  it('an UNREADABLE date is not cached: the next load re-reads it', async () => {
    // Round-3 review A-8. A transient read error must not refuse the graph for
    // the life of the process. Breaks if the runtime caches `unreadable`.
    const d = scratch();
    mkdirSync(join(d, IMAGE_BUILD_DATE_FILE)); // EISDIR on read
    const runtime = await runtimeIn(d);
    const first = runtime.loadExtractedSecurityGraph();
    if (first.available) throw new Error('expected the unreadable date to refuse');
    expect(first.reason).toContain('could not be read');
    rmSync(join(d, IMAGE_BUILD_DATE_FILE), { recursive: true });
    writeFileSync(join(d, IMAGE_BUILD_DATE_FILE), `${isoDaysAgo(1)}\n`);
    const second = runtime.loadExtractedSecurityGraph();
    if (!second.available) throw new Error(`expected a re-read to succeed, got: ${second.reason}`);
    expect(second.ageChecked).toBe(true);
  });

  it('a SETTLED date is cached: the file is read once per process (control)', async () => {
    // The other half of the cache rule: a present date cannot change under a
    // running server, so deleting it after the first load changes nothing.
    // Breaks if caching is removed altogether.
    const d = scratch();
    writeFileSync(join(d, IMAGE_BUILD_DATE_FILE), `${isoDaysAgo(1)}\n`);
    const runtime = await runtimeIn(d);
    expect(runtime.loadExtractedSecurityGraph().available).toBe(true);
    rmSync(join(d, IMAGE_BUILD_DATE_FILE));
    writeFileSync(join(d, 'server.js'), '// would now read as missing\n');
    expect(runtime.loadExtractedSecurityGraph().available).toBe(true);
  });
});
