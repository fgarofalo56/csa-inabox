/**
 * SQL-login honest gate (audit B3).
 *
 * Synapse dedicated SQL pools / warehouses authenticate the Console UAMI as an
 * Entra (AAD) principal. When the UAMI has NOT been provisioned as a SQL login
 * on the pool/warehouse, the TDS driver fails with `Login failed for user
 * '<token-identified principal>'` (mssql error code `ELOGIN`). Several surfaces
 * (Warp visual-query on a warehouse / Synapse Dedicated, DAB sources
 * schema/columns, Thread warehouse-tables) previously leaked that raw 500/ELOGIN.
 *
 * This is a genuine Azure RBAC/provisioning gap (NOT a Fabric dependency), so it
 * is an honest infra-gate per no-vaporware.md: detect the login failure and
 * return a structured 503 naming the EXACT remediation — granting the UAMI a
 * SQL login via `CREATE USER … FROM EXTERNAL PROVIDER` + a role on the pool.
 */

/** True when the error is a SQL-login / authentication failure against the pool. */
export function isSqlLoginFailure(e: unknown): boolean {
  if (!e) return false;
  const err = e as any;
  const code = String(err?.code || err?.number || '').toUpperCase();
  if (code === 'ELOGIN') return true;
  // mssql login-failed maps to SQL error number 18456.
  if (err?.number === 18456) return true;
  const msg = `${err?.message || ''} ${typeof err === 'string' ? err : ''}`;
  return /login failed for user|cannot open (server|database).*login|not able to log ?in/i.test(msg);
}

export interface SqlLoginGate {
  ok: false;
  code: 'sql_login_required';
  error: string;
  gate: {
    reason: string;
    remediation: string;
    sql: string;
  };
}

/**
 * Build the structured 503 gate body for a SQL-login failure. `target` names the
 * surface ("warehouse", "Synapse dedicated pool", "DAB source") for the message;
 * `principal` is the UAMI display name / client id when known.
 */
/** The Console UAMI's display name, resolved from Loom's own env so the CREATE
 * USER script is copy-paste-runnable (rule #70) — the UAMI resource name IS the
 * Entra SP display name. Placeholder only when neither env coordinate exists. */
function consoleUamiName(): string {
  const fromRid = (process.env.LOOM_UAMI_RESOURCE_ID || '').trim().split('/').pop() || '';
  return fromRid || (process.env.LOOM_UAMI_NAME || '').trim() || '<console-uami-name>';
}

export function sqlLoginGateBody(opts: { target?: string; principal?: string; detail?: string } = {}): SqlLoginGate {
  const target = opts.target || 'the dedicated SQL pool / warehouse';
  const principal = opts.principal || 'the Console UAMI (LOOM_UAMI_CLIENT_ID)';
  const user = opts.principal || consoleUamiName();
  const sql =
    `-- Run as an Entra admin on ${target}:\n` +
    `CREATE USER [${user}] FROM EXTERNAL PROVIDER;\n` +
    `ALTER ROLE db_datareader ADD MEMBER [${user}];\n` +
    `-- (add db_datawriter / db_ddladmin only if write/DDL is required)`;
  return {
    ok: false,
    code: 'sql_login_required',
    error: `${principal} is not authorized to sign in to ${target} (SQL login failed).` +
      (opts.detail ? ` ${opts.detail}` : ''),
    gate: {
      reason: `${principal} authenticates to ${target} as an Entra principal but has no SQL login there, so the query can't run.`,
      remediation:
        `Grant ${principal} a SQL login on ${target}: connect as an Entra admin and run ` +
        `CREATE USER [${user}] FROM EXTERNAL PROVIDER, then add it to the needed database role(s). ` +
        `No Microsoft Fabric is required — this is an Azure SQL/Synapse RBAC grant.`,
      sql,
    },
  };
}
