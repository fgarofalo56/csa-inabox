#!/usr/bin/env python3
"""
Download geospatial public data.

Downloads Census TIGER/Line shapefiles, Natural Earth data, and EPA facility locations.
Converts shapefiles to GeoParquet format when possible for better performance.

Data sources:
- Census TIGER/Line: https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html
- Natural Earth: https://www.naturalearthdata.com/
- EPA FRS: https://www.epa.gov/frs/facility-registry-service-frs-data-downloads
"""

import argparse
import json
import logging
import os
import sys
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urljoin

import pandas as pd
import requests
from tqdm import tqdm

# Optional imports for geospatial processing
try:
    import geopandas as gpd
    HAS_GEOPANDAS = True
except ImportError:
    HAS_GEOPANDAS = False
    logging.warning("geopandas not available - will keep shapefiles in original format")


def setup_logging(verbose: bool = False) -> None:
    """Set up logging configuration."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )


class GeospatialDownloader:
    """Download geospatial data from public sources."""

    TIGER_BASE_URL = "https://www2.census.gov/geo/tiger/TIGER2023/"
    NATURAL_EARTH_URL = "https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/"
    EPA_FRS_URL = "https://www.epa.gov/frs/"

    def __init__(self):
        """Initialize downloader."""
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'CSA-in-a-Box Data Downloader (research/educational use)'
        })

    def _download_file(self, url: str, description: str) -> Optional[bytes]:
        """Download file with progress bar and return content."""
        try:
            response = self.session.get(url, stream=True, timeout=120)
            response.raise_for_status()

            # Get content length for progress bar
            total_size = int(response.headers.get('content-length', 0))

            content = []
            with tqdm(desc=description, total=total_size, unit='B', unit_scale=True) as pbar:
                for chunk in response.iter_content(chunk_size=8192):
                    content.append(chunk)
                    pbar.update(len(chunk))

            return b''.join(content)

        except requests.RequestException as e:
            logging.error(f"Failed to download {url}: {e}")
            return None

    def download_tiger_states(self, year: str = "2023") -> Optional[str]:
        """Download Census TIGER state boundaries."""
        filename = f"tl_{year}_us_state.zip"
        url = f"https://www2.census.gov/geo/tiger/TIGER{year}/STATE/{filename}"

        content = self._download_file(url, f"TIGER States {year}")
        if not content:
            return None

        return self._extract_shapefile(content, f"tiger_states_{year}")

    def download_tiger_counties(self, state_fips: Optional[str] = None, year: str = "2023") -> Optional[str]:
        """Download Census TIGER county boundaries."""
        if state_fips:
            # Download for specific state
            filename = f"tl_{year}_{state_fips}_county.zip"
            url = f"https://www2.census.gov/geo/tiger/TIGER{year}/COUNTY/{filename}"
        else:
            # Download national county file
            filename = f"tl_{year}_us_county.zip"
            url = f"https://www2.census.gov/geo/tiger/TIGER{year}/COUNTY/{filename}"

        content = self._download_file(url, f"TIGER Counties {year}")
        if not content:
            return None

        suffix = f"_{state_fips}" if state_fips else "_national"
        return self._extract_shapefile(content, f"tiger_counties_{year}{suffix}")

    def download_tiger_tracts(self, state_fips: str, year: str = "2023") -> Optional[str]:
        """Download Census TIGER tract boundaries for a state."""
        filename = f"tl_{year}_{state_fips}_tract.zip"
        url = f"https://www2.census.gov/geo/tiger/TIGER{year}/TRACT/{filename}"

        content = self._download_file(url, f"TIGER Tracts {state_fips} {year}")
        if not content:
            return None

        return self._extract_shapefile(content, f"tiger_tracts_{state_fips}_{year}")

    def download_natural_earth_countries(self, resolution: str = "50m") -> Optional[str]:
        """Download Natural Earth country boundaries."""
        # Resolution: 10m, 50m, or 110m
        filename = f"ne_{resolution}_admin_0_countries.zip"
        url = f"https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/{resolution}/cultural/{filename}"

        content = self._download_file(url, f"Natural Earth Countries {resolution}")
        if not content:
            return None

        return self._extract_shapefile(content, f"natural_earth_countries_{resolution}")

    def download_natural_earth_coastlines(self, resolution: str = "50m") -> Optional[str]:
        """Download Natural Earth coastline data."""
        filename = f"ne_{resolution}_coastline.zip"
        url = f"https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/{resolution}/physical/{filename}"

        content = self._download_file(url, f"Natural Earth Coastlines {resolution}")
        if not content:
            return None

        return self._extract_shapefile(content, f"natural_earth_coastlines_{resolution}")

    def download_epa_frs_facilities(self) -> List[Dict]:
        """Download EPA Facility Registry Service (FRS) data."""
        # EPA FRS provides CSV downloads
        url = "https://www.epa.gov/system/files/other-files/2022-11/national_single.zip"

        content = self._download_file(url, "EPA FRS Facilities")
        if not content:
            return []

        try:
            # Extract and read CSV from ZIP
            with zipfile.ZipFile(BytesIO(content)) as zf:
                csv_files = [f for f in zf.namelist() if f.endswith('.csv')]

                if csv_files:
                    with zf.open(csv_files[0]) as f:
                        df = pd.read_csv(f, low_memory=False)
                        return df.to_dict('records')

        except Exception as e:
            logging.error(f"Failed to extract EPA FRS data: {e}")

        return []

    def _extract_shapefile(self, zip_content: bytes, base_name: str) -> Optional[str]:
        """Extract shapefile and optionally convert to GeoParquet."""
        try:
            # Extract ZIP file
            with zipfile.ZipFile(BytesIO(zip_content)) as zf:
                # Find shapefile (.shp file)
                shp_files = [f for f in zf.namelist() if f.endswith('.shp')]
                if not shp_files:
                    logging.error("No shapefile found in ZIP archive")
                    return None

                # Extract all files to temporary directory
                extract_dir = Path("temp") / f"extract_{base_name}"
                extract_dir.mkdir(parents=True, exist_ok=True)

                zf.extractall(extract_dir)
                shp_path = extract_dir / shp_files[0]

                if HAS_GEOPANDAS:
                    # Convert to GeoParquet
                    gdf = gpd.read_file(shp_path)
                    output_file = f"{base_name}.parquet"
                    gdf.to_parquet(output_file)
                    logging.info(f"Converted shapefile to GeoParquet: {output_file}")

                    # Clean up temporary files
                    import shutil
                    shutil.rmtree(extract_dir)

                    return output_file
                else:
                    # Keep as shapefile - move files to final location
                    for file in extract_dir.glob("*"):
                        final_path = Path(file.name)
                        file.rename(final_path)

                    # Clean up directory
                    extract_dir.rmdir()

                    return shp_files[0]

        except Exception as e:
            logging.error(f"Failed to process shapefile: {e}")
            return None

    def get_state_fips_codes(self) -> Dict[str, str]:
        """Get mapping of state abbreviations to FIPS codes."""
        return {
            'AL': '01', 'AK': '02', 'AZ': '04', 'AR': '05', 'CA': '06',
            'CO': '08', 'CT': '09', 'DE': '10', 'FL': '12', 'GA': '13',
            'HI': '15', 'ID': '16', 'IL': '17', 'IN': '18', 'IA': '19',
            'KS': '20', 'KY': '21', 'LA': '22', 'ME': '23', 'MD': '24',
            'MA': '25', 'MI': '26', 'MN': '27', 'MS': '28', 'MO': '29',
            'MT': '30', 'NE': '31', 'NV': '32', 'NH': '33', 'NJ': '34',
            'NM': '35', 'NY': '36', 'NC': '37', 'ND': '38', 'OH': '39',
            'OK': '40', 'OR': '41', 'PA': '42', 'RI': '44', 'SC': '45',
            'SD': '46', 'TN': '47', 'TX': '48', 'UT': '49', 'VT': '50',
            'VA': '51', 'WA': '53', 'WV': '54', 'WI': '55', 'WY': '56',
            'DC': '11', 'PR': '72'
        }


def save_data_with_manifest(data: List[Dict], filename: str, output_dir: Path,
                          description: str, source_url: str) -> None:
    """Save data as CSV and update manifest."""
    if not data:
        logging.warning(f"No data to save for {description}")
        return

    # Convert to DataFrame and save
    df = pd.DataFrame(data)
    csv_path = output_dir / filename
    df.to_csv(csv_path, index=False)

    # Update manifest
    manifest_path = output_dir / "manifest.json"

    manifest = {}
    if manifest_path.exists():
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)

    file_info = {
        'filename': filename,
        'description': description,
        'source_url': source_url,
        'download_timestamp': datetime.utcnow().isoformat() + 'Z',
        'record_count': len(data),
        'file_size_bytes': csv_path.stat().st_size,
        'columns': list(df.columns) if not df.empty else []
    }

    manifest[filename] = file_info

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    logging.info(f"Saved {len(data)} records to {csv_path}")


def save_geospatial_manifest(filename: str, output_dir: Path, description: str,
                           source_url: str, format_type: str) -> None:
    """Save geospatial file info to manifest."""
    file_path = output_dir / filename
    if not file_path.exists():
        logging.warning(f"Geospatial file not found: {filename}")
        return

    manifest_path = output_dir / "manifest.json"

    manifest = {}
    if manifest_path.exists():
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)

    file_info = {
        'filename': filename,
        'description': description,
        'source_url': source_url,
        'download_timestamp': datetime.utcnow().isoformat() + 'Z',
        'file_size_bytes': file_path.stat().st_size,
        'format': format_type,
        'coordinate_system': 'EPSG:4326 (WGS84)' if format_type == 'geoparquet' else 'varies'
    }

    manifest[filename] = file_info

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    logging.info(f"Saved geospatial file: {filename} ({format_type})")


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Download geospatial public data",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--datasets',
        nargs='+',
        choices=['tiger', 'natural-earth', 'epa-frs', 'all'],
        default=['all'],
        help='Datasets to download'
    )
    parser.add_argument(
        '--state',
        help='State for TIGER data (2-letter abbreviation, e.g., CA)'
    )
    parser.add_argument(
        '--tiger-level',
        choices=['states', 'counties', 'tracts'],
        default='states',
        help='TIGER geographic level to download'
    )
    parser.add_argument(
        '--natural-earth-resolution',
        choices=['10m', '50m', '110m'],
        default='50m',
        help='Natural Earth data resolution'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/geospatial/data/raw/',
        help='Output directory for downloaded files'
    )
    parser.add_argument(
        '--year',
        default='2023',
        help='Year for TIGER data'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    setup_logging(args.verbose)

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Initialize downloader
    downloader = GeospatialDownloader()

    # Change to output directory for geospatial files
    original_cwd = os.getcwd()
    os.chdir(output_dir)

    try:
        # Determine datasets to download
        datasets = args.datasets
        if 'all' in datasets:
            datasets = ['tiger', 'natural-earth', 'epa-frs']

        # Download each dataset
        for dataset in datasets:
            if dataset == 'tiger':
                logging.info(f"Downloading TIGER {args.tiger_level} for {args.year}")

                if args.tiger_level == 'states':
                    filename = downloader.download_tiger_states(args.year)
                    if filename:
                        save_geospatial_manifest(
                            filename, Path("."),
                            f"TIGER State Boundaries {args.year}",
                            downloader.TIGER_BASE_URL,
                            'geoparquet' if filename.endswith('.parquet') else 'shapefile'
                        )

                elif args.tiger_level == 'counties':
                    state_fips = None
                    if args.state:
                        fips_codes = downloader.get_state_fips_codes()
                        state_fips = fips_codes.get(args.state.upper())

                    filename = downloader.download_tiger_counties(state_fips, args.year)
                    if filename:
                        save_geospatial_manifest(
                            filename, Path("."),
                            f"TIGER County Boundaries {args.year}",
                            downloader.TIGER_BASE_URL,
                            'geoparquet' if filename.endswith('.parquet') else 'shapefile'
                        )

                elif args.tiger_level == 'tracts':
                    if not args.state:
                        logging.error("State required for tract-level TIGER data")
                        continue

                    fips_codes = downloader.get_state_fips_codes()
                    state_fips = fips_codes.get(args.state.upper())
                    if not state_fips:
                        logging.error(f"Invalid state code: {args.state}")
                        continue

                    filename = downloader.download_tiger_tracts(state_fips, args.year)
                    if filename:
                        save_geospatial_manifest(
                            filename, Path("."),
                            f"TIGER Census Tracts {args.state.upper()} {args.year}",
                            downloader.TIGER_BASE_URL,
                            'geoparquet' if filename.endswith('.parquet') else 'shapefile'
                        )

            elif dataset == 'natural-earth':
                logging.info(f"Downloading Natural Earth data ({args.natural_earth_resolution})")

                # Download countries
                filename = downloader.download_natural_earth_countries(args.natural_earth_resolution)
                if filename:
                    save_geospatial_manifest(
                        filename, Path("."),
                        f"Natural Earth Country Boundaries ({args.natural_earth_resolution})",
                        "https://www.naturalearthdata.com/",
                        'geoparquet' if filename.endswith('.parquet') else 'shapefile'
                    )

                # Download coastlines
                filename = downloader.download_natural_earth_coastlines(args.natural_earth_resolution)
                if filename:
                    save_geospatial_manifest(
                        filename, Path("."),
                        f"Natural Earth Coastlines ({args.natural_earth_resolution})",
                        "https://www.naturalearthdata.com/",
                        'geoparquet' if filename.endswith('.parquet') else 'shapefile'
                    )

            elif dataset == 'epa-frs':
                logging.info("Downloading EPA FRS facility data")
                data = downloader.download_epa_frs_facilities()

                save_data_with_manifest(
                    data, "epa_frs_facilities.csv", Path("."),
                    "EPA Facility Registry Service (FRS) facility locations",
                    downloader.EPA_FRS_URL
                )

        # Save FIPS codes reference
        fips_codes = downloader.get_state_fips_codes()
        fips_path = Path(".") / "state_fips_codes.json"
        with open(fips_path, 'w') as f:
            json.dump({
                'fips_codes': fips_codes,
                'description': 'State FIPS codes for TIGER data downloads',
                'generated': datetime.utcnow().isoformat() + 'Z'
            }, f, indent=2)

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)

    finally:
        # Return to original directory
        os.chdir(original_cwd)


if __name__ == "__main__":
    main()