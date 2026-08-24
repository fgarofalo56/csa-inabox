#!/usr/bin/env node
/**
 * cmd-quote.mjs — pure string quoting for a Windows `cmd.exe` command line.
 *
 * Deliberately separate from measure.mjs and containing NO process execution.
 * Two reasons:
 *
 *  1. It is pure, so it is trivially testable without spawning anything — which
 *     matters because the batch-launch path shipped broken once precisely
 *     because every test spawned `node.exe` and never a `.cmd`.
 *
 *  2. CodeQL's IndirectCommandInjection query does not terminate (1 of 104
 *     queries, 600s budget) when this logic sits in the same module as the
 *     `spawnSync` sink and is exported — an exported parameter is an external
 *     taint source, and the combination explodes the search. Keeping the sink
 *     and the string-building in separate modules is also just better shape.
 *
 *     CORRECTION, measured 2026-08-24: separating the modules was NOT
 *     sufficient. `Analyze (javascript-typescript)` failed 3/3 on
 *     `fix/3971-measure-allowlist-bypass` with this split already in place —
 *     same query, same `Stage4::FwdFlowInThrough`, same 600s exit 33. The
 *     module split is still worth keeping for reason 1, but it did not fix
 *     termination and the paragraph above should not be read as saying it did.
 *     The construct that actually correlates is the map/join in `buildCmdLine`
 *     — see the note there.
 *
 *     Why this matters more than a red check: when `run-queries` exits 33 it
 *     discards ALL 104 results, and the action still uploads a 0-rules SARIF.
 *     GitHub does not retire alerts from an empty upload, so the JS/TS alert
 *     list FREEZES at the last real scan while continuing to read as current.
 *     The silent freeze is the harm, not the failing job.
 */

export class CmdQuoteError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CmdQuoteError';
    this.detail = detail;
  }
}

/**
 * Quote one argument for a `cmd.exe /c "<line>"` command line.
 *
 * Refuses `%`: cmd expands `%VAR%` even INSIDE double quotes and there is no
 * reliable command-line escape (`%%` only works in a batch file). Running a
 * command different from the one requested is the exact class of silent
 * wrongness this directory exists to prevent, so this fails closed.
 *
 * Refuses CR and LF for the identical reason, measured rather than assumed. A
 * newline TERMINATES the cmd.exe command line: everything after it -- including
 * every subsequent argument -- is silently dropped, and the process still exits
 * 0. Sending `["resources\n| where type =~ 'x'", "NEXT"]` had the child receive
 * exactly `["resources"]`. A multi-line KQL query passed to `az graph query -q`
 * would therefore run a SHORTER, DIFFERENT query and return a confident wrong
 * answer. (A bare CR is worse in a quieter way: `a\rb` arrives as `ab`.)
 *
 * To be precise about the risk: this is not command injection. The truncated
 * remainder is discarded, never executed -- `& echo INJECTED` and friends all
 * stay literal. It is a FIDELITY failure, which for a measurement harness is
 * the more dangerous of the two.
 */
export function quoteForCmd(arg) {
  const s = String(arg);
  if (s.includes('%')) {
    throw new CmdQuoteError(
      `argument contains '%', which cmd.exe would expand as a variable: ${s.slice(0, 60)}. ` +
      'Refusing rather than running a command different from the one requested.',
      { arg: s },
    );
  }
  if (/[\r\n]/.test(s)) {
    throw new CmdQuoteError(
      'argument contains a newline, which TERMINATES a cmd.exe command line: everything ' +
      `after it (including later arguments) is dropped and the call still exits 0: ${s.slice(0, 60)}. ` +
      'Refusing rather than running a truncated command and reporting its result.',
      { arg: s },
    );
  }
  if (s === '') return '""';
  // Inside double quotes everything is literal except % (refused above) and ",
  // which cmd takes as doubled. Outside quotes these metacharacters are live,
  // so their presence is what triggers quoting.
  if (!/[\s"^&|<>()]/.test(s)) return s;
  // Trailing backslashes must be DOUBLED before the closing quote. CommandLineToArgvW
  // reads `\"` as an escaped literal quote, so `C:\my dir\` would emit
  // `"C:\my dir\"` -- the closing quote is consumed, quoting never ends, and the
  // following arguments are spliced into this one. Measured: `["C:\my dir\",
  // "--query", "SECRET"]` arrived as the single token `C:\my dir" --query SECRET`.
  // Node's own windowsQuoteArg does this; the hand-rolled version did not.
  const escaped = s.replace(/"/g, '""').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Join a resolved binary and its arguments into one quoted cmd.exe line.
 *
 * Written as an explicit loop rather than `[file, ...args].map(quoteForCmd)
 * .join(' ')`. The two forms are semantically identical; the loop is here for
 * the analyser, not the runtime. Spreading argv into an array literal, mapping
 * it through a higher-order function and joining the result is the one
 * construct present on every branch where `js/indirect-command-line-injection`
 * stopped terminating inside its 600s per-query budget, and it is the construct
 * whose removal from `scripts/ci/estate-live-probe.mjs` turned that branch from
 * red to green in a one-file diff (4f1aacd6 -> 249f81ea).
 *
 * Do not "simplify" this back to a map/join.
 */
export function buildCmdLine(file, args) {
  let line = quoteForCmd(String(file).replace(/\//g, '\\'));
  for (let i = 0; i < args.length; i += 1) {
    line += ' ' + quoteForCmd(args[i]);
  }
  return line;
}

/**
 * Does this resolved file need the cmd.exe wrapper?
 *
 * Only a batch shim does. Node >= 20 refuses to spawn a .cmd directly
 * (EINVAL, CVE-2024-27980), while a real .exe must be spawned directly —
 * wrapping one in cmd.exe would re-introduce the very quoting risk the
 * wrapper exists to manage.
 */
export function needsCmdWrapper(file, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(String(file));
}
