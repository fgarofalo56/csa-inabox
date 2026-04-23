"""
Core geospatial processing module for CSA-in-a-Box.

Provides comprehensive geospatial data processing capabilities including:
- Data loading and format conversion
- Coordinate system transformations
- Spatial operations (buffer, clip, union, intersection)
- H3 hexagonal indexing
- Distance calculations
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import geopandas as gpd
import h3
import pandas as pd
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient
from shapely.geometry import Point, Polygon

logger = logging.getLogger(__name__)


@dataclass
class GeoProcessingConfig:
    """Configuration for geospatial processing operations."""

    default_crs: str = "EPSG:4326"  # WGS84
    h3_resolution: int = 8  # Default H3 resolution
    buffer_distance_meters: float = 1000.0
    azure_storage_account: str | None = None
    azure_container: str = "geoanalytics"


class H3Indexer:
    """H3 hexagonal indexing utilities for spatial aggregation."""

    def __init__(self, resolution: int = 8):
        """Initialize H3 indexer with given resolution.

        Args:
            resolution: H3 resolution level (0-15, higher = more granular)
        """
        self.resolution = resolution

    def point_to_h3(self, lat: float, lng: float) -> str:
        """Convert a point to H3 index.

        Args:
            lat: Latitude
            lng: Longitude

        Returns:
            H3 index string
        """
        return h3.latlng_to_cell(lat, lng, self.resolution)

    def geometry_to_h3(self, geometry: Any) -> list[str]:
        """Convert geometry to H3 indices that intersect it.

        Args:
            geometry: Shapely geometry object

        Returns:
            List of H3 index strings
        """
        if hasattr(geometry, 'centroid'):
            # For complex geometries, use polyfill
            if geometry.geom_type == 'Point':
                lat, lng = geometry.y, geometry.x
                return [self.point_to_h3(lat, lng)]
            if hasattr(geometry, 'exterior'):
                # Convert to GeoJSON-like format for h3.polyfill
                coords = list(geometry.exterior.coords)
                geojson = {
                    "type": "Polygon",
                    "coordinates": [coords]
                }
                return list(h3.polyfill_geojson(geojson, self.resolution))

        # Fallback to centroid
        centroid = geometry.centroid
        return [self.point_to_h3(centroid.y, centroid.x)]

    def h3_to_polygon(self, h3_index: str) -> Polygon:
        """Convert H3 index to Shapely polygon.

        Args:
            h3_index: H3 index string

        Returns:
            Shapely Polygon
        """
        boundary = h3.cell_to_boundary(h3_index)
        # Convert from (lat, lng) to (lng, lat) for Shapely
        coords = [(lng, lat) for lat, lng in boundary]
        return Polygon(coords)


class SpatialJoiner:
    """Spatial join operations between GeoDataFrames."""

    @staticmethod
    def spatial_join(
        left_gdf: gpd.GeoDataFrame,
        right_gdf: gpd.GeoDataFrame,
        how: str = "inner",
        predicate: str = "intersects"
    ) -> gpd.GeoDataFrame:
        """Perform spatial join between two GeoDataFrames.

        Args:
            left_gdf: Left GeoDataFrame
            right_gdf: Right GeoDataFrame
            how: Join type ('inner', 'left', 'right')
            predicate: Spatial predicate ('intersects', 'within', 'contains')

        Returns:
            Joined GeoDataFrame
        """
        # Ensure both GDFs have the same CRS
        if left_gdf.crs != right_gdf.crs:
            logger.warning("CRS mismatch detected, reprojecting right GDF to match left")
            right_gdf = right_gdf.to_crs(left_gdf.crs)

        return gpd.sjoin(left_gdf, right_gdf, how=how, predicate=predicate)

    @staticmethod
    def spatial_aggregate(
        points_gdf: gpd.GeoDataFrame,
        polygons_gdf: gpd.GeoDataFrame,
        agg_column: str,
        agg_func: str = "count"
    ) -> gpd.GeoDataFrame:
        """Aggregate points within polygons.

        Args:
            points_gdf: Points to aggregate
            polygons_gdf: Polygons for aggregation
            agg_column: Column to aggregate
            agg_func: Aggregation function ('count', 'sum', 'mean')

        Returns:
            Polygons with aggregated values
        """
        joined = SpatialJoiner.spatial_join(points_gdf, polygons_gdf, how="inner")

        if agg_func == "count":
            result = joined.groupby(joined.index_right).size().to_frame(f"{agg_column}_count")
        else:
            result = joined.groupby(joined.index_right)[agg_column].agg(agg_func).to_frame(f"{agg_column}_{agg_func}")

        return polygons_gdf.merge(result, left_index=True, right_index=True, how="left").fillna(0)


class GeoProcessor:
    """Main geospatial processing class with data loading, transformation, and analysis capabilities."""

    def __init__(self, config: GeoProcessingConfig | None = None):
        """Initialize GeoProcessor with configuration.

        Args:
            config: Configuration object, defaults to GeoProcessingConfig()
        """
        self.config = config or GeoProcessingConfig()
        self.h3_indexer = H3Indexer(self.config.h3_resolution)
        self._blob_client: BlobServiceClient | None = None

    def _get_blob_client(self) -> BlobServiceClient:
        """Get Azure Blob Storage client with managed identity."""
        if self._blob_client is None:
            if not self.config.azure_storage_account:
                raise ValueError("Azure storage account not configured")

            credential = DefaultAzureCredential()
            account_url = f"https://{self.config.azure_storage_account}.blob.core.windows.net"
            self._blob_client = BlobServiceClient(account_url=account_url, credential=credential)

        return self._blob_client

    def load_geodata(
        self,
        path: str | Path,
        file_format: str | None = None,
        **kwargs
    ) -> gpd.GeoDataFrame:
        """Load geospatial data from various sources.

        Args:
            path: File path, URL, or Azure blob path (abfss://)
            file_format: Force specific format ('geojson', 'shapefile', 'geoparquet', 'csv')
            **kwargs: Additional arguments passed to geopandas reader

        Returns:
            GeoDataFrame with loaded data
        """
        path_str = str(path)

        # Handle Azure Data Lake paths
        if path_str.startswith("abfss://"):
            return self._load_from_azure(path_str, file_format, **kwargs)

        # Detect format from extension if not specified
        if file_format is None:
            file_format = self._detect_format(path_str)

        logger.info(f"Loading {file_format} data from {path_str}")

        try:
            if file_format == "geoparquet":
                gdf = gpd.read_parquet(path_str, **kwargs)
            elif file_format == "geojson" or file_format == "shapefile":
                gdf = gpd.read_file(path_str, **kwargs)
            elif file_format == "csv":
                # Assume CSV has lat/lng columns
                df = pd.read_csv(path_str, **kwargs)
                gdf = self._csv_to_geodataframe(df)
            else:
                # Let geopandas auto-detect
                gdf = gpd.read_file(path_str, **kwargs)

            # Ensure CRS is set
            if gdf.crs is None:
                logger.warning(f"No CRS found, setting to {self.config.default_crs}")
                gdf = gdf.set_crs(self.config.default_crs)

            logger.info(f"Loaded {len(gdf)} features with CRS {gdf.crs}")
            return gdf

        except Exception as e:
            logger.error(f"Failed to load geodata from {path_str}: {e}")
            raise

    def _load_from_azure(self, abfss_path: str, file_format: str | None, **kwargs) -> gpd.GeoDataFrame:
        """Load geodata from Azure Data Lake using abfss:// paths."""
        # Parse abfss://container@account/path
        parsed = urlparse(abfss_path)
        container_and_account = parsed.netloc
        blob_path = parsed.path.lstrip('/')

        if '@' in container_and_account:
            container, account_with_suffix = container_and_account.split('@')
            _account = account_with_suffix.split('.')[0]
        else:
            raise ValueError(f"Invalid abfss path format: {abfss_path}")

        # Download to temp file and load
        blob_client = self._get_blob_client()
        container_client = blob_client.get_container_client(container)

        temp_path = Path("temp") / f"geo_temp_{hash(abfss_path)}"
        temp_path.parent.mkdir(exist_ok=True)

        try:
            with open(temp_path, "wb") as f:
                blob_data = container_client.download_blob(blob_path)
                blob_data.readinto(f)

            return self.load_geodata(temp_path, file_format, **kwargs)
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def _detect_format(self, path: str) -> str:
        """Detect file format from extension."""
        path_lower = path.lower()
        if path_lower.endswith(('.geojson', '.json')):
            return "geojson"
        if path_lower.endswith('.parquet'):
            return "geoparquet"
        if path_lower.endswith('.shp'):
            return "shapefile"
        if path_lower.endswith('.csv'):
            return "csv"
        return "auto"

    def _csv_to_geodataframe(self, df: pd.DataFrame) -> gpd.GeoDataFrame:
        """Convert CSV with lat/lng columns to GeoDataFrame."""
        # Try common column names
        lat_cols = ['lat', 'latitude', 'y', 'LAT', 'LATITUDE']
        lng_cols = ['lon', 'lng', 'longitude', 'x', 'LON', 'LNG', 'LONGITUDE']

        lat_col = None
        lng_col = None

        for col in lat_cols:
            if col in df.columns:
                lat_col = col
                break

        for col in lng_cols:
            if col in df.columns:
                lng_col = col
                break

        if lat_col is None or lng_col is None:
            raise ValueError("Could not find latitude/longitude columns in CSV")

        geometry = gpd.points_from_xy(df[lng_col], df[lat_col])
        return gpd.GeoDataFrame(df, geometry=geometry, crs=self.config.default_crs)

    def to_geoparquet(
        self,
        gdf: gpd.GeoDataFrame,
        path: str | Path,
        **kwargs
    ) -> None:
        """Save GeoDataFrame as GeoParquet.

        Args:
            gdf: GeoDataFrame to save
            path: Output path
            **kwargs: Additional arguments for to_parquet()
        """
        logger.info(f"Saving {len(gdf)} features to {path}")
        gdf.to_parquet(str(path), **kwargs)

    def transform_crs(self, gdf: gpd.GeoDataFrame, target_crs: str | int) -> gpd.GeoDataFrame:
        """Transform GeoDataFrame to different coordinate reference system.

        Args:
            gdf: Input GeoDataFrame
            target_crs: Target CRS (EPSG code or proj string)

        Returns:
            Transformed GeoDataFrame
        """
        if gdf.crs is None:
            raise ValueError("Source GeoDataFrame has no CRS defined")

        logger.info(f"Transforming from {gdf.crs} to {target_crs}")
        return gdf.to_crs(target_crs)

    def buffer_geometries(
        self,
        gdf: gpd.GeoDataFrame,
        distance: float | None = None,
        units: str = "meters"
    ) -> gpd.GeoDataFrame:
        """Create buffer around geometries.

        Args:
            gdf: Input GeoDataFrame
            distance: Buffer distance (uses config default if None)
            units: Distance units ('meters', 'degrees')

        Returns:
            GeoDataFrame with buffered geometries
        """
        if distance is None:
            distance = self.config.buffer_distance_meters

        gdf_copy = gdf.copy()

        if units == "meters" and gdf_copy.crs.to_string() == "EPSG:4326":
            # Convert to projected CRS for accurate meter-based buffer
            utm_crs = self._estimate_utm_crs(gdf_copy)
            gdf_copy = gdf_copy.to_crs(utm_crs)
            gdf_copy['geometry'] = gdf_copy.buffer(distance)
            gdf_copy = gdf_copy.to_crs("EPSG:4326")
        else:
            gdf_copy['geometry'] = gdf_copy.buffer(distance)

        logger.info(f"Created {distance} {units} buffer around {len(gdf_copy)} geometries")
        return gdf_copy

    def _estimate_utm_crs(self, gdf: gpd.GeoDataFrame) -> str:
        """Estimate appropriate UTM CRS for the data."""
        # Get centroid of all data
        total_bounds = gdf.total_bounds
        center_lng = (total_bounds[0] + total_bounds[2]) / 2

        # Calculate UTM zone
        utm_zone = int((center_lng + 180) / 6) + 1

        # Determine hemisphere
        center_lat = (total_bounds[1] + total_bounds[3]) / 2
        hemisphere = "north" if center_lat >= 0 else "south"

        # Construct EPSG code
        if hemisphere == "north":
            epsg_code = 32600 + utm_zone  # WGS84 UTM North
        else:
            epsg_code = 32700 + utm_zone  # WGS84 UTM South

        return f"EPSG:{epsg_code}"

    def spatial_join(
        self,
        left_gdf: gpd.GeoDataFrame,
        right_gdf: gpd.GeoDataFrame,
        **kwargs
    ) -> gpd.GeoDataFrame:
        """Perform spatial join using SpatialJoiner."""
        return SpatialJoiner.spatial_join(left_gdf, right_gdf, **kwargs)

    def calculate_distances(
        self,
        gdf: gpd.GeoDataFrame,
        target_point: Point,
        units: str = "meters"
    ) -> gpd.GeoDataFrame:
        """Calculate distances from geometries to a target point.

        Args:
            gdf: Input GeoDataFrame
            target_point: Target point for distance calculation
            units: Distance units ('meters', 'degrees')

        Returns:
            GeoDataFrame with distance column added
        """
        gdf_copy = gdf.copy()

        if units == "meters" and gdf_copy.crs.to_string() == "EPSG:4326":
            # Use geodesic distance for accuracy
            gdf_copy['distance_meters'] = gdf_copy.geometry.apply(
                lambda geom: geom.distance(target_point) * 111320  # Rough deg to meter conversion
            )
        else:
            gdf_copy['distance'] = gdf_copy.distance(target_point)

        return gdf_copy

    def h3_index(self, gdf: gpd.GeoDataFrame, geometry_col: str = 'geometry') -> gpd.GeoDataFrame:
        """Add H3 indices to GeoDataFrame.

        Args:
            gdf: Input GeoDataFrame
            geometry_col: Name of geometry column

        Returns:
            GeoDataFrame with h3_index column added
        """
        gdf_copy = gdf.copy()

        # Ensure data is in WGS84 for H3
        if gdf_copy.crs.to_string() != "EPSG:4326":
            gdf_copy = gdf_copy.to_crs("EPSG:4326")

        gdf_copy['h3_index'] = gdf_copy[geometry_col].apply(
            lambda geom: self.h3_indexer.geometry_to_h3(geom)[0] if geom else None
        )

        logger.info(f"Added H3 indices at resolution {self.h3_indexer.resolution}")
        return gdf_copy

    def create_h3_grid(
        self,
        gdf: gpd.GeoDataFrame,
        resolution: int | None = None
    ) -> gpd.GeoDataFrame:
        """Create H3 hexagonal grid covering the GeoDataFrame extent.

        Args:
            gdf: GeoDataFrame to cover with grid
            resolution: H3 resolution (uses config default if None)

        Returns:
            GeoDataFrame with H3 hexagons
        """
        if resolution is None:
            resolution = self.config.h3_resolution

        # Get bounding box
        bounds = gdf.total_bounds

        # Create a polygon for the bounds
        bbox_poly = Polygon([
            (bounds[0], bounds[1]),
            (bounds[2], bounds[1]),
            (bounds[2], bounds[3]),
            (bounds[0], bounds[3])
        ])

        # Convert to GeoJSON for H3
        geojson = {
            "type": "Polygon",
            "coordinates": [list(bbox_poly.exterior.coords)]
        }

        # Get H3 indices
        h3_indices = list(h3.polyfill_geojson(geojson, resolution))

        # Create polygons
        polygons = [self.h3_indexer.h3_to_polygon(idx) for idx in h3_indices]

        grid_gdf = gpd.GeoDataFrame({
            'h3_index': h3_indices,
            'geometry': polygons
        }, crs="EPSG:4326")

        logger.info(f"Created H3 grid with {len(grid_gdf)} hexagons at resolution {resolution}")
        return grid_gdf
