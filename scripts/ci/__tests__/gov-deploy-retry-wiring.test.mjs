/**
 * #3017 — every boundary's deploy workflow must run its provisioning mutation
 * through scripts/ci/deploy-retry.mjs (classification, bounded retry,
 * fail-closed, the classified deploy-failure.json artifact).
 *
 * WHY THIS TEST EXISTS. The eight-class taxonomy and bounded retry existed on
 * Commercial only; measured on 2026-08-05, `grep -c deploy-retry
 * deploy-fiab-gcch.yml` was 0 while that workflow's OWN failure notifier read
 * deploy-failure.json — an artifact nothing on the workflow produced. A
 * GCC-High throttle or replication lag failed the whole deploy outright with
 * no classification. And check-deploy-failure-handling.mjs only flags
 * HAND-ROLLED retry loops — a provisioning step with NO retry at all is
 * invisible to it, so removing this wiring would go green everywhere else.
 *
 * The check is LINE-anchored, not block-anchored, on purpose: the gcch/gcc/il5
 * provision steps put their dlz-attach and tenant branches in ONE run block, so
 * "the block mentions deploy-retry.mjs somewhere" would stay green while one
 * branch runs bare — measured against exactly that mutant while writing this.
 * A provisioning command is wrapped iff it sits behind deploy-retry's `-- `
 * handoff on its own line.
 *
 * Runs under `node --test scripts/ci/__tests__/*.test.mjs` (loom-guardrails).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runBlocks } from '../check-deploy-failure-handling.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF_DIR = path.resolve(__dirname, '..', '..', '..', '.github', 'workflows');

/**
 * Per workflow: the provisioning mutations that must be wrapped. Each regex
 * matches the START of the invocation (so the `-- ` prefix test is meaningful).
 * `az deployment sub create` deliberately does NOT match `what-if`/`validate`
 * (reads on the deploy path — classified elsewhere).
 */
const EXPECTATIONS = [
  { file: 'deploy-fiab-commercial.yml', mutations: [/\baz\s+deployment\s+sub\s+create\b/] },
  { file: 'deploy-fiab-gcc.yml', mutations: [/\baz\s+deployment\s+sub\s+create\b/, /\bazd\s+provision\b/] },
  { file: 'deploy-fiab-gcch.yml', mutations: [/\baz\s+deployment\s+sub\s+create\b/, /\bazd\s+provision\b/] },
  {
    file: 'deploy-fiab-il5.yml',
    mutations: [/\baz\s+deployment\s+sub\s+create\b/, /\bbash\s+scripts\/csa-loom\/redeploy-gov\.sh\b/],
  },
  { file: 'deploy-gov.yml', mutations: [/\baz\s+deployment\s+sub\s+create\b/] },
];

/**
 * Every non-comment line in a run block that invokes `re`, split into wrapped
 * (behind deploy-retry's `-- ` handoff) and bare.
 */
export function classifyInvocations(source, re) {
  const wrapped = [];
  const bare = [];
  for (const b of runBlocks(source)) {
    for (const l of b.body) {
      if (/^\s*#/.test(l.text)) continue;
      const m = re.exec(l.text);
      if (!m) continue;
      const prefix = l.text.slice(0, m.index);
      // Inside a quoted string it is a LABEL, not an invocation — e.g.
      // `--step "az deployment sub create (gcch)"`. An odd number of `"` in
      // the prefix means the match sits inside one.
      if (((prefix.match(/"/g) || []).length) % 2 === 1) continue;
      // `-- az deployment sub create …` is deploy-retry's command handoff;
      // anything else at that position is a bare invocation.
      (/(^|\s)--\s*$/.test(prefix) ? wrapped : bare).push({ line: l.line, text: l.text.trim() });
    }
  }
  return { wrapped, bare };
}

for (const { file, mutations } of EXPECTATIONS) {
  test(`${file}: every provisioning mutation runs through deploy-retry.mjs`, () => {
    const p = path.join(WF_DIR, file);
    assert.ok(fs.existsSync(p), `${file} is missing — the boundary map in deploy-workflows.ts names it`);
    const source = fs.readFileSync(p, 'utf8');
    for (const re of mutations) {
      const { wrapped, bare } = classifyInvocations(source, re);
      assert.ok(
        wrapped.length + bare.length > 0,
        `${file}: expected an invocation matching ${re} — the provisioning step moved; update this expectation rather than deleting it`,
      );
      assert.deepEqual(
        bare,
        [],
        `${file}: ${bare.length} BARE invocation(s) of ${re} — not behind deploy-retry.mjs's \`-- \` handoff. ` +
          `An unclassified Gov deploy failure is the exact #3017 defect; wrap each one: ` +
          `node scripts/ci/deploy-retry.mjs --class-allow transient,eventual-consistency … -- <cmd>`,
      );
      // Belt: the same block set must actually name the harness.
      assert.ok(
        source.includes('deploy-retry.mjs'),
        `${file}: no deploy-retry.mjs reference at all — the \`-- \` prefixes above are not the harness handoff`,
      );
    }
  });
}

test('the deploy-retry harness the workflows call actually exists', () => {
  const p = path.resolve(__dirname, '..', 'deploy-retry.mjs');
  assert.ok(fs.existsSync(p), 'scripts/ci/deploy-retry.mjs is missing');
});

test('self-check: a bare invocation IS detected even when its block mentions deploy-retry elsewhere', () => {
  // This is the mutant that defeated the block-level draft of this guard:
  // one branch wrapped, the sibling branch bare, one shared run block.
  const mutant = [
    '      - name: Provision',
    '        run: |',
    '          if [ "$T" = "dlz-attach" ]; then',
    '            node scripts/ci/deploy-retry.mjs --class-allow transient \\',
    '              -- az deployment sub create --name x --location y',
    '          else',
    '            azd provision --no-prompt',
    '          fi',
  ].join('\n');
  const create = classifyInvocations(mutant, /\baz\s+deployment\s+sub\s+create\b/);
  assert.equal(create.bare.length, 0);
  assert.equal(create.wrapped.length, 1);
  const azd = classifyInvocations(mutant, /\bazd\s+provision\b/);
  assert.equal(azd.bare.length, 1, 'the bare sibling branch must be visible');
});
