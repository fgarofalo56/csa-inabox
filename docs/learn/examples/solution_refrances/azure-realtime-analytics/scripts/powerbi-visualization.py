# Power BI Real-Time Visualization & Integration Configuration
# This file contains Power BI integration, real-time dashboards, and visualization setup

import os
import json
import requests
from typing import Dict, List, Optional
from datetime import datetime, timedelta
import pandas as pd
from azure.identity import DefaultAzureCredential
from pyspark.sql import SparkSession
from pyspark.sql.functions import *

# ============================================================================
# 1. POWER BI CONFIGURATION
# ============================================================================

class PowerBIConfig:
    """Configuration for Power BI integration"""
    
    def __init__(self):
        self.TENANT_ID = os.getenv("AZURE_TENANT_ID")
        self.CLIENT_ID = os.getenv("POWERBI_CLIENT_ID")
        self.CLIENT_SECRET = os.getenv("POWERBI_CLIENT_SECRET")
        self.WORKSPACE_ID = os.getenv("POWERBI_WORKSPACE_ID")
        self.API_BASE_URL = "https://api.powerbi.com/v1.0/myorg"
        
        # Databricks connection details
        self.DATABRICKS_HOST = os.getenv("DATABRICKS_HOST")
        self.DATABRICKS_HTTP_PATH = os.getenv("DATABRICKS_HTTP_PATH")
        self.DATABRICKS_TOKEN = os.getenv("DATABRICKS_TOKEN")
        
    def get_access_token(self) -> str:
        """Get Power BI access token"""
        token_url = f"https://login.microsoftonline.com/{self.TENANT_ID}/oauth2/v2.0/token"
        
        data = {
            'grant_type': 'client_credentials',
            'client_id': self.CLIENT_ID,
            'client_secret': self.CLIENT_SECRET,
            'scope': 'https://analysis.windows.net/powerbi/api/.default'
        }
        
        response = requests.post(token_url, data=data)
        return response.json()['access_token']

# ============================================================================
# 2. DIRECT LAKE MODE SETUP
# ============================================================================

class DirectLakeIntegration:
    """Setup Direct Lake mode for Power BI with Databricks"""
    
    def __init__(self, config: PowerBIConfig):
        self.config = config
        self.access_token = config.get_access_token()
        self.headers = {
            'Authorization': f'Bearer {self.access_token}',
            'Content-Type': 'application/json'
        }
    
    def create_direct_lake_dataset(self, dataset_name: str, catalog: str, 
                                  schema: str, tables: List[str]) -> str:
        """Create a Direct Lake dataset in Power BI"""
        
        dataset_config = {
            "name": dataset_name,
            "description": f"Direct Lake dataset for {schema} schema",
            "configuredBy": "DirectLake",
            "tables": []
        }
        
        # Add tables to dataset
        for table_name in tables:
            table_config = {
                "name": table_name,
                "source": {
                    "type": "databricks",
                    "expression": f"{catalog}.{schema}.{table_name}",
                    "connectionDetails": {
                        "protocol": "databricks",
                        "address": {
                            "server": self.config.DATABRICKS_HOST,
                            "httpPath": self.config.DATABRICKS_HTTP_PATH
                        },
                        "authentication": {
                            "kind": "OAuth2",
                            "accessToken": self.config.DATABRICKS_TOKEN
                        }
                    }
                },
                "columns": self._get_table_columns(catalog, schema, table_name),
                "measures": self._create_default_measures(table_name)
            }
            dataset_config["tables"].append(table_config)
        
        # Create dataset via Power BI REST API
        url = f"{self.config.API_BASE_URL}/groups/{self.config.WORKSPACE_ID}/datasets"
        response = requests.post(url, headers=self.headers, json=dataset_config)
        
        if response.status_code == 201:
            dataset_id = response.json()['id']
            print(f"Created Direct Lake dataset: {dataset_id}")
            return dataset_id
        else:
            raise Exception(f"Failed to create dataset: {response.text}")
    
    def _get_table_columns(self, catalog: str, schema: str, table: str) -> List[Dict]:
        """Get column metadata for a table"""
        
        # Connect to Databricks to get schema
        from databricks import sql
        
        connection = sql.connect(
            server_hostname=self.config.DATABRICKS_HOST,
            http_path=self.config.DATABRICKS_HTTP_PATH,
            access_token=self.config.DATABRICKS_TOKEN
        )
        
        cursor = connection.cursor()
        cursor.execute(f"DESCRIBE {catalog}.{schema}.{table}")
        
        columns = []
        for row in cursor.fetchall():
            col_name, col_type, _ = row
            columns.append({
                "name": col_name,
                "dataType": self._map_databricks_to_powerbi_type(col_type),
                "isHidden": False,
                "isKey": col_name.endswith("_id") or col_name == "id"
            })
        
        cursor.close()
        connection.close()
        
        return columns
    
    def _map_databricks_to_powerbi_type(self, databricks_type: str) -> str:
        """Map Databricks data types to Power BI data types"""
        
        type_mapping = {
            "string": "string",
            "int": "int64",
            "bigint": "int64",
            "float": "double",
            "double": "double",
            "boolean": "boolean",
            "date": "datetime",
            "timestamp": "datetime",
            "decimal": "decimal",
            "array": "string",  # Arrays serialized as JSON strings
            "struct": "string"  # Structs serialized as JSON strings
        }
        
        # Handle complex types
        base_type = databricks_type.lower().split("<")[0].split("(")[0]
        return type_mapping.get(base_type, "string")
    
    def _create_default_measures(self, table_name: str) -> List[Dict]:
        """Create default measures for a table"""
        
        measures = []
        
        # Count measure
        measures.append({
            "name": f"{table_name}_Count",
            "expression": f"COUNTROWS('{table_name}')",
            "formatString": "#,0"
        })
        
        # Add specific measures based on table
        if "events" in table_name.lower():
            measures.append({
                "name": "Events_Per_Hour",
                "expression": f"CALCULATE(COUNTROWS('{table_name}'), DATESINPERIOD('{table_name}'[timestamp], LASTDATE('{table_name}'[timestamp]), -1, HOUR))",
                "formatString": "#,0"
            })
        
        if "sentiment" in table_name.lower():
            measures.append({
                "name": "Avg_Sentiment_Score",
                "expression": f"AVERAGE('{table_name}'[sentiment_score])",
                "formatString": "0.00"
            })
        
        return measures
    
    def create_relationships(self, dataset_id: str, relationships: List[Dict]):
        """Create relationships between tables in the dataset"""
        
        url = f"{self.config.API_BASE_URL}/datasets/{dataset_id}/relationships"
        
        for rel in relationships:
            relationship_config = {
                "name": rel["name"],
                "fromTable": rel["from_table"],
                "fromColumn": rel["from_column"],
                "toTable": rel["to_table"],
                "toColumn": rel["to_column"],
                "crossFilteringBehavior": rel.get("cross_filter", "OneDirection")
            }
            
            response = requests.post(url, headers=self.headers, json=relationship_config)
            
            if response.status_code == 201:
                print(f"Created relationship: {rel['name']}")
            else:
                print(f"Failed to create relationship: {response.text}")

# ============================================================================
# 3. REAL-TIME STREAMING DASHBOARD
# ============================================================================

class RealTimeStreamingDashboard:
    """Create and manage real-time streaming dashboards"""
    
    def __init__(self, config: PowerBIConfig):
        self.config = config
        self.access_token = config.get_access_token()
        self.headers = {
            'Authorization': f'Bearer {self.access_token}',
            'Content-Type': 'application/json'
        }
    
    def create_streaming_dataset(self, dataset_name: str) -> Dict:
        """Create a streaming dataset for real-time data"""
        
        dataset_config = {
            "name": dataset_name,
            "defaultMode": "pushStreaming",
            "tables": [{
                "name": "RealTimeMetrics",
                "columns": [
                    {"name": "timestamp", "dataType": "DateTime"},
                    {"name": "metric_name", "dataType": "String"},
                    {"name": "metric_value", "dataType": "Double"},
                    {"name": "dimension1", "dataType": "String"},
                    {"name": "dimension2", "dataType": "String"},
                    {"name": "sentiment", "dataType": "String"},
                    {"name": "confidence", "dataType": "Double"},
                    {"name": "event_count", "dataType": "Int64"},
                    {"name": "avg_processing_time", "dataType": "Double"}
                ]
            }]
        }
        
        url = f"{self.config.API_BASE_URL}/groups/{self.config.WORKSPACE_ID}/datasets"
        response = requests.post(url, headers=self.headers, json=dataset_config)
        
        if response.status_code == 201:
            result = response.json()
            print(f"Created streaming dataset: {result['id']}")
            return result
        else:
            raise Exception(f"Failed to create streaming dataset: {response.text}")
    
    def push_data_to_streaming_dataset(self, dataset_id: str, table_name: str, rows: List[Dict]):
        """Push data to a streaming dataset"""
        
        url = f"{self.config.API_BASE_URL}/datasets/{dataset_id}/tables/{table_name}/rows"
        
        # Ensure timestamp format is correct
        for row in rows:
            if 'timestamp' in row and isinstance(row['timestamp'], datetime):
                row['timestamp'] = row['timestamp'].isoformat()
        
        data = {"rows": rows}
        
        response = requests.post(url, headers=self.headers, json=data)
        
        if response.status_code == 200:
            print(f"Successfully pushed {len(rows)} rows to streaming dataset")
        else:
            print(f"Failed to push data: {response.text}")
    
    def create_streaming_dashboard(self, dashboard_name: str, dataset_id: str) -> str:
        """Create a dashboard with streaming tiles"""
        
        # Create dashboard
        dashboard_config = {
            "name": dashboard_name,
            "tiles": []
        }
        
        url = f"{self.config.API_BASE_URL}/groups/{self.config.WORKSPACE_ID}/dashboards"
        response = requests.post(url, headers=self.headers, json=dashboard_config)
        
        if response.status_code == 201:
            dashboard_id = response.json()['id']
            print(f"Created dashboard: {dashboard_id}")
            
            # Add tiles to dashboard
            self._add_streaming_tiles(dashboard_id, dataset_id)
            
            return dashboard_id
        else:
            raise Exception(f"Failed to create dashboard: {response.text}")
    
    def _add_streaming_tiles(self, dashboard_id: str, dataset_id: str):
        """Add streaming tiles to dashboard"""
        
        tiles = [
            {
                "title": "Real-Time Event Count",
                "type": "card",
                "visualization": {
                    "visualType": "card",
                    "properties": {
                        "value": {
                            "expr": "SUM(RealTimeMetrics[event_count])"
                        }
                    }
                }
            },
            {
                "title": "Events Per Minute",
                "type": "line",
                "visualization": {
                    "visualType": "line",
                    "properties": {
                        "categoryAxis": {
                            "expr": "RealTimeMetrics[timestamp]"
                        },
                        "values": [{
                            "expr": "SUM(RealTimeMetrics[event_count])"
                        }]
                    }
                }
            },
            {
                "title": "Sentiment Distribution",
                "type": "pie",
                "visualization": {
                    "visualType": "pieChart",
                    "properties": {
                        "legend": {
                            "expr": "RealTimeMetrics[sentiment]"
                        },
                        "values": [{
                            "expr": "COUNT(RealTimeMetrics[sentiment])"
                        }]
                    }
                }
            },
            {
                "title": "Average Processing Time",
                "type": "gauge",
                "visualization": {
                    "visualType": "gauge",
                    "properties": {
                        "value": {
                            "expr": "AVERAGE(RealTimeMetrics[avg_processing_time])"
                        },
                        "min": 0,
                        "max": 1000,
                        "target": 500
                    }
                }
            }
        ]
        
        for tile in tiles:
            self._add_tile_to_dashboard(dashboard_id, dataset_id, tile)
    
    def _add_tile_to_dashboard(self, dashboard_id: str, dataset_id: str, tile_config: Dict):
        """Add a single tile to dashboard"""
        
        tile_request = {
            "datasetId": dataset_id,
            "title": tile_config["title"],
            "tileType": tile_config["type"],
            "visualization": tile_config["visualization"]
        }
        
        url = f"{self.config.API_BASE_URL}/dashboards/{dashboard_id}/tiles"
        response = requests.post(url, headers=self.headers, json=tile_request)
        
        if response.status_code == 201:
            print(f"Added tile: {tile_config['title']}")
        else:
            print(f"Failed to add tile: {response.text}")

# ============================================================================
# 4. DATABRICKS TO POWER BI STREAMING
# ============================================================================

class DatabricksToPowerBIStreaming:
    """Stream data from Databricks to Power BI"""
    
    def __init__(self, spark: SparkSession, powerbi_config: PowerBIConfig):
        self.spark = spark
        self.powerbi_config = powerbi_config
        self.streaming_dashboard = RealTimeStreamingDashboard(powerbi_config)
    
    def stream_to_powerbi(self, df, dataset_id: str, table_name: str = "RealTimeMetrics"):
        """Stream DataFrame to Power BI"""
        
        def send_to_powerbi(batch_df, batch_id):
            """Process each micro-batch"""
            
            # Convert to Pandas for easier processing
            pandas_df = batch_df.toPandas()
            
            if len(pandas_df) > 0:
                # Prepare rows for Power BI
                rows = pandas_df.to_dict('records')
                
                # Send to Power BI
                self.streaming_dashboard.push_data_to_streaming_dataset(
                    dataset_id, table_name, rows
                )
            
            print(f"Processed batch {batch_id} with {len(pandas_df)} rows")
        
        # Write stream to Power BI
        query = (df
            .writeStream
            .foreachBatch(send_to_powerbi)
            .outputMode("update")
            .trigger(processingTime="10 seconds")
            .start()
        )
        
        return query
    
    def create_aggregated_stream(self, source_df):
        """Create aggregated stream for dashboard"""
        
        # Perform streaming aggregations
        aggregated_df = (source_df
            .withWatermark("timestamp", "1 minute")
            .groupBy(
                window(col("timestamp"), "1 minute"),
                col("sentiment")
            )
            .agg(
                count("*").alias("event_count"),
                avg("confidence").alias("avg_confidence"),
                avg("processing_time").alias("avg_processing_time")
            )
            .select(
                col("window.start").alias("timestamp"),
                col("sentiment"),
                col("event_count"),
                col("avg_confidence").alias("confidence"),
                col("avg_processing_time"),
                lit("Real-Time").alias("metric_name"),
                col("event_count").cast("double").alias("metric_value"),
                lit("Stream").alias("dimension1"),
                lit("Analytics").alias("dimension2")
            )
        )
        
        return aggregated_df

# ============================================================================
# 5. AUTOMATED REPORT GENERATION
# ============================================================================

class AutomatedReportGeneration:
    """Automatically generate Power BI reports"""
    
    def __init__(self, config: PowerBIConfig):
        self.config = config
        self.access_token = config.get_access_token()
        self.headers = {
            'Authorization': f'Bearer {self.access_token}',
            'Content-Type': 'application/json'
        }
    
    def create_report_from_dataset(self, dataset_id: str, report_name: str) -> str:
        """Create a report from a dataset"""
        
        report_config = {
            "name": report_name,
            "datasetId": dataset_id,
            "pages": [
                self._create_overview_page(),
                self._create_detail_page(),
                self._create_ai_insights_page()
            ]
        }
        
        url = f"{self.config.API_BASE_URL}/groups/{self.config.WORKSPACE_ID}/reports"
        response = requests.post(url, headers=self.headers, json=report_config)
        
        if response.status_code == 201:
            report_id = response.json()['id']
            print(f"Created report: {report_id}")
            return report_id
        else:
            raise Exception(f"Failed to create report: {response.text}")
    
    def _create_overview_page(self) -> Dict:
        """Create overview page configuration"""
        
        return {
            "name": "Overview",
            "displayName": "Executive Overview",
            "visualizations": [
                {
                    "type": "kpi",
                    "x": 0,
                    "y": 0,
                    "width": 200,
                    "height": 100,
                    "config": {
                        "title": "Total Events",
                        "value": "SUM(event_count)",
                        "goal": 1000000,
                        "trend": "timestamp"
                    }
                },
                {
                    "type": "lineChart",
                    "x": 200,
                    "y": 0,
                    "width": 400,
                    "height": 200,
                    "config": {
                        "title": "Event Trend",
                        "xAxis": "timestamp",
                        "yAxis": ["event_count"],
                        "legend": True
                    }
                },
                {
                    "type": "map",
                    "x": 600,
                    "y": 0,
                    "width": 400,
                    "height": 200,
                    "config": {
                        "title": "Geographic Distribution",
                        "location": "location",
                        "size": "event_count",
                        "color": "sentiment"
                    }
                }
            ]
        }
    
    def _create_detail_page(self) -> Dict:
        """Create detail page configuration"""
        
        return {
            "name": "Details",
            "displayName": "Detailed Analytics",
            "visualizations": [
                {
                    "type": "table",
                    "x": 0,
                    "y": 0,
                    "width": 500,
                    "height": 300,
                    "config": {
                        "title": "Event Details",
                        "columns": [
                            "timestamp",
                            "event_type",
                            "sentiment",
                            "confidence",
                            "key_phrases"
                        ],
                        "sort": {"column": "timestamp", "order": "desc"}
                    }
                },
                {
                    "type": "clusteredBar",
                    "x": 500,
                    "y": 0,
                    "width": 500,
                    "height": 300,
                    "config": {
                        "title": "Sentiment by Category",
                        "xAxis": "category",
                        "yAxis": "event_count",
                        "series": "sentiment"
                    }
                }
            ]
        }
    
    def _create_ai_insights_page(self) -> Dict:
        """Create AI insights page configuration"""
        
        return {
            "name": "AIInsights",
            "displayName": "AI-Powered Insights",
            "visualizations": [
                {
                    "type": "aiVisual",
                    "x": 0,
                    "y": 0,
                    "width": 1000,
                    "height": 150,
                    "config": {
                        "type": "keyInfluencers",
                        "analyze": "sentiment",
                        "explainBy": ["category", "source", "time_of_day"]
                    }
                },
                {
                    "type": "wordCloud",
                    "x": 0,
                    "y": 150,
                    "width": 500,
                    "height": 250,
                    "config": {
                        "title": "Key Phrases",
                        "text": "key_phrases",
                        "size": "frequency"
                    }
                },
                {
                    "type": "decompositionTree",
                    "x": 500,
                    "y": 150,
                    "width": 500,
                    "height": 250,
                    "config": {
                        "title": "Metric Decomposition",
                        "metric": "event_count",
                        "dimensions": ["category", "source", "sentiment"]
                    }
                }
            ]
        }
    
    def publish_to_web(self, report_id: str) -> str:
        """Publish report to web"""
        
        url = f"{self.config.API_BASE_URL}/reports/{report_id}/PublishToWeb"
        response = requests.post(url, headers=self.headers)
        
        if response.status_code == 200:
            embed_url = response.json()['embedUrl']
            print(f"Report published to web: {embed_url}")
            return embed_url
        else:
            print(f"Failed to publish report: {response.text}")
            return None

# ============================================================================
# 6. ORCHESTRATION EXAMPLE
# ============================================================================

def setup_complete_powerbi_integration():
    """Complete Power BI integration setup"""
    
    # Initialize configuration
    config = PowerBIConfig()
    
    # 1. Setup Direct Lake integration
    direct_lake = DirectLakeIntegration(config)
    
    # Create Direct Lake dataset for Gold tables
    gold_tables = ["events_summary", "sentiment_analysis", "entity_extraction"]
    dataset_id = direct_lake.create_direct_lake_dataset(
        dataset_name="Real-Time Analytics Gold",
        catalog="main",
        schema="gold",
        tables=gold_tables
    )
    
    # Create relationships
    relationships = [
        {
            "name": "events_to_sentiment",
            "from_table": "events_summary",
            "from_column": "event_id",
            "to_table": "sentiment_analysis",
            "to_column": "event_id"
        }
    ]
    direct_lake.create_relationships(dataset_id, relationships)
    
    # 2. Setup streaming dashboard
    streaming = RealTimeStreamingDashboard(config)
    
    # Create streaming dataset
    streaming_dataset = streaming.create_streaming_dataset("Real-Time Metrics Stream")
    streaming_dataset_id = streaming_dataset['id']
    
    # Create dashboard
    dashboard_id = streaming.create_streaming_dashboard(
        "Real-Time Analytics Dashboard",
        streaming_dataset_id
    )
    
    # 3. Generate automated report
    report_gen = AutomatedReportGeneration(config)
    report_id = report_gen.create_report_from_dataset(
        dataset_id,
        "Analytics Executive Report"
    )
    
    # Publish to web (if needed)
    embed_url = report_gen.publish_to_web(report_id)
    
    print(f"""
    Power BI Integration Complete!
    ==============================
    Direct Lake Dataset ID: {dataset_id}
    Streaming Dataset ID: {streaming_dataset_id}
    Dashboard ID: {dashboard_id}
    Report ID: {report_id}
    Embed URL: {embed_url}
    """)
    
    return {
        "dataset_id": dataset_id,
        "streaming_dataset_id": streaming_dataset_id,
        "dashboard_id": dashboard_id,
        "report_id": report_id,
        "embed_url": embed_url
    }

if __name__ == "__main__":
    setup_complete_powerbi_integration()