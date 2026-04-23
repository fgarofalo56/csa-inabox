"""
Storage Plugin for Semantic Kernel

This plugin provides semantic kernel functions for interacting with Azure Data Lake Storage
including listing containers, browsing files, and reading file metadata.
"""

import logging
import json
from typing import Optional, List, Dict, Any
from datetime import datetime

from semantic_kernel.functions import kernel_function
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContainerClient, BlobClient
from azure.storage.filedatalake import DataLakeServiceClient
import pandas as pd

logger = logging.getLogger(__name__)


class StoragePlugin:
    """Plugin for Azure Data Lake Storage operations."""

    def __init__(
        self,
        storage_account_url: Optional[str] = None,
        credential: Optional[DefaultAzureCredential] = None
    ):
        """
        Initialize the Storage Plugin.

        Args:
            storage_account_url: Azure Storage account URL
            credential: Azure credential for authentication
        """
        self.storage_account_url = storage_account_url
        self.credential = credential or DefaultAzureCredential()
        self._blob_service_client: Optional[BlobServiceClient] = None
        self._datalake_service_client: Optional[DataLakeServiceClient] = None

    @property
    def blob_service_client(self) -> Optional[BlobServiceClient]:
        """Get or create Blob service client."""
        if self._blob_service_client is None and self.storage_account_url:
            try:
                self._blob_service_client = BlobServiceClient(
                    account_url=self.storage_account_url,
                    credential=self.credential
                )
            except Exception as e:
                logger.error(f"Failed to create Blob service client: {str(e)}")
                return None
        return self._blob_service_client

    @property
    def datalake_service_client(self) -> Optional[DataLakeServiceClient]:
        """Get or create Data Lake service client."""
        if self._datalake_service_client is None and self.storage_account_url:
            try:
                self._datalake_service_client = DataLakeServiceClient(
                    account_url=self.storage_account_url,
                    credential=self.credential
                )
            except Exception as e:
                logger.error(f"Failed to create Data Lake service client: {str(e)}")
                return None
        return self._datalake_service_client

    @kernel_function(
        description="List all containers in the storage account",
        name="list_containers"
    )
    def list_containers(self) -> str:
        """
        List all containers in the storage account.

        Returns:
            List of containers as JSON string or error message
        """
        try:
            if not self.blob_service_client:
                return "Error: Blob service client not configured"

            logger.info("Listing storage containers")

            containers = []
            container_list = self.blob_service_client.list_containers()

            for container in container_list:
                container_info = {
                    "name": container.name,
                    "last_modified": container.last_modified.isoformat() if container.last_modified else None,
                    "metadata": dict(container.metadata) if container.metadata else {},
                    "public_access": container.public_access,
                    "has_immutability_policy": getattr(container, 'has_immutability_policy', False),
                    "has_legal_hold": getattr(container, 'has_legal_hold', False)
                }
                containers.append(container_info)

            result = {
                "summary": f"Found {len(containers)} containers",
                "total_containers": len(containers),
                "containers": containers
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to list containers: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="List files in a specific container and path",
        name="list_files"
    )
    def list_files(self, container: str, path: str = "", max_results: int = 100) -> str:
        """
        List files in a specific container and path.

        Args:
            container: Container name
            path: Path within the container (optional)
            max_results: Maximum number of files to return

        Returns:
            List of files as JSON string or error message
        """
        try:
            if not self.blob_service_client:
                return "Error: Blob service client not configured"

            logger.info(f"Listing files in container: {container}, path: {path}")

            container_client = self.blob_service_client.get_container_client(container)

            # List blobs with the specified prefix
            blob_list = container_client.list_blobs(name_starts_with=path)

            files = []
            count = 0
            for blob in blob_list:
                if count >= max_results:
                    break

                file_info = {
                    "name": blob.name,
                    "size": blob.size,
                    "last_modified": blob.last_modified.isoformat() if blob.last_modified else None,
                    "content_type": blob.content_settings.content_type if blob.content_settings else None,
                    "content_encoding": blob.content_settings.content_encoding if blob.content_settings else None,
                    "etag": blob.etag,
                    "metadata": dict(blob.metadata) if blob.metadata else {},
                    "blob_type": blob.blob_type,
                    "tier": getattr(blob, 'blob_tier', None)
                }
                files.append(file_info)
                count += 1

            result = {
                "summary": f"Found {len(files)} files in container '{container}', path '{path}'",
                "container": container,
                "path": path,
                "total_files": len(files),
                "files": files,
                "truncated": count >= max_results
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to list files in container '{container}': {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Read preview of a file (first N rows for structured data)",
        name="read_file_preview"
    )
    def read_file_preview(self, container: str, path: str, rows: int = 10) -> str:
        """
        Read a preview of a file (first N rows for structured data).

        Args:
            container: Container name
            path: File path within the container
            rows: Number of rows to preview (for structured data)

        Returns:
            File preview as JSON string or error message
        """
        try:
            if not self.blob_service_client:
                return "Error: Blob service client not configured"

            logger.info(f"Reading file preview: {container}/{path}, rows: {rows}")

            blob_client = self.blob_service_client.get_blob_client(
                container=container,
                blob=path
            )

            # Get file properties
            properties = blob_client.get_blob_properties()
            file_size = properties.size
            content_type = properties.content_settings.content_type if properties.content_settings else 'unknown'

            # Determine if we should read as text or binary
            text_types = ['text/', 'application/json', 'application/csv', 'application/xml']
            is_text = any(content_type.startswith(t) for t in text_types) or path.lower().endswith(('.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.log'))

            if is_text and file_size < 10 * 1024 * 1024:  # 10MB limit for text files
                # Read text content
                download_stream = blob_client.download_blob()
                content = download_stream.readall().decode('utf-8')

                # Try to parse structured data
                if path.lower().endswith('.csv'):
                    try:
                        df = pd.read_csv(pd.io.common.StringIO(content))
                        if len(df) > rows:
                            df_preview = df.head(rows)
                            preview_info = f"Showing first {rows} of {len(df)} rows"
                        else:
                            df_preview = df
                            preview_info = f"Showing all {len(df)} rows"

                        result = {
                            "file_type": "csv",
                            "file_size": file_size,
                            "preview_info": preview_info,
                            "columns": df_preview.columns.tolist(),
                            "data": df_preview.to_dict('records'),
                            "total_rows": len(df),
                            "total_columns": len(df.columns)
                        }
                    except:
                        result = {
                            "file_type": "text",
                            "file_size": file_size,
                            "preview_info": f"Text content (first {min(1000, len(content))} characters)",
                            "content": content[:1000]
                        }

                elif path.lower().endswith('.json'):
                    try:
                        json_data = json.loads(content)
                        result = {
                            "file_type": "json",
                            "file_size": file_size,
                            "preview_info": "JSON content",
                            "data": json_data
                        }
                    except:
                        result = {
                            "file_type": "text",
                            "file_size": file_size,
                            "preview_info": f"Text content (first {min(1000, len(content))} characters)",
                            "content": content[:1000]
                        }

                else:
                    # Generic text file
                    lines = content.split('\n')
                    preview_lines = lines[:rows]
                    result = {
                        "file_type": "text",
                        "file_size": file_size,
                        "preview_info": f"Showing first {len(preview_lines)} of {len(lines)} lines",
                        "lines": preview_lines,
                        "total_lines": len(lines)
                    }

            else:
                # Binary file or too large
                result = {
                    "file_type": "binary",
                    "file_size": file_size,
                    "content_type": content_type,
                    "preview_info": "Binary file - no preview available",
                    "metadata": dict(properties.metadata) if properties.metadata else {}
                }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to read file preview {container}/{path}: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get detailed metadata for a specific file",
        name="get_file_metadata"
    )
    def get_file_metadata(self, container: str, path: str) -> str:
        """
        Get detailed metadata for a specific file.

        Args:
            container: Container name
            path: File path within the container

        Returns:
            File metadata as JSON string or error message
        """
        try:
            if not self.blob_service_client:
                return "Error: Blob service client not configured"

            logger.info(f"Getting file metadata: {container}/{path}")

            blob_client = self.blob_service_client.get_blob_client(
                container=container,
                blob=path
            )

            properties = blob_client.get_blob_properties()

            metadata = {
                "name": path,
                "container": container,
                "size": properties.size,
                "creation_time": properties.creation_time.isoformat() if properties.creation_time else None,
                "last_modified": properties.last_modified.isoformat() if properties.last_modified else None,
                "etag": properties.etag,
                "blob_type": properties.blob_type,
                "content_settings": {
                    "content_type": properties.content_settings.content_type if properties.content_settings else None,
                    "content_encoding": properties.content_settings.content_encoding if properties.content_settings else None,
                    "content_language": properties.content_settings.content_language if properties.content_settings else None,
                    "content_disposition": properties.content_settings.content_disposition if properties.content_settings else None,
                    "cache_control": properties.content_settings.cache_control if properties.content_settings else None
                },
                "metadata": dict(properties.metadata) if properties.metadata else {},
                "lease": {
                    "status": properties.lease.status if properties.lease else None,
                    "state": properties.lease.state if properties.lease else None,
                    "duration": properties.lease.duration if properties.lease else None
                },
                "copy": {
                    "id": properties.copy.id if properties.copy else None,
                    "source": properties.copy.source if properties.copy else None,
                    "status": properties.copy.status if properties.copy else None,
                    "progress": properties.copy.progress if properties.copy else None,
                    "completion_time": properties.copy.completion_time.isoformat() if properties.copy and properties.copy.completion_time else None
                },
                "server_encrypted": getattr(properties, 'server_encrypted', None),
                "encryption_key_sha256": getattr(properties, 'encryption_key_sha256', None),
                "access_tier": getattr(properties, 'blob_tier', None),
                "archive_status": getattr(properties, 'archive_status', None),
                "tag_count": getattr(properties, 'tag_count', 0)
            }

            # Try to get tags if available
            try:
                tags = blob_client.get_blob_tags()
                metadata["tags"] = dict(tags)
            except:
                metadata["tags"] = {}

            return json.dumps(metadata, indent=2)

        except Exception as e:
            error_msg = f"Failed to get file metadata {container}/{path}: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Search for files by name pattern in a container",
        name="search_files"
    )
    def search_files(self, container: str, pattern: str, path: str = "", max_results: int = 50) -> str:
        """
        Search for files by name pattern in a container.

        Args:
            container: Container name
            pattern: File name pattern to search for
            path: Path within the container to search (optional)
            max_results: Maximum number of results to return

        Returns:
            Search results as JSON string or error message
        """
        try:
            if not self.blob_service_client:
                return "Error: Blob service client not configured"

            logger.info(f"Searching files in container: {container}, pattern: {pattern}")

            container_client = self.blob_service_client.get_container_client(container)
            blob_list = container_client.list_blobs(name_starts_with=path)

            matching_files = []
            count = 0

            for blob in blob_list:
                if count >= max_results:
                    break

                # Simple pattern matching (case-insensitive)
                if pattern.lower() in blob.name.lower():
                    file_info = {
                        "name": blob.name,
                        "size": blob.size,
                        "last_modified": blob.last_modified.isoformat() if blob.last_modified else None,
                        "content_type": blob.content_settings.content_type if blob.content_settings else None
                    }
                    matching_files.append(file_info)
                    count += 1

            result = {
                "summary": f"Found {len(matching_files)} files matching pattern '{pattern}' in container '{container}'",
                "container": container,
                "search_pattern": pattern,
                "search_path": path,
                "total_matches": len(matching_files),
                "files": matching_files,
                "truncated": count >= max_results
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to search files in container '{container}': {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"
