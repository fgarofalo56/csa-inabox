import { describe, it, expect } from 'vitest';
import { buildConnectionStrings, getSqlHostSuffix } from '../components/connection-strings-builder';

describe('getSqlHostSuffix', () => {
  it('extracts database.windows.net from a Commercial FQDN', () => {
    expect(getSqlHostSuffix('myserver.database.windows.net')).toBe('database.windows.net');
  });
  it('extracts database.usgovcloudapi.net from a Gov FQDN', () => {
    expect(getSqlHostSuffix('myserver.database.usgovcloudapi.net')).toBe('database.usgovcloudapi.net');
  });
  it('defaults to database.windows.net for a bare server name', () => {
    expect(getSqlHostSuffix('myserver')).toBe('database.windows.net');
  });
});

describe('buildConnectionStrings — Commercial (database.windows.net)', () => {
  const s = buildConnectionStrings({ fqdn: 'myserver.database.windows.net', database: 'mydb' });

  it('ADO.NET contains the real FQDN, database, and Active Directory Default auth', () => {
    expect(s.adonet).toContain('Server=tcp:myserver.database.windows.net,1433');
    expect(s.adonet).toContain('Database=mydb');
    expect(s.adonet).toContain('Authentication=Active Directory Default');
    expect(s.adonet).toContain('Encrypt=True');
    expect(s.adonet).toContain('TrustServerCertificate=False');
  });

  it('JDBC contains ActiveDirectoryMSI and hostNameInCertificate=*.database.windows.net', () => {
    expect(s.jdbc).toContain('jdbc:sqlserver://myserver.database.windows.net:1433');
    expect(s.jdbc).toContain('database=mydb');
    expect(s.jdbc).toContain('authentication=ActiveDirectoryMSI');
    expect(s.jdbc).toContain('hostNameInCertificate=*.database.windows.net');
  });

  it('ODBC uses ODBC Driver 18 and ActiveDirectoryManagedIdentity', () => {
    expect(s.odbc).toContain('{ODBC Driver 18 for SQL Server}');
    expect(s.odbc).toContain('Authentication=ActiveDirectoryManagedIdentity');
    expect(s.odbc).toContain('myserver.database.windows.net');
  });

  it('PHP uses ActiveDirectoryMsi in sqlsrv_connect with the real FQDN and DB', () => {
    expect(s.php).toContain("'ActiveDirectoryMsi'");
    expect(s.php).toContain('myserver.database.windows.net');
    expect(s.php).toContain("'mydb'");
  });

  it('Go uses fedauth=ActiveDirectoryDefault and azuread.DriverName', () => {
    expect(s.go).toContain('fedauth=ActiveDirectoryDefault');
    expect(s.go).toContain('server=myserver.database.windows.net');
    expect(s.go).toContain('database=mydb');
    expect(s.go).toContain('azuread.DriverName');
  });
});

describe('buildConnectionStrings — GCC-High / IL5 / DoD (database.usgovcloudapi.net)', () => {
  const s = buildConnectionStrings({ fqdn: 'myserver.database.usgovcloudapi.net', database: 'govdb' });

  it('ADO.NET contains the Gov FQDN and DB', () => {
    expect(s.adonet).toContain('myserver.database.usgovcloudapi.net');
    expect(s.adonet).toContain('Database=govdb');
    expect(s.adonet).not.toContain('windows.net');
  });

  it('JDBC hostNameInCertificate uses the Gov suffix only', () => {
    expect(s.jdbc).toContain('hostNameInCertificate=*.database.usgovcloudapi.net');
    expect(s.jdbc).not.toContain('windows.net');
  });

  it('ODBC contains the Gov FQDN', () => {
    expect(s.odbc).toContain('myserver.database.usgovcloudapi.net');
  });

  it('Go contains the Gov FQDN', () => {
    expect(s.go).toContain('server=myserver.database.usgovcloudapi.net');
  });
});

describe('cloud-matrix — suffix switching is FQDN-driven', () => {
  it('the same server name yields different suffixes per cloud', () => {
    const comm = buildConnectionStrings({ fqdn: 'loom-sql-01.database.windows.net', database: 'appdb' });
    const gov = buildConnectionStrings({ fqdn: 'loom-sql-01.database.usgovcloudapi.net', database: 'appdb' });
    expect(comm.jdbc).toContain('*.database.windows.net');
    expect(gov.jdbc).toContain('*.database.usgovcloudapi.net');
    expect(comm.adonet).not.toEqual(gov.adonet);
  });
});
