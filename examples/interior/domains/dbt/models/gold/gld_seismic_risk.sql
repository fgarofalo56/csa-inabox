{{ config(
    materialized='table',
    tags=['gold', 'seismic_risk', 'earthquake', 'analytics']
) }}

{#
    Gold Layer: Seismic Risk Model by Region

    Computes seismic risk assessment for each tectonic region using:

    1. Gutenberg-Richter Frequency-Magnitude Relationship:
       log10(N) = a - b*M
       Where N = number of events >= M, a = productivity, b = b-value (~1.0)
       The b-value describes the relative frequency of large vs small events.

    2. Recurrence Intervals:
       Average time between events of a given magnitude.
       T(M) = 1 / (10^(a - b*M))

    3. Population Exposure:
       Estimated population within the affected zone of each region.

    4. Probability Calculation:
       P(M >= threshold in T years) = 1 - exp(-T / recurrence_interval)
       Using Poisson model for earthquake occurrence.

    Output: One row per seismic region per year with risk metrics.
#}

WITH -- Step 1: Event counts and magnitude statistics by region and year
event_stats AS (
    SELECT
        seismic_region AS region_name,
        tectonic_setting AS risk_zone,
        event_year AS year,
        COUNT(*) AS total_events,
        COUNT(CASE WHEN magnitude >= 3.0 THEN 1 END) AS m3_plus_events,
        COUNT(CASE WHEN magnitude >= 4.0 THEN 1 END) AS m4_plus_events,
        COUNT(CASE WHEN magnitude >= 5.0 THEN 1 END) AS m5_plus_events,
        COUNT(CASE WHEN magnitude >= 6.0 THEN 1 END) AS m6_plus_events,
        ROUND(AVG(magnitude), 2) AS avg_magnitude,
        ROUND(MAX(magnitude), 2) AS max_magnitude,
        ROUND(AVG(depth_km), 1) AS avg_depth_km,
        ROUND(STDDEV(magnitude), 3) AS magnitude_stddev,
        -- Median magnitude approximation
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY magnitude), 2) AS median_magnitude,
        -- Most recent significant event
        MAX(CASE WHEN magnitude >= {{ var('significant_magnitude_threshold') }}
                 THEN event_time END) AS last_significant_event,
        MIN(event_time) AS earliest_event,
        MAX(event_time) AS latest_event
    FROM {{ ref('slv_earthquake_events') }}
    WHERE magnitude >= {{ var('min_magnitude_analysis') }}
    GROUP BY seismic_region, tectonic_setting, event_year
),

-- Step 2: Calculate Gutenberg-Richter b-value per region
-- Using maximum likelihood estimator: b = log10(e) / (M_mean - M_min)
gr_params AS (
    SELECT
        seismic_region AS region_name,
        -- b-value (maximum likelihood estimate)
        ROUND(
            LOG10(EXP(1)) / (AVG(magnitude) - {{ var('gutenberg_richter_completeness') }}),
            3
        ) AS b_value,
        -- a-value: a = log10(N) + b * Mc
        ROUND(
            LOG10(COUNT(*)) + (
                LOG10(EXP(1)) / (AVG(magnitude) - {{ var('gutenberg_richter_completeness') }})
            ) * {{ var('gutenberg_richter_completeness') }},
            3
        ) AS a_value,
        COUNT(*) AS total_events_all_years,
        -- Time span of catalog in years
        ROUND(
            DATEDIFF(MAX(event_time), MIN(event_time)) / 365.25, 1
        ) AS catalog_span_years
    FROM {{ ref('slv_earthquake_events') }}
    WHERE magnitude >= {{ var('gutenberg_richter_completeness') }}
    GROUP BY seismic_region
),

-- Step 3: Calculate recurrence intervals using G-R relationship
recurrence AS (
    SELECT
        region_name,
        b_value,
        a_value,
        catalog_span_years,
        total_events_all_years,
        -- Annual rate of M >= 5.0 events: N5 = 10^(a - b*5.0) / catalog_years
        CASE
            WHEN catalog_span_years > 0
            THEN ROUND(POWER(10, a_value - b_value * 5.0) / catalog_span_years, 4)
            ELSE 0
        END AS annual_rate_m5,
        -- Recurrence interval for M >= 5.0 (years)
        CASE
            WHEN POWER(10, a_value - b_value * 5.0) / NULLIF(catalog_span_years, 0) > 0
            THEN ROUND(1.0 / (POWER(10, a_value - b_value * 5.0) / catalog_span_years), 1)
            ELSE NULL
        END AS recurrence_interval_m5_years,
        -- Recurrence interval for M >= 6.0
        CASE
            WHEN POWER(10, a_value - b_value * 6.0) / NULLIF(catalog_span_years, 0) > 0
            THEN ROUND(1.0 / (POWER(10, a_value - b_value * 6.0) / catalog_span_years), 1)
            ELSE NULL
        END AS recurrence_interval_m6_years,
        -- Recurrence interval for M >= 7.0
        CASE
            WHEN POWER(10, a_value - b_value * 7.0) / NULLIF(catalog_span_years, 0) > 0
            THEN ROUND(1.0 / (POWER(10, a_value - b_value * 7.0) / catalog_span_years), 1)
            ELSE NULL
        END AS recurrence_interval_m7_years
    FROM gr_params
),

-- Step 4: Estimate population exposure by seismic region
-- Using rough population estimates for each tectonic zone
population_exposure AS (
    SELECT
        region_name,
        CASE
            WHEN region_name = 'CALIFORNIA' THEN 39500000
            WHEN region_name = 'CASCADIA' THEN 12000000
            WHEN region_name = 'ALASKA' THEN 730000
            WHEN region_name = 'HAWAII' THEN 1450000
            WHEN region_name = 'INTERMOUNTAIN' THEN 15000000
            WHEN region_name = 'CENTRAL_US' THEN 25000000
            WHEN region_name = 'EASTERN_US' THEN 100000000
            WHEN region_name = 'CARIBBEAN' THEN 3500000
            ELSE 5000000
        END AS population_exposed
    FROM (SELECT DISTINCT seismic_region AS region_name FROM {{ ref('slv_earthquake_events') }})
),

-- Step 5: Compute final risk metrics and probabilities
final AS (
    SELECT
        e.region_name,
        e.risk_zone,
        e.year,

        -- Event statistics
        e.total_events,
        e.m3_plus_events,
        e.m4_plus_events,
        e.m5_plus_events,
        e.m6_plus_events,
        e.avg_magnitude,
        e.max_magnitude AS max_historical_magnitude,
        e.avg_depth_km,
        e.median_magnitude,

        -- Timing
        e.last_significant_event,
        CASE
            WHEN e.last_significant_event IS NOT NULL
            THEN DATEDIFF(CURRENT_DATE(), e.last_significant_event)
            ELSE NULL
        END AS days_since_last_significant,

        -- Gutenberg-Richter parameters
        COALESCE(r.b_value, 1.0) AS gutenberg_richter_b_value,
        COALESCE(r.a_value, 0) AS gutenberg_richter_a_value,
        r.catalog_span_years,

        -- Recurrence intervals
        r.recurrence_interval_m5_years,
        r.recurrence_interval_m6_years,
        r.recurrence_interval_m7_years,

        -- Probability of M >= 5.0 in next 10 years (Poisson model)
        -- P = 1 - exp(-T/recurrence)
        CASE
            WHEN r.recurrence_interval_m5_years IS NOT NULL AND r.recurrence_interval_m5_years > 0
            THEN ROUND(
                (1 - EXP(-10.0 / r.recurrence_interval_m5_years)) * 100, 2
            )
            ELSE 0
        END AS probability_m5_10yr,

        -- Probability of M >= 6.0 in next 30 years
        CASE
            WHEN r.recurrence_interval_m6_years IS NOT NULL AND r.recurrence_interval_m6_years > 0
            THEN ROUND(
                (1 - EXP(-30.0 / r.recurrence_interval_m6_years)) * 100, 2
            )
            ELSE 0
        END AS probability_m6_30yr,

        -- Population exposure
        COALESCE(p.population_exposed, 0) AS population_exposed,

        -- Composite risk category
        CASE
            WHEN (
                CASE
                    WHEN r.recurrence_interval_m5_years IS NOT NULL AND r.recurrence_interval_m5_years > 0
                    THEN (1 - EXP(-10.0 / r.recurrence_interval_m5_years)) * 100
                    ELSE 0
                END
            ) >= 80 THEN 'VERY_HIGH'
            WHEN (
                CASE
                    WHEN r.recurrence_interval_m5_years IS NOT NULL AND r.recurrence_interval_m5_years > 0
                    THEN (1 - EXP(-10.0 / r.recurrence_interval_m5_years)) * 100
                    ELSE 0
                END
            ) >= 50 THEN 'HIGH'
            WHEN e.m4_plus_events >= 5 THEN 'MODERATE'
            WHEN e.total_events >= 20 THEN 'LOW'
            ELSE 'MINIMAL'
        END AS risk_category,

        -- Risk score (0-100)
        ROUND(LEAST(100, GREATEST(0,
            30 * CASE
                    WHEN r.recurrence_interval_m5_years IS NOT NULL AND r.recurrence_interval_m5_years > 0
                    THEN (1 - EXP(-10.0 / r.recurrence_interval_m5_years))
                    ELSE 0
                END * 100
            + 25 * LEAST(1, e.m5_plus_events / 5.0) * 100
            + 20 * LEAST(1, e.max_magnitude / 8.0) * 100
            + 15 * LEAST(1, COALESCE(p.population_exposed, 0) / 40000000.0) * 100
            + 10 * CASE WHEN e.avg_depth_km < 30 THEN 1.0 ELSE 0.5 END * 100
        ) / 100), 2) AS seismic_risk_score,

        -- Ranking
        ROW_NUMBER() OVER (
            PARTITION BY e.year
            ORDER BY COALESCE(r.annual_rate_m5, 0) DESC, e.total_events DESC
        ) AS risk_rank,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM event_stats e
    LEFT JOIN recurrence r ON e.region_name = r.region_name
    LEFT JOIN population_exposure p ON e.region_name = p.region_name
    WHERE e.year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
)

SELECT * FROM final
ORDER BY year DESC, seismic_risk_score DESC
