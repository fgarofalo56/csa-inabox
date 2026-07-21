/**
 * `loom policy` — Governance-as-Code (WS-10.2 / BTB-8).
 *
 *   policy show                     Show the authored policy set + which
 *                                   backends it compiles to.
 *   policy compile [--backend b]    Show the one-pass compiled artifacts (real
 *                                   SQL/KQL/REST/scope statements) per backend.
 *   policy diff                     Dry-run reconcile — per-backend drift, no
 *                                   mutation.
 *   policy apply [--yes]            Reconcile: converge every configured backend
 *                                   with real calls, self-healing drift. Without
 *                                   --yes this is a dry run (same as diff).
 *
 * Wraps the same BFF routes the /admin/policy-code page uses. Azure-native; the
 * OSS-UC path needs no Databricks/Fabric capacity.
 */
import { requireAuth, CliError } from './context.js';
import type { GlobalOptions } from '../config.js';
import { flagStr, flagBool, type ParsedArgs } from '../args.js';
import { printResult } from '../output.js';

interface CompiledOp { key: string; kind: string; statement: string; target: string }
interface CompiledArtifact { backend: string; applicable: boolean; ops: CompiledOp[]; warnings: string[]; summary: string[] }
interface LoadResp {
  ok: boolean;
  set: { name: string; statements: unknown[] };
  exists: boolean;
  backends: string[];
  compiledBackends: string[];
  totalOps: number;
  artifacts: CompiledArtifact[];
}
interface ReconcileResp {
  ok: boolean;
  receipt: {
    mode: string;
    policySetName: string;
    compiledBackends: string[];
    totalDrift: number;
    backends: Array<{ backend: string; status: string; desired: number; inSync: number; applied: number; revoked: number; drift: number; errors: number; gate?: string }>;
    at: string;
  };
}

export async function runPolicy(sub: string, args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  const { client, output } = await requireAuth(opts);

  switch (sub) {
    case 'show': {
      const data = await client.request<LoadResp>('GET', '/api/admin/policy-code');
      printResult(
        {
          name: data.set?.name,
          statements: data.set?.statements?.length ?? 0,
          compilesTo: data.compiledBackends,
          totalOps: data.totalOps,
          exists: data.exists,
        },
        output,
      );
      return;
    }

    case 'compile': {
      const data = await client.request<LoadResp>('GET', '/api/admin/policy-code');
      const filter = flagStr(args.flags, 'backend');
      const artifacts = (data.artifacts || []).filter((a) => a.applicable && (!filter || a.backend === filter));
      if (output === 'json' || output === 'yaml') {
        printResult(artifacts as unknown as object, output);
        return;
      }
      // Human table: one row per op, backend-grouped.
      const rows = artifacts.flatMap((a) => a.ops.map((op) => ({ backend: a.backend, kind: op.kind, target: op.target, statement: op.statement })));
      if (!rows.length) {
        printResult({ compiledBackends: data.compiledBackends, note: 'no ops for the selected backend(s)' }, output);
        return;
      }
      printResult(rows, output, ['backend', 'kind', 'target', 'statement']);
      return;
    }

    case 'diff': {
      const data = await client.request<ReconcileResp>('POST', '/api/admin/policy-code/reconcile', { apply: false });
      printReceipt(data, output);
      return;
    }

    case 'apply': {
      const apply = flagBool(args.flags, 'yes') || flagBool(args.flags, 'y');
      const data = await client.request<ReconcileResp>('POST', '/api/admin/policy-code/reconcile', { apply });
      printReceipt(data, output);
      if (!apply) {
        process.stderr.write('Dry run (no changes applied). Re-run with --yes to converge every configured backend.\n');
      }
      return;
    }

    default:
      throw new CliError(
        `Unknown policy subcommand "${sub}". Use: show | compile [--backend b] | diff | apply [--yes]`,
      );
  }
}

function printReceipt(data: ReconcileResp, output: GlobalOptions['output'] | 'table'): void {
  const r = data.receipt;
  if (output === 'json' || output === 'yaml') {
    printResult(r as unknown as object, output as any);
    return;
  }
  process.stdout.write(`policy: ${r.policySetName}   mode: ${r.mode}   drift: ${r.totalDrift}   compiles to ${r.compiledBackends.length} backend(s)\n`);
  printResult(
    r.backends.map((b) => ({
      backend: b.backend,
      status: b.status,
      desired: b.desired,
      inSync: b.inSync,
      applied: b.applied,
      revoked: b.revoked,
      drift: b.drift,
      errors: b.errors,
      gate: b.gate ? b.gate.slice(0, 60) : '',
    })),
    output as any,
    ['backend', 'status', 'desired', 'inSync', 'applied', 'revoked', 'drift', 'errors', 'gate'],
  );
}
