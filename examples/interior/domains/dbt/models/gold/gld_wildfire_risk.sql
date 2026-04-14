{{ config(
    materialized='table',
    tags=['gold', 'wildfire_risk', 'fire', 'analytics']
) }}

{#
    Gold Layer: Wildfire Risk Composite

    Combines drought conditions, vegetation dryness proxies, weather patterns,
    and historical fire data to produce a composite wildfire risk score.

    Risk Factors and Weights (configured in dbt_project.yml):
    1. Drought Index ({{ var('drought_weight') * 100 }}%):
       Based on water gauge data showing below-normal streamflow.
       Prolonged drought = dry vegetation = higher fire risk.

    2. Vegetation Dryness ({{ var('vegetation_weight') * 100 }}%):
       Proxy from seasonal precipitation deficit (spring/summer rainfall
       compared to historical average). In production, would use NDVI
       satellite data.

    3. Weather/Wind Risk ({{ var('weather_weight') * 100 }}%):
       Based on regional climate patterns — areas with hot, dry, windy
       conditions (Santa Ana winds, Chinooks) score higher.

    4. Historical Fire Frequency ({{ var('historical_fire_weight') * 100 }}%):
       Regions with more frequent historical fires have higher baseline risk.
       Uses earthquake catalog as proxy for geologic/geographic regions
       (production would use NIFC fire perimeter data).

    Output: One row per state per year with composite fire risk and components.

    NOTE: This is a demonstration model using available data sources
    (water gauges, seismic regions) as proxies. Production implementation
    would incorporate NIFC fire perimeter data, MODIS/VIIRS satellite fire
    detections, NDVI vegetation indices, and gridMET weather data.
#}

WITH -- Step 1: Drought conditions from water gauge data
-- Aggregate drought conditions by state and year
drought_conditions AS (
    SELECT
        state_code,
        measurement_year AS year,
        -- Proportion of measurements in drought conditions
        ROUND(
            COUNT(CASE WHEN drought_index IN ('EXTREME_DROUGHT', 'MODERATE_DROUGHT')
                       THEN 1 END)::DECIMAL
            / NULLIF(COUNT(*), 0) * 100, 2
        ) AS pct_drought_readings,
        -- Proportion in extreme drought
        ROUND(
            COUNT(CASE WHEN drought_index = 'EXTREME_DROUGHT' THEN 1 END)::DECIMAL
            / NULLIF(COUNT(*), 0) * 100, 2
        ) AS pct_extreme_drought,
        -- Average flow relative to median (lower = drier)
        ROUND(AVG(estimated_percentile), 1) AS avg_flow_percentile,
        -- Number of gauge sites in drought
        COUNT(DISTINCT CASE WHEN drought_index IN ('EXTREME_DROUGHT', 'MODERATE_DROUGHT')
                            THEN site_id END) AS drought_gauge_count,
        COUNT(DISTINCT site_id) AS total_gauge_count,
        -- Summer drought specifically (fire season)
        ROUND(
            COUNT(CASE WHEN drought_index IN ('EXTREME_DROUGHT', 'MODERATE_DROUGHT')
                            AND season IN ('SUMMER', 'FALL')
                       THEN 1 END)::DECIMAL
            / NULLIF(COUNT(CASE WHEN season IN ('SUMMER', 'FALL') THEN 1 END), 0) * 100, 2
        ) AS pct_fire_season_drought
    FROM {{ ref('slv_water_resources') }}
    WHERE parameter_code = '00060'  -- Streamflow only
    GROUP BY state_code, measurement_year
),

-- Step 2: Vegetation dryness proxy
-- Using spring/summer precipitation deficit as proxy for vegetation moisture
-- (In production, would use NDVI satellite data)
vegetation_dryness AS (
    SELECT
        state_code,
        measurement_year AS year,
        -- Vegetation dryness score (0-100):
        -- Higher score = drier vegetation = higher fire risk
        -- Based on ratio of dry readings during growing season
        ROUND(
            LEAST(100,
                COALESCE(
                    COUNT(CASE WHEN drought_index IN ('EXTREME_DROUGHT', 'MODERATE_DROUGHT')
                                    AND season IN ('SPRING', 'SUMMER')
                               THEN 1 END)::DECIMAL
                    / NULLIF(COUNT(CASE WHEN season IN ('SPRING', 'SUMMER') THEN 1 END), 0) * 150,
                    50  -- Default moderate dryness
                )
            ), 2
        ) AS vegetation_dryness_score
    FROM {{ ref('slv_water_resources') }}
    WHERE parameter_code = '00060'
    GROUP BY state_code, measurement_year
),

-- Step 3: Weather/wind risk patterns by region
-- Static risk factors based on known fire weather patterns
weather_risk AS (
    SELECT state_code, wind_risk_factor FROM (VALUES
        ('CA', 90),  -- Santa Ana winds, Diablo winds
        ('OR', 65),  -- East wind events
        ('WA', 55),  -- East wind events
        ('MT', 70),  -- Chinook winds
        ('ID', 65),  -- Dry lightning
        ('WY', 60),  -- Chinook winds
        ('CO', 75),  -- Chinook winds, dry conditions
        ('NM', 70),  -- Southwest monsoon failure
        ('AZ', 75),  -- Extreme heat, low humidity
        ('UT', 60),  -- Dry lightning
        ('NV', 65),  -- Dry lightning, wind events
        ('TX', 55),  -- Grassland fire weather
        ('OK', 50)   -- Grassland fire weather
    ) AS t(state_code, wind_risk_factor)
),

-- Step 4: Historical seismic activity as geographic region proxy
-- (In production, replace with actual NIFC fire history data)
-- For now, approximate fire-prone regions from geographic patterns
historical_fire_proxy AS (
    SELECT
        seismic_region,
        event_year AS year,
        -- Map seismic regions to approximate fire regions
        CASE
            WHEN seismic_region = 'CALIFORNIA' THEN 85
            WHEN seismic_region = 'CASCADIA' THEN 65
            WHEN seismic_region = 'INTERMOUNTAIN' THEN 70
            WHEN seismic_region = 'CENTRAL_US' THEN 30
            WHEN seismic_region = 'EASTERN_US' THEN 15
            WHEN seismic_region = 'ALASKA' THEN 55
            WHEN seismic_region = 'HAWAII' THEN 20
            ELSE 25
        END AS historical_fire_frequency_score
    FROM {{ ref('slv_earthquake_events') }}
    GROUP BY seismic_region, event_year
),

-- Step 5: State-level fire history score
-- Approximate from wildfire-prone state list
state_fire_history AS (
    SELECT state_code, historical_fire_score FROM (VALUES
        ('CA', 95), ('OR', 70), ('WA', 60), ('MT', 75), ('ID', 70),
        ('WY', 55), ('CO', 75), ('NM', 65), ('AZ', 70), ('UT', 55),
        ('NV', 50), ('TX', 45), ('OK', 40), ('GA', 30), ('FL', 35),
        ('NC', 25), ('SC', 25), ('AL', 20), ('MS', 20), ('LA', 15)
    ) AS t(state_code, historical_fire_score)
),

-- Step 6: Combine all risk factors into composite score
combined AS (
    SELECT
        d.state_code,
        CASE
            WHEN d.state_code IN ('CA','OR','WA','MT','ID','WY','CO','NM','AZ','UT','NV')
            THEN 'WESTERN'
            WHEN d.state_code IN ('TX','OK','KS','NE','SD','ND') THEN 'GREAT_PLAINS'
            WHEN d.state_code IN ('GA','FL','NC','SC','AL','MS','LA') THEN 'SOUTHEAST'
            ELSE 'OTHER'
        END AS region_name,
        d.year,

        -- Drought component
        d.pct_drought_readings,
        d.pct_extreme_drought,
        d.avg_flow_percentile,
        d.pct_fire_season_drought,

        -- Drought score (0-100, higher = drier)
        ROUND(LEAST(100,
            COALESCE(d.pct_fire_season_drought, d.pct_drought_readings * 1.2, 30)
        ), 2) AS drought_index,

        -- Vegetation dryness
        COALESCE(v.vegetation_dryness_score, 50) AS vegetation_dryness_score,

        -- Weather/wind risk
        COALESCE(w.wind_risk_factor, 30) AS wind_risk_factor,

        -- Historical fire frequency
        COALESCE(f.historical_fire_score, 20) AS historical_fire_frequency,

        -- Composite fire risk score (weighted combination)
        ROUND(
            {{ var('drought_weight') }} * LEAST(100, COALESCE(d.pct_fire_season_drought, d.pct_drought_readings * 1.2, 30))
            + {{ var('vegetation_weight') }} * COALESCE(v.vegetation_dryness_score, 50)
            + {{ var('weather_weight') }} * COALESCE(w.wind_risk_factor, 30)
            + {{ var('historical_fire_weight') }} * COALESCE(f.historical_fire_score, 20),
            2
        ) AS composite_fire_risk,

        -- Water gauge monitoring density
        d.drought_gauge_count,
        d.total_gauge_count

    FROM drought_conditions d
    LEFT JOIN vegetation_dryness v ON d.state_code = v.state_code AND d.year = v.year
    LEFT JOIN weather_risk w ON d.state_code = w.state_code
    LEFT JOIN state_fire_history f ON d.state_code = f.state_code
    -- Only include wildfire-relevant states
    WHERE d.state_code IN ({{ var('wildfire_states') | map('quote') | join(', ') }})
),

-- Step 7: Add risk categories and recommendations
final AS (
    SELECT
        *,
        -- Risk category
        CASE
            WHEN composite_fire_risk >= 80 THEN 'EXTREME'
            WHEN composite_fire_risk >= 60 THEN 'HIGH'
            WHEN composite_fire_risk >= 40 THEN 'MODERATE'
            WHEN composite_fire_risk >= 20 THEN 'LOW'
            ELSE 'MINIMAL'
        END AS risk_category,

        -- Recommended alert level
        CASE
            WHEN composite_fire_risk >= 80 THEN 'RED_FLAG_WARNING'
            WHEN composite_fire_risk >= 60 THEN 'FIRE_WEATHER_WATCH'
            WHEN composite_fire_risk >= 40 THEN 'ELEVATED_AWARENESS'
            ELSE 'NORMAL_OPERATIONS'
        END AS recommended_alert_level,

        -- Dominant risk factor
        CASE
            WHEN drought_index >= vegetation_dryness_score
                 AND drought_index >= wind_risk_factor
                 AND drought_index >= historical_fire_frequency
                THEN 'DROUGHT'
            WHEN vegetation_dryness_score >= wind_risk_factor
                 AND vegetation_dryness_score >= historical_fire_frequency
                THEN 'VEGETATION_DRYNESS'
            WHEN wind_risk_factor >= historical_fire_frequency
                THEN 'WIND_WEATHER'
            ELSE 'HISTORICAL_PATTERN'
        END AS dominant_risk_factor,

        -- Ranking
        ROW_NUMBER() OVER (PARTITION BY year ORDER BY composite_fire_risk DESC)
            AS state_fire_risk_rank,

        -- Year context
        year AS analysis_year,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM combined
)

SELECT * FROM final
ORDER BY analysis_year DESC, composite_fire_risk DESC
