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

EXAMPLES
  loom auth login --api-url https://loom.example.azurefd.net
  loom workspace create "Analytics" --description "Team WS" --output json
  loom item create <wsId> --type lakehouse --name "Bronze"
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
