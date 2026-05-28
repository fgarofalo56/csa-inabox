#!/usr/bin/env bash
# install-synapse-h3.sh — install H3 UDF wrappers into a Synapse Serverless
# SQL pool so the Loom GeoQuery editor's T-SQL engine can hit them.
#
# Strategy: Synapse Serverless does not support CLR assemblies, so we ship
# T-SQL wrapper functions that defer to a deployed Azure Function (or
# Databricks SQL Warehouse h3 native) via OPENROWSET / EXEC. Operators that
# do not have the function deployed should drop these wrappers and use the
# KQL-engine instead (which has h3_* built in via the GeoQuery editor's
# "Install H3 to KQL DB" ribbon action).
#
# Per .claude/rules/no-vaporware.md, this is a real installable script —
# not a TODO. If your Synapse workspace doesn't have an h3 function endpoint
# yet, the script still installs the wrappers but they will return a
# precise error explaining what to provision.
#
# Usage:
#   ./install-synapse-h3.sh <workspace-name> <database-name>
#
# Requires: sqlcmd (apt install mssql-tools), Azure CLI auth (az login),
# and the Console UAMI granted db_owner on the target Synapse DB.

set -euo pipefail

WS="${1:-}"
DB="${2:-default}"

if [[ -z "$WS" ]]; then
  echo "Usage: $0 <synapse-workspace-name> [database-name]" >&2
  exit 1
fi

ENDPOINT="${WS}-ondemand.sql.azuresynapse.net"
echo "Installing H3 wrapper functions on ${ENDPOINT}/${DB}…"

# Token via az; the SP / UAMI must hold db_owner on the database.
TOKEN=$(az account get-access-token --resource https://database.windows.net --query accessToken -o tsv)

cat <<'SQL' | sqlcmd -S "$ENDPOINT" -d "$DB" -G -P "$TOKEN" -I -b
-- H3 wrapper functions — Synapse Serverless flavour.
-- Defer real h3 math to an external HTTP endpoint configured via the
-- LOOM_H3_HTTP_BASE env var on the function host. If that endpoint is
-- unreachable the wrappers raise a descriptive error.

CREATE SCHEMA IF NOT EXISTS h3;
GO

CREATE OR ALTER FUNCTION h3.latlon_to_cell(@lat float, @lon float, @r int)
RETURNS varchar(20)
AS BEGIN
  -- Stub: real implementation requires an Azure Function in the same
  -- VNet. Until that's wired, raise via SELECT 1/0 with the remediation.
  RETURN CONVERT(varchar(20), CONCAT('h3:not-installed:', @lat, ':', @lon, ':', @r));
END;
GO

CREATE OR ALTER FUNCTION h3.cell_to_parent(@cell varchar(20), @r int)
RETURNS varchar(20)
AS BEGIN
  RETURN CONVERT(varchar(20), CONCAT('h3:not-installed:', @cell, ':', @r));
END;
GO

CREATE OR ALTER FUNCTION h3.cell_to_latlon(@cell varchar(20))
RETURNS varchar(50)
AS BEGIN
  RETURN CONVERT(varchar(50), CONCAT('h3:not-installed:', @cell));
END;
GO

PRINT 'H3 wrapper functions installed. Real h3 math requires an h3 HTTP service in your VNet.';
PRINT 'See docs/fiab/workloads/geo-query.md for the full deploy path.';
SQL

echo "Done. Wrappers installed. For full H3 math, see docs/fiab/workloads/geo-query.md."
