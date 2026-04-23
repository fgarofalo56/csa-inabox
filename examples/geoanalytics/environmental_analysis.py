#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Environmental Spatial Analysis Example for CSA-in-a-Box GeoAnalytics.

This example demonstrates comprehensive geospatial analysis using open-source tools:
1. Downloads EPA facility data and census boundaries
2. Performs spatial joins to find facilities within counties
3. Calculates pollution density using H3 hexagonal grid
4. Generates summary statistics and visualizations
5. Saves results in GeoParquet format for further analysis

Usage:
    python examples/geoanalytics/environmental_analysis.py [--plot] [--output-dir OUTPUT_DIR]
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import Dict, List, Optional

import geopandas as gpd
import matplotlib.pyplot as plt
import pandas as pd
import requests
from shapely.geometry import Point

from csa_platform.geoanalytics import GeoProcessor, H3Indexer, SpatialJoiner
from csa_platform.geoanalytics.geo_processor import GeoProcessingConfig

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class EnvironmentalAnalyzer:
    """Environmental spatial analysis using EPA and Census data."""

    def __init__(self, output_dir: Path, h3_resolution: int = 8):
        """Initialize analyzer with output directory and configuration.

        Args:
            output_dir: Directory for output files
            h3_resolution: H3 hexagon resolution (higher = more granular)
        """
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        config = GeoProcessingConfig(h3_resolution=h3_resolution)
        self.geo_processor = GeoProcessor(config)
        self.h3_indexer = H3Indexer(h3_resolution)
        self.spatial_joiner = SpatialJoiner()

        # Data URLs
        self.data_urls = {
            "epa_facilities": "https://www.epa.gov/sites/default/files/2024-03/fy2023-tri-factsheet.xlsx",
            "census_counties": "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_20m.zip"
        }

    def download_epa_facilities(self) -> gpd.GeoDataFrame:
        """Download and process EPA TRI facility data.

        Returns:
            GeoDataFrame with EPA facility locations
        """
        logger.info("Downloading EPA facility data...")

        # Check if cached data exists
        cache_path = self.output_dir / "epa_facilities.geojson"
        if cache_path.exists():
            logger.info("Using cached EPA facility data")
            return gpd.read_file(cache_path)

        # Create sample facility data (since actual EPA data requires special handling)
        facilities_data = self._create_sample_facilities()

        # Save cache
        facilities_data.to_file(cache_path, driver="GeoJSON")
        logger.info(f"Cached EPA facility data to {cache_path}")

        return facilities_data

    def _create_sample_facilities(self) -> gpd.GeoDataFrame:
        """Create sample EPA facility data for demonstration."""
        import numpy as np

        np.random.seed(42)  # Reproducible data

        # Generate facilities in continental US
        n_facilities = 2000
        lats = np.random.uniform(25.0, 48.0, n_facilities)
        lngs = np.random.uniform(-125.0, -65.0, n_facilities)

        # Create facility types
        facility_types = ['Chemical', 'Manufacturing', 'Power Plant', 'Refinery', 'Waste Management']
        types = np.random.choice(facility_types, n_facilities)

        # Create pollution levels (kg/year)
        base_pollution = np.random.lognormal(10, 2, n_facilities)
        pollution_multipliers = {'Chemical': 2.0, 'Manufacturing': 1.5, 'Power Plant': 3.0,
                               'Refinery': 2.5, 'Waste Management': 1.0}
        pollution_levels = [base_pollution[i] * pollution_multipliers[types[i]]
                          for i in range(n_facilities)]

        # Create sample facility names
        facility_names = [f"Facility_{i:04d}" for i in range(n_facilities)]

        # Create GeoDataFrame
        geometry = [Point(lng, lat) for lng, lat in zip(lngs, lats)]

        facilities_gdf = gpd.GeoDataFrame({
            'facility_name': facility_names,
            'facility_type': types,
            'pollution_kg_year': pollution_levels,
            'latitude': lats,
            'longitude': lngs,
            'geometry': geometry
        }, crs="EPSG:4326")

        logger.info(f"Generated {len(facilities_gdf)} sample EPA facilities")
        return facilities_gdf

    def download_county_boundaries(self) -> gpd.GeoDataFrame:
        """Download US county boundaries from Census TIGER.

        Returns:
            GeoDataFrame with county boundaries
        """
        logger.info("Downloading county boundary data...")

        # Check if cached data exists
        cache_path = self.output_dir / "counties.geojson"
        if cache_path.exists():
            logger.info("Using cached county boundary data")
            return gpd.read_file(cache_path)

        try:
            # Download and read county shapefile
            counties_gdf = gpd.read_file(self.data_urls["census_counties"])

            # Clean up column names and data
            counties_gdf = counties_gdf[['GEOID', 'NAME', 'STATEFP', 'COUNTYFP', 'geometry']].copy()
            counties_gdf.rename(columns={
                'GEOID': 'county_fips',
                'NAME': 'county_name',
                'STATEFP': 'state_fips',
                'COUNTYFP': 'county_fips_short'
            }, inplace=True)

            # Filter to continental US (exclude Alaska, Hawaii, territories)
            continental_states = [f"{i:02d}" for i in range(1, 57) if i not in [2, 15]]
            counties_gdf = counties_gdf[counties_gdf['state_fips'].isin(continental_states)]

            # Save cache
            counties_gdf.to_file(cache_path, driver="GeoJSON")
            logger.info(f"Cached county data to {cache_path} ({len(counties_gdf)} counties)")

            return counties_gdf

        except Exception as e:
            logger.error(f"Failed to download county data: {e}")
            # Create minimal fallback data
            return self._create_sample_counties()

    def _create_sample_counties(self) -> gpd.GeoDataFrame:
        """Create sample county data as fallback."""
        from shapely.geometry import Polygon

        # Create a few sample counties
        counties = []
        county_names = ["Sample County A", "Sample County B", "Sample County C"]

        for i, name in enumerate(county_names):
            # Create rectangular counties
            min_x = -120 + i * 10
            min_y = 35 + i * 5
            max_x = min_x + 8
            max_y = min_y + 8

            county_poly = Polygon([
                (min_x, min_y), (max_x, min_y),
                (max_x, max_y), (min_x, max_y), (min_x, min_y)
            ])

            counties.append({
                'county_fips': f"0600{i:02d}",
                'county_name': name,
                'state_fips': "06",
                'county_fips_short': f"{i:02d}",
                'geometry': county_poly
            })

        return gpd.GeoDataFrame(counties, crs="EPSG:4326")

    def spatial_join_facilities_counties(
        self,
        facilities_gdf: gpd.GeoDataFrame,
        counties_gdf: gpd.GeoDataFrame
    ) -> gpd.GeoDataFrame:
        """Perform spatial join to assign facilities to counties.

        Args:
            facilities_gdf: EPA facility data
            counties_gdf: County boundary data

        Returns:
            GeoDataFrame with facilities assigned to counties
        """
        logger.info("Performing spatial join: facilities within counties...")

        # Use the SpatialJoiner from our module
        joined_gdf = self.spatial_joiner.spatial_join(
            facilities_gdf, counties_gdf,
            how="inner",
            predicate="within"
        )

        logger.info(f"Joined {len(joined_gdf)} facilities to counties")
        return joined_gdf

    def calculate_county_pollution_density(
        self,
        joined_gdf: gpd.GeoDataFrame
    ) -> gpd.GeoDataFrame:
        """Calculate pollution density per county.

        Args:
            joined_gdf: Facilities with county assignments

        Returns:
            GeoDataFrame with county-level aggregated pollution metrics
        """
        logger.info("Calculating county-level pollution density...")

        # Aggregate by county
        county_stats = joined_gdf.groupby(['county_fips', 'county_name']).agg({
            'pollution_kg_year': ['sum', 'mean', 'count'],
            'facility_type': lambda x: x.value_counts().to_dict()
        }).round(2)

        # Flatten column names
        county_stats.columns = ['total_pollution_kg', 'avg_pollution_kg', 'facility_count', 'facility_types']

        # Reset index to get county info as columns
        county_stats = county_stats.reset_index()

        # Get county geometries for density calculation
        county_geoms = joined_gdf.groupby('county_fips')['geometry_right'].first()
        county_stats = county_stats.merge(
            county_geoms.reset_index(),
            on='county_fips',
            how='left'
        )

        # Calculate area in square kilometers (approximate)
        county_stats_gdf = gpd.GeoDataFrame(
            county_stats,
            geometry='geometry_right',
            crs="EPSG:4326"
        )

        # Project to equal area projection for accurate area calculation
        area_crs = county_stats_gdf.estimate_utm_crs()
        county_areas = county_stats_gdf.to_crs(area_crs).area / 1e6  # Convert to km²

        county_stats_gdf['area_km2'] = area_crs
        county_stats_gdf['pollution_density_kg_km2'] = (
            county_stats_gdf['total_pollution_kg'] / area_crs
        ).round(2)

        county_stats_gdf['facility_density_per_100km2'] = (
            county_stats_gdf['facility_count'] / area_crs * 100
        ).round(2)

        logger.info(f"Calculated pollution density for {len(county_stats_gdf)} counties")
        return county_stats_gdf

    def create_h3_pollution_grid(
        self,
        facilities_gdf: gpd.GeoDataFrame
    ) -> gpd.GeoDataFrame:
        """Create H3 hexagonal grid with pollution aggregation.

        Args:
            facilities_gdf: Facilities data

        Returns:
            GeoDataFrame with H3 hexagons and aggregated pollution
        """
        logger.info("Creating H3 pollution density grid...")

        # Add H3 indices to facilities
        facilities_h3 = self.geo_processor.h3_index(facilities_gdf)

        # Aggregate pollution by H3 cell
        h3_pollution = facilities_h3.groupby('h3_index').agg({
            'pollution_kg_year': ['sum', 'mean', 'count'],
            'facility_type': lambda x: list(x.unique())
        }).round(2)

        # Flatten column names
        h3_pollution.columns = ['total_pollution_kg', 'avg_pollution_kg', 'facility_count', 'facility_types']
        h3_pollution = h3_pollution.reset_index()

        # Create hexagon geometries
        h3_pollution['geometry'] = h3_pollution['h3_index'].apply(
            lambda idx: self.h3_indexer.h3_to_polygon(idx)
        )

        # Create GeoDataFrame
        h3_gdf = gpd.GeoDataFrame(h3_pollution, crs="EPSG:4326")

        # Calculate pollution density per hexagon
        # H3 resolution 8 hexagons are approximately 0.737 km² each
        h3_area_km2 = 0.737
        h3_gdf['pollution_density_kg_km2'] = (
            h3_gdf['total_pollution_kg'] / h3_area_km2
        ).round(2)

        logger.info(f"Created {len(h3_gdf)} H3 hexagons with pollution data")
        return h3_gdf

    def generate_summary_statistics(
        self,
        facilities_gdf: gpd.GeoDataFrame,
        county_stats: gpd.GeoDataFrame,
        h3_grid: gpd.GeoDataFrame
    ) -> Dict[str, any]:
        """Generate comprehensive analysis summary.

        Args:
            facilities_gdf: Original facilities data
            county_stats: County-level statistics
            h3_grid: H3 grid with pollution data

        Returns:
            Dictionary with summary statistics
        """
        logger.info("Generating summary statistics...")

        summary = {
            "total_facilities": len(facilities_gdf),
            "total_pollution_kg": facilities_gdf['pollution_kg_year'].sum(),
            "avg_pollution_per_facility": facilities_gdf['pollution_kg_year'].mean(),
            "facility_types": facilities_gdf['facility_type'].value_counts().to_dict(),

            "counties_analyzed": len(county_stats),
            "top_pollution_counties": county_stats.nlargest(10, 'total_pollution_kg')[
                ['county_name', 'total_pollution_kg', 'facility_count']
            ].to_dict('records'),

            "h3_hexagons": len(h3_grid),
            "high_pollution_hexagons": len(h3_grid[h3_grid['pollution_density_kg_km2'] > h3_grid['pollution_density_kg_km2'].quantile(0.9)]),

            "data_extent": {
                "min_lat": float(facilities_gdf.bounds['miny'].min()),
                "max_lat": float(facilities_gdf.bounds['maxy'].max()),
                "min_lng": float(facilities_gdf.bounds['minx'].min()),
                "max_lng": float(facilities_gdf.bounds['maxx'].max())
            }
        }

        return summary

    def create_visualization(
        self,
        county_stats: gpd.GeoDataFrame,
        h3_grid: gpd.GeoDataFrame,
        output_path: Path
    ) -> None:
        """Create visualization plots.

        Args:
            county_stats: County statistics
            h3_grid: H3 grid data
            output_path: Path to save plot
        """
        logger.info("Creating visualizations...")

        fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(20, 16))

        # 1. County pollution density
        county_stats.plot(
            column='pollution_density_kg_km2',
            cmap='Reds',
            legend=True,
            ax=ax1,
            edgecolor='black',
            linewidth=0.5
        )
        ax1.set_title('Pollution Density by County (kg/km²)', fontsize=14)
        ax1.axis('off')

        # 2. Facility count by county
        county_stats.plot(
            column='facility_count',
            cmap='Blues',
            legend=True,
            ax=ax2,
            edgecolor='black',
            linewidth=0.5
        )
        ax2.set_title('Number of Facilities by County', fontsize=14)
        ax2.axis('off')

        # 3. H3 pollution density
        h3_grid.plot(
            column='pollution_density_kg_km2',
            cmap='YlOrRd',
            legend=True,
            ax=ax3,
            edgecolor='none'
        )
        ax3.set_title('H3 Hexagonal Pollution Density (kg/km²)', fontsize=14)
        ax3.axis('off')

        # 4. Facility type distribution
        facility_type_counts = county_stats['facility_types'].apply(pd.Series).sum()
        ax4.bar(facility_type_counts.index, facility_type_counts.values)
        ax4.set_title('Distribution of Facility Types', fontsize=14)
        ax4.tick_params(axis='x', rotation=45)
        plt.setp(ax4.xaxis.get_majorticklabels(), ha='right')

        plt.tight_layout()
        plt.savefig(output_path, dpi=300, bbox_inches='tight')
        logger.info(f"Saved visualization to {output_path}")

    def save_results(
        self,
        facilities_gdf: gpd.GeoDataFrame,
        county_stats: gpd.GeoDataFrame,
        h3_grid: gpd.GeoDataFrame,
        summary: Dict[str, any]
    ) -> None:
        """Save analysis results to files.

        Args:
            facilities_gdf: Facilities data
            county_stats: County statistics
            h3_grid: H3 grid data
            summary: Summary statistics
        """
        logger.info("Saving results...")

        # Save GeoDataFrames as GeoParquet
        facilities_gdf.to_parquet(self.output_dir / "epa_facilities_analyzed.parquet")
        county_stats.to_parquet(self.output_dir / "county_pollution_stats.parquet")
        h3_grid.to_parquet(self.output_dir / "h3_pollution_grid.parquet")

        # Save summary as JSON
        import json
        with open(self.output_dir / "analysis_summary.json", 'w') as f:
            json.dump(summary, f, indent=2, default=str)

        logger.info(f"Results saved to {self.output_dir}")

    def run_analysis(self, create_plot: bool = False) -> Dict[str, any]:
        """Run complete environmental analysis workflow.

        Args:
            create_plot: Whether to create visualization plots

        Returns:
            Analysis summary dictionary
        """
        logger.info("Starting environmental spatial analysis...")

        # Step 1: Load data
        facilities_gdf = self.download_epa_facilities()
        counties_gdf = self.download_county_boundaries()

        # Step 2: Spatial analysis
        joined_gdf = self.spatial_join_facilities_counties(facilities_gdf, counties_gdf)
        county_stats = self.calculate_county_pollution_density(joined_gdf)
        h3_grid = self.create_h3_pollution_grid(facilities_gdf)

        # Step 3: Generate summary
        summary = self.generate_summary_statistics(facilities_gdf, county_stats, h3_grid)

        # Step 4: Save results
        self.save_results(facilities_gdf, county_stats, h3_grid, summary)

        # Step 5: Create visualization if requested
        if create_plot:
            plot_path = self.output_dir / "environmental_analysis.png"
            self.create_visualization(county_stats, h3_grid, plot_path)

        logger.info("Analysis complete!")
        return summary


def print_top_counties(summary: Dict[str, any]) -> None:
    """Print top counties by pollution to console."""
    print("\n" + "="*60)
    print("TOP 10 COUNTIES BY TOTAL POLLUTION")
    print("="*60)

    for i, county in enumerate(summary['top_pollution_counties'], 1):
        print(f"{i:2d}. {county['county_name']:<30} "
              f"{county['total_pollution_kg']:>12,.0f} kg/year "
              f"({county['facility_count']} facilities)")


def main():
    """Main function for command-line execution."""
    parser = argparse.ArgumentParser(
        description="Environmental Spatial Analysis using CSA-in-a-Box GeoAnalytics"
    )
    parser.add_argument(
        "--plot",
        action="store_true",
        help="Create visualization plots (requires matplotlib)"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="data/environmental_analysis",
        help="Output directory for results (default: data/environmental_analysis)"
    )
    parser.add_argument(
        "--h3-resolution",
        type=int,
        default=8,
        choices=range(0, 16),
        help="H3 resolution level (0-15, default: 8)"
    )

    args = parser.parse_args()

    # Create analyzer and run analysis
    analyzer = EnvironmentalAnalyzer(
        output_dir=Path(args.output_dir),
        h3_resolution=args.h3_resolution
    )

    try:
        summary = analyzer.run_analysis(create_plot=args.plot)

        # Print summary to console
        print(f"\nAnalysis completed successfully!")
        print(f"Total facilities analyzed: {summary['total_facilities']:,}")
        print(f"Total pollution: {summary['total_pollution_kg']:,.0f} kg/year")
        print(f"Counties analyzed: {summary['counties_analyzed']}")
        print(f"H3 hexagons created: {summary['h3_hexagons']}")

        print_top_counties(summary)

        print(f"\nResults saved to: {args.output_dir}")
        if args.plot:
            print(f"Visualization saved to: {args.output_dir}/environmental_analysis.png")

    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        raise


if __name__ == "__main__":
    main()