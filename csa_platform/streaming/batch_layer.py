# -*- coding: utf-8 -*-
"""csa_platform.streaming.batch_layer — Batch processing layer for Lambda architecture.

This module implements the batch layer (cold path) of the Lambda architecture,
providing reprocessing of raw events from ADLS, correctness-focused processing
using PySpark or pandas, and writing to the Gold layer as Parquet/Delta tables.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import pandas as pd
from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob.aio import BlobServiceClient
from azure.storage.filedatalake.aio import DataLakeServiceClient

from csa_platform.streaming.event_processor import EventSchema

logger = logging.getLogger(__name__)


@dataclass
class BatchLayerConfig:
    """Configuration for the BatchLayer."""
    # Azure Data Lake Storage settings
    adls_account_url: str
    adls_filesystem: str = "datalake"
    raw_events_path: str = "bronze/events"  # Event Hubs Capture path
    gold_layer_path: str = "gold/aggregated"
    checkpoint_path: str = "checkpoints/batch_layer"

    # Processing settings
    batch_size: int = 10000
    max_workers: int = 4
    reprocess_window: timedelta = timedelta(hours=24)
    compaction_threshold: int = 100  # Number of small files before compacting

    # Delta/Parquet settings
    output_format: str = "parquet"  # "parquet" or "delta"
    partition_columns: List[str] = None
    compression: str = "snappy"

    def __post_init__(self):
        if self.partition_columns is None:
            self.partition_columns = ["event_type", "date"]


@dataclass
class BatchProcessingResult:
    """Result of batch processing operation."""
    start_time: datetime
    end_time: datetime
    processed_events: int
    output_files: List[str]
    aggregation_results: Dict[str, Any]
    errors: List[str]


class BatchLayer:
    """Batch processing layer implementing the batch layer of Lambda architecture.

    Features:
    - Reads raw events from ADLS (landed by Event Hubs Capture)
    - Reprocesses using pandas for correctness and completeness
    - Writes to Gold layer as Parquet/Delta files
    - Compacts partitions to optimize query performance
    - Scheduled to run periodically (designed for ADF trigger)
    - Merges results with serving layer
    """

    def __init__(self, config: BatchLayerConfig):
        """Initialize the batch layer.

        Args:
            config: Configuration for the batch layer
        """
        self.config = config
        self._adls_client: Optional[DataLakeServiceClient] = None
        self._filesystem_client = None

    async def initialize(self) -> None:
        """Initialize connections to Azure Data Lake Storage."""
        credential = DefaultAzureCredential()
        self._adls_client = DataLakeServiceClient(
            account_url=self.config.adls_account_url,
            credential=credential
        )
        self._filesystem_client = self._adls_client.get_file_system_client(
            file_system=self.config.adls_filesystem
        )

        # Ensure required directories exist
        await self._create_directory_if_not_exists(self.config.raw_events_path)
        await self._create_directory_if_not_exists(self.config.gold_layer_path)
        await self._create_directory_if_not_exists(self.config.checkpoint_path)

        logger.info("Batch layer initialized")

    async def _create_directory_if_not_exists(self, path: str) -> None:
        """Create directory in ADLS if it doesn't exist."""
        try:
            directory_client = self._filesystem_client.get_directory_client(path)
            await directory_client.get_directory_properties()
        except Exception:
            await self._filesystem_client.create_directory(path)
            logger.info(f"Created directory: {path}")

    async def _list_files_in_path(self, path: str, file_extension: str = ".avro") -> List[str]:
        """List files in ADLS path with specific extension."""
        files = []
        try:
            async for path_item in self._filesystem_client.get_paths(path=path):
                if path_item.name.endswith(file_extension) and not path_item.is_directory:
                    files.append(path_item.name)
        except Exception as e:
            logger.warning(f"Failed to list files in {path}: {e}")

        return files

    async def _download_file_content(self, file_path: str) -> bytes:
        """Download file content from ADLS."""
        file_client = self._filesystem_client.get_file_client(file_path)
        download = await file_client.download_file()
        content = await download.readall()
        return content

    async def _get_last_checkpoint(self) -> Optional[datetime]:
        """Get the last processing checkpoint."""
        checkpoint_file = f"{self.config.checkpoint_path}/last_processed.txt"
        try:
            file_client = self._filesystem_client.get_file_client(checkpoint_file)
            download = await file_client.download_file()
            content = await download.readall()
            timestamp_str = content.decode('utf-8').strip()
            return datetime.fromisoformat(timestamp_str)
        except Exception:
            return None

    async def _save_checkpoint(self, timestamp: datetime) -> None:
        """Save processing checkpoint."""
        checkpoint_file = f"{self.config.checkpoint_path}/last_processed.txt"
        file_client = self._filesystem_client.get_file_client(checkpoint_file)
        content = timestamp.isoformat().encode('utf-8')
        await file_client.upload_data(content, overwrite=True)

    def _parse_avro_events(self, avro_content: bytes) -> List[EventSchema]:
        """Parse Avro content from Event Hubs Capture into EventSchema objects.

        Note: This is a simplified implementation. In production, you'd use
        the avro-python3 library to properly parse Avro files.
        """
        # This is a placeholder implementation
        # In reality, you'd parse the Avro binary format
        events = []

        try:
            # For demonstration, assume JSON-like structure
            # Real implementation would use fastavro or similar
            import json
            text_content = avro_content.decode('utf-8', errors='ignore')

            # Simple line-by-line JSON parsing (adjust for your capture format)
            for line in text_content.split('\n'):
                if line.strip():
                    try:
                        event_data = json.loads(line)
                        event = EventSchema(
                            id=event_data.get('id', f"batch_{len(events)}"),
                            timestamp=datetime.fromisoformat(
                                event_data.get('timestamp', datetime.utcnow().isoformat())
                            ),
                            event_type=event_data.get('event_type', 'unknown'),
                            source=event_data.get('source', 'unknown'),
                            payload=event_data.get('payload', {}),
                            raw_data=line.encode('utf-8')
                        )
                        events.append(event)
                    except Exception as e:
                        logger.warning(f"Failed to parse event line: {e}")

        except Exception as e:
            logger.error(f"Failed to parse Avro content: {e}")

        return events

    def _process_events_dataframe(self, events: List[EventSchema]) -> pd.DataFrame:
        """Process events using pandas for correctness and completeness."""
        if not events:
            return pd.DataFrame()

        # Convert events to DataFrame
        data = []
        for event in events:
            row = {
                'id': event.id,
                'timestamp': event.timestamp,
                'event_type': event.event_type,
                'source': event.source,
                'date': event.timestamp.date(),
                'hour': event.timestamp.hour,
                **event.payload  # Flatten payload
            }
            data.append(row)

        df = pd.DataFrame(data)

        # Data cleaning and validation
        df = df.dropna(subset=['id', 'timestamp', 'event_type'])  # Remove invalid rows
        df = df.drop_duplicates(subset=['id'])  # Remove duplicates
        df['timestamp'] = pd.to_datetime(df['timestamp'])  # Ensure proper timestamp format

        # Add computed columns
        df['processing_time'] = datetime.utcnow()
        df['year'] = df['timestamp'].dt.year
        df['month'] = df['timestamp'].dt.month
        df['day'] = df['timestamp'].dt.day

        return df

    def _compute_aggregations(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Compute aggregations on the processed DataFrame."""
        if df.empty:
            return {}

        aggregations = {
            'total_events': len(df),
            'time_range': {
                'start': df['timestamp'].min().isoformat(),
                'end': df['timestamp'].max().isoformat()
            },
            'event_types': df['event_type'].value_counts().to_dict(),
            'sources': df['source'].value_counts().to_dict(),
            'hourly_counts': df.groupby('hour').size().to_dict()
        }

        # Numeric aggregations for numeric columns
        numeric_columns = df.select_dtypes(include=['number']).columns
        for col in numeric_columns:
            if col in df.columns and not df[col].isna().all():
                aggregations[f'{col}_stats'] = {
                    'sum': float(df[col].sum()),
                    'mean': float(df[col].mean()),
                    'min': float(df[col].min()),
                    'max': float(df[col].max()),
                    'count': int(df[col].count())
                }

        return aggregations

    async def _write_parquet_partitioned(
        self,
        df: pd.DataFrame,
        output_path: str,
        partition_cols: List[str]
    ) -> List[str]:
        """Write DataFrame as partitioned Parquet files."""
        output_files = []

        if df.empty:
            return output_files

        # Group by partition columns
        grouped = df.groupby(partition_cols)

        for partition_values, group_df in grouped:
            # Create partition path
            if isinstance(partition_values, tuple):
                partition_parts = [f"{col}={val}" for col, val in zip(partition_cols, partition_values)]
            else:
                partition_parts = [f"{partition_cols[0]}={partition_values}"]

            partition_path = f"{output_path}/{'/'.join(partition_parts)}"
            filename = f"data_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.parquet"
            full_path = f"{partition_path}/{filename}"

            # Convert DataFrame to Parquet bytes
            parquet_buffer = group_df.to_parquet(
                engine='pyarrow',
                compression=self.config.compression,
                index=False
            )

            # Upload to ADLS
            file_client = self._filesystem_client.get_file_client(full_path)
            await file_client.upload_data(parquet_buffer, overwrite=True)

            output_files.append(full_path)
            logger.debug(f"Wrote {len(group_df)} records to {full_path}")

        return output_files

    async def reprocess_batch(
        self,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None
    ) -> BatchProcessingResult:
        """Reprocess a batch of events for correctness.

        Args:
            start_time: Start time for batch processing (default: last checkpoint)
            end_time: End time for batch processing (default: now)

        Returns:
            BatchProcessingResult with processing details
        """
        if not self._adls_client:
            await self.initialize()

        processing_start = datetime.utcnow()
        errors = []
        processed_events = 0
        output_files = []

        # Determine time window
        if start_time is None:
            start_time = await self._get_last_checkpoint()
            if start_time is None:
                start_time = datetime.utcnow() - self.config.reprocess_window

        if end_time is None:
            end_time = datetime.utcnow()

        logger.info(f"Starting batch reprocessing from {start_time} to {end_time}")

        try:
            # List all capture files in the time window
            capture_files = await self._list_files_in_path(self.config.raw_events_path, ".avro")

            # Filter files by time window (basic implementation)
            relevant_files = []
            for file_path in capture_files:
                # Extract timestamp from filename (Event Hubs Capture format)
                # Example: namespace/eventhub/partition/2024/04/22/14/file.avro
                try:
                    path_parts = file_path.split('/')
                    if len(path_parts) >= 6:
                        year = int(path_parts[-4])
                        month = int(path_parts[-3])
                        day = int(path_parts[-2])
                        hour = int(path_parts[-1])

                        file_time = datetime(year, month, day, hour)
                        if start_time <= file_time <= end_time:
                            relevant_files.append(file_path)
                except Exception as e:
                    logger.warning(f"Could not parse timestamp from file {file_path}: {e}")
                    errors.append(f"Failed to parse file timestamp: {file_path}")

            logger.info(f"Found {len(relevant_files)} files to process")

            # Process files in batches
            all_events = []
            for file_path in relevant_files:
                try:
                    # Download and parse file
                    content = await self._download_file_content(file_path)
                    events = self._parse_avro_events(content)
                    all_events.extend(events)

                    logger.debug(f"Processed {len(events)} events from {file_path}")

                except Exception as e:
                    error_msg = f"Failed to process file {file_path}: {e}"
                    logger.error(error_msg)
                    errors.append(error_msg)

            # Process all events with pandas for correctness
            if all_events:
                df = self._process_events_dataframe(all_events)
                processed_events = len(df)

                # Write to Gold layer
                if not df.empty:
                    output_files = await self._write_parquet_partitioned(
                        df,
                        self.config.gold_layer_path,
                        self.config.partition_columns
                    )

                # Compute aggregations
                aggregation_results = self._compute_aggregations(df)

                # Save checkpoint
                await self._save_checkpoint(end_time)

                logger.info(f"Batch processing completed: {processed_events} events processed")

            else:
                aggregation_results = {}

        except Exception as e:
            error_msg = f"Batch processing failed: {e}"
            logger.error(error_msg, exc_info=True)
            errors.append(error_msg)
            aggregation_results = {}

        return BatchProcessingResult(
            start_time=processing_start,
            end_time=datetime.utcnow(),
            processed_events=processed_events,
            output_files=output_files,
            aggregation_results=aggregation_results,
            errors=errors
        )

    async def merge_with_serving(self, batch_results: List[str]) -> None:
        """Merge batch processing results with serving layer.

        Args:
            batch_results: List of output file paths from batch processing
        """
        # This would typically involve updating serving layer views
        # For now, we'll log the operation
        logger.info(f"Merging {len(batch_results)} batch files with serving layer")

        # In a real implementation, this might:
        # 1. Update materialized views in Azure Data Explorer
        # 2. Refresh cached aggregations in Cosmos DB
        # 3. Update serving layer indexes
        # 4. Trigger downstream notifications

    async def compact_partitions(self, partition_path: str) -> None:
        """Compact small files in a partition to improve query performance.

        Args:
            partition_path: Path to the partition to compact
        """
        try:
            # List files in partition
            files = await self._list_files_in_path(partition_path, ".parquet")

            if len(files) < self.config.compaction_threshold:
                logger.debug(f"Partition {partition_path} has {len(files)} files, skipping compaction")
                return

            logger.info(f"Compacting {len(files)} files in partition {partition_path}")

            # Download and merge all Parquet files
            dfs = []
            for file_path in files:
                try:
                    content = await self._download_file_content(file_path)
                    df = pd.read_parquet(content)
                    dfs.append(df)
                except Exception as e:
                    logger.warning(f"Failed to read file {file_path} for compaction: {e}")

            if dfs:
                # Combine all DataFrames
                combined_df = pd.concat(dfs, ignore_index=True)

                # Remove duplicates and sort
                combined_df = combined_df.drop_duplicates(subset=['id'])
                combined_df = combined_df.sort_values('timestamp')

                # Write compacted file
                compacted_filename = f"compacted_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.parquet"
                compacted_path = f"{partition_path}/{compacted_filename}"

                parquet_buffer = combined_df.to_parquet(
                    engine='pyarrow',
                    compression=self.config.compression,
                    index=False
                )

                file_client = self._filesystem_client.get_file_client(compacted_path)
                await file_client.upload_data(parquet_buffer, overwrite=True)

                # Remove original files
                for file_path in files:
                    try:
                        file_client = self._filesystem_client.get_file_client(file_path)
                        await file_client.delete_file()
                    except Exception as e:
                        logger.warning(f"Failed to delete original file {file_path}: {e}")

                logger.info(f"Compacted {len(files)} files into {compacted_path}")

        except Exception as e:
            logger.error(f"Partition compaction failed for {partition_path}: {e}")

    async def close(self) -> None:
        """Close connections and cleanup resources."""
        if self._adls_client:
            await self._adls_client.close()

        logger.info("Batch layer closed")


if __name__ == "__main__":
    import os

    async def main():
        """Example usage of BatchLayer."""
        config = BatchLayerConfig(
            adls_account_url=os.environ.get("ADLS_ACCOUNT_URL", "https://storage.dfs.core.windows.net"),
            adls_filesystem="datalake",
            batch_size=5000,
            reprocess_window=timedelta(hours=6)
        )

        batch_layer = BatchLayer(config)
        await batch_layer.initialize()

        # Run batch reprocessing
        result = await batch_layer.reprocess_batch()

        print(f"Processed {result.processed_events} events")
        print(f"Output files: {len(result.output_files)}")
        print(f"Errors: {len(result.errors)}")

        if result.aggregation_results:
            print("Aggregation results:")
            for key, value in result.aggregation_results.items():
                print(f"  {key}: {value}")

        await batch_layer.close()

    if os.environ.get("ADLS_ACCOUNT_URL"):
        asyncio.run(main())
    else:
        print("Set ADLS_ACCOUNT_URL environment variable to test")
