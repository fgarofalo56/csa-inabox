# Public Data Download Scripts

This directory contains Python scripts for downloading public data from various US government agencies and organizations. These scripts are designed for CSA-in-a-Box tutorials, demonstrations, and research purposes.

## Overview

| Script | Description | Data Source | Output Format |
|--------|-------------|-------------|---------------|
| `download-usda.py` | Agricultural data (crop yields, livestock, land use) | USDA NASS QuickStats API | CSV |
| `download-noaa.py` | Weather data (GHCN-Daily, Storm Events) | NOAA NCEI | CSV |
| `download-epa.py` | Air quality and toxics data | EPA AQS, TRI | CSV |
| `download-census.py` | Demographics and housing data | US Census Bureau API | CSV |
| `download-commerce.py` | Retail and economic data | Commerce Department | CSV |
| `download-dot.py` | Transportation data (FARS, airline) | DOT agencies | CSV |
| `download-health.py` | Healthcare data (Medicare, CMS) | CMS Public Use Files | CSV |
| `download-geospatial.py` | Geographic boundaries and locations | Census TIGER, Natural Earth, EPA | Shapefile/GeoParquet |
| `download-streaming.py` | Real-time data feeds | USGS, NOAA, Wikimedia | JSONL |

## Installation Requirements

### Core Dependencies

```bash
pip install requests pandas tqdm
```

### Optional Dependencies

```bash
# For geospatial data processing
pip install geopandas

# For streaming data
pip install sseclient-py azure-eventhub
```

### API Keys Required

Some scripts require API keys:

- **USDA NASS**: Register at https://quickstats.nass.usda.gov/api (free)
- **Census Bureau**: Register at https://api.census.gov/data/key_signup.html (free)

Set environment variables or pass as command-line arguments:
```bash
export NASS_API_KEY="your_nass_api_key"
export CENSUS_API_KEY="your_census_api_key"
```

## Quick Start Examples

### Download 2023 USDA crop data for California

```bash
python download-usda.py --api-key YOUR_KEY --year 2023 --state CA --datasets crops
```

### Download weather data for Texas stations

```bash
python download-noaa.py --year 2023 --state TX --datasets ghcn --max-stations 5
```

### Download EPA air quality data (ozone)

```bash
python download-epa.py --year 2022 --dataset aqs --aqs-type daily --pollutant 44201
```

### Download Census demographics for all states

```bash
python download-census.py --api-key YOUR_KEY --year 2022 --geography "state:*"
```

### Download geospatial state boundaries

```bash
python download-geospatial.py --datasets tiger --tiger-level states
```

### Collect real-time earthquake data for 5 minutes

```bash
python download-streaming.py --feed earthquake --duration-seconds 300
```

## Detailed Script Documentation

### USDA Agricultural Data (`download-usda.py`)

Downloads crop yields, livestock counts, and land use from USDA NASS QuickStats API.

**Usage:**
```bash
python download-usda.py [OPTIONS]
```

**Key Options:**
- `--api-key`: NASS API key (required)
- `--year`: Year to download (default: 2023)
- `--state`: State filter (2-letter code, default: all states)
- `--datasets`: crops, livestock, landuse, or all
- `--output-dir`: Output directory (default: examples/usda/data/raw/)

**Example Output:**
```
examples/usda/data/raw/
├── crop_yields_2023.csv
├── livestock_counts_2023.csv
├── land_use_2023.csv
└── manifest.json
```

**Data Description:**
- Crop yields by state and commodity
- Livestock inventory counts by type and state  
- Agricultural land use by crop type and state
- Supports pagination for large datasets (50k+ records)

### NOAA Weather Data (`download-noaa.py`)

Downloads weather station data and storm events from NOAA.

**Usage:**
```bash
python download-noaa.py [OPTIONS]
```

**Key Options:**
- `--year`: Year to download (default: 2023)
- `--state`: State for weather stations (2-letter code)
- `--stations`: Comma-separated station IDs
- `--datasets`: ghcn, storms, or all
- `--max-stations`: Max stations when not specified (default: 10)

**Data Sources:**
- GHCN-Daily: Daily weather observations (temperature, precipitation)
- Storm Events: Severe weather events (tornadoes, floods, etc.)

### EPA Environmental Data (`download-epa.py`)

Downloads air quality and toxics release data from EPA.

**Usage:**
```bash
python download-epa.py [OPTIONS]
```

**Key Options:**
- `--year`: Year to download (default: 2023)
- `--dataset`: aqs, tri, or both
- `--aqs-type`: annual or daily
- `--pollutant`: EPA parameter code (44201=Ozone, 88101=PM2.5)

**Pollutant Codes:**
- 44201: Ozone
- 42401: Sulfur dioxide  
- 42101: Carbon monoxide
- 88101: PM2.5

### Census Demographics (`download-census.py`)

Downloads demographic and housing data from US Census Bureau.

**Usage:**
```bash
python download-census.py [OPTIONS]
```

**Key Options:**
- `--api-key`: Census API key (optional for some data)
- `--year`: Year to download (default: 2022)
- `--variables`: Variable codes (default: common demographics)
- `--geography`: Geographic level (state:*, county:*, etc.)
- `--dataset`: acs5, acs1, or decennial

**Example Variables:**
- B01003_001E: Total Population
- B19013_001E: Median Household Income
- B25003_002E: Owner Occupied Housing Units

### Commerce Retail Data (`download-commerce.py`)

Downloads retail trade and economic data from Commerce Department.

**Usage:**
```bash
python download-commerce.py [OPTIONS]
```

**Datasets:**
- Monthly Retail Trade Survey
- E-commerce retail sales
- Business Formation Statistics (where available)

### Transportation Data (`download-dot.py`)

Downloads crash and airline data from Department of Transportation.

**Usage:**
```bash
python download-dot.py [OPTIONS]
```

**Datasets:**
- FARS: Fatal crash data with multiple tables (accident, person, vehicle)
- Airline: On-time performance from Bureau of Transportation Statistics
- Traffic: Volume trends (where available)

### Health Data (`download-health.py`)

Downloads Medicare and healthcare data from CMS.

**Usage:**
```bash
python download-health.py [OPTIONS]
```

**Datasets:**
- Medicare Provider Utilization and Payment
- Medicare Inpatient Hospital Charges
- Nursing Home Compare
- Hospital General Information

### Geospatial Data (`download-geospatial.py`)

Downloads geographic boundaries and facility locations.

**Usage:**
```bash
python download-geospatial.py [OPTIONS]
```

**Key Options:**
- `--datasets`: tiger, natural-earth, epa-frs, or all
- `--state`: State for TIGER data (2-letter code)
- `--tiger-level`: states, counties, or tracts
- `--natural-earth-resolution`: 10m, 50m, or 110m

**Output Formats:**
- GeoParquet (if geopandas available) - recommended for performance
- Shapefile (fallback)

### Streaming Data (`download-streaming.py`)

Collects real-time data feeds for streaming tutorials.

**Usage:**
```bash
python download-streaming.py [OPTIONS]
```

**Key Options:**
- `--feed`: earthquake, weather, wikimedia, or all
- `--duration-seconds`: Collection duration (default: 60)
- `--output`: file or eventhub
- `--eventhub-connection-string`: Azure Event Hub connection

**Data Feeds:**
- USGS Earthquakes: Real-time seismic events
- NOAA Weather Alerts: Active weather warnings
- Wikimedia: Recent changes to Wikipedia articles

## Output Format

### Manifest Files

Each script creates a `manifest.json` file with metadata:

```json
{
  "crop_yields_2023.csv": {
    "filename": "crop_yields_2023.csv",
    "description": "Crop yields for 2023",
    "source_url": "https://quickstats.nass.usda.gov/api",
    "download_timestamp": "2024-04-22T20:15:30Z",
    "record_count": 15420,
    "file_size_bytes": 2458000,
    "columns": ["STATE_NAME", "COMMODITY_DESC", "YIELD", "UNIT_DESC", ...]
  }
}
```

### CSV Structure

All tabular data is saved as CSV with:
- Headers in first row
- UTF-8 encoding
- Proper escaping for commas and quotes
- Missing values as empty strings

### JSONL Format (Streaming)

Streaming data uses JSON Lines format:
```json
{"timestamp": "2024-04-22T20:15:30Z", "source": "usgs_earthquake", "data": {...}}
{"timestamp": "2024-04-22T20:16:30Z", "source": "usgs_earthquake", "data": {...}}
```

## Error Handling

All scripts include:
- Retry logic for network failures
- Graceful handling of missing data
- Progress bars for long downloads
- Detailed logging with timestamps
- Validation of API responses

## Data Freshness and Availability

| Source | Update Frequency | Typical Lag |
|--------|------------------|-------------|
| USDA NASS | Annual/Monthly | 3-6 months |
| NOAA Weather | Daily/Real-time | 1-2 days |
| EPA AQS | Daily | 1-3 months |
| Census ACS | Annual | 1 year |
| CMS Medicare | Annual | 6-12 months |
| DOT FARS | Annual | 6-18 months |
| TIGER Boundaries | Annual | Updated yearly |
| Streaming Feeds | Real-time | < 1 minute |

## Troubleshooting

### Common Issues

**API Key Errors:**
```bash
# Set environment variables
export NASS_API_KEY="your_key_here"
export CENSUS_API_KEY="your_key_here"

# Or pass explicitly  
python download-usda.py --api-key your_key_here
```

**Network Timeouts:**
- Scripts include retry logic
- Large downloads may take 10+ minutes
- Use `--verbose` flag for detailed progress

**Missing Dependencies:**
```bash
# Install optional packages as needed
pip install geopandas  # for geospatial processing
pip install sseclient-py azure-eventhub  # for streaming
```

**Data Not Available:**
- Recent years may not be published yet
- Try previous year if current year fails
- Check data source websites for availability

### Performance Tips

1. **Use state filters** when available to reduce download size
2. **Download geospatial data** in GeoParquet format (faster than shapefiles)  
3. **Stream to Event Hubs** for real-time processing scenarios
4. **Run multiple scripts** in parallel for different agencies
5. **Set appropriate timeouts** for large datasets

## Integration with CSA-in-a-Box

These scripts integrate with CSA-in-a-Box tutorials:

### Data Lake Ingestion
```bash
# Download to data lake raw zone
python download-usda.py --output-dir /mnt/datalake/raw/usda/
```

### Streaming Analytics
```bash
# Stream directly to Event Hub
python download-streaming.py --output eventhub --eventhub-connection-string "..."
```

### Azure Data Factory
The scripts can be called from ADF pipelines:
```json
{
  "name": "USDADownload",
  "type": "PythonActivity",
  "command": "python download-usda.py --api-key @{linkedService().apiKey}"
}
```

## Data Privacy and Compliance

All scripts download **public data only**:
- No personally identifiable information (PII)
- Aggregate statistics and geographic boundaries
- Publicly available government datasets
- Appropriate for research and educational use

For production use:
- Review data licensing terms
- Implement proper data governance
- Consider data retention policies
- Document data lineage

## Support and Contributing

For issues or improvements:
1. Check script logs with `--verbose` flag
2. Verify API keys and network connectivity
3. Review data source documentation
4. File issues with error details and command used

The scripts follow common patterns and can be extended for additional data sources following the same structure.

## License

These scripts are part of CSA-in-a-Box and subject to the project license. All downloaded data retains its original licensing from respective government agencies.