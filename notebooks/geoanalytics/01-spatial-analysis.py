# Databricks notebook source
# MAGIC %md
# MAGIC # Spatial Analysis with CSA-in-a-Box GeoAnalytics
# MAGIC
# MAGIC This notebook demonstrates advanced geospatial analysis using the CSA-in-a-Box GeoAnalytics module.
# MAGIC
# MAGIC **Workflow:**
# MAGIC 1. Install and configure geospatial libraries
# MAGIC 2. Load GeoParquet data from Azure Data Lake
# MAGIC 3. Create H3 hexagonal grid for spatial indexing
# MAGIC 4. Perform spatial aggregation by hexagon
# MAGIC 5. Join with demographic data for enrichment
# MAGIC 6. Visualize results and patterns
# MAGIC 7. Save processed data to Gold layer

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 1: Install Required Libraries

# MAGIC %pip install geopandas h3 pyproj shapely apache-sedona matplotlib folium contextily

# Restart Python to ensure packages are loaded
dbutils.library.restartPython()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 2: Setup and Load Data from ADLS

# Import required libraries
import geopandas as gpd
import pandas as pd
import matplotlib.pyplot as plt
import folium
from pyspark.sql import SparkSession
from azure.identity import DefaultAzureCredential
import warnings
warnings.filterwarnings('ignore')

# Import CSA GeoAnalytics modules
import sys
sys.path.append('/Workspace/Repos/csa-inabox')

from csa_platform.geoanalytics import GeoProcessor, H3Indexer, SpatialJoiner
from csa_platform.geoanalytics.geo_processor import GeoProcessingConfig

# Configure GeoAnalytics
config = GeoProcessingConfig(
    h3_resolution=8,
    azure_storage_account="csainaboxdata",  # Replace with your storage account
    azure_container="gold"
)

geo_processor = GeoProcessor(config)
h3_indexer = H3Indexer(resolution=8)

print("✅ Libraries and configuration loaded successfully")

# COMMAND ----------

# Load sample geospatial data from ADLS
# This could be any geospatial dataset (facilities, sensors, events, etc.)

# For demonstration, we'll create sample data and then show ADLS loading pattern
import numpy as np
from shapely.geometry import Point

# Create sample facility data
np.random.seed(42)
n_facilities = 1000

# Generate facilities around major US cities
cities = {
    'New York': (-74.0, 40.7),
    'Los Angeles': (-118.2, 34.0),
    'Chicago': (-87.6, 41.8),
    'Houston': (-95.4, 29.8),
    'Phoenix': (-112.1, 33.4)
}

facilities_data = []
for city, (lng, lat) in cities.items():
    n_city_facilities = n_facilities // len(cities)

    # Add some random scatter around each city
    lngs = np.random.normal(lng, 0.5, n_city_facilities)
    lats = np.random.normal(lat, 0.5, n_city_facilities)

    for i in range(n_city_facilities):
        facilities_data.append({
            'facility_id': f"{city}_{i:03d}",
            'city': city,
            'facility_type': np.random.choice(['Manufacturing', 'Warehouse', 'Retail', 'Office']),
            'value': np.random.exponential(100),  # Some metric to aggregate
            'geometry': Point(lngs[i], lats[i])
        })

facilities_gdf = gpd.GeoDataFrame(facilities_data, crs="EPSG:4326")

# Display basic info
print(f"📊 Loaded {len(facilities_gdf)} facilities")
print(f"🌍 CRS: {facilities_gdf.crs}")
print(f"📦 Facility types: {facilities_gdf['facility_type'].value_counts().to_dict()}")

# Show sample of data
display(facilities_gdf.head())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 3: H3 Hexagonal Indexing
# MAGIC
# MAGIC Convert point data to H3 hexagonal grid for spatial aggregation

# Add H3 indices to facilities
facilities_h3 = geo_processor.h3_index(facilities_gdf)

# Create H3 grid covering the data extent
h3_grid = geo_processor.create_h3_grid(facilities_gdf, resolution=8)

print(f"🔷 Added H3 indices to facilities")
print(f"🔷 Created H3 grid with {len(h3_grid)} hexagons")
print(f"🔷 Sample H3 indices: {facilities_h3['h3_index'].head().tolist()}")

# Show the H3 index distribution
h3_counts = facilities_h3['h3_index'].value_counts()
print(f"🔷 Facilities per hexagon - Mean: {h3_counts.mean():.1f}, Max: {h3_counts.max()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 4: Spatial Aggregation by Hexagon

# Aggregate facilities by H3 hexagon
h3_aggregated = facilities_h3.groupby('h3_index').agg({
    'value': ['sum', 'mean', 'count'],
    'facility_type': lambda x: x.value_counts().to_dict(),
    'city': lambda x: x.mode().iloc[0] if len(x.mode()) > 0 else 'Mixed'
}).round(2)

# Flatten column names
h3_aggregated.columns = ['total_value', 'avg_value', 'facility_count', 'facility_types', 'primary_city']
h3_aggregated = h3_aggregated.reset_index()

# Join with H3 grid geometries
h3_analysis = h3_grid.merge(h3_aggregated, on='h3_index', how='left')
h3_analysis = h3_analysis.fillna(0)

# Calculate density metrics
# H3 resolution 8 hexagons are approximately 0.737 km² each
hex_area_km2 = 0.737
h3_analysis['facility_density_per_km2'] = h3_analysis['facility_count'] / hex_area_km2
h3_analysis['value_density_per_km2'] = h3_analysis['total_value'] / hex_area_km2

print(f"📈 H3 Spatial Aggregation Results:")
print(f"   - Hexagons with facilities: {len(h3_analysis[h3_analysis['facility_count'] > 0])}")
print(f"   - Max facilities per hex: {h3_analysis['facility_count'].max()}")
print(f"   - Max facility density: {h3_analysis['facility_density_per_km2'].max():.1f} facilities/km²")

# Show top hexagons by facility count
top_hexes = h3_analysis.nlargest(10, 'facility_count')[
    ['h3_index', 'facility_count', 'total_value', 'primary_city']
]
print(f"\n🏆 Top 10 Hexagons by Facility Count:")
display(top_hexes)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 5: Join with Demographic Data
# MAGIC
# MAGIC Enrich spatial analysis with demographic and economic data

# Create sample demographic data for cities
# In practice, this would come from Census or other demographic sources
demographics = pd.DataFrame([
    {'city': 'New York', 'population': 8400000, 'median_income': 65000, 'density': 11000},
    {'city': 'Los Angeles', 'population': 4000000, 'median_income': 62000, 'density': 3200},
    {'city': 'Chicago', 'population': 2700000, 'median_income': 58000, 'density': 4600},
    {'city': 'Houston', 'population': 2300000, 'median_income': 52000, 'density': 1400},
    {'city': 'Phoenix', 'population': 1700000, 'median_income': 55000, 'density': 1200}
])

# Join H3 analysis with demographic data
h3_enriched = h3_analysis.merge(demographics, left_on='primary_city', right_on='city', how='left')

# Calculate enriched metrics
h3_enriched['facilities_per_capita'] = (
    h3_enriched['facility_count'] / (h3_enriched['population'] / 1000000)  # Per million people
).round(3)

h3_enriched['value_per_capita'] = (
    h3_enriched['total_value'] / (h3_enriched['population'] / 1000000)
).round(2)

# Show enriched analysis
print(f"🎯 Demographic Enrichment Results:")
print(f"   - Cities analyzed: {h3_enriched['city'].nunique()}")
print(f"   - Total population represented: {h3_enriched['population'].sum():,}")

# City-level summary
city_summary = h3_enriched.groupby('city').agg({
    'facility_count': 'sum',
    'total_value': 'sum',
    'population': 'first',
    'median_income': 'first'
}).round(2)

city_summary['facilities_per_100k_pop'] = (
    city_summary['facility_count'] / city_summary['population'] * 100000
).round(1)

print(f"\n🏙️ City-Level Summary:")
display(city_summary.sort_values('facilities_per_100k_pop', ascending=False))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 6: Visualization with Matplotlib
# MAGIC
# MAGIC Create maps and charts to visualize spatial patterns

# Create visualization
fig, axes = plt.subplots(2, 2, figsize=(20, 16))

# 1. Facility density by H3 hexagon
ax1 = axes[0, 0]
h3_enriched[h3_enriched['facility_count'] > 0].plot(
    column='facility_density_per_km2',
    cmap='Reds',
    legend=True,
    ax=ax1,
    edgecolor='white',
    linewidth=0.1
)
ax1.set_title('Facility Density per H3 Hexagon (facilities/km²)', fontsize=14, pad=20)
ax1.axis('off')

# 2. Total value by hexagon
ax2 = axes[0, 1]
h3_enriched[h3_enriched['total_value'] > 0].plot(
    column='total_value',
    cmap='Blues',
    legend=True,
    ax=ax2,
    edgecolor='white',
    linewidth=0.1
)
ax2.set_title('Total Value by H3 Hexagon', fontsize=14, pad=20)
ax2.axis('off')

# 3. Facilities per capita by city
ax3 = axes[1, 0]
city_summary_reset = city_summary.reset_index()
bars = ax3.bar(city_summary_reset['city'], city_summary_reset['facilities_per_100k_pop'])
ax3.set_title('Facilities per 100k Population by City', fontsize=14, pad=20)
ax3.tick_params(axis='x', rotation=45)
ax3.set_ylabel('Facilities per 100k Population')

# Color bars by value
for bar, value in zip(bars, city_summary_reset['facilities_per_100k_pop']):
    bar.set_color(plt.cm.viridis(value / city_summary_reset['facilities_per_100k_pop'].max()))

# 4. Facility types distribution
ax4 = axes[1, 1]
facility_types = facilities_gdf['facility_type'].value_counts()
wedges, texts, autotexts = ax4.pie(
    facility_types.values,
    labels=facility_types.index,
    autopct='%1.1f%%',
    startangle=90
)
ax4.set_title('Distribution of Facility Types', fontsize=14, pad=20)

plt.tight_layout()
plt.savefig('/tmp/spatial_analysis_results.png', dpi=300, bbox_inches='tight')
plt.show()

print("📊 Visualizations created successfully")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 7: Save Results to Gold Layer
# MAGIC
# MAGIC Save processed geospatial data for downstream analytics

# Convert to Spark DataFrames for saving to Delta tables
spark = SparkSession.getActiveSession()

# Prepare data for Delta Lake storage
# Convert geometries to WKT for Spark compatibility
facilities_for_delta = facilities_h3.copy()
facilities_for_delta['geometry_wkt'] = facilities_for_delta['geometry'].apply(lambda geom: geom.wkt)
facilities_for_delta = facilities_for_delta.drop('geometry', axis=1)

h3_for_delta = h3_enriched.copy()
h3_for_delta['geometry_wkt'] = h3_for_delta['geometry'].apply(lambda geom: geom.wkt)
h3_for_delta = h3_for_delta.drop('geometry', axis=1)

# Convert to Spark DataFrames
facilities_spark = spark.createDataFrame(facilities_for_delta)
h3_analysis_spark = spark.createDataFrame(h3_for_delta)

# Save to Delta tables in Gold layer
# Replace with your actual Delta table paths

# Save facilities with H3 indices
facilities_spark.write \
    .format("delta") \
    .mode("overwrite") \
    .option("mergeSchema", "true") \
    .saveAsTable("gold.geoanalytics_facilities_h3")

# Save H3 aggregated analysis
h3_analysis_spark.write \
    .format("delta") \
    .mode("overwrite") \
    .option("mergeSchema", "true") \
    .saveAsTable("gold.geoanalytics_h3_analysis")

# Save city summary
city_summary_spark = spark.createDataFrame(city_summary.reset_index())
city_summary_spark.write \
    .format("delta") \
    .mode("overwrite") \
    .option("mergeSchema", "true") \
    .saveAsTable("gold.geoanalytics_city_summary")

print("💾 Data successfully saved to Gold layer Delta tables:")
print("   - gold.geoanalytics_facilities_h3")
print("   - gold.geoanalytics_h3_analysis")
print("   - gold.geoanalytics_city_summary")

# Also save as GeoParquet for direct geospatial use
facilities_h3.to_parquet("/tmp/facilities_h3.parquet")
h3_enriched.to_parquet("/tmp/h3_analysis_enriched.parquet")

print("\n📁 GeoParquet files also saved:")
print("   - /tmp/facilities_h3.parquet")
print("   - /tmp/h3_analysis_enriched.parquet")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary and Next Steps
# MAGIC
# MAGIC This notebook demonstrated a complete geospatial analysis workflow using CSA-in-a-Box GeoAnalytics:
# MAGIC
# MAGIC ### ✅ What We Accomplished:
# MAGIC
# MAGIC 1. **Loaded geospatial data** - Demonstrated loading patterns for Azure Data Lake
# MAGIC 2. **H3 spatial indexing** - Created hexagonal grid for consistent spatial aggregation
# MAGIC 3. **Spatial aggregation** - Calculated facility density and value metrics by hexagon
# MAGIC 4. **Data enrichment** - Joined with demographic data for deeper insights
# MAGIC 5. **Visualization** - Created maps and charts to reveal spatial patterns
# MAGIC 6. **Data persistence** - Saved results to Delta tables and GeoParquet formats
# MAGIC
# MAGIC ### 🔄 Key Benefits of H3 Hexagonal Grid:
# MAGIC
# MAGIC - **Consistent area**: All hexagons at same resolution have equal area
# MAGIC - **No edge effects**: Better neighbor relationships than square grids
# MAGIC - **Multi-resolution**: Can aggregate up/down resolution levels
# MAGIC - **Global standard**: Compatible with other H3-based systems
# MAGIC
# MAGIC ### 🚀 Next Steps:
# MAGIC
# MAGIC 1. **Scale up**: Process larger datasets using Spark and Sedona
# MAGIC 2. **Real-time analysis**: Integrate with streaming data sources
# MAGIC 3. **Advanced analytics**: Add machine learning for spatial prediction
# MAGIC 4. **Dashboard integration**: Connect to Power BI or Tableau for business users
# MAGIC 5. **API development**: Expose spatial analytics as REST services
# MAGIC
# MAGIC ### 📚 Additional Resources:
# MAGIC
# MAGIC - [H3 Documentation](https://h3geo.org/)
# MAGIC - [GeoPandas User Guide](https://geopandas.org/)
# MAGIC - [Apache Sedona Documentation](https://sedona.apache.org/)
# MAGIC - [PostGIS Spatial Functions](https://postgis.net/docs/reference.html)

# COMMAND ----------

# Display final summary statistics
print("="*60)
print("SPATIAL ANALYSIS SUMMARY")
print("="*60)
print(f"Total Facilities Analyzed: {len(facilities_gdf):,}")
print(f"H3 Hexagons Created: {len(h3_grid):,}")
print(f"Hexagons with Data: {len(h3_enriched[h3_enriched['facility_count'] > 0]):,}")
print(f"Cities Analyzed: {len(demographics)}")
print(f"Max Facility Density: {h3_enriched['facility_density_per_km2'].max():.1f} facilities/km²")
print(f"Analysis Resolution: H3 Level {config.h3_resolution}")
print("="*60)

# Show data quality metrics
data_quality = {
    "Facilities with valid H3": len(facilities_h3.dropna(subset=['h3_index'])),
    "Facilities with geometry": len(facilities_gdf.dropna(subset=['geometry'])),
    "H3 hexagons with facilities": len(h3_enriched[h3_enriched['facility_count'] > 0]),
    "Cities with demographic data": len(h3_enriched.dropna(subset=['population']))
}

print("\n📊 Data Quality Metrics:")
for metric, value in data_quality.items():
    print(f"   {metric}: {value:,}")

print(f"\n✅ Notebook execution completed successfully!")
print(f"🔍 Check the Gold layer tables for persistent analytical datasets")
print(f"📈 Use the saved GeoParquet files for further geospatial analysis")