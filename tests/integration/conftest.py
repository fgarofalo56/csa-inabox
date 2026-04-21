"""Shared fixtures for end-to-end integration tests.

All fixtures use an in-memory DuckDB instance so the test suite can run
offline (``make test-e2e``) without any Azure resources.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
import yaml

if TYPE_CHECKING:
    from collections.abc import Generator

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SEED_DIR = Path(__file__).resolve().parent / "seed_data"
_DBT_PROJECT_DIR = _REPO_ROOT / "domains" / "shared" / "dbt"
_CONTRACT_DIR = _REPO_ROOT / "domains"

# ---------------------------------------------------------------------------
# pytest markers
# ---------------------------------------------------------------------------


def pytest_configure(config: Any) -> None:
    """Register custom markers so ``--strict-markers`` does not fail."""
    config.addinivalue_line("markers", "live: requires a live Azure connection")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def repo_root() -> Path:
    """Absolute path to the repository root."""
    return _REPO_ROOT


@pytest.fixture(scope="session")
def seed_data_path() -> Path:
    """Absolute path to tests/integration/seed_data/."""
    return _SEED_DIR


@pytest.fixture(scope="session")
def dbt_project_dir() -> Path:
    """Absolute path to domains/shared/dbt/."""
    return _DBT_PROJECT_DIR


@pytest.fixture(scope="session")
def contract_paths() -> list[Path]:
    """Return every ``contract.yaml`` under ``domains/*/data-products/``."""
    return sorted(_CONTRACT_DIR.glob("*/data-products/**/contract.yaml"))


@pytest.fixture(scope="session")
def contract_schemas(contract_paths: list[Path]) -> dict[str, dict[str, Any]]:
    """Load all contract YAML files keyed by ``metadata.name``.

    Returns a mapping like::

        {
            "sales.orders": { <full parsed YAML dict> },
            "shared.customers": { ... },
        }
    """
    schemas: dict[str, dict[str, Any]] = {}
    for path in contract_paths:
        with open(path) as fh:
            data = yaml.safe_load(fh)
        if isinstance(data, dict) and "metadata" in data:
            name = data["metadata"]["name"]
            schemas[name] = data
    return schemas


@pytest.fixture(scope="session")
def duckdb_conn() -> Generator[Any, None, None]:
    """Create an in-memory DuckDB connection with seed data loaded.

    Tables created:

    - ``bronze.customers``  (from seed_data/customers.csv)
    - ``bronze.orders``     (from seed_data/orders.csv)
    - ``bronze.products``   (from seed_data/products.csv)

    Silver and Gold tables are derived from Bronze via simplified SQL
    that mirrors the dbt medallion architecture.
    """
    try:
        import duckdb
    except ImportError:
        pytest.skip("duckdb not installed — run: pip install duckdb")

    conn = duckdb.connect(":memory:")

    # --- Create schemas ---
    conn.execute("CREATE SCHEMA IF NOT EXISTS bronze")
    conn.execute("CREATE SCHEMA IF NOT EXISTS silver")
    conn.execute("CREATE SCHEMA IF NOT EXISTS gold")

    # --- Load Bronze tables from seed CSVs ---
    _load_csv_to_table(conn, "bronze", "customers", _SEED_DIR / "customers.csv")
    _load_csv_to_table(conn, "bronze", "orders", _SEED_DIR / "orders.csv")
    _load_csv_to_table(conn, "bronze", "products", _SEED_DIR / "products.csv")

    # --- Build Silver tables (cleansed, typed, validated) ---
    conn.execute("""
        CREATE TABLE silver.customers AS
        SELECT
            md5(CAST(customer_id AS VARCHAR))  AS customer_sk,
            CAST(customer_id AS INTEGER)       AS customer_id,
            split_part(name, ' ', 1)           AS first_name,
            split_part(name, ' ', 2)           AS last_name,
            lower(email)                       AS email,
            region,
            segment,
            created_at,
            true                               AS is_valid,
            ''                                 AS validation_errors
        FROM bronze.customers
    """)

    conn.execute("""
        CREATE TABLE silver.orders AS
        SELECT
            md5(CAST(order_id AS VARCHAR))     AS order_sk,
            CAST(order_id AS INTEGER)          AS order_id,
            CAST(customer_id AS INTEGER)       AS customer_id,
            CAST(order_date AS DATE)           AS order_date,
            CAST(quantity * unit_price AS DECIMAL(18,2)) AS total_amount,
            upper(status)                      AS status,
            true                               AS is_valid,
            ''                                 AS validation_errors
        FROM bronze.orders
    """)

    conn.execute("""
        CREATE TABLE silver.products AS
        SELECT
            md5(CAST(product_id AS VARCHAR))   AS product_sk,
            CAST(product_id AS INTEGER)        AS product_id,
            name                               AS product_name,
            upper(category)                    AS category,
            CAST(list_price AS DECIMAL(18,2))  AS unit_price,
            true                               AS is_valid,
            ''                                 AS validation_errors
        FROM bronze.products
    """)

    # --- Build Gold tables ---
    conn.execute("""
        CREATE TABLE gold.dim_customers AS
        SELECT
            customer_sk,
            customer_id,
            first_name,
            last_name,
            CONCAT(first_name, ' ', last_name) AS full_name,
            email,
            region
        FROM silver.customers
        WHERE is_valid = true
    """)

    conn.execute("""
        CREATE TABLE gold.dim_products AS
        SELECT
            product_sk,
            product_id,
            product_name,
            category,
            unit_price,
            CASE
                WHEN unit_price >= 100 THEN 'premium'
                WHEN unit_price >= 50  THEN 'standard'
                WHEN unit_price >= 25  THEN 'value'
                ELSE 'economy'
            END AS price_tier
        FROM silver.products
        WHERE is_valid = true
    """)

    conn.execute("""
        CREATE TABLE gold.fact_orders AS
        SELECT
            o.order_sk,
            o.order_id,
            o.customer_id,
            c.customer_sk,
            o.order_date,
            o.total_amount,
            o.status AS order_status,
            EXTRACT(YEAR FROM o.order_date)    AS order_year,
            EXTRACT(MONTH FROM o.order_date)   AS order_month,
            EXTRACT(QUARTER FROM o.order_date) AS order_quarter
        FROM silver.orders o
        LEFT JOIN gold.dim_customers c ON o.customer_id = c.customer_id
        WHERE o.is_valid = true
    """)

    conn.execute("""
        CREATE TABLE gold.gld_customer_lifetime_value AS
        SELECT
            c.customer_id,
            c.first_name,
            c.last_name,
            c.region AS customer_segment,
            COALESCE(SUM(o.total_amount), 0) AS lifetime_revenue,
            COUNT(o.order_id) AS total_orders,
            CASE
                WHEN COALESCE(SUM(o.total_amount), 0) >= 500 THEN 'platinum'
                WHEN COALESCE(SUM(o.total_amount), 0) >= 200 THEN 'gold'
                WHEN COALESCE(SUM(o.total_amount), 0) >= 50  THEN 'silver'
                ELSE 'bronze'
            END AS value_tier
        FROM silver.customers c
        LEFT JOIN silver.orders o ON c.customer_id = o.customer_id
        WHERE c.is_valid = true
        GROUP BY c.customer_id, c.first_name, c.last_name, c.region
    """)

    conn.execute("""
        CREATE TABLE gold.gld_daily_order_metrics AS
        SELECT
            o.order_date,
            COUNT(DISTINCT o.order_id)         AS total_orders,
            SUM(o.total_amount)                AS total_revenue,
            AVG(o.total_amount)                AS avg_order_value,
            COUNT(CASE WHEN o.status = 'CANCELLED' THEN 1 END) * 100.0
                / NULLIF(COUNT(*), 0)          AS cancellation_rate_pct
        FROM silver.orders o
        WHERE o.is_valid = true
        GROUP BY o.order_date
    """)

    conn.execute("""
        CREATE TABLE gold.gld_monthly_revenue AS
        SELECT
            CONCAT(
                CAST(EXTRACT(YEAR FROM order_date) AS VARCHAR),
                '-',
                LPAD(CAST(EXTRACT(MONTH FROM order_date) AS VARCHAR), 2, '0')
            ) AS month_key,
            CAST(EXTRACT(YEAR FROM order_date) AS INTEGER) AS revenue_year,
            CAST(EXTRACT(MONTH FROM order_date) AS INTEGER) AS revenue_month,
            DATE_TRUNC('month', order_date)   AS revenue_period,
            SUM(total_amount)                 AS gross_revenue,
            SUM(CASE WHEN status NOT IN ('CANCELLED', 'RETURNED')
                     THEN total_amount ELSE 0 END) AS net_revenue,
            COUNT(DISTINCT order_id)           AS total_orders,
            COUNT(DISTINCT customer_id)        AS unique_customers,
            COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) * 100.0
                / NULLIF(COUNT(*), 0)          AS cancellation_rate_pct,
            COUNT(CASE WHEN status = 'RETURNED' THEN 1 END) * 100.0
                / NULLIF(COUNT(*), 0)          AS return_rate_pct
        FROM silver.orders
        WHERE is_valid = true
        GROUP BY
            EXTRACT(YEAR FROM order_date),
            EXTRACT(MONTH FROM order_date),
            DATE_TRUNC('month', order_date)
    """)

    yield conn

    conn.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_csv_to_table(
    conn: Any,
    schema: str,
    table: str,
    csv_path: Path,
) -> None:
    """Load a CSV file into a DuckDB table using ``read_csv_auto``."""
    conn.execute(f"CREATE TABLE {schema}.{table} AS SELECT * FROM read_csv_auto('{csv_path.as_posix()}')")
