#!/usr/bin/env node
/**
 * loom — CSA Loom command-line interface.
 *
 * Wraps the Loom REST API (the BFF routes the Console UI uses) for one-command
 * workspace + item management. Authenticates with the same encrypted
 * loom_session cookie via `loom auth login` (device-code or service principal).
 *
 * Azure-native by default — no Microsoft Fabric tenant required. Fabric is
 * opt-in server-side only (.claude/rules/no-fabric-dependency.md).
 */
import { parseArgs, flagStr, flagBool } from './args.js';
import type { GlobalOptions, OutputFormat } from './config.js';
import { CliError, LoomApiErrorGuard } from './errors.js';
import { runAuth } from './commands/auth.js';
import { runWorkspace } from './commands/workspace.js';
import { runItem } from './commands/item.js';
import { runFind } from './commands/find.js';
import { runApps } from './commands/apps.js';
import { runPolicy } from './commands/policy.js';
import { runReport } from './commands/report.js';
import { CLI_NAME, CLI_VERSION } from './constants.js';

const HELP = `${CLI_NAME} v${CLI_VERSION} — CSA Loom CLI (wraps the Loom REST API)

USAGE
  loom <group> <command> [args] [flags]

GLOBAL FLAGS
  --api-url <url>     Loom API base URL (or env LOOM_API_URL).
  --output <fmt>      Output format: table | json | yaml (or env LOOM_OUTPUT). Default: table.
  --tenant <id>       Entra tenant override for sign-in (or env LOOM_TENANT).
  --help, -h          Show help.
  --version, -v       Show version.

AUTH
  loom auth login [--service-principal] [--client-id --client-secret --tenant-id]
                                      Sign in (device-code default) and store the session.
  loom auth logout                    Clear the stored session for the API URL.
  loom auth status                    Show + verify the current session.

WORKSPACE
  loom workspace list [--count]                       List workspaces.
  loom workspace show <id>                            Show one workspace.
  loom workspace create <name> [--description --capacity --domain]
  loom workspace update <id> [--name --description --capacity --domain]
  loom workspace delete <id>
  loom workspace bulk-delete <id> [<id> ...]          (tenant-admin only)

ITEM
  loom item list <workspaceId>                        List items in a workspace.
  loom item create <workspaceId> --type <t> --name <n> [--description]
  loom item show <type> <id>
  loom item update <type> <id> [--name --description]
  loom item delete <type> <id>
  loom item types                                     List valid item types.

APPS (Loom App Runtime dev loop)
  loom apps build <itemId> [--template t | --git url] [--port N] [--watch]
  loom apps status <itemId> --run <runId>
  loom apps deploy <itemId> [--image ref] [--min N --max N]
  loom apps logs <itemId> [--tail N]
  loom apps reconcile <itemId> [--build]               Redeploy-on-push: check
                                                       git for a new commit.
  loom apps start|stop <itemId>
  loom apps run-local <itemId> [--dir path] [--run]    Fetch the real build
                                                       context; docker run it.
  loom apps export <itemId> [--out app.loomapp]        Portable app bundle.
  loom apps import <bundle.loomapp> --workspace <wsId> [--name n]  Install an app.
  loom apps ci-template <itemId> [--out file.yml]      GitHub Actions workflow.

FIND
  loom find <query> [--type <itemType>] [--limit N]   Estate-wide catalog search
                                                      (every accessible workspace,
                                                       matched by name/type/desc/tags).
  loom find --all [--limit N]                         Browse most-recent items.

POLICY (Governance-as-Code — WS-10.2)
  loom policy show                                    The authored policy set +
                                                      which backends it compiles to.
  loom policy compile [--backend b]                   One-pass compiled artifacts
                                                      (real SQL/KQL/REST/scope) per
                                                      backend.
  loom policy diff                                    Dry-run reconcile — per-backend
                                                      drift, no mutation.
  loom policy apply [--yes]                           Reconcile: converge every
                                                      configured backend + self-heal
                                                      drift (--yes applies; else dry-run).

REPORT (Code report — BI-as-code CI hook, N16)
  loom report validate <file> [--engine synapse|lakehouse|adx]
                                      Parse + dry-compile a code report; exits
                                      NON-ZERO on any error (CI gate). Metric
                                      blocks are compiled against your governed spec.

EXAMPLES
  loom auth login --api-url https://loom.example.azurefd.net
  loom workspace create "Analytics" --description "Team WS" --output json
  loom item create <wsId> --type lakehouse --name "Bronze"
  loom find "bronze" --type lakehouse
  loom report validate reports/revenue.md
`;

function pickGlobals(flags: Record<string, string | boolean>): GlobalOptions {
  const output = flagStr(flags, 'output') as OutputFormat | undefined;
  return {
    apiUrl: flagStr(flags, 'api-url'),
    output,
    tenant: flagStr(flags, 'tenant'),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const { positionals, flags } = parsed;

  if (flagBool(flags, 'version', 'v') && positionals.length === 0) {
    process.stdout.write(`${CLI_NAME} ${CLI_VERSION}\n`);
    return 0;
  }
  if (positionals.length === 0 || flagBool(flags, 'help', 'h')) {
    process.stdout.write(HELP + '\n');
    return positionals.length === 0 ? 0 : 0;
  }

  const group = positionals[0];
  const sub = positionals[1] || '';
  // Remaining positionals (after group + sub) become the command's positionals.
  const rest = { positionals: positionals.slice(2), flags };
  const opts = pickGlobals(flags);

  try {
    switch (group) {
      case 'auth':
        await runAuth(sub, rest, opts);
        return 0;
      case 'workspace':
      case 'ws':
        await runWorkspace(sub, rest, opts);
        return 0;
      case 'item':
        await runItem(sub, rest, opts);
        return 0;
      case 'apps':
        await runApps(sub, rest, opts);
        return 0;
      case 'policy':
        await runPolicy(sub, rest, opts);
        return 0;
      case 'report':
        await runReport(sub, rest, opts);
        return 0;
      case 'find':
        // `find` is a flat command — the whole query follows the verb (no
        // sub-command), so pass every positional after `find` through.
        await runFind({ positionals: positionals.slice(1), flags }, opts);
        return 0;
      case 'help':
        process.stdout.write(HELP + '\n');
        return 0;
      default:
        process.stderr.write(`Unknown command group "${group}". Run \`loom --help\`.\n`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    if (LoomApiErrorGuard(e)) {
      process.stderr.write(`API error (${e.status}${e.code ? ` ${e.code}` : ''}): ${e.message}\n`);
      if (e.hint) process.stderr.write(`Hint: ${e.hint}\n`);
      return 1;
    }
    process.stderr.write(`Unexpected error: ${(e as Error)?.message || String(e)}\n`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`Fatal: ${(e as Error)?.message || String(e)}\n`);
    process.exit(1);
  },
);
