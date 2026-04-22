"""
Governance Plugin for Semantic Kernel

This plugin provides semantic kernel functions for data governance operations
including Purview catalog search, glossary management, and data contract validation.
"""

import logging
import json
import yaml
from typing import Optional, List, Dict, Any

from semantic_kernel.functions import kernel_function
from azure.identity import DefaultAzureCredential
from azure.purview.catalog import PurviewCatalogClient
from azure.purview.scanning import PurviewScanningClient
import requests

logger = logging.getLogger(__name__)


class GovernancePlugin:
    """Plugin for data governance and compliance operations."""

    def __init__(
        self,
        purview_endpoint: Optional[str] = None,
        credential: Optional[DefaultAzureCredential] = None
    ):
        """
        Initialize the Governance Plugin.

        Args:
            purview_endpoint: Purview catalog endpoint URL
            credential: Azure credential for authentication
        """
        self.purview_endpoint = purview_endpoint
        self.credential = credential or DefaultAzureCredential()
        self._catalog_client: Optional[PurviewCatalogClient] = None
        self._scanning_client: Optional[PurviewScanningClient] = None

    @property
    def catalog_client(self) -> Optional[PurviewCatalogClient]:
        """Get or create Purview catalog client."""
        if self._catalog_client is None and self.purview_endpoint:
            try:
                self._catalog_client = PurviewCatalogClient(
                    endpoint=self.purview_endpoint,
                    credential=self.credential
                )
            except Exception as e:
                logger.error(f"Failed to create Purview catalog client: {str(e)}")
                return None
        return self._catalog_client

    @property
    def scanning_client(self) -> Optional[PurviewScanningClient]:
        """Get or create Purview scanning client."""
        if self._scanning_client is None and self.purview_endpoint:
            try:
                self._scanning_client = PurviewScanningClient(
                    endpoint=self.purview_endpoint,
                    credential=self.credential
                )
            except Exception as e:
                logger.error(f"Failed to create Purview scanning client: {str(e)}")
                return None
        return self._scanning_client

    @kernel_function(
        description="Search the Purview data catalog for assets",
        name="search_catalog"
    )
    def search_catalog(self, query: str, limit: int = 10) -> str:
        """
        Search the Purview data catalog for assets.

        Args:
            query: Search query string
            limit: Maximum number of results to return

        Returns:
            Search results as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Searching Purview catalog for: {query}")

            # Prepare search request
            search_request = {
                "keywords": query,
                "limit": limit,
                "filter": {}
            }

            # Execute search
            response = self.catalog_client.discovery.query(search_request)

            if not response or not hasattr(response, 'value'):
                return "No results found in catalog search."

            results = []
            for asset in response.value[:limit]:
                asset_info = {
                    "id": getattr(asset, 'id', 'Unknown'),
                    "name": getattr(asset, 'name', 'Unknown'),
                    "qualified_name": getattr(asset, 'qualifiedName', 'Unknown'),
                    "asset_type": getattr(asset, 'assetType', 'Unknown'),
                    "description": getattr(asset, 'description', ''),
                    "owner": getattr(asset, 'owner', ''),
                    "classifications": getattr(asset, 'classification', [])
                }
                results.append(asset_info)

            result = {
                "summary": f"Found {len(results)} assets matching '{query}'",
                "total_results": len(results),
                "assets": results
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Catalog search failed: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get glossary term definition from Purview",
        name="get_glossary_term"
    )
    def get_glossary_term(self, term: str) -> str:
        """
        Look up a glossary term definition from Purview.

        Args:
            term: Glossary term name to lookup

        Returns:
            Term definition as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Looking up glossary term: {term}")

            # Search for the term in glossary
            glossary_response = self.catalog_client.glossary.list_terms()

            if not glossary_response:
                return f"No glossary terms found or glossary not accessible."

            matching_terms = []
            for glossary_term in glossary_response:
                if term.lower() in getattr(glossary_term, 'name', '').lower():
                    term_info = {
                        "guid": getattr(glossary_term, 'guid', ''),
                        "name": getattr(glossary_term, 'name', ''),
                        "definition": getattr(glossary_term, 'definition', ''),
                        "abbreviation": getattr(glossary_term, 'abbreviation', ''),
                        "status": getattr(glossary_term, 'status', ''),
                        "created_by": getattr(glossary_term, 'createdBy', ''),
                        "updated_by": getattr(glossary_term, 'updatedBy', '')
                    }
                    matching_terms.append(term_info)

            if not matching_terms:
                return f"No glossary terms found matching '{term}'."

            result = {
                "summary": f"Found {len(matching_terms)} matching terms for '{term}'",
                "terms": matching_terms
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Glossary term lookup failed: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get data classifications for an asset",
        name="check_classification"
    )
    def check_classification(self, asset: str) -> str:
        """
        Get data classifications for a specific asset.

        Args:
            asset: Asset qualified name or ID

        Returns:
            Asset classifications as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Checking classifications for asset: {asset}")

            # Get asset details
            try:
                asset_response = self.catalog_client.entity.get_by_unique_attributes(
                    type_name="DataSet",  # Generic type, may need adjustment
                    attr_qualified_name=asset
                )
            except:
                # Try getting by GUID if qualified name fails
                asset_response = self.catalog_client.entity.get_by_guid(asset)

            if not asset_response:
                return f"Asset '{asset}' not found."

            # Extract classification information
            entity = asset_response.get('entity', {})
            classifications = entity.get('classifications', [])

            classification_info = []
            for classification in classifications:
                class_info = {
                    "type_name": classification.get('typeName', ''),
                    "attributes": classification.get('attributes', {}),
                    "entity_guid": classification.get('entityGuid', ''),
                    "entity_status": classification.get('entityStatus', ''),
                    "remove_propagations_on_entity_delete": classification.get('removePropagationsOnEntityDelete', False)
                }
                classification_info.append(class_info)

            result = {
                "asset_name": entity.get('displayText', asset),
                "asset_type": entity.get('typeName', ''),
                "qualified_name": entity.get('attributes', {}).get('qualifiedName', ''),
                "classification_count": len(classification_info),
                "classifications": classification_info
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Classification check failed: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Validate a data contract YAML specification",
        name="validate_contract"
    )
    def validate_contract(self, contract_yaml: str) -> str:
        """
        Validate a data contract YAML specification.

        Args:
            contract_yaml: YAML string containing the data contract

        Returns:
            Validation results as JSON string
        """
        try:
            logger.info("Validating data contract")

            # Parse YAML
            try:
                contract = yaml.safe_load(contract_yaml)
            except yaml.YAMLError as e:
                return f"Error: Invalid YAML format: {str(e)}"

            validation_results = {
                "valid": True,
                "errors": [],
                "warnings": [],
                "metadata": {}
            }

            # Required fields validation
            required_fields = ['name', 'version', 'description', 'schema']
            for field in required_fields:
                if field not in contract:
                    validation_results["valid"] = False
                    validation_results["errors"].append(f"Missing required field: {field}")

            # Schema validation
            if 'schema' in contract:
                schema = contract['schema']
                if not isinstance(schema, dict):
                    validation_results["valid"] = False
                    validation_results["errors"].append("Schema must be a dictionary")
                elif 'columns' not in schema:
                    validation_results["valid"] = False
                    validation_results["errors"].append("Schema must contain 'columns'")
                else:
                    columns = schema['columns']
                    if not isinstance(columns, list) or len(columns) == 0:
                        validation_results["valid"] = False
                        validation_results["errors"].append("Schema columns must be a non-empty list")
                    else:
                        # Validate each column
                        for i, column in enumerate(columns):
                            if not isinstance(column, dict):
                                validation_results["errors"].append(f"Column {i} must be a dictionary")
                                validation_results["valid"] = False
                                continue

                            if 'name' not in column:
                                validation_results["errors"].append(f"Column {i} missing 'name'")
                                validation_results["valid"] = False

                            if 'type' not in column:
                                validation_results["errors"].append(f"Column {i} missing 'type'")
                                validation_results["valid"] = False

            # Data quality rules validation
            if 'quality' in contract:
                quality = contract['quality']
                if not isinstance(quality, dict):
                    validation_results["warnings"].append("Quality section should be a dictionary")
                elif 'rules' in quality:
                    rules = quality['rules']
                    if not isinstance(rules, list):
                        validation_results["warnings"].append("Quality rules should be a list")

            # SLA validation
            if 'sla' in contract:
                sla = contract['sla']
                if not isinstance(sla, dict):
                    validation_results["warnings"].append("SLA section should be a dictionary")

            # Extract metadata
            validation_results["metadata"] = {
                "name": contract.get('name', ''),
                "version": contract.get('version', ''),
                "description": contract.get('description', ''),
                "owner": contract.get('owner', ''),
                "column_count": len(contract.get('schema', {}).get('columns', [])),
                "has_quality_rules": 'quality' in contract,
                "has_sla": 'sla' in contract
            }

            return json.dumps(validation_results, indent=2)

        except Exception as e:
            error_msg = f"Contract validation failed: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get data lineage information for an asset",
        name="get_lineage"
    )
    def get_lineage(self, asset: str, direction: str = "both") -> str:
        """
        Get data lineage information for an asset.

        Args:
            asset: Asset qualified name or ID
            direction: Lineage direction ('input', 'output', or 'both')

        Returns:
            Lineage information as JSON string or error message
        """
        try:
            if not self.catalog_client:
                return "Error: Purview catalog client not configured"

            logger.info(f"Getting lineage for asset: {asset}, direction: {direction}")

            # Get asset GUID first
            try:
                asset_response = self.catalog_client.entity.get_by_unique_attributes(
                    type_name="DataSet",
                    attr_qualified_name=asset
                )
                asset_guid = asset_response['entity']['guid']
            except:
                # Try using the asset parameter as GUID directly
                asset_guid = asset

            # Get lineage information
            lineage_response = self.catalog_client.lineage.get(
                guid=asset_guid,
                direction=direction,
                depth=3  # Maximum depth of lineage to traverse
            )

            if not lineage_response:
                return f"No lineage information found for asset '{asset}'."

            # Process lineage data
            lineage_info = {
                "base_entity_guid": lineage_response.get('baseEntityGuid', ''),
                "guidEntityMap": {},
                "relations": []
            }

            # Extract entity information
            guid_entity_map = lineage_response.get('guidEntityMap', {})
            for guid, entity_info in guid_entity_map.items():
                lineage_info["guidEntityMap"][guid] = {
                    "type_name": entity_info.get('typeName', ''),
                    "display_text": entity_info.get('displayText', ''),
                    "qualified_name": entity_info.get('attributes', {}).get('qualifiedName', ''),
                    "status": entity_info.get('status', '')
                }

            # Extract relationships
            relations = lineage_response.get('relations', [])
            for relation in relations:
                relation_info = {
                    "from_entity_id": relation.get('fromEntityId', ''),
                    "to_entity_id": relation.get('toEntityId', ''),
                    "relationship_id": relation.get('relationshipId', '')
                }
                lineage_info["relations"].append(relation_info)

            result = {
                "summary": f"Found lineage information for '{asset}'",
                "entity_count": len(lineage_info["guidEntityMap"]),
                "relationship_count": len(lineage_info["relations"]),
                "lineage": lineage_info
            }

            return json.dumps(result, indent=2)

        except Exception as e:
            error_msg = f"Lineage lookup failed: {str(e)}"
            logger.error(error_msg)
            return f"Error: {error_msg}"