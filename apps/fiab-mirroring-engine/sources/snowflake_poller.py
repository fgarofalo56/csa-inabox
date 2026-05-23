"""CSA Loom Mirroring — Snowflake source via Streams + Tasks.

Snowflake has no Debezium connector. Strategy: enable a STREAM on the
source table, run a periodic TASK that flushes the stream's CDC
records into a staged Parquet file in the customer's S3/Blob, and
have the Loom replicator's Open Mirroring landing-zone path pick it
up. This module generates the SQL that the operator runs in Snowflake;
the replicator side requires no changes.

Operational expectations (documented openly per AMENDMENTS A10):
- The polling cadence (default 5 minutes) is the floor on freshness.
- Schema drift is detected only on each poll; production hardening
  adds an `INFORMATION_SCHEMA` poll job.
"""

from __future__ import annotations

import textwrap
from dataclasses import dataclass


@dataclass
class SnowflakeMirrorSpec:
    database: str
    schema: str
    table: str
    stage_name: str
    azure_storage_account: str
    azure_landing_zone_path: str
    poll_minutes: int = 5


def generate_setup_sql(spec: SnowflakeMirrorSpec) -> str:
    """Generate the Snowflake SQL the operator runs once per mirror.

    Creates:
      - CDC stream on the source table
      - External stage pointing at the Loom landing-zone container
      - Task that runs every `poll_minutes` and copies CDC records out
        as Parquet with __rowMarker__ derived from METADATA$ACTION.
    """
    fully_qualified = f"{spec.database}.{spec.schema}.{spec.table}"
    stream_name = f"{spec.table}_cdc_stream"
    task_name = f"{spec.table}_cdc_flush"

    return textwrap.dedent(f"""
    -- CSA Loom mirror setup for {fully_qualified}
    USE DATABASE {spec.database};
    USE SCHEMA {spec.schema};

    -- 1. Stream tracks INSERT/UPDATE/DELETE on the source table.
    --    APPEND_ONLY=FALSE captures all DML.
    CREATE OR REPLACE STREAM {stream_name}
      ON TABLE {fully_qualified}
      APPEND_ONLY = FALSE
      COMMENT = 'CSA Loom CDC stream — flushed every {spec.poll_minutes}m to landing zone';

    -- 2. External stage pointing at the Loom landing-zone container.
    --    Uses STORAGE INTEGRATION with the Azure tenant — operator
    --    creates the integration separately (one-time).
    CREATE OR REPLACE STAGE {spec.stage_name}
      URL = 'azure://{spec.azure_storage_account}.blob.core.windows.net/landing-zone/{spec.azure_landing_zone_path}/'
      STORAGE_INTEGRATION = csa_loom_azure_integration
      FILE_FORMAT = (TYPE = PARQUET);

    -- 3. Task: every poll interval, copy stream contents to stage as
    --    Parquet with __rowMarker__ derived from METADATA$ACTION.
    CREATE OR REPLACE TASK {task_name}
      WAREHOUSE = csa_loom_mirror_wh
      SCHEDULE = '{spec.poll_minutes} MINUTE'
      WHEN SYSTEM$STREAM_HAS_DATA('{stream_name}')
    AS
      COPY INTO @{spec.stage_name}/data_$(TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDDHHMISSFF6')).parquet
      FROM (
        SELECT
          *,
          CASE METADATA$ACTION
            WHEN 'INSERT' THEN 1
            WHEN 'UPDATE' THEN 2
            WHEN 'DELETE' THEN 3
          END AS __rowMarker__,
          METADATA$ROW_ID AS __snowflake_row_id,
          CURRENT_TIMESTAMP() AS __snowflake_change_time
        FROM {stream_name}
      )
      FILE_FORMAT = (TYPE = PARQUET COMPRESSION = SNAPPY)
      OVERWRITE = FALSE;

    -- 4. Start the task.
    ALTER TASK {task_name} RESUME;

    -- 5. Verify.
    SHOW TASKS LIKE '{task_name}';
    SHOW STREAMS LIKE '{stream_name}';
    """).strip()


def generate_metadata_json(spec: SnowflakeMirrorSpec, key_columns: list[str]) -> dict:
    """Companion _metadata.json the operator writes into the landing zone."""
    return {
        "keyColumns": key_columns,
        "protocolVersion": "1.0",
        "publisher": f"csa-loom-snowflake-poller@{spec.database}.{spec.schema}.{spec.table}",
        "publisherCadenceSeconds": spec.poll_minutes * 60,
    }


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 4:
        print("usage: snowflake_poller.py <database> <schema> <table> <storage-account> <landing-zone-path>")
        sys.exit(1)
    spec = SnowflakeMirrorSpec(
        database=sys.argv[1],
        schema=sys.argv[2],
        table=sys.argv[3],
        stage_name=f"loom_{sys.argv[3]}_stage",
        azure_storage_account=sys.argv[4],
        azure_landing_zone_path=sys.argv[5],
    )
    print("-- SQL to run in Snowflake --")
    print(generate_setup_sql(spec))
    print()
    print("-- _metadata.json --")
    print(json.dumps(generate_metadata_json(spec, key_columns=["id"]), indent=2))
