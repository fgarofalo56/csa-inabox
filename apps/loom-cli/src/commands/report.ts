/**
 * `loom report` — the CI hook for the N16 `code-report` item type.
 *
 *   report validate <file> [--engine synapse|lakehouse|adx] [--output json]
 *       Parse + DRY-COMPILE a code report and exit NON-ZERO on any error, so a
 *       broken dashboard never merges. Reads the file locally, then POSTs it to
 *       POST /api/items/code-report/validate, which runs the REAL parser AND
 *       dry-compiles every governed-metric block through the N15 metrics layer
 *       against the signed-in caller's spec (no execution). A fake pass is
 *       impossible — an unknown metric / undeclared dimension / malformed block
 *       / non-read-only raw query all become validation errors.
 *
 * Wraps the Loom REST API like every other CLI group (client.ts). Azure-native;
 * no Fabric tenant required.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { requireAuth, CliError } from './context.js';
import type { GlobalOptions } from '../config.js';
import { flagStr, type ParsedArgs } from '../args.js';
import { printResult } from '../output.js';

interface ValidateIssue {
  message: string;
  line?: number;
  query?: string;
}
interface ValidateResp {
  ok: boolean;
  valid: boolean;
  errors: ValidateIssue[];
  warnings: ValidateIssue[];
  queries: Array<{ name: string; kind: string; metric?: string }>;
  visualCount?: number;
}

export async function runReport(sub: string, args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  switch (sub) {
    case 'validate': {
      const file = args.positionals[0] || flagStr(args.flags, 'file');
      if (!file) {
        throw new CliError('Usage: loom report validate <file> [--engine synapse|lakehouse|adx]');
      }
      let source: string;
      try {
        source = await fs.readFile(path.resolve(file), 'utf8');
      } catch (e) {
        throw new CliError(`Cannot read "${file}": ${(e as Error).message}`);
      }

      const engine = flagStr(args.flags, 'engine');
      const { client, output } = await requireAuth(opts);
      const data = await client.request<ValidateResp>('POST', '/api/items/code-report/validate', {
        source,
        ...(engine ? { engine } : {}),
      });

      // Warnings never fail the build; surface them on stderr.
      for (const w of data.warnings || []) process.stderr.write(`warning: ${w.message}\n`);

      if (output === 'json' || output === 'yaml') {
        printResult(data as unknown as object, output);
      }

      if (data.ok) {
        if (output !== 'json' && output !== 'yaml') {
          const q = data.queries.length;
          process.stdout.write(
            `✓ ${path.basename(file)} is valid — ${q} quer${q === 1 ? 'y' : 'ies'}, ${data.visualCount ?? 0} visual(s).\n`,
          );
        }
        return;
      }

      // Failure: print each error, then throw so `loom` exits non-zero (CI gate).
      if (output !== 'json' && output !== 'yaml') {
        for (const err of data.errors || []) {
          const loc = err.line ? `:${err.line}` : err.query ? ` [${err.query}]` : '';
          process.stderr.write(`error${loc}: ${err.message}\n`);
        }
      }
      throw new CliError(
        `report validate: ${data.errors?.length ?? 0} error(s) in ${path.basename(file)}`,
      );
    }

    default:
      throw new CliError(`Unknown report subcommand "${sub}". Use: validate <file>`);
  }
}
