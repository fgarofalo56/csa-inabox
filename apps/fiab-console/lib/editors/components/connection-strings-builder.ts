/**
 * connection-strings-builder — pure, cloud-aware Azure SQL connection string
 * generator. Takes the ARM-authoritative FQDN + DB name and emits copy-ready
 * strings for ADO.NET, JDBC, ODBC, PHP, and Go.
 *
 * No side effects, no process.env reads, no fetch calls: safe for client
 * components and vitest without mocks.
 *
 * Cloud awareness: the FQDN returned by ARM
 * (Microsoft.Sql/servers · properties.fullyQualifiedDomainName) already carries
 * the cloud-correct suffix — `database.windows.net` for Commercial/GCC,
 * `database.usgovcloudapi.net` for GCC-High/IL5/DoD. `getSqlHostSuffix()`
 * extracts it so `hostNameInCertificate` in the JDBC string and the driver
 * guidance are always gov-correct.
 *
 * Auth mode for every driver is password-free Microsoft Entra (Managed
 * Identity / Default) — the Microsoft-recommended, secretless path. Grounded
 * in Microsoft Learn:
 *   ADO.NET → Authentication=Active Directory Default
 *   JDBC    → authentication=ActiveDirectoryMSI
 *   ODBC 18 → Authentication=ActiveDirectoryManagedIdentity
 *   PHP     → 'Authentication' => 'ActiveDirectoryMsi'
 *   Go      → fedauth=ActiveDirectoryDefault (go-mssqldb/azuread)
 */

export interface ConnectionStringInput {
  /** ARM-authoritative FQDN (e.g. myserver.database.windows.net). */
  fqdn: string;
  /** Database name. */
  database: string;
}

export interface ConnectionStrings {
  adonet: string;
  jdbc: string;
  odbc: string;
  php: string;
  go: string;
}

/**
 * Extract the SQL endpoint suffix from the ARM-returned FQDN.
 *   "myserver.database.windows.net"        → "database.windows.net"
 *   "myserver.database.usgovcloudapi.net"  → "database.usgovcloudapi.net"
 * Falls back to the Commercial suffix for a bare server name (no dot).
 */
export function getSqlHostSuffix(fqdn: string): string {
  const dot = fqdn.indexOf('.');
  return dot === -1 ? 'database.windows.net' : fqdn.slice(dot + 1);
}

export function buildConnectionStrings({ fqdn, database }: ConnectionStringInput): ConnectionStrings {
  const suffix = getSqlHostSuffix(fqdn);

  const adonet =
    `Server=tcp:${fqdn},1433;Database=${database};` +
    `Authentication=Active Directory Default;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;`;

  const jdbc =
    `jdbc:sqlserver://${fqdn}:1433;` +
    `database=${database};authentication=ActiveDirectoryMSI;` +
    `encrypt=true;trustServerCertificate=false;` +
    `hostNameInCertificate=*.${suffix};loginTimeout=30;`;

  const odbc =
    `Driver={ODBC Driver 18 for SQL Server};Server=tcp:${fqdn},1433;Database=${database};` +
    `Authentication=ActiveDirectoryManagedIdentity;Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;`;

  const php =
    `// SQLSRV (Microsoft Drivers for PHP for SQL Server):\n` +
    `$connectionInfo = array('Database' => '${database}', 'Authentication' => 'ActiveDirectoryMsi');\n` +
    `$conn = sqlsrv_connect('${fqdn}', $connectionInfo);\n\n` +
    `// PDO_SQLSRV:\n` +
    `$conn = new PDO("sqlsrv:server = ${fqdn},1433; Database = ${database}; Authentication = ActiveDirectoryMsi");`;

  const go =
    `// github.com/microsoft/go-mssqldb/azuread\n` +
    `connString := fmt.Sprintf(\n` +
    `    "server=${fqdn};port=1433;database=${database};fedauth=ActiveDirectoryDefault;")\n` +
    `db, err = sql.Open(azuread.DriverName, connString)`;

  return { adonet, jdbc, odbc, php, go };
}
