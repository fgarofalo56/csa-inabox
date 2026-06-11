/**
 * Minimal argv parser (zero deps). Predictable rules:
 *   --key=value          -> flags.key = "value"
 *   --key value          -> flags.key = "value"   (only when `key` is a VALUE_FLAG)
 *   --bool               -> flags.bool = true
 *   -x                   -> flags.x = true (short boolean; combinable: -ab)
 *   --                   -> stop flag parsing; rest are positionals
 *   anything else        -> positional
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take a value via the space form (`--description "a b"`). */
const VALUE_FLAGS = new Set([
  'api-url',
  'output',
  'tenant',
  'tenant-id',
  'description',
  'capacity',
  'domain',
  'type',
  'name',
  'client-id',
  'client-secret',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let stop = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (stop) {
      positionals.push(tok);
      continue;
    }
    if (tok === '--') {
      stop = true;
    } else if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (VALUE_FLAGS.has(body) && i + 1 < argv.length) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else if (tok.startsWith('-') && tok.length > 1) {
      for (const ch of tok.slice(1)) flags[ch] = true;
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

export function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => flags[n] === true || flags[n] === 'true');
}
