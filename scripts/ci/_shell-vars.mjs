/**
 * _shell-vars — "is this variable ever assigned?" analysis for the shell
 * scripts embedded in GitHub Actions `run:` blocks.
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT RE-ADD ONE (see _ratchet-count.mjs for why).
 *
 * WHY THIS EXISTS — the check actionlint cannot do
 * ------------------------------------------------
 * shellcheck's SC2154 ("var is referenced but not assigned") is the mechanical
 * form of the defect that killed full-app-deploy-commercial.yml on 2026-08-05:
 * `echo "admin_sub=$ADMIN_SUB" >> "$GITHUB_OUTPUT"` where ADMIN_SUB was never
 * assigned, under `set -uo pipefail`, which aborted the step and took every
 * image build and app roll with it (#3030).
 *
 * actionlint pipes `run:` blocks through shellcheck, so the obvious move is to
 * run actionlint. It does not work, for two independent reasons that both had
 * to be checked rather than assumed:
 *
 *   1. shellcheck EXEMPTS ALL-CAPS names from SC2154 by default, on the theory
 *      that they are environment variables. `ADMIN_SUB` is all-caps, so stock
 *      shellcheck is silent on it. (The optional check `check-unassigned-
 *      uppercase` removes that exemption.)
 *   2. actionlint then hard-codes its shellcheck invocation as
 *        --norc -f json -x --shell bash -e SC1091,SC2194,SC2050,SC2153,SC2154,SC2157,SC2043 -
 *      — it EXCLUDES SC2154 outright, and `--norc` means a repo `.shellcheckrc`
 *      cannot re-enable it. Both were verified against actionlint v1.7.12 /
 *      shellcheck v0.11.0 before this module was written.
 *
 * actionlint's exclusion is correct for actionlint: a `run:` script legitimately
 * reads variables defined in a workflow/job/step `env:` block, which shellcheck
 * cannot see, so un-excluded SC2154 would be a false-positive machine. The fix
 * is not to force the rule on — it is to do the same analysis with the missing
 * context supplied. That is what this module does: it resolves a name against
 * the three `env:` scopes, the names an earlier step in the same job wrote to
 * `$GITHUB_ENV`, and the runner/shell built-ins, before calling it unassigned.
 *
 * WHAT IS TREATED AS "DEFINED"
 *   - assigned anywhere in the same script (order-insensitive, as SC2154 is)
 *   - a key of the step's, the job's, or the workflow's `env:`
 *   - written to `$GITHUB_ENV` by any step of the same job
 *   - a documented GitHub Actions / runner variable, or a shell built-in
 *   - named in an inline `# unset-var-ok: NAME` pragma in the script
 *
 * WHAT IS NOT A VIOLATION — the safe-by-construction expansions. Under `set -u`
 * these do NOT abort, so flagging them would be noise:
 *   ${VAR:-d} ${VAR-d} ${VAR:=d} ${VAR=d} ${VAR:+a} ${VAR+a} ${VAR:?m} ${VAR?m}
 * `${VAR:?msg}` is an author deliberately failing closed; it is the fix, not
 * the defect.
 */

/** GitHub Actions + runner variables that always exist in a `run:` step. */
const GITHUB_PREFIXES = ['GITHUB_', 'RUNNER_', 'ACTIONS_', 'INPUT_'];
const GITHUB_VARS = new Set([
  'CI',
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HOSTNAME',
  'PWD',
  'OLDPWD',
  'TERM',
  'EDITOR',
  'PAGER',
  'SHLVL',
  'COLUMNS',
  'LINES',
  'DEBIAN_FRONTEND',
  'DOTNET_ROOT',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'ANDROID_HOME',
  'NVM_DIR',
  'AGENT_TOOLSDIRECTORY',
  'IMAGE_OS',
  'IMAGE_VERSION',
]);

/** Shell built-ins and specials — never "unassigned" in any meaningful sense. */
const SHELL_VARS = new Set([
  'IFS',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'LINENO',
  'FUNCNAME',
  'RANDOM',
  'SECONDS',
  'REPLY',
  'EUID',
  'UID',
  'PPID',
  'OPTIND',
  'OPTARG',
  'OPTERR',
  'PIPESTATUS',
  'BASHPID',
  'BASHOPTS',
  'SHELLOPTS',
  'EPOCHSECONDS',
  'EPOCHREALTIME',
  'HISTFILE',
  'MACHTYPE',
  'OSTYPE',
  'HOSTTYPE',
  'BASH',
  'BASH_VERSION',
  'BASH_SUBSHELL',
  'BASH_COMMAND',
  'BASH_SOURCE',
  'BASH_LINENO',
  'BASH_REMATCH',
  'BASH_ARGV',
  'BASH_ARGC',
  'BASH_ALIASES',
  'BASH_ENV',
  'GLOBIGNORE',
  'CDPATH',
  'MAIL',
  'MAILCHECK',
  'TIMEFORMAT',
  'TMOUT',
]);

const isAlwaysDefined = (name) =>
  GITHUB_VARS.has(name) ||
  SHELL_VARS.has(name) ||
  GITHUB_PREFIXES.some((p) => name.startsWith(p)) ||
  /^BASH_/.test(name);

/** Shells whose `run:` body is POSIX-ish and uses `$VAR` expansion. */
export function isPosixShell(shell) {
  if (!shell) return true; // GitHub's default on Linux/macOS runners is bash
  const head = String(shell).trim().split(/\s+/)[0].toLowerCase();
  return head === 'bash' || head === 'sh' || head === 'dash' || head === 'ksh' || head === 'zsh';
}

/**
 * Replace `${{ ... }}` GitHub expressions with an inert placeholder of the
 * same length, preserving newlines so reported line numbers stay true. These
 * are substituted by the Actions runner before the shell ever sees them, so
 * they are not shell variable references.
 */
export function maskGitHubExpressions(script) {
  return script.replace(/\$\{\{[\s\S]*?\}\}/g, (m) => m.replace(/[^\n]/g, 'x'));
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

/** Assignment forms. Each captures the assigned name in group 1. */
const ASSIGN_PATTERNS = [
  // NAME=, export NAME=, declare -x NAME=, local NAME=, readonly NAME=, NAME+=
  /(?:^|[\s;&|(){}])(?:(?:export|declare|local|typeset|readonly)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/g,
  // for NAME in …  /  for (( NAME=…
  /(?:^|[\s;&|(){}])for\s+\(?\(?\s*([A-Za-z_][A-Za-z0-9_]*)\b/g,
  // select NAME in …
  /(?:^|[\s;&|(){}])select\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
  // printf -v NAME
  /printf\s+(?:-\w+\s+)*-v\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  // mapfile/readarray [-opts] NAME
  /(?:mapfile|readarray)\s+(?:-\w+(?:\s+\S+)?\s+)*([A-Za-z_][A-Za-z0-9_]*)/g,
  // getopts "spec" NAME
  /getopts\s+\S+\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  // let NAME=…  /  (( NAME=… ))  /  (( NAME++ ))
  /(?:^|[\s;&|(){}])let\s+['"]?([A-Za-z_][A-Za-z0-9_]*)/g,
  /\(\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--|[-+*/%]?=)/g,
  // declare/local NAME (no `=`) still declares it
  /(?:^|[\s;&|(){}])(?:declare|local|typeset|readonly)\s+(?:-\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:$|[\s;&|)])/gm,
];

/** `read [-opts] NAME1 NAME2 …` — every trailing word is assigned. */
function readTargets(script, out) {
  const re = /(?:^|[\s;&|(){}])read\s+([^\n;&|<>]*)/g;
  let m;
  while ((m = re.exec(script)) !== null) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (/^-/.test(tok)) continue;
      // skip an option's argument (e.g. `-d ''`, `-t 5`, `-a arr` handled below)
      if (/^['"]/.test(tok)) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) out.add(tok);
    }
  }
}

/** Every name this script assigns, by any form we model. */
export function assignedNames(script) {
  const out = new Set();
  for (const re of ASSIGN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(script)) !== null) out.add(m[1]);
  }
  readTargets(script, out);
  return out;
}

/**
 * Names an `env:`-producing step writes to `$GITHUB_ENV`. Recognises the three
 * forms this repo actually uses:
 *   echo "NAME=…" >> "$GITHUB_ENV"
 *   cat <<EOF >> "$GITHUB_ENV" … EOF
 *   { echo "A=1"; echo "B=2"; } >> "$GITHUB_ENV"        <-- group redirect
 * The group form matters: gov-provision-dataplane-images.yml publishes NINE
 * variables that way, and a per-line scan reports every one of them as an
 * unassigned read in the steps that consume them.
 *
 * Over-collecting here is the safe direction: it can only suppress a finding,
 * never invent one.
 */
export function githubEnvWrites(script) {
  const out = new Set();
  const lines = script.split('\n');
  const collect = (text) => {
    for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) out.add(m[1]);
  };
  for (let i = 0; i < lines.length; i++) {
    if (!/GITHUB_ENV/.test(lines[i])) continue;

    // `} >> "$GITHUB_ENV"` / `) >> $GITHUB_ENV` — walk back to the opener and
    // take every assignment in the group.
    if (/^\s*[})]\s*(\|[^>]*)?>>/.test(lines[i])) {
      for (let j = i - 1; j >= 0 && i - j <= 60; j--) {
        const t = lines[j].trim();
        if (t === '{' || t === '(' || /(^|\s)[{(]$/.test(t)) break;
        collect(lines[j]);
      }
    }
    collect(lines[i]);

    const hd = lines[i].match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (!hd) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === hd[1]) break;
      const a = lines[j].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
      if (a) out.add(a[1]);
    }
  }
  return out;
}

/**
 * Does this script pull definitions in from a file it sources?
 * `set -a; . ./vals.env; set +a` is how gov-discover.yml hands variables from
 * one step to the next, and every name in that file is defined afterwards.
 */
export function sourcesAFile(script) {
  return /(?:^|[\s;&|(){}])(?:source|\.)\s+["']?[.$/\w][^\s;&|]*/m.test(script);
}

/**
 * Names written into an env-style FILE (as opposed to `$GITHUB_ENV`) by an
 * `echo "NAME=…"` / `printf 'NAME=…'` or a heredoc body. Used only for scripts
 * that source such a file — see `sourcesAFile`. Without this, gov-discover.yml
 * reports POSTGRES_HOST_SUFFIX as unassigned when the step above it writes that
 * exact name into `vals.env` and this step sources it.
 */
export function envFileWrites(script) {
  const out = new Set();
  for (const m of script.matchAll(/(?:echo|printf)\s+["']([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    out.add(m[1]);
  }
  for (const m of script.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/gm)) out.add(m[1]);
  return out;
}

/** `# unset-var-ok: NAME, NAME2` pragmas anywhere in the script. */
export function inlineAllowlist(script) {
  const out = new Set();
  for (const m of script.matchAll(/#\s*unset-var-ok:\s*([^\n]+)/g)) {
    for (const n of m[1].split(/[,\s]+/)) if (n) out.add(n.trim());
  }
  return out;
}

/**
 * Names the script expands with a default/alternate/error operator ANYWHERE —
 * `${X:-}`, `${X-}`, `${X:=}`, `${X:+}`, `${X:?}` and friends.
 *
 * Such a name is exempt from every other read of it in the same script. The
 * reason is the dominant correct idiom in this repo:
 *
 *     if [ -n "${ADLS_ACCOUNT:-}" ]; then
 *       echo "… '$ADLS_ACCOUNT' …"        # bare, but only reached when set
 *     fi
 *
 * The guarded expansion proves the author knows the name may be unset and has
 * handled it; the bare read inside the branch cannot be reached when it is not.
 * Flagging those would bury the real defect in noise — and the real defect is
 * unaffected, because a name that is simply forgotten (ADMIN_SUB) appears with
 * no default anywhere.
 */
export function defaultedNames(script) {
  const out = new Set();
  for (const m of script.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\s*:?[-=+?]/g)) out.add(m[1]);
  return out;
}

/**
 * Every variable REFERENCE in the script that would abort under `set -u` if the
 * name were unset. Walks the text with a quoting state machine so that
 * single-quoted strings, comments, and quoted heredocs — none of which expand
 * variables — do not produce phantom references.
 *
 * Returns `[{ name, line }]` (1-based line within the script).
 */
export function referencedNames(script) {
  const refs = [];
  const s = script;
  let line = 1;
  let i = 0;
  // Context stack. 'normal' is top level; 'cmdsub' is inside `$( … )` and
  // 'arith' inside `$(( … ))` — both restart quoting, so they must be PUSHED
  // on entry and POPPED on the closing paren. Forgetting the pop desyncs every
  // quote after the first command substitution, which is how `$GITHUB_OUTPUT`
  // inside `{ … } >> "$GITHUB_OUTPUT"` and a `$p` inside a single-quoted jq
  // program were both reported as unassigned reads.
  const stack = ['normal'];
  const top = () => stack[stack.length - 1];
  /** true when we are in an unquoted (word) context, not inside "…" or '…' */
  const inWord = () => top() === 'normal' || top() === 'cmdsub' || top() === 'arith';
  let pendingHeredocs = [];
  let heredoc = null; // { delim, expand, stripTabs }

  const readIdentAt = (pos) => {
    IDENT.lastIndex = pos;
    const m = IDENT.exec(s);
    return m ? m[0] : null;
  };

  while (i < s.length) {
    const c = s[i];

    if (c === '\n') {
      line++;
      i++;
      if (heredoc === null && pendingHeredocs.length) heredoc = pendingHeredocs.shift();
      if (heredoc) {
        // consume heredoc body until the delimiter line
        while (i < s.length) {
          let eol = s.indexOf('\n', i);
          if (eol === -1) eol = s.length;
          const raw = s.slice(i, eol);
          const probe = heredoc.stripTabs ? raw.replace(/^\t+/, '') : raw;
          if (probe.trim() === heredoc.delim) {
            i = eol;
            heredoc = pendingHeredocs.length ? pendingHeredocs.shift() : null;
            break;
          }
          if (heredoc.expand) {
            for (const m of raw.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
              // heredoc bodies are scanned coarsely; default-expansions inside
              // them are rare and being conservative here avoids false hits
              if (/\$\{[A-Za-z_][A-Za-z0-9_]*[:\-+?=]/.test(m[0])) continue;
              if (isAlwaysDefined(m[1])) continue;
              refs.push({ name: m[1], line });
            }
          }
          i = eol;
          if (i < s.length) {
            i++;
            line++;
          }
        }
      }
      continue;
    }

    if (top() === 'sq') {
      if (c === "'") stack.pop();
      i++;
      continue;
    }

    if (c === '\\' && top() !== 'sq') {
      if (s[i + 1] === '\n') line++;
      i += 2;
      continue;
    }

    if (inWord() && c === "'") {
      stack.push('sq');
      i++;
      continue;
    }
    if (top() !== 'sq' && c === '"') {
      if (top() === 'dq') stack.pop();
      else stack.push('dq');
      i++;
      continue;
    }
    if (inWord() && c === '#') {
      const prev = s[i - 1];
      if (i === 0 || /[\s;&|(]/.test(prev)) {
        const eol = s.indexOf('\n', i);
        i = eol === -1 ? s.length : eol;
        continue;
      }
    }
    // heredoc introducer
    if (inWord() && c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(s.slice(i));
      if (m) {
        pendingHeredocs.push({ delim: m[3], expand: m[2] === '', stripTabs: m[1] === '-' });
        i += m[0].length;
        continue;
      }
    }
    // close a command substitution / arithmetic expansion
    if (c === ')') {
      if (top() === 'arith' && s[i + 1] === ')') {
        stack.pop();
        i += 2;
        continue;
      }
      if (top() === 'cmdsub') {
        stack.pop();
        i++;
        continue;
      }
    }

    if (c !== '$') {
      i++;
      continue;
    }

    // ---- a `$` in an expanding context ------------------------------------
    const n1 = s[i + 1];
    if (n1 === '(') {
      if (s[i + 2] === '(') {
        stack.push('arith');
        i += 3;
      } else {
        stack.push('cmdsub'); // command substitution restarts quoting
        i += 2;
      }
      continue;
    }
    if (n1 === '{') {
      let p = i + 2;
      let indirect = false;
      if (s[p] === '#' || s[p] === '!') {
        indirect = true;
        p++;
      }
      const name = readIdentAt(p);
      if (!name) {
        i += 2;
        continue;
      }
      p += name.length;
      const rest = s[p];
      const rest2 = s[p + 1];
      // ${VAR:-d} ${VAR-d} ${VAR:=d} ${VAR=d} ${VAR:+a} ${VAR+a} ${VAR:?m} ${VAR?m}
      const safe =
        (rest === ':' && ['-', '=', '+', '?'].includes(rest2)) ||
        ['-', '=', '+', '?'].includes(rest);
      if (!safe && !isAlwaysDefined(name)) refs.push({ name, line });
      else if (safe && indirect && !isAlwaysDefined(name)) {
        // `${#VAR:-}` is not a thing; nothing to record
      }
      i = p;
      continue;
    }
    const name = readIdentAt(i + 1);
    if (name) {
      if (!isAlwaysDefined(name)) refs.push({ name, line });
      i += 1 + name.length;
      continue;
    }
    i++;
  }

  return refs;
}

/**
 * The guard's core question, answered for one `run:` script.
 *
 * @param {string} script      the dedented `run:` body
 * @param {Set<string>} envDefined  workflow+job+step `env:` keys and $GITHUB_ENV writes
 * @returns {{name:string,line:number}[]} unique violations, first line each
 */
export function unassignedReferences(script, envDefined) {
  const masked = maskGitHubExpressions(script);
  const assigned = assignedNames(masked);
  const allow = inlineAllowlist(masked);
  const defaulted = defaultedNames(masked);
  const seen = new Map();
  for (const { name, line } of referencedNames(masked)) {
    if (assigned.has(name) || envDefined.has(name) || allow.has(name) || defaulted.has(name)) {
      continue;
    }
    if (!seen.has(name)) seen.set(name, line);
  }
  return [...seen].map(([name, line]) => ({ name, line }));
}
