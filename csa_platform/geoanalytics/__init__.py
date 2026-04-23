"""
GeoAnalytics module for CSA-in-a-Box.

Provides open-source geospatial analytics capabilities as an alternative to ArcGIS.
Built on top of geopandas, h3, and PostGIS for comprehensive spatial analysis.
"""

from __future__ import annotations

from .geo_processor import GeoProcessor, H3Indexer, SpatialJoiner
from .postgis_store import PostGISStore

__all__ = [
    "GeoProcessor",
    "H3Indexer",
    "SpatialJoiner",
    "PostGISStore",
]

__version__ = "0.1.0"
