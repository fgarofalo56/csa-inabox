# Application Migration -- IBM Db2 to Azure SQL

**Audience:** Application Developers, Architects, QA Engineers
**Purpose:** Guide for updating applications that connect to IBM Db2 to work with Azure SQL, covering JDBC/ODBC driver changes, connection string migration, embedded SQL conversion, COBOL precompiler dependencies, and testing strategies.

---

## Overview

Application migration is the complement to database migration. After the schema and data have moved to Azure SQL, every application that connected to Db2 must be updated. The scope of changes depends on how tightly the application is coupled to Db2:

| Coupling level | Application type                                                                     | Migration effort                                                             |
| -------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Loose**      | Modern Java/Spring, .NET, Python using ORM (Hibernate, Entity Framework, SQLAlchemy) | Low -- driver change + connection string + minor SQL fixes                   |
| **Moderate**   | Java/JDBC with inline SQL, .NET with ADO.NET, Python with direct SQL                 | Medium -- driver change + SQL syntax conversion                              |
| **Tight**      | COBOL with embedded SQL (EXEC SQL), SQLJ, Db2-specific stored procedure calls        | High -- precompiler elimination + SQL rewrite + potential language migration |
| **Very tight** | CICS/IMS transactions, batch programs with EXEC SQL, COBOL DCLGEN                    | Very high -- full application modernization program                          |

---

## 1. JDBC driver migration

### Current Db2 JDBC configuration

Most Java applications connect to Db2 using the IBM Db2 JDBC driver (`db2jcc4.jar` or the newer `jcc` driver):

```java
// Db2 JDBC connection (Type 4 -- pure Java)
import com.ibm.db2.jcc.DB2Driver;

String url = "jdbc:db2://db2server.example.com:50000/FINANCEDB";
String user = "db2admin";
String password = "password";

Connection conn = DriverManager.getConnection(url, user, password);
```

### Target Azure SQL JDBC configuration

```java
// Azure SQL JDBC connection
import com.microsoft.sqlserver.jdbc.SQLServerDriver;

String url = "jdbc:sqlserver://sqlmi-instance.database.usgovcloudapi.net:1433;"
    + "database=FinanceDB;"
    + "encrypt=true;"
    + "trustServerCertificate=false;"
    + "hostNameInCertificate=*.database.usgovcloudapi.net;"
    + "loginTimeout=30;";

// Option 1: SQL authentication
Connection conn = DriverManager.getConnection(url, "sqladmin", password);

// Option 2: Azure AD (Entra ID) authentication with managed identity
String url = "jdbc:sqlserver://sqlmi-instance.database.usgovcloudapi.net:1433;"
    + "database=FinanceDB;"
    + "encrypt=true;"
    + "authentication=ActiveDirectoryManagedIdentity;";
Connection conn = DriverManager.getConnection(url);
```

### Maven/Gradle dependency changes

```xml
<!-- Remove Db2 JDBC driver -->
<!-- <dependency>
    <groupId>com.ibm.db2</groupId>
    <artifactId>jcc</artifactId>
    <version>11.5.9.0</version>
</dependency> -->

<!-- Add SQL Server JDBC driver -->
<dependency>
    <groupId>com.microsoft.sqlserver</groupId>
    <artifactId>mssql-jdbc</artifactId>
    <version>12.6.1.jre11</version>
</dependency>
```

### Spring Boot configuration changes

```yaml
# Before (Db2)
spring:
  datasource:
    url: jdbc:db2://db2server:50000/FINANCEDB
    username: db2admin
    password: ${DB2_PASSWORD}
    driver-class-name: com.ibm.db2.jcc.DB2Driver
  jpa:
    database-platform: org.hibernate.dialect.DB2Dialect

# After (Azure SQL)
spring:
  datasource:
    url: jdbc:sqlserver://sqlmi.database.usgovcloudapi.net:1433;database=FinanceDB;encrypt=true
    username: sqladmin
    password: ${AZURE_SQL_PASSWORD}
    driver-class-name: com.microsoft.sqlserver.jdbc.SQLServerDriver
  jpa:
    database-platform: org.hibernate.dialect.SQLServerDialect
```

### Hibernate dialect change

If using Hibernate or JPA, the dialect must change:

```java
// Before
properties.put("hibernate.dialect", "org.hibernate.dialect.DB2Dialect");
// or for z/OS
properties.put("hibernate.dialect", "org.hibernate.dialect.DB2390Dialect");

// After
properties.put("hibernate.dialect", "org.hibernate.dialect.SQLServerDialect");
```

Hibernate handles most SQL generation differences through the dialect. However, any native queries or HQL with Db2-specific functions will need manual updating.

---

## 2. ODBC driver migration

### Windows ODBC DSN changes

```ini
; Before (Db2 ODBC)
[DB2_FINANCE]
Driver=IBM DB2 ODBC DRIVER - DB2COPY1
Database=FINANCEDB
Hostname=db2server.example.com
Port=50000
Protocol=TCPIP

; After (SQL Server ODBC)
[AZURE_SQL_FINANCE]
Driver=ODBC Driver 18 for SQL Server
Server=sqlmi-instance.database.usgovcloudapi.net,1433
Database=FinanceDB
Encrypt=yes
TrustServerCertificate=no
```

### Connection string migration

```
; Db2 ODBC connection string
Driver={IBM DB2 ODBC DRIVER};Database=FINANCEDB;Hostname=db2server;Port=50000;Protocol=TCPIP;UID=db2admin;PWD=password;

; Azure SQL ODBC connection string
Driver={ODBC Driver 18 for SQL Server};Server=sqlmi.database.usgovcloudapi.net,1433;Database=FinanceDB;UID=sqladmin;PWD=password;Encrypt=yes;
```

---

## 3. .NET / ADO.NET migration

### Db2 to SqlClient conversion

```csharp
// Before (IBM Db2 .NET provider)
using IBM.Data.Db2;

var conn = new DB2Connection(
    "Server=db2server:50000;Database=FINANCEDB;UID=db2admin;PWD=password;");
conn.Open();

var cmd = new DB2Command("SELECT * FROM accounts WHERE account_id = @id", conn);
cmd.Parameters.Add(new DB2Parameter("@id", 12345));

// After (Microsoft.Data.SqlClient)
using Microsoft.Data.SqlClient;

var conn = new SqlConnection(
    "Server=sqlmi.database.usgovcloudapi.net;Database=FinanceDB;" +
    "User Id=sqladmin;Password=password;Encrypt=True;");
conn.Open();

var cmd = new SqlCommand("SELECT * FROM accounts WHERE account_id = @id", conn);
cmd.Parameters.Add(new SqlParameter("@id", 12345));
```

### Entity Framework changes

```csharp
// Before (Db2 provider)
services.AddDbContext<FinanceContext>(options =>
    options.UseDb2(Configuration.GetConnectionString("Db2Connection")));

// After (SQL Server provider)
services.AddDbContext<FinanceContext>(options =>
    options.UseSqlServer(Configuration.GetConnectionString("AzureSqlConnection")));
```

Entity Framework Core handles most SQL generation differences automatically when the provider is changed. Review any raw SQL queries or `FromSqlRaw()` calls for Db2-specific syntax.

---

## 4. Python application migration

### Direct SQL connection changes

```python
# Before (ibm_db / ibm_db_dbi)
import ibm_db
import ibm_db_dbi

conn_str = "DATABASE=FINANCEDB;HOSTNAME=db2server;PORT=50000;PROTOCOL=TCPIP;UID=db2admin;PWD=password;"
conn = ibm_db.connect(conn_str, "", "")
pconn = ibm_db_dbi.Connection(conn)

# After (pyodbc for Azure SQL)
import pyodbc

conn_str = (
    "Driver={ODBC Driver 18 for SQL Server};"
    "Server=sqlmi.database.usgovcloudapi.net,1433;"
    "Database=FinanceDB;"
    "UID=sqladmin;"
    "PWD=password;"
    "Encrypt=yes;"
)
conn = pyodbc.connect(conn_str)
```

### SQLAlchemy changes

```python
# Before (Db2)
from sqlalchemy import create_engine
engine = create_engine("ibm_db_sa://db2admin:password@db2server:50000/FINANCEDB")

# After (Azure SQL)
engine = create_engine(
    "mssql+pyodbc://sqladmin:password@sqlmi.database.usgovcloudapi.net:1433/FinanceDB"
    "?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes"
)
```

---

## 5. Embedded SQL (SQLJ) migration

Db2 applications using SQLJ (static SQL in Java) require significant rework because SQL Server does not support SQLJ.

### SQLJ to JDBC conversion pattern

```java
// Before (SQLJ -- static SQL embedded in Java)
#sql {
    SELECT name, balance
    INTO :name, :balance
    FROM accounts
    WHERE account_id = :accountId
};

// After (JDBC PreparedStatement)
PreparedStatement pstmt = conn.prepareStatement(
    "SELECT name, balance FROM accounts WHERE account_id = ?");
pstmt.setInt(1, accountId);
ResultSet rs = pstmt.executeQuery();
if (rs.next()) {
    name = rs.getString("name");
    balance = rs.getBigDecimal("balance");
}
```

### SQLJ iterator to ResultSet conversion

```java
// Before (SQLJ iterator)
#sql iterator AccountIterator(int accountId, String name, BigDecimal balance);
AccountIterator iter;
#sql iter = {
    SELECT account_id, name, balance FROM accounts WHERE status = 'ACTIVE'
};
while (iter.next()) {
    processAccount(iter.accountId(), iter.name(), iter.balance());
}
iter.close();

// After (JDBC ResultSet)
PreparedStatement pstmt = conn.prepareStatement(
    "SELECT account_id, name, balance FROM accounts WHERE status = 'ACTIVE'");
ResultSet rs = pstmt.executeQuery();
while (rs.next()) {
    processAccount(rs.getInt("account_id"), rs.getString("name"),
                   rs.getBigDecimal("balance"));
}
rs.close();
pstmt.close();
```

---

## 6. COBOL precompiler dependencies

COBOL programs using Db2 embedded SQL (EXEC SQL) have the deepest coupling to Db2. These programs are precompiled by the Db2 precompiler, which generates COBOL code with CALL statements to the Db2 runtime.

### Assessment of COBOL-Db2 coupling

Inventory all COBOL programs containing embedded SQL:

```
EXEC SQL
    SELECT ACCT_NAME, ACCT_BAL
    INTO :WS-ACCT-NAME, :WS-ACCT-BAL
    FROM ACCOUNTS
    WHERE ACCT_ID = :WS-ACCT-ID
END-EXEC
```

### Migration strategies for COBOL-Db2

| Strategy                                 | Effort    | When to use                                                                           |
| ---------------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| **Rewrite in modern language**           | Very high | Greenfield modernization; new Java/.NET/Python services replace COBOL programs        |
| **Micro Focus Enterprise Server**        | High      | Run COBOL unchanged on Azure VMs with SQL Server connectivity via ODBC                |
| **API wrapping**                         | Medium    | Expose COBOL logic as REST APIs; keep COBOL on mainframe, query Azure SQL via gateway |
| **Automated conversion (COBOL to Java)** | High      | Tools like Blu Age, Raincode, or Modern Systems convert COBOL to Java                 |

### DCLGEN replacement

DCLGEN (Declaration Generator) produces COBOL copybooks from Db2 table definitions. After migration, these copybooks must be regenerated to match the Azure SQL schema or the application must be converted to use a different data access method.

---

## 7. Batch job migration

Db2 batch processing typically runs via:

- z/OS: JCL jobs calling programs with embedded SQL
- LUW: Shell scripts calling `db2 -tvf script.sql` or compiled programs

### LUW batch script conversion

```bash
# Before (Db2 LUW batch)
#!/bin/bash
db2 connect to FINANCEDB user db2admin using $DB2_PASSWORD
db2 -tvf /opt/batch/daily_interest_calc.sql
db2 -tvf /opt/batch/account_summary.sql
db2 connect reset

# After (Azure SQL batch via sqlcmd)
#!/bin/bash
sqlcmd -S sqlmi.database.usgovcloudapi.net -d FinanceDB \
    -U sqladmin -P "$AZURE_SQL_PASSWORD" \
    -i /opt/batch/daily_interest_calc.sql -o /opt/batch/output.log

sqlcmd -S sqlmi.database.usgovcloudapi.net -d FinanceDB \
    -U sqladmin -P "$AZURE_SQL_PASSWORD" \
    -i /opt/batch/account_summary.sql -o /opt/batch/output.log
```

### SQL Agent job replacement

For Azure SQL MI, batch scripts become SQL Agent jobs:

```sql
-- Create a SQL Agent job for nightly processing
EXEC msdb.dbo.sp_add_job @job_name = N'Daily_Interest_Calculation';

EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'Daily_Interest_Calculation',
    @step_name = N'Calculate interest',
    @subsystem = N'TSQL',
    @command = N'EXEC dbo.sp_calculate_daily_interest;',
    @database_name = N'FinanceDB';

EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'Nightly_0200',
    @freq_type = 4,  -- daily
    @active_start_time = 020000;  -- 2:00 AM

EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'Daily_Interest_Calculation',
    @schedule_name = N'Nightly_0200';
```

---

## 8. Application testing strategy

### Test phases

| Phase                     | Scope                                          | Duration  | Goal                                                        |
| ------------------------- | ---------------------------------------------- | --------- | ----------------------------------------------------------- |
| **Unit testing**          | Individual SQL queries, stored procedure calls | 1-2 weeks | Verify each query returns correct results against Azure SQL |
| **Integration testing**   | Application modules with database interactions | 2-3 weeks | Verify end-to-end data flows work correctly                 |
| **Performance testing**   | Representative workloads at production scale   | 1-2 weeks | Verify response times and throughput meet SLAs              |
| **Regression testing**    | Full application test suite                    | 2-3 weeks | Verify no existing functionality is broken                  |
| **UAT (User Acceptance)** | Business scenario testing                      | 1-2 weeks | Business stakeholders validate critical workflows           |
| **Parallel running**      | Simultaneous Db2 and Azure SQL operation       | 2-4 weeks | Compare outputs to validate migration accuracy              |

### SQL query validation approach

1. **Extract all SQL statements** from application code (search for SQL keywords, prepared statements, ORM-generated queries).
2. **Categorize by complexity:** simple (SELECT/INSERT/UPDATE/DELETE), moderate (joins, subqueries), complex (Db2-specific functions, dynamic SQL).
3. **Run each query against Azure SQL** and compare results to Db2.
4. **Pay special attention to:**
    - Date arithmetic (DAYS(), MONTHS_BETWEEN() -> DATEDIFF())
    - String function argument order (POSSTR -> CHARINDEX)
    - Null handling differences
    - Numeric precision (DECFLOAT -> DECIMAL rounding)
    - Isolation level behavior differences

### Performance baseline comparison

Run the application's critical queries on both Db2 and Azure SQL and compare:

```sql
-- Azure SQL: capture query performance
SET STATISTICS TIME ON;
SET STATISTICS IO ON;

-- Run the query
SELECT ...;

-- Review logical reads, CPU time, elapsed time
```

Compare against the Db2 EXPLAIN output for the same queries. Azure SQL's Query Store provides historical query performance data for ongoing monitoring.

---

## 9. Connection pooling considerations

### Db2 connection pooling

Db2 applications typically use connection pooling via:

- JDBC: Apache DBCP, HikariCP, or container-managed (WebSphere)
- .NET: Built-in Db2 connection pooling
- ODBC: Driver-level pooling

### Azure SQL connection pooling

Azure SQL supports the same pooling mechanisms. Key configuration changes:

```yaml
# HikariCP configuration for Azure SQL
spring:
    datasource:
        hikari:
            connection-timeout: 30000
            maximum-pool-size: 20
            minimum-idle: 5
            idle-timeout: 600000
            max-lifetime: 1800000
            connection-test-query: SELECT 1
```

**Azure SQL MI connection limits:** General Purpose supports up to 30,000 concurrent connections. Business Critical supports up to 30,000. Pool sizes should be tuned to remain within these limits across all application instances.

---

## 10. Rollback plan

Every application migration must have a documented rollback procedure:

1. **Maintain Db2 connectivity** throughout the migration period (do not decommission drivers or remove connection strings until validation is complete).
2. **Feature flags** for database-specific code paths allow switching back to Db2.
3. **DNS-based cutover** using CNAME records that can be redirected back to Db2.
4. **Dual-write capability** during the transition period ensures both databases have current data.

---

## Related resources

- [Schema Migration](schema-migration.md) -- SQL syntax differences to fix in application code
- [Stored Procedure Migration](stored-proc-migration.md) -- procedure call changes
- [Mainframe Considerations](mainframe-considerations.md) -- COBOL/CICS application patterns
- [Best Practices](best-practices.md) -- testing methodology

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
