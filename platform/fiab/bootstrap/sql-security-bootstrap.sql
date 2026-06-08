-- =====================================================================
-- sql-security-bootstrap.sql — one-time per-database bootstrap for the
-- SQL granular-security wizards (F11: object/column GRANT, RLS, DDM).
--
-- WHY: the Loom Console wizards execute security DDL (GRANT, CREATE
-- SECURITY POLICY, ALTER COLUMN ... ADD MASKED) over a TDS connection
-- authenticated as the Console user-assigned managed identity (UAMI),
-- using a Microsoft Entra access token ONLY (no SQL auth). To run that
-- DDL the UAMI must be a db_owner contained user in each target database.
--
-- The UAMI is already the workspace/server Microsoft Entra admin (see
-- platform/fiab/bicep/modules/landing-zone/synapse.bicep `consoleAadAdmin`
-- and the azure-sql `administrators/ActiveDirectory` ARM mapping), which
-- gives it server-level admin. This script promotes it to db_owner inside
-- each USER database so the per-database security DDL succeeds. db_owner
-- covers everything the wizards need:
--   - ALTER ANY MASK            (Dynamic Data Masking)
--   - ALTER ANY SECURITY POLICY (Row-Level Security)
--   - CONTROL / GRANT-forwarding (object + column GRANT)
--   - SELECT on the sys.* catalog views the state panel reads
--
-- RUN: once per user database, at first deploy (and whenever a new user
-- database is created). Connect AS the Entra admin and execute:
--
--   sqlcmd -G -S <server>.database.windows.net -d <db> \
--     -v LOOM_CONSOLE_UAMI_NAME="<uami-name>" \
--     -i platform/fiab/bootstrap/sql-security-bootstrap.sql
--
-- LOOM_CONSOLE_UAMI_NAME must equal `consoleUamiName` in synapse.bicep
-- (e.g. uami-loom-console-<region>), i.e. the UAMI's display name.
--
-- NOTE: in `master` (serverless) the contained-user step is skipped — the
-- UAMI authenticates against master as the Entra admin already, and the
-- serverless databases are logical OPENROWSET endpoints.
-- =====================================================================

IF DB_NAME() <> N'master'
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$(LOOM_CONSOLE_UAMI_NAME)')
        EXEC ('CREATE USER [$(LOOM_CONSOLE_UAMI_NAME)] FROM EXTERNAL PROVIDER;');

    -- db_owner is the smallest built-in role that covers ALTER ANY MASK +
    -- ALTER ANY SECURITY POLICY + GRANT-forwarding in one grant.
    EXEC sp_addrolemember N'db_owner', N'$(LOOM_CONSOLE_UAMI_NAME)';
END
GO
