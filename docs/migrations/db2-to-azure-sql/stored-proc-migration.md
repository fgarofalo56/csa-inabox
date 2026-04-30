# Stored Procedure Migration -- IBM Db2 SQL PL to T-SQL

**Audience:** Database Developers, DBAs, Migration Engineers
**Purpose:** Detailed conversion guide for IBM Db2 SQL PL stored procedures, functions, and triggers to T-SQL, covering variable declarations, control flow, error handling, cursors, dynamic SQL, and Db2 built-in function equivalents.

---

## Overview

Db2 stored procedures are written in **SQL PL** (SQL Procedural Language), a procedural extension to SQL defined by the SQL/PSM standard. T-SQL is Microsoft's proprietary procedural extension. While both serve the same purpose, they differ in syntax, error handling, variable scoping, and built-in function availability.

SSMA for Db2 converts approximately 70% of stored procedures automatically. The remaining 30% requires manual intervention, concentrated in these areas:

1. **Condition handlers** (Db2) vs **TRY/CATCH** (T-SQL)
2. **SIGNAL / RESIGNAL** vs **THROW / RAISERROR**
3. **Compound statements** (BEGIN...END with variable declarations)
4. **Cursor patterns** (Db2 cursor WITH HOLD, WITH RETURN)
5. **Db2 built-in functions** without T-SQL equivalents
6. **Dynamic SQL** (PREPARE/EXECUTE vs sp_executesql)

---

## 1. Procedure structure

### Basic procedure skeleton

```sql
-- Db2 SQL PL
CREATE OR REPLACE PROCEDURE schema.calc_interest(
    IN p_account_id INTEGER,
    IN p_rate DECIMAL(5,4),
    OUT p_interest DECIMAL(15,2)
)
LANGUAGE SQL
BEGIN
    DECLARE v_balance DECIMAL(15,2);

    SELECT balance INTO v_balance
    FROM accounts
    WHERE account_id = p_account_id;

    SET p_interest = v_balance * p_rate;

    UPDATE accounts
    SET last_calc_date = CURRENT DATE
    WHERE account_id = p_account_id;
END;
```

```sql
-- T-SQL
CREATE OR ALTER PROCEDURE schema.calc_interest
    @p_account_id INT,
    @p_rate DECIMAL(5,4),
    @p_interest DECIMAL(15,2) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @v_balance DECIMAL(15,2);

    SELECT @v_balance = balance
    FROM accounts
    WHERE account_id = @p_account_id;

    SET @p_interest = @v_balance * @p_rate;

    UPDATE accounts
    SET last_calc_date = CAST(GETDATE() AS DATE)
    WHERE account_id = @p_account_id;
END;
```

**Key differences:**

| Aspect               | Db2 SQL PL            | T-SQL                                 |
| -------------------- | --------------------- | ------------------------------------- |
| Parameter prefix     | None                  | `@` prefix required                   |
| Parameter direction  | `IN`, `OUT`, `INOUT`  | Default is `IN`; use `OUTPUT` for out |
| Variable prefix      | None                  | `@` prefix required                   |
| Variable declaration | Inside BEGIN...END    | After AS BEGIN, before usage          |
| SELECT INTO          | `SELECT col INTO var` | `SELECT @var = col`                   |
| Current date         | `CURRENT DATE`        | `CAST(GETDATE() AS DATE)`             |
| SET statement        | `SET var = expr`      | `SET @var = expr`                     |
| NOCOUNT              | Not needed            | `SET NOCOUNT ON` recommended          |

---

## 2. Variable declarations

```sql
-- Db2: variables declared in compound statement
BEGIN
    DECLARE v_count INTEGER DEFAULT 0;
    DECLARE v_name VARCHAR(100);
    DECLARE v_amount DECIMAL(15,2) DEFAULT 0.00;
    DECLARE v_today DATE DEFAULT CURRENT DATE;
    DECLARE v_found BOOLEAN DEFAULT FALSE;
    -- ...
END;
```

```sql
-- T-SQL: variables declared with @
BEGIN
    DECLARE @v_count INT = 0;
    DECLARE @v_name VARCHAR(100);
    DECLARE @v_amount DECIMAL(15,2) = 0.00;
    DECLARE @v_today DATE = CAST(GETDATE() AS DATE);
    DECLARE @v_found BIT = 0;
    -- ...
END;
```

**Notes:**

- Db2 uses `DEFAULT` for initialization; T-SQL uses `=`
- Db2 `BOOLEAN` maps to T-SQL `BIT` (TRUE/FALSE -> 1/0)
- T-SQL allows variable declaration anywhere in the block; Db2 requires declarations at the start of the compound statement

---

## 3. Condition handlers (Db2) vs TRY/CATCH (T-SQL)

This is the most significant structural difference between Db2 SQL PL and T-SQL.

### Db2 condition handler model

Db2 uses DECLARE HANDLER to define exception handlers within compound statements:

```sql
-- Db2: condition handlers
CREATE PROCEDURE schema.process_payment(
    IN p_account_id INTEGER,
    IN p_amount DECIMAL(15,2),
    OUT p_status VARCHAR(20)
)
LANGUAGE SQL
BEGIN
    DECLARE SQLSTATE CHAR(5);
    DECLARE v_balance DECIMAL(15,2);

    -- Handler for "not found" condition
    DECLARE not_found CONDITION FOR SQLSTATE '02000';
    DECLARE CONTINUE HANDLER FOR not_found
    BEGIN
        SET p_status = 'ACCOUNT_NOT_FOUND';
    END;

    -- Handler for constraint violation
    DECLARE CONTINUE HANDLER FOR SQLSTATE '23505'
    BEGIN
        SET p_status = 'DUPLICATE_PAYMENT';
    END;

    -- Handler for any other SQL exception
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET p_status = 'ERROR';
        ROLLBACK;
    END;

    SET p_status = 'SUCCESS';

    SELECT balance INTO v_balance
    FROM accounts
    WHERE account_id = p_account_id;

    IF p_status = 'ACCOUNT_NOT_FOUND' THEN
        RETURN;
    END IF;

    IF v_balance < p_amount THEN
        SET p_status = 'INSUFFICIENT_FUNDS';
        RETURN;
    END IF;

    UPDATE accounts
    SET balance = balance - p_amount
    WHERE account_id = p_account_id;

    INSERT INTO payments (account_id, amount, payment_date)
    VALUES (p_account_id, p_amount, CURRENT TIMESTAMP);
END;
```

### T-SQL TRY/CATCH equivalent

```sql
-- T-SQL: TRY/CATCH
CREATE OR ALTER PROCEDURE schema.process_payment
    @p_account_id INT,
    @p_amount DECIMAL(15,2),
    @p_status VARCHAR(20) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @v_balance DECIMAL(15,2);

    BEGIN TRY
        SET @p_status = 'SUCCESS';

        SELECT @v_balance = balance
        FROM accounts
        WHERE account_id = @p_account_id;

        IF @v_balance IS NULL
        BEGIN
            SET @p_status = 'ACCOUNT_NOT_FOUND';
            RETURN;
        END;

        IF @v_balance < @p_amount
        BEGIN
            SET @p_status = 'INSUFFICIENT_FUNDS';
            RETURN;
        END;

        UPDATE accounts
        SET balance = balance - @p_amount
        WHERE account_id = @p_account_id;

        INSERT INTO payments (account_id, amount, payment_date)
        VALUES (@p_account_id, @p_amount, SYSDATETIME());

    END TRY
    BEGIN CATCH
        SET @p_status = 'ERROR';

        IF XACT_STATE() <> 0
            ROLLBACK;

        -- Log the error
        INSERT INTO error_log (error_number, error_message, error_procedure, error_line)
        VALUES (ERROR_NUMBER(), ERROR_MESSAGE(), ERROR_PROCEDURE(), ERROR_LINE());
    END CATCH;
END;
```

### Handler type mapping

| Db2 handler type           | T-SQL equivalent                               | Notes                                                                                                  |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `DECLARE CONTINUE HANDLER` | Logic within TRY block with conditional checks | CONTINUE handler allows execution to proceed after handling. In T-SQL, check for the condition inline. |
| `DECLARE EXIT HANDLER`     | `CATCH` block                                  | EXIT handler terminates the compound statement. CATCH block runs on any error.                         |
| `DECLARE UNDO HANDLER`     | `CATCH` block with `ROLLBACK`                  | UNDO handler rolls back and exits. CATCH + ROLLBACK.                                                   |
| `FOR SQLEXCEPTION`         | `CATCH` (all errors)                           | Catches all SQL errors.                                                                                |
| `FOR SQLWARNING`           | `@@ROWCOUNT` / `@@ERROR` checks                | T-SQL has no warning handler; check post-execution.                                                    |
| `FOR NOT FOUND`            | `IF @@ROWCOUNT = 0`                            | Check after SELECT/FETCH.                                                                              |
| `FOR SQLSTATE 'xxxxx'`     | `IF ERROR_NUMBER() = nnn` in CATCH             | Map SQLSTATE to SQL Server error numbers.                                                              |

---

## 4. SIGNAL and RESIGNAL vs THROW and RAISERROR

### Raising errors

```sql
-- Db2: SIGNAL
SIGNAL SQLSTATE '75001'
    SET MESSAGE_TEXT = 'Invalid account status';

-- T-SQL (SQL Server 2012+): THROW
THROW 75001, 'Invalid account status', 1;
```

```sql
-- Db2: SIGNAL with condition name
DECLARE invalid_status CONDITION FOR SQLSTATE '75001';
SIGNAL invalid_status SET MESSAGE_TEXT = 'Invalid account status';

-- T-SQL: RAISERROR (legacy, with severity and state)
RAISERROR('Invalid account status', 16, 1);
```

### Re-raising errors in CATCH

```sql
-- Db2: RESIGNAL (re-raise current exception)
DECLARE EXIT HANDLER FOR SQLEXCEPTION
BEGIN
    -- log the error
    INSERT INTO error_log (msg) VALUES ('Error in processing');
    RESIGNAL;
END;

-- T-SQL: THROW without parameters (re-raise in CATCH)
BEGIN CATCH
    INSERT INTO error_log (msg) VALUES ('Error in processing');
    THROW;  -- re-raises the original error
END CATCH;
```

---

## 5. Cursor patterns

### Standard cursor

```sql
-- Db2: cursor with FETCH
CREATE PROCEDURE schema.process_all_accounts()
LANGUAGE SQL
BEGIN
    DECLARE v_id INTEGER;
    DECLARE v_balance DECIMAL(15,2);
    DECLARE v_done INTEGER DEFAULT 0;

    DECLARE c_accounts CURSOR FOR
        SELECT account_id, balance FROM accounts WHERE status = 'ACTIVE';

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

    OPEN c_accounts;

    fetch_loop: LOOP
        FETCH c_accounts INTO v_id, v_balance;
        IF v_done = 1 THEN
            LEAVE fetch_loop;
        END IF;

        -- process each account
        CALL process_single_account(v_id, v_balance);
    END LOOP;

    CLOSE c_accounts;
END;
```

```sql
-- T-SQL: cursor equivalent
CREATE OR ALTER PROCEDURE schema.process_all_accounts
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @v_id INT;
    DECLARE @v_balance DECIMAL(15,2);

    DECLARE c_accounts CURSOR LOCAL FAST_FORWARD FOR
        SELECT account_id, balance FROM accounts WHERE status = 'ACTIVE';

    OPEN c_accounts;

    FETCH NEXT FROM c_accounts INTO @v_id, @v_balance;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- process each account
        EXEC process_single_account @v_id, @v_balance;

        FETCH NEXT FROM c_accounts INTO @v_id, @v_balance;
    END;

    CLOSE c_accounts;
    DEALLOCATE c_accounts;
END;
```

**Key differences:**

| Aspect                | Db2                                      | T-SQL                                        |
| --------------------- | ---------------------------------------- | -------------------------------------------- |
| End-of-data detection | `DECLARE CONTINUE HANDLER FOR NOT FOUND` | `@@FETCH_STATUS = 0`                         |
| Loop construct        | `LOOP...END LOOP` with `LEAVE`           | `WHILE @@FETCH_STATUS = 0`                   |
| FETCH syntax          | `FETCH cursor INTO vars`                 | `FETCH NEXT FROM cursor INTO @vars`          |
| Cleanup               | `CLOSE`                                  | `CLOSE` + `DEALLOCATE` (T-SQL requires both) |
| Performance hint      | Default                                  | `LOCAL FAST_FORWARD` recommended             |

### Cursor WITH RETURN (result set return)

```sql
-- Db2: cursor WITH RETURN returns result set to caller
CREATE PROCEDURE schema.get_active_accounts()
LANGUAGE SQL
DYNAMIC RESULT SETS 1
BEGIN
    DECLARE c_result CURSOR WITH RETURN FOR
        SELECT account_id, name, balance
        FROM accounts
        WHERE status = 'ACTIVE';

    OPEN c_result;
    -- cursor is returned to caller; do NOT close
END;

-- T-SQL: simply SELECT (no cursor needed)
CREATE OR ALTER PROCEDURE schema.get_active_accounts
AS
BEGIN
    SET NOCOUNT ON;

    SELECT account_id, name, balance
    FROM accounts
    WHERE status = 'ACTIVE';
END;
```

T-SQL is simpler here -- any SELECT in a procedure implicitly returns a result set to the caller.

---

## 6. Control flow

### IF/ELSEIF/ELSE

```sql
-- Db2
IF v_status = 'A' THEN
    SET v_description = 'Active';
ELSEIF v_status = 'I' THEN
    SET v_description = 'Inactive';
ELSE
    SET v_description = 'Unknown';
END IF;

-- T-SQL
IF @v_status = 'A'
    SET @v_description = 'Active';
ELSE IF @v_status = 'I'
    SET @v_description = 'Inactive';
ELSE
    SET @v_description = 'Unknown';
```

### CASE in procedural code

```sql
-- Db2: CASE used as a statement
CASE v_type
    WHEN 'CHECKING' THEN SET v_rate = 0.01;
    WHEN 'SAVINGS' THEN SET v_rate = 0.03;
    WHEN 'CD' THEN SET v_rate = 0.05;
    ELSE SET v_rate = 0.00;
END CASE;

-- T-SQL: CASE is only an expression, not a statement
SET @v_rate = CASE @v_type
    WHEN 'CHECKING' THEN 0.01
    WHEN 'SAVINGS' THEN 0.03
    WHEN 'CD' THEN 0.05
    ELSE 0.00
END;
```

### LOOP / WHILE / REPEAT

```sql
-- Db2: WHILE loop
WHILE v_counter < 10 DO
    SET v_counter = v_counter + 1;
END WHILE;

-- T-SQL: WHILE loop
WHILE @v_counter < 10
BEGIN
    SET @v_counter = @v_counter + 1;
END;
```

```sql
-- Db2: REPEAT...UNTIL
REPEAT
    SET v_counter = v_counter + 1;
    FETCH c_data INTO v_row;
UNTIL v_done = 1
END REPEAT;

-- T-SQL: use WHILE with break
WHILE 1 = 1
BEGIN
    SET @v_counter = @v_counter + 1;
    FETCH NEXT FROM c_data INTO @v_row;
    IF @@FETCH_STATUS <> 0
        BREAK;
END;
```

```sql
-- Db2: labeled LOOP with LEAVE and ITERATE
process_loop: LOOP
    FETCH c_data INTO v_id, v_amount;
    IF v_done = 1 THEN
        LEAVE process_loop;
    END IF;
    IF v_amount <= 0 THEN
        ITERATE process_loop;  -- skip to next iteration
    END IF;
    -- process row
END LOOP;

-- T-SQL: WHILE with CONTINUE and BREAK
FETCH NEXT FROM c_data INTO @v_id, @v_amount;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF @v_amount <= 0
    BEGIN
        FETCH NEXT FROM c_data INTO @v_id, @v_amount;
        CONTINUE;  -- skip to next iteration
    END;
    -- process row
    FETCH NEXT FROM c_data INTO @v_id, @v_amount;
END;
```

---

## 7. Dynamic SQL

```sql
-- Db2: PREPARE and EXECUTE
CREATE PROCEDURE schema.dynamic_query(
    IN p_table VARCHAR(128),
    IN p_column VARCHAR(128),
    IN p_value VARCHAR(256)
)
LANGUAGE SQL
BEGIN
    DECLARE v_sql VARCHAR(1000);
    DECLARE v_stmt STATEMENT;
    DECLARE v_count INTEGER;

    SET v_sql = 'SELECT COUNT(*) FROM ' || p_table ||
                ' WHERE ' || p_column || ' = ?';

    PREPARE v_stmt FROM v_sql;
    EXECUTE v_stmt INTO v_count USING p_value;
END;

-- T-SQL: sp_executesql
CREATE OR ALTER PROCEDURE schema.dynamic_query
    @p_table NVARCHAR(128),
    @p_column NVARCHAR(128),
    @p_value NVARCHAR(256)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @v_sql NVARCHAR(1000);
    DECLARE @v_count INT;

    SET @v_sql = N'SELECT @cnt = COUNT(*) FROM ' +
                 QUOTENAME(@p_table) +
                 N' WHERE ' + QUOTENAME(@p_column) + N' = @val';

    EXEC sp_executesql @v_sql,
        N'@cnt INT OUTPUT, @val NVARCHAR(256)',
        @cnt = @v_count OUTPUT,
        @val = @p_value;
END;
```

**Critical note:** Use `QUOTENAME()` in T-SQL to prevent SQL injection when building dynamic SQL with table/column names. Db2 does not have an equivalent function -- the parameterized `USING` clause handles values but not identifiers.

---

## 8. Db2 built-in functions to T-SQL equivalents

| Db2 function                    | T-SQL equivalent                                    | Notes                                        |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `DAYS(date)`                    | `DATEDIFF(DAY, '0001-01-01', date)`                 | Db2 DAYS returns absolute day number         |
| `MONTHS_BETWEEN(d1, d2)`        | `DATEDIFF(MONTH, d2, d1)`                           | Argument order differs                       |
| `DAYOFWEEK(date)`               | `DATEPART(WEEKDAY, date)`                           | Db2: 1=Sunday; T-SQL: depends on @@DATEFIRST |
| `DAYOFYEAR(date)`               | `DATEPART(DAYOFYEAR, date)`                         | 1:1                                          |
| `WEEK(date)`                    | `DATEPART(WEEK, date)`                              | Week numbering may differ                    |
| `MIDNIGHT_SECONDS(time)`        | `DATEDIFF(SECOND, '00:00:00', time)`                | Seconds since midnight                       |
| `JULIAN_DAY(date)`              | Custom calculation                                  | No built-in Julian day function              |
| `POSSTR(string, search)`        | `CHARINDEX(search, string)`                         | Argument order reversed                      |
| `LOCATE(search, string, start)` | `CHARINDEX(search, string, start)`                  | Argument order differs                       |
| `STRIP(string)`                 | `TRIM(string)`                                      | SQL Server 2017+                             |
| `DIGITS(number)`                | `RIGHT(REPLICATE('0',n)+CAST(number AS VARCHAR),n)` | Zero-padded number to string                 |
| `HEX(value)`                    | `CONVERT(VARCHAR, value, 2)`                        | Hexadecimal conversion                       |
| `RAISE_ERROR(state, msg)`       | `RAISERROR(msg, 16, 1)` or `THROW`                  | Error raising                                |
| `IDENTITY_VAL_LOCAL()`          | `SCOPE_IDENTITY()`                                  | Last identity value in scope                 |
| `VALUE(a, b)`                   | `ISNULL(a, b)` or `COALESCE(a, b)`                  | Null substitution                            |
| `DECRYPT_CHAR(data, pwd)`       | `DecryptByPassPhrase(pwd, data)`                    | Column decryption                            |
| `ENCRYPT(data, pwd)`            | `EncryptByPassPhrase(pwd, data)`                    | Column encryption                            |
| `GENERATE_UNIQUE()`             | `NEWID()`                                           | Unique value generation                      |
| `TABLESAMPLE`                   | `TABLESAMPLE`                                       | Same syntax in both                          |

---

## 9. Trigger conversion

### BEFORE trigger to INSTEAD OF trigger

```sql
-- Db2: BEFORE INSERT trigger (validation)
CREATE TRIGGER schema.trg_validate_account
BEFORE INSERT ON accounts
REFERENCING NEW AS n
FOR EACH ROW
BEGIN ATOMIC
    IF n.balance < 0 THEN
        SIGNAL SQLSTATE '75001'
            SET MESSAGE_TEXT = 'Balance cannot be negative';
    END IF;
    SET n.created_date = CURRENT DATE;
END;

-- T-SQL: INSTEAD OF trigger (BEFORE not available)
CREATE OR ALTER TRIGGER schema.trg_validate_account
ON accounts
INSTEAD OF INSERT
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (SELECT 1 FROM inserted WHERE balance < 0)
    BEGIN
        THROW 75001, 'Balance cannot be negative', 1;
        RETURN;
    END;

    INSERT INTO accounts (account_id, name, balance, created_date)
    SELECT account_id, name, balance, CAST(GETDATE() AS DATE)
    FROM inserted;
END;
```

**Important:** INSTEAD OF triggers must perform the actual INSERT/UPDATE/DELETE operation. The trigger replaces the original DML statement entirely.

---

## 10. Function conversion

```sql
-- Db2: scalar function
CREATE FUNCTION schema.calc_age(p_birth_date DATE)
RETURNS INTEGER
LANGUAGE SQL
DETERMINISTIC
NO EXTERNAL ACTION
RETURN YEAR(CURRENT DATE) - YEAR(p_birth_date) -
    CASE WHEN MONTH(CURRENT DATE) * 100 + DAY(CURRENT DATE) <
              MONTH(p_birth_date) * 100 + DAY(p_birth_date)
         THEN 1 ELSE 0 END;

-- T-SQL: scalar function
CREATE OR ALTER FUNCTION schema.calc_age(@p_birth_date DATE)
RETURNS INT
AS
BEGIN
    RETURN DATEDIFF(YEAR, @p_birth_date, GETDATE()) -
        CASE WHEN DATEADD(YEAR, DATEDIFF(YEAR, @p_birth_date, GETDATE()),
                          @p_birth_date) > GETDATE()
             THEN 1 ELSE 0 END;
END;
```

---

## 11. Conversion checklist

- [ ] All `DECLARE HANDLER` blocks converted to TRY/CATCH
- [ ] All `SIGNAL` / `RESIGNAL` converted to `THROW` / `RAISERROR`
- [ ] All cursors have `DEALLOCATE` added after `CLOSE`
- [ ] All `FETCH cursor INTO` changed to `FETCH NEXT FROM cursor INTO @`
- [ ] All cursor WITH RETURN procedures simplified to SELECT statements
- [ ] All `LOOP...END LOOP` converted to `WHILE` loops
- [ ] All `LEAVE label` converted to `BREAK`
- [ ] All `ITERATE label` converted to `CONTINUE`
- [ ] All Db2 built-in functions mapped to T-SQL equivalents
- [ ] All BEFORE triggers converted to INSTEAD OF triggers
- [ ] All dynamic SQL using `PREPARE/EXECUTE` converted to `sp_executesql`
- [ ] All parameter names prefixed with `@`
- [ ] All variable names prefixed with `@`
- [ ] `SET NOCOUNT ON` added to all procedures
- [ ] `CURRENT DATE/TIME/TIMESTAMP` replaced with T-SQL equivalents
- [ ] Unit tests created for converted procedures

---

## Related resources

- [Schema Migration](schema-migration.md) -- data type and SQL syntax conversion
- [Feature Mapping](feature-mapping-complete.md) -- comprehensive feature comparison
- [Application Migration](application-migration.md) -- JDBC/ODBC and connection changes
- [Tutorial: SSMA Migration](tutorial-ssma-migration.md) -- SSMA automates initial conversion

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
