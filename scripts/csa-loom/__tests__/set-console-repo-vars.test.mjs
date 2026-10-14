import test from 'node:test';
import assert from 'node:assert/strict';

import { run, namesFor, validate, EXIT_OK, EXIT_FAILED, EXIT_USAGE } from '../set-console-repo-vars.mjs';

const TOKEN = 'SENTINEL-TOKEN-do-not-leak-7f3a';
const URL = 'https://loom-console.example.azurecontainerapps.io';
const AUD = 'api://11111111-1111-4111-8111-111111111111';
const ARGS = ['--boundary', 'Commercial', '--url', URL, '--audience', AUD];

/** Fake gh with an in-memory variable store; `calls` records argv (must never hold the token). */
function fake({ store = {}, token = TOKEN, failSet = false, dropWrite = false, getErr = null } = {}) {
  const calls = [];
  const out = [];
  const io = {
    token,
    log: (l) => out.push(l),
    summary: (l) => out.push(l),
    gh(args, tok) {
      calls.push({ args, tok });
      const [, verb, name] = [args[0], args[1], args[2]];
      if (verb === 'get') {
        if (getErr) return { status: 1, stdout: '', stderr: getErr };
        return name in store ? { status: 0, stdout: `${store[name]}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      }
      if (failSet) return { status: 1, stdout: '', stderr: `denied for ${tok}` };
      if (!dropWrite) store[name] = args[4];
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  return { io, store, calls, out, writes: () => calls.filter((c) => c.args[1] === 'set') };
}

test('Commercial writes CSA_LOOM_CONSOLE_*; GCC-High writes CSA_LOOM_GCCH_CONSOLE_*', () => {
  // Breaks if: the boundary mapping swaps or collapses the two name sets.
  assert.deepEqual(namesFor('Commercial'), { url: 'CSA_LOOM_CONSOLE_URL', aud: 'CSA_LOOM_CONSOLE_AUDIENCE' });
  assert.deepEqual(namesFor('GCC-High'), { url: 'CSA_LOOM_GCCH_CONSOLE_URL', aud: 'CSA_LOOM_GCCH_CONSOLE_AUDIENCE' });
  // IL5 must NOT share the GCC-High pair (it would overwrite the GCC-High console values).
  assert.throws(() => namesFor('IL5'), /unknown boundary/);
  assert.throws(() => namesFor('GCC'), /unknown boundary/);
});

test('first run creates both; second run with identical values makes ZERO set calls', () => {
  // Breaks if: the script writes when the value is unchanged.
  const f = fake();
  assert.equal(run(ARGS, f.io), EXIT_OK);
  assert.deepEqual(f.store, { CSA_LOOM_CONSOLE_URL: URL, CSA_LOOM_CONSOLE_AUDIENCE: AUD });
  assert.equal(f.writes().length, 2);
  f.calls.length = 0;
  assert.equal(run(ARGS, f.io), EXIT_OK);
  assert.equal(f.writes().length, 0);
});

test('a changed value is updated; an unchanged sibling is not rewritten', () => {
  // Breaks if: update skips on name match alone, or rewrites everything.
  const f = fake({ store: { CSA_LOOM_CONSOLE_URL: 'https://old.example.com', CSA_LOOM_CONSOLE_AUDIENCE: AUD } });
  assert.equal(run(ARGS, f.io), EXIT_OK);
  assert.equal(f.store.CSA_LOOM_CONSOLE_URL, URL);
  assert.equal(f.writes().length, 1);
});

test('empty token: visible NOT SET skip naming LOOM_REPO_VARS_TOKEN, no gh call at all', () => {
  // Breaks if: an empty token proceeds silently or the output omits that nothing was set.
  const f = fake({ token: '' });
  assert.equal(run(ARGS, f.io), EXIT_OK);
  assert.equal(f.calls.length, 0);
  const text = f.out.join('\n');
  assert.match(text, /LOOM_REPO_VARS_TOKEN/);
  assert.match(text, /NOT set/i);
});

test('read-back that differs from what was written FAILS', () => {
  // Breaks if: success is taken from the set exit code instead of the get.
  const f = fake({ dropWrite: true });
  assert.equal(run(ARGS, f.io), EXIT_FAILED);
  assert.match(f.out.join('\n'), /read-back of CSA_LOOM_CONSOLE_URL FAILED/);
});

test('read-back that SUCCEEDS but returns a different value FAILS (get status 0, wrong content)', () => {
  // Breaks if: only the get exit status is checked and the value comparison is dropped.
  const f = fake({ store: { CSA_LOOM_CONSOLE_URL: 'https://old.example.com' }, dropWrite: true });
  assert.equal(run(ARGS, f.io), EXIT_FAILED);
  assert.match(f.out.join('\n'), /read-back of CSA_LOOM_CONSOLE_URL FAILED or differs/);
});

test('an unreadable variable (not a 404) fails rather than being treated as absent', () => {
  // Breaks if: any get error is read as "does not exist" and overwritten.
  const f = fake({ getErr: 'HTTP 403: forbidden' });
  assert.equal(run(ARGS, f.io), EXIT_FAILED);
  assert.equal(f.writes().length, 0);
});

test('the token never appears in argv or in any emitted line, even when gh echoes it', () => {
  // Breaks if: the token is put in argv, or gh stderr containing it is logged unscrubbed.
  const f = fake({ failSet: true });
  assert.equal(run(ARGS, f.io), EXIT_FAILED);
  for (const c of f.calls) assert.ok(!c.args.join(' ').includes(TOKEN), 'token in argv');
  assert.ok(!f.out.join('\n').includes(TOKEN), 'token in output');
  assert.ok(f.out.join('\n').includes('***'), 'scrub must have fired (gh stderr carried the sentinel)');
});

test('invalid values are rejected before any gh call', () => {
  // Breaks if: validation is skipped for any of these inputs.
  const bad = [
    ['--url', 'http://x.example.com'], ['--url', 'https://x.example.com/path'], ['--url', 'https://x.example.com/'],
    ['--url', 'https://x.example.com\nINJECT=1'], ['--url', 'https://x.example.com:8443'], ['--url', ''],
    ['--audience', 'api://not-a-guid'], ['--audience', `${AUD}\nX=1`], ['--audience', '11111111-1111-4111-8111-111111111111'],
  ];
  for (const [k, v] of bad) {
    const args = ['--boundary', 'Commercial', '--url', URL, '--audience', AUD];
    args[args.indexOf(k) + 1] = v;
    const f = fake();
    assert.equal(run(args, f.io), EXIT_USAGE, `${k}=${JSON.stringify(v)} must be rejected`);
    assert.equal(f.calls.length, 0);
  }
  assert.doesNotThrow(() => validate(URL, AUD));
});
