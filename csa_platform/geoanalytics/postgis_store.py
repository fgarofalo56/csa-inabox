"""
PostGIS integration module for CSA-in-a-Box GeoAnalytics.

Provides PostgreSQL/PostGIS database connectivity for storing and querying
geospatial data with spatial indexes and advanced SQL capabilities.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

import geopandas as gpd
import pandas as pd
from azure.identity import DefaultAzureCredential
from geoalchemy2 import Geometry, Geography
from sqlalchemy import create_engine, text, MetaData, Table, Column, Integer, String, Float, DateTime
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

logger = logging.getLogger(__name__)


@dataclass
class PostGISConfig:
    """Configuration for PostGIS database connection."""

    host: str
    database: str
    username: Optional[str] = None
    password: Optional[str] = None
    port: int = 5432
    sslmode: str = "require"
    use_azure_identity: bool = False
    connection_timeout: int = 30
    pool_size: int = 5
    max_overflow: int = 10


class PostGISStore:
    """PostgreSQL/PostGIS database interface for geospatial data storage and querying."""

    def __init__(self, config: PostGISConfig):
        """Initialize PostGIS store with configuration.

        Args:
            config: PostGIS configuration object
        """
        self.config = config
        self._engine: Optional[Engine] = None
        self._session_factory = None

    def _get_connection_string(self) -> str:
        """Build PostgreSQL connection string from configuration."""
        if self.config.use_azure_identity:
            # Use Azure managed identity for authentication
            credential = DefaultAzureCredential()
            token = credential.get_token("https://ossrdbms-aad.database.windows.net/.default")
            password = token.token
            username = self.config.username or "azure_user"
        else:
            username = self.config.username
            password = self.config.password

        if not username or not password:
            raise ValueError("Username and password required for PostGIS connection")

        conn_str = (
            f"postgresql://{username}:{password}@{self.config.host}:{self.config.port}"
            f"/{self.config.database}?sslmode={self.config.sslmode}"
        )

        return conn_str

    def _get_engine(self) -> Engine:
        """Get SQLAlchemy engine with connection pooling."""
        if self._engine is None:
            conn_str = self._get_connection_string()

            self._engine = create_engine(
                conn_str,
                pool_size=self.config.pool_size,
                max_overflow=self.config.max_overflow,
                pool_timeout=self.config.connection_timeout,
                pool_pre_ping=True,  # Verify connections before use
                echo=False  # Set to True for SQL debugging
            )

            # Create session factory
            self._session_factory = sessionmaker(bind=self._engine)

            logger.info(f"Connected to PostGIS database at {self.config.host}")

        return self._engine

    def test_connection(self) -> bool:
        """Test database connection and PostGIS availability.

        Returns:
            True if connection successful and PostGIS is available
        """
        try:
            engine = self._get_engine()
            with engine.connect() as conn:
                # Test basic connection
                result = conn.execute(text("SELECT version()"))
                postgres_version = result.fetchone()[0]
                logger.info(f"PostgreSQL version: {postgres_version}")

                # Test PostGIS extension
                result = conn.execute(text("SELECT PostGIS_Version()"))
                postgis_version = result.fetchone()[0]
                logger.info(f"PostGIS version: {postgis_version}")

                return True

        except Exception as e:
            logger.error(f"Database connection failed: {e}")
            return False

    def write_geodata(
        self,
        gdf: gpd.GeoDataFrame,
        table_name: str,
        schema: str = "public",
        if_exists: str = "replace",
        geometry_type: str = "geometry",
        srid: int = 4326,
        create_spatial_index: bool = True,
        **kwargs
    ) -> None:
        """Write GeoDataFrame to PostGIS table.

        Args:
            gdf: GeoDataFrame to write
            table_name: Target table name
            schema: Database schema name
            if_exists: How to behave if table exists ('fail', 'replace', 'append')
            geometry_type: PostGIS geometry type ('geometry' or 'geography')
            srid: Spatial reference system identifier
            create_spatial_index: Whether to create spatial index
            **kwargs: Additional arguments for to_postgis()
        """
        if gdf.empty:
            logger.warning("Empty GeoDataFrame provided, skipping write")
            return

        # Ensure CRS is set and matches SRID
        if gdf.crs is None:
            logger.warning(f"No CRS found, setting to EPSG:{srid}")
            gdf = gdf.set_crs(f"EPSG:{srid}")
        elif gdf.crs.to_epsg() != srid:
            logger.info(f"Reprojecting from {gdf.crs} to EPSG:{srid}")
            gdf = gdf.to_crs(f"EPSG:{srid}")

        engine = self._get_engine()

        try:
            # Write to PostGIS
            logger.info(f"Writing {len(gdf)} features to {schema}.{table_name}")

            gdf.to_postgis(
                name=table_name,
                con=engine,
                schema=schema,
                if_exists=if_exists,
                index=False,
                **kwargs
            )

            # Create spatial index if requested
            if create_spatial_index:
                self.create_spatial_index(table_name, schema=schema)

            logger.info(f"Successfully wrote data to {schema}.{table_name}")

        except Exception as e:
            logger.error(f"Failed to write geodata to PostGIS: {e}")
            raise

    def read_geodata(
        self,
        table_name: str,
        schema: str = "public",
        geometry_col: str = "geometry",
        where_clause: Optional[str] = None,
        columns: Optional[List[str]] = None,
        limit: Optional[int] = None,
        **kwargs
    ) -> gpd.GeoDataFrame:
        """Read GeoDataFrame from PostGIS table.

        Args:
            table_name: Source table name
            schema: Database schema name
            geometry_col: Name of geometry column
            where_clause: SQL WHERE clause (without WHERE keyword)
            columns: List of columns to select (None for all)
            limit: Maximum number of rows to return
            **kwargs: Additional arguments for read_postgis()

        Returns:
            GeoDataFrame with spatial data
        """
        engine = self._get_engine()

        # Build SQL query
        if columns:
            cols = ", ".join(columns)
        else:
            cols = "*"

        sql = f"SELECT {cols} FROM {schema}.{table_name}"

        if where_clause:
            sql += f" WHERE {where_clause}"

        if limit:
            sql += f" LIMIT {limit}"

        try:
            logger.info(f"Reading data from {schema}.{table_name}")

            gdf = gpd.read_postgis(
                sql=sql,
                con=engine,
                geom_col=geometry_col,
                **kwargs
            )

            logger.info(f"Read {len(gdf)} features from {schema}.{table_name}")
            return gdf

        except Exception as e:
            logger.error(f"Failed to read geodata from PostGIS: {e}")
            raise

    def spatial_query(
        self,
        sql: str,
        geometry_col: str = "geometry",
        params: Optional[Dict[str, Any]] = None
    ) -> gpd.GeoDataFrame:
        """Execute spatial SQL query and return GeoDataFrame.

        Args:
            sql: SQL query string
            geometry_col: Name of geometry column in results
            params: Query parameters for safe parameterization

        Returns:
            GeoDataFrame with query results
        """
        engine = self._get_engine()

        try:
            logger.info("Executing spatial query")

            gdf = gpd.read_postgis(
                sql=sql,
                con=engine,
                geom_col=geometry_col,
                params=params
            )

            logger.info(f"Query returned {len(gdf)} features")
            return gdf

        except Exception as e:
            logger.error(f"Spatial query failed: {e}")
            raise

    def create_spatial_index(
        self,
        table_name: str,
        schema: str = "public",
        geometry_col: str = "geometry",
        index_method: str = "GIST"
    ) -> None:
        """Create spatial index on geometry column.

        Args:
            table_name: Table name
            schema: Schema name
            geometry_col: Geometry column name
            index_method: Index method ('GIST' or 'SP-GIST')
        """
        engine = self._get_engine()
        index_name = f"idx_{table_name}_{geometry_col}"

        sql = f"""
        CREATE INDEX IF NOT EXISTS {index_name}
        ON {schema}.{table_name}
        USING {index_method} ({geometry_col})
        """

        try:
            with engine.connect() as conn:
                conn.execute(text(sql))
                conn.commit()

            logger.info(f"Created spatial index {index_name} on {schema}.{table_name}")

        except Exception as e:
            logger.error(f"Failed to create spatial index: {e}")
            raise

    def analyze_table_stats(self, table_name: str, schema: str = "public") -> Dict[str, Any]:
        """Get table statistics including spatial extents.

        Args:
            table_name: Table name
            schema: Schema name

        Returns:
            Dictionary with table statistics
        """
        engine = self._get_engine()

        sql = f"""
        WITH stats AS (
            SELECT
                COUNT(*) as row_count,
                ST_Extent(geometry) as extent,
                ST_Area(ST_Extent(geometry)) as extent_area,
                pg_size_pretty(pg_total_relation_size('{schema}.{table_name}')) as table_size
            FROM {schema}.{table_name}
            WHERE geometry IS NOT NULL
        )
        SELECT * FROM stats
        """

        try:
            with engine.connect() as conn:
                result = conn.execute(text(sql))
                row = result.fetchone()

                if row:
                    return {
                        "row_count": row[0],
                        "spatial_extent": str(row[1]),
                        "extent_area": float(row[2]) if row[2] else 0,
                        "table_size": row[3]
                    }
                else:
                    return {}

        except Exception as e:
            logger.error(f"Failed to analyze table stats: {e}")
            return {}

    def execute_spatial_function(
        self,
        function_name: str,
        params: List[Any],
        return_geometry: bool = True
    ) -> Union[gpd.GeoDataFrame, pd.DataFrame]:
        """Execute PostGIS spatial function.

        Args:
            function_name: PostGIS function name (e.g., 'ST_Buffer')
            params: Function parameters
            return_geometry: Whether result contains geometry

        Returns:
            DataFrame or GeoDataFrame with function results
        """
        engine = self._get_engine()
        param_placeholders = ", ".join([f"${i+1}" for i in range(len(params))])
        sql = f"SELECT {function_name}({param_placeholders}) as result"

        try:
            if return_geometry:
                gdf = gpd.read_postgis(
                    sql=sql,
                    con=engine,
                    geom_col="result",
                    params=params
                )
                return gdf
            else:
                with engine.connect() as conn:
                    result = conn.execute(text(sql), params)
                    data = result.fetchall()
                    return pd.DataFrame(data, columns=["result"])

        except Exception as e:
            logger.error(f"Failed to execute spatial function {function_name}: {e}")
            raise

    def create_table_from_geodataframe(
        self,
        gdf: gpd.GeoDataFrame,
        table_name: str,
        schema: str = "public",
        geometry_type: str = "geometry",
        srid: int = 4326,
        primary_key: Optional[str] = None
    ) -> None:
        """Create table structure matching GeoDataFrame schema.

        Args:
            gdf: GeoDataFrame to match
            table_name: Table name to create
            schema: Schema name
            geometry_type: Geometry column type
            srid: Spatial reference system ID
            primary_key: Primary key column name
        """
        engine = self._get_engine()
        metadata = MetaData()

        # Build column definitions
        columns = []

        if primary_key:
            columns.append(Column(primary_key, Integer, primary_key=True, autoincrement=True))

        for col_name, dtype in gdf.dtypes.items():
            if col_name == 'geometry':
                continue

            # Map pandas dtypes to SQL types
            if pd.api.types.is_integer_dtype(dtype):
                sql_type = Integer
            elif pd.api.types.is_float_dtype(dtype):
                sql_type = Float
            else:
                sql_type = String(255)

            columns.append(Column(col_name, sql_type))

        # Add geometry column
        if geometry_type == "geography":
            geom_col = Column("geometry", Geography('GEOMETRY', srid=srid))
        else:
            geom_col = Column("geometry", Geometry('GEOMETRY', srid=srid))

        columns.append(geom_col)

        # Create table
        table = Table(table_name, metadata, *columns, schema=schema)

        try:
            metadata.create_all(engine, tables=[table])
            logger.info(f"Created table {schema}.{table_name}")

        except Exception as e:
            logger.error(f"Failed to create table: {e}")
            raise

    def drop_table(self, table_name: str, schema: str = "public") -> None:
        """Drop table if it exists.

        Args:
            table_name: Table name to drop
            schema: Schema name
        """
        engine = self._get_engine()
        sql = f"DROP TABLE IF EXISTS {schema}.{table_name}"

        try:
            with engine.connect() as conn:
                conn.execute(text(sql))
                conn.commit()

            logger.info(f"Dropped table {schema}.{table_name}")

        except Exception as e:
            logger.error(f"Failed to drop table: {e}")
            raise

    def list_tables(self, schema: str = "public") -> List[str]:
        """List tables in schema.

        Args:
            schema: Schema name

        Returns:
            List of table names
        """
        engine = self._get_engine()
        sql = """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = %s AND table_type = 'BASE TABLE'
        ORDER BY table_name
        """

        try:
            with engine.connect() as conn:
                result = conn.execute(text(sql), (schema,))
                tables = [row[0] for row in result]

            logger.info(f"Found {len(tables)} tables in schema {schema}")
            return tables

        except Exception as e:
            logger.error(f"Failed to list tables: {e}")
            return []

    def close_connections(self) -> None:
        """Close all database connections."""
        if self._engine:
            self._engine.dispose()
            self._engine = None
            self._session_factory = None
            logger.info("Closed PostGIS connections")
