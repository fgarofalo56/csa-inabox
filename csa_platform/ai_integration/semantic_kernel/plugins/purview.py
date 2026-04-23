"""
Purview Plugin for Semantic Kernel

This plugin provides semantic kernel functions for comprehensive Microsoft Purview operations
including asset search, detailed metadata retrieval, and data quality assessments.
"""

import json
import logging

from azure.identity import DefaultAzureCredential
from azure.purview.account import PurviewAccountClient
from azure.purview.catalog import PurviewCatalogClient
from semantic_kernel.functions import kernel_function

logger = logging.getLogger(__name__)


class PurviewPlugin:
    """Plugin for comprehensive Microsoft Purview operations."""

    def __init__(
        self,
        purview_endpoint: str | None = None,
        credential: DefaultAzureCredential | None = None
    ):
        """
        Initialize the Purview Plugin.

        Args:
            purview_endpoint: Purview account endpoint URL
            credential: Azure credential for authentication
        """
        self.purview_endpoint = purview_endpoint
        self.credential = credential or DefaultAzureCredential()
        self._catalog_client: PurviewCatalogClient | None = None
        self._account_client: PurviewAccountClient | None = None

    @property
    def catalog_client(self) -> PurviewCatalogClient | None:
        """Get or create Purview catalog client."""
        if self._catalog_client is None and self.purview_endpoint:
            try:
                self._catalog_client = PurviewCatalogClient(
                    endpoint=self.purview_endpoint,
                    credential=self.credential
                )
            except Exception as e:
                logger.error(f"Failed to create Purview catalog client: {e!s}")
                return None
        return self._catalog_client

    @property
    def account_client(self) -> PurviewAccountClient | None:
        """Get or create Purview account client."""
        if self._account_client is None and self.purview_endpoint:
            try:
                self._account_client = PurviewAccountClient(
                    endpoint=self.purview_endpoint,
                    credential=self.credential
                )
            except Exception as e:
                logger.error(f"Failed to create Purview account client: {e!s}")
                return None
        return self._account_client

    @kernel_function(
        description="Search for data assets in Purview catalog",
        name="search_assets"
    )
    def search_assets(self, query: str, limit: int = 10, asset_type: str = "") -> str:
        """
        Search for data assets in Purview catalog.

        Args:
            query: Search query string
            limit: Maximum number of results to return
            asset_type: Optional filter by asset type (e.g., 'azure_sql_table', 'adls_gen2_folder')

        Returns:
            Search results as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Searching Purview assets for: {query}")

            # Prepare search request
            search_request = {
                "keywords": query,
                "limit": limit,
                "filter": {}
            }

            if asset_type:
                search_request["filter"]["entityType"] = [asset_type]

            # Execute search
            response = self.catalog_client.discovery.query(search_request)

            if not response or not hasattr(response, 'value'):
                return "No assets found matching the search criteria."

            assets = []
            for asset in response.value[:limit]:
                asset_info = {
                    "id": getattr(asset, 'id', 'Unknown'),
                    "name": getattr(asset, 'name', 'Unknown'),
                    "qualified_name": getattr(asset, 'qualifiedName', 'Unknown'),
                    "asset_type": getattr(asset, 'assetType', 'Unknown'),
                    "description": getattr(asset, 'description', ''),
                    "owner": getattr(asset, 'owner', ''),
                    "classifications": getattr(asset, 'classification', []),
                    "glossary_terms": getattr(asset, 'glossaryTerms', []),
                    "contact": {
                        "expert": getattr(asset, 'expert', []),
                        "owner": getattr(asset, 'owner', [])
                    }
                }
                assets.append(asset_info)

            result = {
                "summary": f"Found {len(assets)} assets matching '{query}'",
                "search_query": query,
                "asset_type_filter": asset_type,
                "total_results": len(assets),
                "assets": assets
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Asset search failed: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get detailed information about a specific asset",
        name="get_asset_details"
    )
    def get_asset_details(self, qualified_name: str) -> str:
        """
        Get detailed information about a specific asset.

        Args:
            qualified_name: The qualified name of the asset

        Returns:
            Detailed asset information as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Getting asset details for: {qualified_name}")

            # Get asset by qualified name
            try:
                response = self.catalog_client.entity.get_by_unique_attributes(
                    type_name="DataSet",  # Generic type, may need adjustment based on actual asset type
                    attr_qualified_name=qualified_name
                )
            except Exception:
                # Try different common entity types
                for entity_type in ["azure_sql_table", "adls_gen2_folder", "adls_gen2_file", "DataSet"]:
                    try:
                        response = self.catalog_client.entity.get_by_unique_attributes(
                            type_name=entity_type,
                            attr_qualified_name=qualified_name
                        )
                        break
                    except Exception:
                        continue
                else:
                    return f"Asset with qualified name '{qualified_name}' not found."

            if not response or 'entity' not in response:
                return f"Asset with qualified name '{qualified_name}' not found."

            entity = response['entity']

            # Extract detailed information
            asset_details = {
                "guid": entity.get('guid', ''),
                "type_name": entity.get('typeName', ''),
                "display_text": entity.get('displayText', ''),
                "status": entity.get('status', ''),
                "created_by": entity.get('createdBy', ''),
                "updated_by": entity.get('updatedBy', ''),
                "create_time": entity.get('createTime', 0),
                "update_time": entity.get('updateTime', 0),
                "version": entity.get('version', 0),
                "proxy_url": entity.get('proxyUrl', ''),
                "source": entity.get('source', ''),
                "home_id": entity.get('homeId', '')
            }

            # Extract attributes
            attributes = entity.get('attributes', {})
            asset_details['attributes'] = attributes

            # Extract classifications
            classifications = entity.get('classifications', [])
            classification_details = []
            for classification in classifications:
                class_detail = {
                    "type_name": classification.get('typeName', ''),
                    "attributes": classification.get('attributes', {}),
                    "entity_guid": classification.get('entityGuid', ''),
                    "entity_status": classification.get('entityStatus', ''),
                    "source": classification.get('source', ''),
                    "source_details": classification.get('sourceDetails', {})
                }
                classification_details.append(class_detail)

            asset_details['classifications'] = classification_details

            # Extract meanings (glossary terms)
            meanings = entity.get('meanings', [])
            meaning_details = []
            for meaning in meanings:
                meaning_detail = {
                    "display_text": meaning.get('displayText', ''),
                    "relation_guid": meaning.get('relationGuid', ''),
                    "expression": meaning.get('expression', ''),
                    "confidence": meaning.get('confidence', 0),
                    "steward": meaning.get('steward', ''),
                    "source": meaning.get('source', '')
                }
                meaning_details.append(meaning_detail)

            asset_details['glossary_terms'] = meaning_details

            # Extract relationship attributes
            relationship_attrs = entity.get('relationshipAttributes', {})
            asset_details['relationships'] = relationship_attrs

            result = {
                "summary": f"Detailed information for asset '{qualified_name}'",
                "qualified_name": qualified_name,
                "asset": asset_details
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to get asset details: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Browse glossary terms with optional parent filter",
        name="list_glossary_terms"
    )
    def list_glossary_terms(self, parent: str | None = None, limit: int = 50) -> str:
        """
        Browse glossary terms with optional parent filter.

        Args:
            parent: Parent term GUID to filter by (optional)
            limit: Maximum number of terms to return

        Returns:
            Glossary terms as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Listing glossary terms, parent: {parent}")

            # Get glossary terms
            glossary_response = self.catalog_client.glossary.list_terms(limit=limit)

            if not glossary_response:
                return "No glossary terms found or glossary not accessible."

            terms = []
            for term in glossary_response:
                term_info = {
                    "guid": getattr(term, 'guid', ''),
                    "name": getattr(term, 'name', ''),
                    "short_description": getattr(term, 'shortDescription', ''),
                    "long_description": getattr(term, 'longDescription', ''),
                    "definition": getattr(term, 'definition', ''),
                    "abbreviation": getattr(term, 'abbreviation', ''),
                    "template": getattr(term, 'template', ''),
                    "status": getattr(term, 'status', ''),
                    "nick_name": getattr(term, 'nickName', ''),
                    "hierarchical_naming": getattr(term, 'hierarchicalNaming', False),
                    "created_by": getattr(term, 'createdBy', ''),
                    "updated_by": getattr(term, 'updatedBy', ''),
                    "create_time": getattr(term, 'createTime', 0),
                    "update_time": getattr(term, 'updateTime', 0)
                }

                # Filter by parent if specified
                if parent:
                    term_parent = getattr(term, 'parentTermGuid', '')
                    if term_parent != parent:
                        continue

                terms.append(term_info)

                if len(terms) >= limit:
                    break

            result = {
                "summary": f"Found {len(terms)} glossary terms" + (f" under parent '{parent}'" if parent else ""),
                "parent_filter": parent,
                "total_terms": len(terms),
                "terms": terms
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to list glossary terms: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get data quality score and metrics for an asset",
        name="get_quality_score"
    )
    def get_quality_score(self, asset: str) -> str:
        """
        Get data quality score and metrics for an asset.

        Args:
            asset: Asset qualified name or GUID

        Returns:
            Quality metrics as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Getting quality metrics for asset: {asset}")

            # Get asset details first
            try:
                if asset.startswith("guid:"):
                    asset_guid = asset[5:]  # Remove "guid:" prefix
                    response = self.catalog_client.entity.get_by_guid(asset_guid)
                else:
                    # Try to find asset by qualified name
                    response = self.catalog_client.entity.get_by_unique_attributes(
                        type_name="DataSet",
                        attr_qualified_name=asset
                    )
                    asset_guid = response['entity']['guid']

            except Exception:
                return f"Asset '{asset}' not found or not accessible."

            if not response or 'entity' not in response:
                return f"Asset '{asset}' not found."

            entity = response['entity']

            # Calculate quality score based on available metadata
            quality_metrics = {
                "overall_score": 0,
                "completeness": 0,
                "accuracy": 0,
                "consistency": 0,
                "timeliness": 0,
                "validity": 0
            }

            # Completeness: Check for description, owner, classifications
            completeness_factors = []
            if entity.get('attributes', {}).get('description'):
                completeness_factors.append(25)
            if entity.get('attributes', {}).get('owner'):
                completeness_factors.append(25)
            if entity.get('classifications', []):
                completeness_factors.append(25)
            if entity.get('meanings', []):
                completeness_factors.append(25)

            quality_metrics["completeness"] = sum(completeness_factors)

            # Validity: Check for proper naming and structure
            validity_factors = []
            qualified_name = entity.get('attributes', {}).get('qualifiedName', '')
            if qualified_name and '/' in qualified_name:  # Proper path structure
                validity_factors.append(50)
            if entity.get('typeName') and entity.get('typeName') != 'DataSet':  # Specific type
                validity_factors.append(50)

            quality_metrics["validity"] = sum(validity_factors)

            # Timeliness: Check update time
            update_time = entity.get('updateTime', 0)
            if update_time > 0:
                import time
                days_since_update = (time.time() * 1000 - update_time) / (1000 * 60 * 60 * 24)
                if days_since_update <= 30:
                    quality_metrics["timeliness"] = 100
                elif days_since_update <= 90:
                    quality_metrics["timeliness"] = 75
                elif days_since_update <= 180:
                    quality_metrics["timeliness"] = 50
                else:
                    quality_metrics["timeliness"] = 25
            else:
                quality_metrics["timeliness"] = 0

            # Consistency: Check for standard classifications and naming
            consistency_factors = []
            classifications = entity.get('classifications', [])
            standard_classifications = ['Confidential', 'Personal', 'Public', 'Internal']
            if any(c.get('typeName') in standard_classifications for c in classifications):
                consistency_factors.append(50)

            # Check for consistent naming patterns
            name = entity.get('displayText', '')
            if name and ('_' in name or '-' in name):  # Some naming convention
                consistency_factors.append(50)

            quality_metrics["consistency"] = sum(consistency_factors)

            # Accuracy: Based on presence of validation rules and constraints
            # This would typically require additional data quality tools integration
            accuracy_factors = []
            if entity.get('attributes', {}).get('schema'):
                accuracy_factors.append(50)
            if len(classifications) > 0:
                accuracy_factors.append(50)

            quality_metrics["accuracy"] = sum(accuracy_factors)

            # Calculate overall score
            scores = [quality_metrics[key] for key in ['completeness', 'accuracy', 'consistency', 'timeliness', 'validity']]
            quality_metrics["overall_score"] = sum(scores) / len(scores)

            # Add detailed breakdown
            quality_breakdown = {
                "asset_name": entity.get('displayText', asset),
                "asset_type": entity.get('typeName', ''),
                "qualified_name": qualified_name,
                "last_updated": update_time,
                "classifications_count": len(classifications),
                "glossary_terms_count": len(entity.get('meanings', [])),
                "has_description": bool(entity.get('attributes', {}).get('description')),
                "has_owner": bool(entity.get('attributes', {}).get('owner')),
                "quality_metrics": quality_metrics
            }

            result = {
                "summary": f"Quality assessment for asset '{asset}'",
                "overall_score": round(quality_metrics["overall_score"], 1),
                "grade": self._get_quality_grade(quality_metrics["overall_score"]),
                "assessment": quality_breakdown
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to get quality score: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    def _get_quality_grade(self, score: float) -> str:
        """Convert quality score to letter grade."""
        if score >= 90:
            return "A"
        if score >= 80:
            return "B"
        if score >= 70:
            return "C"
        if score >= 60:
            return "D"
        return "F"

    @kernel_function(
        description="Get collections and their contents",
        name="list_collections"
    )
    def list_collections(self, collection_name: str | None = None) -> str:
        """
        Get collections and their contents.

        Args:
            collection_name: Specific collection name to query (optional)

        Returns:
            Collections information as JSON string or error message
        """
        try:
            if not self.account_client:
                return "Error: Purview account client not configured"

            logger.info(f"Listing collections, collection: {collection_name}")

            # Get collections
            if collection_name:
                # Get specific collection
                collection_response = self.account_client.collections.get_collection(collection_name)
                collections = [collection_response] if collection_response else []
            else:
                # List all collections
                collection_response = self.account_client.collections.list_collections()
                collections = collection_response.value if collection_response and hasattr(collection_response, 'value') else []

            collection_details = []
            for collection in collections:
                collection_info = {
                    "name": getattr(collection, 'name', ''),
                    "friendly_name": getattr(collection, 'friendlyName', ''),
                    "description": getattr(collection, 'description', ''),
                    "collection_id": getattr(collection, 'collectionId', ''),
                    "parent_collection": getattr(collection, 'parentCollection', {}),
                    "system_data": getattr(collection, 'systemData', {})
                }
                collection_details.append(collection_info)

            result = {
                "summary": f"Found {len(collection_details)} collections",
                "collection_filter": collection_name,
                "total_collections": len(collection_details),
                "collections": collection_details
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Failed to list collections: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"
