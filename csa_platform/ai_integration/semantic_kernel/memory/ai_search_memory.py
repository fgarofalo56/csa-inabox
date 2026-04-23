"""
Azure AI Search Memory Store for Semantic Kernel

This module provides a memory store implementation using Azure AI Search
for storing and retrieving conversation history, facts, and semantic memories.
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from azure.core.credentials import AzureKeyCredential
from azure.identity import DefaultAzureCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    HnswAlgorithmConfiguration,
    SearchableField,
    SearchField,
    SearchFieldDataType,
    SearchIndex,
    SimpleField,
    VectorSearch,
    VectorSearchAlgorithmKind,
    VectorSearchProfile,
)
from azure.search.documents.models import VectorizedQuery
from semantic_kernel.memory import MemoryRecord, MemoryStore
from semantic_kernel.utils.experimental_decorator import experimental_class

logger = logging.getLogger(__name__)


@experimental_class
class AISearchMemoryStore(MemoryStore):
    """Azure AI Search implementation of Semantic Kernel MemoryStore."""

    def __init__(
        self,
        search_endpoint: str,
        api_key: str | None = None,
        credential: DefaultAzureCredential | None = None,
        index_name: str = "sk-memory",
        vector_dimensions: int = 1536
    ):
        """
        Initialize the Azure AI Search memory store.

        Args:
            search_endpoint: Azure AI Search service endpoint
            api_key: API key for authentication (if None, uses DefaultAzureCredential)
            credential: Azure credential for authentication
            index_name: Name of the search index to use
            vector_dimensions: Dimensions of the embedding vectors
        """
        self.search_endpoint = search_endpoint
        self.index_name = index_name
        self.vector_dimensions = vector_dimensions

        # Set up authentication
        if api_key:
            self.credential = AzureKeyCredential(api_key)
        elif credential:
            self.credential = credential
        else:
            self.credential = DefaultAzureCredential()

        # Initialize clients
        self.index_client = SearchIndexClient(
            endpoint=search_endpoint,
            credential=self.credential
        )
        self.search_client = SearchClient(
            endpoint=search_endpoint,
            index_name=index_name,
            credential=self.credential
        )

        self._ensure_index_exists()

    def _ensure_index_exists(self) -> None:
        """Ensure the search index exists, create if it doesn't."""
        try:
            # Check if index exists
            try:
                self.index_client.get_index(self.index_name)
                logger.info(f"Using existing index: {self.index_name}")
                return
            except Exception:
                logger.info(f"Creating new index: {self.index_name}")

            # Define the index schema
            fields = [
                SimpleField(
                    name="id",
                    type=SearchFieldDataType.String,
                    key=True,
                    sortable=True,
                    filterable=True,
                    facetable=False
                ),
                SearchableField(
                    name="text",
                    type=SearchFieldDataType.String,
                    searchable=True,
                    filterable=True,
                    sortable=False,
                    facetable=False
                ),
                SearchableField(
                    name="description",
                    type=SearchFieldDataType.String,
                    searchable=True,
                    filterable=True,
                    sortable=False,
                    facetable=False
                ),
                SimpleField(
                    name="collection",
                    type=SearchFieldDataType.String,
                    filterable=True,
                    facetable=True,
                    sortable=True
                ),
                SimpleField(
                    name="timestamp",
                    type=SearchFieldDataType.DateTimeOffset,
                    filterable=True,
                    sortable=True,
                    facetable=False
                ),
                SearchableField(
                    name="metadata",
                    type=SearchFieldDataType.String,
                    searchable=True,
                    filterable=False,
                    sortable=False,
                    facetable=False
                ),
                SearchField(
                    name="embedding",
                    type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                    searchable=True,
                    vector_search_dimensions=self.vector_dimensions,
                    vector_search_profile_name="vector-profile"
                )
            ]

            # Configure vector search
            vector_search = VectorSearch(
                algorithms=[
                    HnswAlgorithmConfiguration(
                        name="hnsw-algorithm",
                        kind=VectorSearchAlgorithmKind.HNSW,
                        parameters={
                            "m": 4,
                            "efConstruction": 400,
                            "efSearch": 500,
                            "metric": "cosine"
                        }
                    )
                ],
                profiles=[
                    VectorSearchProfile(
                        name="vector-profile",
                        algorithm_configuration_name="hnsw-algorithm"
                    )
                ]
            )

            # Create the index
            index = SearchIndex(
                name=self.index_name,
                fields=fields,
                vector_search=vector_search
            )

            self.index_client.create_index(index)
            logger.info(f"Successfully created index: {self.index_name}")

        except Exception as e:
            logger.error(f"Failed to create/verify index: {e!s}")
            raise

    async def create_collection_async(self, collection_name: str) -> None:
        """
        Create a collection (no-op for AI Search, collections are implicit).

        Args:
            collection_name: Name of the collection to create
        """
        logger.info(f"Collection '{collection_name}' noted (implicit in AI Search)")

    async def delete_collection_async(self, collection_name: str) -> None:
        """
        Delete a collection by removing all documents with that collection name.

        Args:
            collection_name: Name of the collection to delete
        """
        try:
            logger.info(f"Deleting collection: {collection_name}")

            # Search for all documents in the collection
            results = self.search_client.search(
                search_text="*",
                filter=f"collection eq '{collection_name}'",
                select=["id"]
            )

            # Delete documents
            documents_to_delete = []
            for result in results:
                documents_to_delete.append({"@search.action": "delete", "id": result["id"]})

            if documents_to_delete:
                result = self.search_client.upload_documents(documents_to_delete)
                logger.info(f"Deleted {len(documents_to_delete)} documents from collection '{collection_name}'")

        except Exception as e:
            logger.error(f"Failed to delete collection '{collection_name}': {e!s}")
            raise

    async def does_collection_exist_async(self, collection_name: str) -> bool:
        """
        Check if a collection exists by searching for documents.

        Args:
            collection_name: Name of the collection to check

        Returns:
            True if collection has documents, False otherwise
        """
        try:
            results = self.search_client.search(
                search_text="*",
                filter=f"collection eq '{collection_name}'",
                top=1,
                select=["id"]
            )

            # Check if any results exist
            for _ in results:
                return True
            return False

        except Exception as e:
            logger.error(f"Failed to check collection existence '{collection_name}': {e!s}")
            return False

    async def get_collections_async(self) -> list[str]:
        """
        Get all collection names.

        Returns:
            List of collection names
        """
        try:
            # Use facets to get unique collection names
            results = self.search_client.search(
                search_text="*",
                facets=["collection"],
                top=0
            )

            collections = []
            if hasattr(results, 'get_facets'):
                facets = results.get_facets()
                if 'collection' in facets:
                    collections = [facet['value'] for facet in facets['collection']]

            logger.info(f"Found {len(collections)} collections")
            return collections

        except Exception as e:
            logger.error(f"Failed to get collections: {e!s}")
            return []

    async def upsert_async(self, collection_name: str, record: MemoryRecord) -> str:
        """
        Upsert a memory record into the specified collection.

        Args:
            collection_name: Name of the collection
            record: Memory record to upsert

        Returns:
            The record ID
        """
        try:
            # Generate ID if not provided
            record_id = record._id or str(uuid.uuid4())

            # Prepare document for upload
            document = {
                "@search.action": "upload",
                "id": record_id,
                "text": record._text or "",
                "description": record._description or "",
                "collection": collection_name,
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                "metadata": json.dumps(record._additional_metadata) if record._additional_metadata else "{}",
                "embedding": record._embedding.tolist() if record._embedding is not None else None
            }

            # Upload the document
            result = self.search_client.upload_documents([document])

            # Check for errors
            if result and len(result) > 0 and result[0].succeeded:
                logger.info(f"Successfully upserted record: {record_id}")
                return record_id
            error_msg = f"Failed to upsert record: {result[0].error_message if result else 'Unknown error'}"
            logger.error(error_msg)
            raise Exception(error_msg)

        except Exception as e:
            logger.error(f"Failed to upsert record: {e!s}")
            raise

    async def get_async(self, collection_name: str, key: str) -> MemoryRecord | None:
        """
        Get a memory record by ID.

        Args:
            collection_name: Name of the collection
            key: Record ID

        Returns:
            MemoryRecord if found, None otherwise
        """
        try:
            # Get document by ID
            result = self.search_client.get_document(key=key)

            if result and result.get('collection') == collection_name:
                return self._convert_to_memory_record(result)
            return None

        except Exception as e:
            if "not found" in str(e).lower():
                return None
            logger.error(f"Failed to get record '{key}': {e!s}")
            raise

    async def remove_async(self, collection_name: str, key: str) -> None:  # noqa: ARG002
        """
        Remove a memory record by ID.

        Args:
            collection_name: Name of the collection
            key: Record ID
        """
        try:
            document = {"@search.action": "delete", "id": key}
            result = self.search_client.upload_documents([document])

            if result and len(result) > 0 and result[0].succeeded:
                logger.info(f"Successfully removed record: {key}")
            else:
                error_msg = f"Failed to remove record: {result[0].error_message if result else 'Unknown error'}"
                logger.error(error_msg)

        except Exception as e:
            logger.error(f"Failed to remove record '{key}': {e!s}")
            raise

    async def get_batch_async(self, collection_name: str, keys: list[str]) -> list[MemoryRecord]:
        """
        Get multiple memory records by IDs.

        Args:
            collection_name: Name of the collection
            keys: List of record IDs

        Returns:
            List of MemoryRecords found
        """
        try:
            records = []

            # Create filter for multiple IDs
            id_filter = " or ".join([f"id eq '{key}'" for key in keys])
            filter_expr = f"collection eq '{collection_name}' and ({id_filter})"

            results = self.search_client.search(
                search_text="*",
                filter=filter_expr,
                top=len(keys)
            )

            for result in results:
                record = self._convert_to_memory_record(result)
                if record:
                    records.append(record)

            logger.info(f"Retrieved {len(records)} records from batch of {len(keys)}")
            return records

        except Exception as e:
            logger.error(f"Failed to get batch records: {e!s}")
            raise

    async def get_nearest_matches_async(
        self,
        collection_name: str,
        embedding: list[float],
        limit: int,
        min_relevance_score: float = 0.0,
        with_embeddings: bool = False
    ) -> list[tuple]:
        """
        Get nearest matches using vector search.

        Args:
            collection_name: Name of the collection
            embedding: Query embedding vector
            limit: Maximum number of matches to return
            min_relevance_score: Minimum relevance score threshold
            with_embeddings: Whether to include embeddings in results

        Returns:
            List of tuples (MemoryRecord, relevance_score)
        """
        try:
            # Create vector query
            vector_query = VectorizedQuery(
                vector=embedding,
                k_nearest_neighbors=limit,
                fields="embedding"
            )

            # Perform vector search
            results = self.search_client.search(
                search_text=None,
                vector_queries=[vector_query],
                filter=f"collection eq '{collection_name}'",
                top=limit,
                include_total_count=True
            )

            matches = []
            for result in results:
                score = result.get('@search.score', 0.0)

                # Apply relevance threshold
                if score >= min_relevance_score:
                    record = self._convert_to_memory_record(result, include_embedding=with_embeddings)
                    if record:
                        matches.append((record, score))

            logger.info(f"Found {len(matches)} nearest matches for collection '{collection_name}'")
            return matches

        except Exception as e:
            logger.error(f"Failed to get nearest matches: {e!s}")
            raise

    async def get_nearest_match_async(
        self,
        collection_name: str,
        embedding: list[float],
        min_relevance_score: float = 0.0,
        with_embedding: bool = False
    ) -> tuple | None:
        """
        Get the nearest match using vector search.

        Args:
            collection_name: Name of the collection
            embedding: Query embedding vector
            min_relevance_score: Minimum relevance score threshold
            with_embedding: Whether to include embedding in result

        Returns:
            Tuple (MemoryRecord, relevance_score) if found, None otherwise
        """
        try:
            matches = await self.get_nearest_matches_async(
                collection_name=collection_name,
                embedding=embedding,
                limit=1,
                min_relevance_score=min_relevance_score,
                with_embeddings=with_embedding
            )

            return matches[0] if matches else None

        except Exception as e:
            logger.error(f"Failed to get nearest match: {e!s}")
            raise

    def _convert_to_memory_record(self, search_result: dict[str, Any], include_embedding: bool = False) -> MemoryRecord | None:
        """
        Convert AI Search result to MemoryRecord.

        Args:
            search_result: Search result from AI Search
            include_embedding: Whether to include embedding vector

        Returns:
            MemoryRecord instance or None if conversion fails
        """
        try:
            # Parse metadata
            metadata = {}
            metadata_str = search_result.get('metadata', '{}')
            if metadata_str:
                try:
                    metadata = json.loads(metadata_str)
                except json.JSONDecodeError:
                    logger.warning(f"Failed to parse metadata: {metadata_str}")

            # Get embedding if requested
            embedding = None
            if include_embedding and 'embedding' in search_result:
                embedding = search_result['embedding']

            # Create MemoryRecord
            return MemoryRecord(
                id=search_result.get('id', ''),
                text=search_result.get('text', ''),
                description=search_result.get('description', ''),
                additional_metadata=metadata,
                embedding=embedding,
                timestamp=search_result.get('timestamp')
            )

        except Exception as e:
            logger.error(f"Failed to convert search result to MemoryRecord: {e!s}")
            return None

    async def search_async(
        self,
        collection_name: str,
        query: str,
        limit: int = 10,
        min_relevance_score: float = 0.0
    ) -> list[tuple]:
        """
        Perform text search in the collection.

        Args:
            collection_name: Name of the collection
            query: Search query text
            limit: Maximum number of results
            min_relevance_score: Minimum relevance score threshold

        Returns:
            List of tuples (MemoryRecord, relevance_score)
        """
        try:
            results = self.search_client.search(
                search_text=query,
                filter=f"collection eq '{collection_name}'",
                top=limit,
                include_total_count=True
            )

            matches = []
            for result in results:
                score = result.get('@search.score', 0.0)

                # Apply relevance threshold
                if score >= min_relevance_score:
                    record = self._convert_to_memory_record(result)
                    if record:
                        matches.append((record, score))

            logger.info(f"Found {len(matches)} text search matches for query '{query}'")
            return matches

        except Exception as e:
            logger.error(f"Failed to search: {e!s}")
            raise
