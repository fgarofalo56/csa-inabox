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
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_BUILD_DATE_FILE, readImageBuildDate } from '../build-date';
import { ageInDays } from '../artifact';
import { loadExtractedSecurityGraph } from '../runtime';

const CONSOLE_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const DOCKERFILE = join(CONSOLE_ROOT, 'Dockerfile');

describe('readImageBuildDate — three states, because "cannot read" is not "not there"', () => {
  const made: string[] = [];
  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), 'loom-build-date-'));
    made.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('PRESENT: returns the trimmed file text (the Dockerfile writes a trailing newline)', () => {
    const d = scratch();
    writeFileSync(join(d, IMAGE_BUILD_DATE_FILE), '2026-09-01T00:00:00Z\n');
    // Breaks if the value is not trimmed ('...Z\n') or the wrong file is read (absent).
    expect(readImageBuildDate(d)).toEqual({ state: 'present', value: '2026-09-01T00:00:00Z' });
  });

  it('ABSENT: a directory with no such file is absent, not unreadable', () => {
    // Breaks if ENOENT is folded into `unreadable` — every local build would
    // then be REFUSED, and the refusal would be learned as noise.
    expect(readImageBuildDate(scratch())).toEqual({ state: 'absent' });
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
});

describe('the runtime joins them: a checkout has no image date, and says so', () => {
  it('loadExtractedSecurityGraph() under vitest is available with an age-NOT-checked note', () => {
    // Fixture control: the test process's cwd really has no image date file.
    expect(existsSync(join(process.cwd(), IMAGE_BUILD_DATE_FILE))).toBe(false);
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);
    // Breaks if the runtime stops passing the read result (e.g. hard-codes a
    // fresh date), or drops the note on the way out.
    expect(source.ageNote).toContain("the graph's age was NOT checked");
  });
});
