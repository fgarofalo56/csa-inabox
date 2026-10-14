#!/usr/bin/env node
/**
 * set-console-repo-vars.mjs -- persist the console URL + audience as repo variables
 * (PRP-02 step 3, #4876) so estate-power.yml / estate-idle-autopause.yml can read
 * them. Names (verified against those workflows on feat/4876-step3-actions):
 *   Commercial: CSA_LOOM_CONSOLE_URL, CSA_LOOM_CONSOLE_AUDIENCE
 *   GCC-High/IL5: CSA_LOOM_GCCH_CONSOLE_URL, CSA_LOOM_GCCH_CONSOLE_AUDIENCE
 *
 * The token (secret LOOM_REPO_VARS_TOKEN) arrives ONLY as env GH_TOKEN; it is never
 * put in argv and every line this script emits is scrubbed of it. An empty token is
 * a VISIBLE skip that says the variables were NOT set -- never a quiet green.
 * Writes only when the value changed; every write is read back and must match.
 *
 * Usage: node set-console-repo-vars.mjs --boundary <Commercial|GCC-High|IL5> --url <https://host> --audience <api://guid>
 * Exit: 0 set/unchanged/skipped-visibly, 1 failed, 2 usage or invalid value.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const URL_RE = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const AUD_RE = /^api:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function namesFor(boundary) {
  if (boundary === 'GCC-High') {
    return { url: 'CSA_LOOM_GCCH_CONSOLE_URL', aud: 'CSA_LOOM_GCCH_CONSOLE_AUDIENCE' };
  }
  if (boundary === 'Commercial') return { url: 'CSA_LOOM_CONSOLE_URL', aud: 'CSA_LOOM_CONSOLE_AUDIENCE' };
  throw new Error(`unknown boundary '${boundary}' (expected Commercial or GCC-High)`);
}

export function validate(url, audience) {
  if (typeof url !== 'string' || !URL_RE.test(url)) {
    throw new Error('console URL must be https://<plain host> with no path, port, query, slash or whitespace');
  }
  if (typeof audience !== 'string' || !AUD_RE.test(audience)) {
    throw new Error('console audience must match api://<guid> on a single line');
  }
}

function ghRun(args, token) {
  const r = spawnSync('gh', args, { encoding: 'utf8', shell: false, env: { ...process.env, GH_TOKEN: token } });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function realIo() {
  return {
    token: process.env.GH_TOKEN ?? '',
    gh: ghRun,
    log: (line) => process.stdout.write(`${line}\n`),
    summary: (text) => {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    },
  };
}

export function run(argv, io = realIo()) {
  const token = io.token;
  const scrub = (s) => (token ? String(s).split(token).join('***') : String(s));
  const log = (s) => io.log(scrub(s));
  const summary = (s) => io.summary(scrub(s));

  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i]] = argv[i + 1];
  let names;
  try {
    names = namesFor(o['--boundary']);
    validate(o['--url'], o['--audience']);
  } catch (e) {
    log(`set-console-repo-vars: ${e.message}`);
    return EXIT_USAGE;
  }

  if (!token) {
    const msg = 'Repo variables NOT set: secret LOOM_REPO_VARS_TOKEN is empty or missing (fine-grained PAT, Variables read/write on this repo). ' +
      `${names.url} and ${names.aud} were not written; estate-power workflows will keep failing closed until they are set.`;
    log(`::notice title=Repo variables NOT set::${msg}`);
    summary(`### Console repo variables\n**SKIPPED - NOT SET.** ${msg}`);
    return EXIT_OK;
  }

  const lines = [];
  for (const [name, value] of [[names.url, o['--url']], [names.aud, o['--audience']]]) {
    const cur = io.gh(['variable', 'get', name], token);
    let existing = null;
    if (cur.status === 0) existing = cur.stdout.replace(/\r?\n$/, '');
    else if (!/404|not found/i.test(`${cur.stderr}${cur.stdout}`)) {
      log(`set-console-repo-vars: could not read ${name} (not established whether it exists): ${cur.stderr.trim()}`);
      return EXIT_FAILED;
    }
    if (existing === value) {
      lines.push(`- ${name}: unchanged`);
      continue;
    }
    const set = io.gh(['variable', 'set', name, '--body', value], token);
    if (set.status !== 0) {
      log(`set-console-repo-vars: gh variable set ${name} FAILED: ${set.stderr.trim()}. The token needs Variables read/write on this repository.`);
      return EXIT_FAILED;
    }
    const back = io.gh(['variable', 'get', name], token);
    if (back.status !== 0 || back.stdout.replace(/\r?\n$/, '') !== value) {
      log(`set-console-repo-vars: read-back of ${name} FAILED or differs from what was written.`);
      return EXIT_FAILED;
    }
    lines.push(`- ${name}: ${existing === null ? 'created' : 'updated'}`);
  }
  log(`set-console-repo-vars: OK\n${lines.join('\n')}`);
  summary(`### Console repo variables\n${lines.join('\n')}`);
  return EXIT_OK;
}

if (process.argv[1]?.endsWith('set-console-repo-vars.mjs')) process.exit(run(process.argv.slice(2)));
