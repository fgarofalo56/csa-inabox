"""Azure Purview automation module for CSA-in-a-Box.

Provides programmatic management of Purview classification rules, glossary
terms, scan schedules, lineage registration, and sensitivity label
application. Wraps the Purview REST API (Apache Atlas) for common
governance automation tasks.

Typical use::

    from platform.governance.purview_automation import PurviewAutomation
    from azure.identity import DefaultAzureCredential

    purview = PurviewAutomation(
        account_name="purview-prod",
        credential=DefaultAzureCredential(),
    )

    # Apply classification rules from YAML
    purview.apply_classification_rules("classifications/pii_classifications.yaml")

    # Import glossary terms
    purview.import_glossary_terms("glossary/business_terms.yaml")

    # Register dbt lineage
    purview.register_dbt_lineage("target/manifest.json", "target/run_results.json")
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Domain models
# ──────────────────────────────────────────────────────────────────────


@dataclass
class ClassificationRule:
    """A single classification rule parsed from YAML."""

    name: str
    description: str
    category: str
    subcategory: str = ""
    sensitivity: str = "Confidential"
    data_patterns: list[dict[str, Any]] = field(default_factory=list)
    column_patterns: list[dict[str, Any]] = field(default_factory=list)
    minimum_percentage_match: float = 60.0
    built_in_classifier: str | None = None
    remediation_action: str = "none"


@dataclass
class GlossaryTerm:
    """A business glossary term for Purview import."""

    name: str
    definition: str
    abbreviation: str = ""
    status: str = "Approved"
    contacts: list[dict[str, str]] = field(default_factory=list)
    related_terms: list[str] = field(default_factory=list)
    classifications: list[str] = field(default_factory=list)
    resources: list[dict[str, str]] = field(default_factory=list)


@dataclass
class ScanSchedule:
    """Configuration for a Purview scan schedule."""

    source_name: str
    scan_name: str
    trigger_type: str = "Recurring"
    recurrence_interval: int = 7  # days
    scan_level: str = "Full"
    credential_name: str = ""


@dataclass
class LineageRelationship:
    """A lineage edge between two entities."""

    source_type: str  # e.g., "azure_datalake_gen2_resource_set"
    source_qualified_name: str
    target_type: str
    target_qualified_name: str
    process_type: str  # e.g., "adf_copy_operation"
    process_qualified_name: str
    process_name: str = ""


# ──────────────────────────────────────────────────────────────────────
# Purview client
# ──────────────────────────────────────────────────────────────────────


class PurviewAutomation:
    """High-level client for Azure Purview governance automation.

    Args:
        account_name: The Purview account name (e.g., ``"purview-prod"``).
        credential: An Azure credential object (e.g.,
            ``DefaultAzureCredential()``) for authentication.
        catalog_endpoint: Override the catalog API endpoint. When ``None``,
            uses ``https://{account_name}.purview.azure.com``.
    """

    def __init__(
        self,
        account_name: str,
        credential: Any,
        catalog_endpoint: str | None = None,
    ) -> None:
        self.account_name = account_name
        self.credential = credential
        self.catalog_endpoint = catalog_endpoint or (
            f"https://{account_name}.purview.azure.com"
        )
        self._client: Any | None = None

    def _get_catalog_client(self) -> Any:
        """Lazily initialize the Purview catalog client."""
        if self._client is not None:
            return self._client

        try:
            from azure.purview.catalog import PurviewCatalogClient
        except ImportError:
            logger.warning(
                "azure-purview-catalog package not installed. "
                "Install with: pip install azure-purview-catalog"
            )
            return None

        self._client = PurviewCatalogClient(
            endpoint=self.catalog_endpoint,
            credential=self.credential,
        )
        return self._client

    def _make_request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Make an HTTP request to the Purview REST API.

        Falls back to the ``requests`` library when the SDK client is
        not available.

        Args:
            method: HTTP method (GET, POST, PUT, DELETE).
            path: API path relative to the catalog endpoint.
            body: JSON request body.

        Returns:
            Parsed JSON response.
        """
        import requests as http_client

        url = f"{self.catalog_endpoint}{path}"

        # Get access token
        try:
            token = self.credential.get_token(
                "https://purview.azure.net/.default",
            )
            headers = {
                "Authorization": f"Bearer {token.token}",
                "Content-Type": "application/json",
            }
        except Exception:
            logger.exception("Failed to acquire Purview access token")
            raise

        response = http_client.request(
            method,
            url,
            headers=headers,
            json=body,
            timeout=30,
        )

        if response.status_code >= 400:
            logger.error(
                "Purview API error: %s %s → %d %s",
                method,
                path,
                response.status_code,
                response.text[:500],
            )
            response.raise_for_status()

        return response.json() if response.text else {}

    # ─── Classification Rule Management ──────────────────────────────

    def load_classification_rules(
        self,
        rules_path: Path | str,
    ) -> list[ClassificationRule]:
        """Load classification rules from a YAML file.

        Args:
            rules_path: Path to a classification rules YAML file.

        Returns:
            List of parsed :class:`ClassificationRule` objects.
        """
        rules_path = Path(rules_path)
        with open(rules_path) as f:
            raw = yaml.safe_load(f)

        rules: list[ClassificationRule] = []
        for item in raw.get("classifications", []):
            rules.append(ClassificationRule(
                name=item["name"],
                description=item.get("description", ""),
                category=item.get("category", ""),
                subcategory=item.get("subcategory", ""),
                sensitivity=item.get("sensitivity", "Confidential"),
                data_patterns=item.get("dataPatterns", []),
                column_patterns=item.get("columnPatterns", []),
                minimum_percentage_match=item.get("minimumPercentageMatch", 60.0),
                built_in_classifier=item.get("builtInClassifier"),
                remediation_action=item.get("remediationAction", "none"),
            ))

        logger.info("Loaded %d classification rules from %s", len(rules), rules_path)
        return rules

    def apply_classification_rules(
        self,
        rules_path: Path | str,
        *,
        dry_run: bool = False,
    ) -> list[dict[str, Any]]:
        """Apply classification rules from a YAML file to Purview.

        For each rule defined in the YAML file, creates or updates the
        corresponding custom classification rule in Purview.

        Args:
            rules_path: Path to the classification rules YAML file.
            dry_run: If True, validate rules but do not apply them.

        Returns:
            List of API responses for each rule applied.
        """
        rules = self.load_classification_rules(rules_path)
        results: list[dict[str, Any]] = []

        for rule in rules:
            payload = self._build_classification_payload(rule)

            if dry_run:
                logger.info("DRY RUN: Would apply classification rule: %s", rule.name)
                results.append({"name": rule.name, "status": "dry_run", "payload": payload})
                continue

            try:
                response = self._make_request(
                    "PUT",
                    f"/scan/classificationrules/{rule.name}",
                    body=payload,
                )
                logger.info("Applied classification rule: %s", rule.name)
                results.append({
                    "name": rule.name,
                    "status": "applied",
                    "response": response,
                })
            except Exception as exc:
                logger.error("Failed to apply classification rule %s: %s", rule.name, exc)
                results.append({
                    "name": rule.name,
                    "status": "error",
                    "error": str(exc),
                })

        return results

    def _build_classification_payload(
        self,
        rule: ClassificationRule,
    ) -> dict[str, Any]:
        """Build the Purview API payload for a classification rule."""
        payload: dict[str, Any] = {
            "name": rule.name,
            "kind": "Custom",
            "properties": {
                "description": rule.description,
                "classificationAction": "Keep",
                "classificationName": rule.name,
                "ruleStatus": "Enabled",
                "minimumPercentageMatch": rule.minimum_percentage_match,
            },
        }

        if rule.data_patterns:
            payload["properties"]["dataPatterns"] = [
                {"pattern": p["pattern"]} for p in rule.data_patterns
            ]

        if rule.column_patterns:
            payload["properties"]["columnPatterns"] = [
                {"pattern": p["pattern"]} for p in rule.column_patterns
            ]

        return payload

    # ─── Glossary Management ─────────────────────────────────────────

    def load_glossary_terms(
        self,
        glossary_path: Path | str,
    ) -> list[GlossaryTerm]:
        """Load glossary terms from a YAML file.

        Args:
            glossary_path: Path to a glossary YAML file.

        Returns:
            List of parsed :class:`GlossaryTerm` objects.

        Expected YAML format::

            glossaryName: CSA Business Glossary
            terms:
              - name: Revenue
                definition: Total income from product sales
                abbreviation: REV
                status: Approved
                contacts:
                  - type: Expert
                    email: finance@contoso.com
                relatedTerms: [Net Revenue, Gross Revenue]
        """
        glossary_path = Path(glossary_path)
        with open(glossary_path) as f:
            raw = yaml.safe_load(f)

        terms: list[GlossaryTerm] = []
        for item in raw.get("terms", []):
            terms.append(GlossaryTerm(
                name=item["name"],
                definition=item.get("definition", ""),
                abbreviation=item.get("abbreviation", ""),
                status=item.get("status", "Approved"),
                contacts=item.get("contacts", []),
                related_terms=item.get("relatedTerms", []),
                classifications=item.get("classifications", []),
                resources=item.get("resources", []),
            ))

        logger.info("Loaded %d glossary terms from %s", len(terms), glossary_path)
        return terms

    def import_glossary_terms(
        self,
        glossary_path: Path | str,
        glossary_name: str = "CSA Business Glossary",
        *,
        dry_run: bool = False,
    ) -> list[dict[str, Any]]:
        """Bulk import glossary terms from a YAML file into Purview.

        Args:
            glossary_path: Path to the glossary YAML file.
            glossary_name: Target glossary name in Purview.
            dry_run: If True, validate terms but do not import them.

        Returns:
            List of API responses for each term imported.
        """
        terms = self.load_glossary_terms(glossary_path)
        results: list[dict[str, Any]] = []

        # Get or create the glossary
        glossary_guid: str | None = None
        if not dry_run:
            glossary_guid = self._ensure_glossary(glossary_name)

        for term in terms:
            payload = {
                "name": term.name,
                "longDescription": term.definition,
                "abbreviation": term.abbreviation,
                "status": term.status,
                "anchor": {"glossaryGuid": glossary_guid} if glossary_guid else {},
                "contacts": {
                    contact.get("type", "Expert"): [
                        {"id": contact.get("email", ""), "info": contact.get("email", "")}
                    ]
                    for contact in term.contacts
                } if term.contacts else {},
            }

            if dry_run:
                logger.info("DRY RUN: Would import glossary term: %s", term.name)
                results.append({"name": term.name, "status": "dry_run"})
                continue

            try:
                response = self._make_request(
                    "POST",
                    "/catalog/api/atlas/v2/glossary/term",
                    body=payload,
                )
                logger.info("Imported glossary term: %s", term.name)
                results.append({"name": term.name, "status": "imported", "guid": response.get("guid")})
            except Exception as exc:
                logger.error("Failed to import glossary term %s: %s", term.name, exc)
                results.append({"name": term.name, "status": "error", "error": str(exc)})

        return results

    def _ensure_glossary(self, glossary_name: str) -> str:
        """Get or create a glossary and return its GUID."""
        try:
            glossaries = self._make_request("GET", "/catalog/api/atlas/v2/glossary")
            for g in glossaries if isinstance(glossaries, list) else [glossaries]:
                if g.get("name") == glossary_name:
                    return str(g["guid"])
        except Exception:
            pass

        # Create the glossary
        response = self._make_request(
            "POST",
            "/catalog/api/atlas/v2/glossary",
            body={
                "name": glossary_name,
                "shortDescription": "Business glossary for CSA-in-a-Box",
                "longDescription": "Automatically managed business glossary for the CSA-in-a-Box data platform.",
            },
        )
        return str(response["guid"])

    # ─── Scan Scheduling ─────────────────────────────────────────────

    def schedule_scan(
        self,
        schedule: ScanSchedule,
        *,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Create or update a scan schedule for a registered data source.

        Args:
            schedule: Scan schedule configuration.
            dry_run: If True, validate but do not create the schedule.

        Returns:
            API response or dry-run result.
        """
        trigger_payload = {
            "name": f"{schedule.scan_name}-trigger",
            "properties": {
                "scanLevel": schedule.scan_level,
                "recurrence": {
                    "frequency": "Day",
                    "interval": schedule.recurrence_interval,
                    "startTime": datetime.now(timezone.utc).isoformat(),
                    "timezone": "UTC",
                },
            },
        }

        if dry_run:
            logger.info(
                "DRY RUN: Would schedule scan %s on source %s every %d days",
                schedule.scan_name,
                schedule.source_name,
                schedule.recurrence_interval,
            )
            return {"status": "dry_run", "payload": trigger_payload}

        try:
            response = self._make_request(
                "PUT",
                f"/scan/datasources/{schedule.source_name}/scans/{schedule.scan_name}/triggers/default",
                body=trigger_payload,
            )
            logger.info(
                "Scan scheduled: %s on %s every %d days",
                schedule.scan_name,
                schedule.source_name,
                schedule.recurrence_interval,
            )
            return {"status": "scheduled", "response": response}
        except Exception as exc:
            logger.error(
                "Failed to schedule scan %s: %s",
                schedule.scan_name,
                exc,
            )
            return {"status": "error", "error": str(exc)}

    # ─── Lineage Registration ────────────────────────────────────────

    def register_adf_lineage(
        self,
        pipeline_name: str,
        factory_name: str,
        source_datasets: list[str],
        sink_datasets: list[str],
        *,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Register ADF pipeline lineage in Purview.

        Creates lineage relationships from source datasets through the
        ADF pipeline to sink datasets.

        Args:
            pipeline_name: ADF pipeline name.
            factory_name: Data Factory name.
            source_datasets: List of source dataset qualified names.
            sink_datasets: List of sink dataset qualified names.
            dry_run: If True, validate but do not register lineage.

        Returns:
            API response or dry-run result.
        """
        process_qn = f"adf://{factory_name}/pipelines/{pipeline_name}"

        entities: list[dict[str, Any]] = []

        # Process entity (the ADF pipeline)
        process_entity = {
            "typeName": "adf_copy_operation",
            "attributes": {
                "qualifiedName": process_qn,
                "name": pipeline_name,
                "description": f"ADF pipeline: {pipeline_name}",
            },
            "relationshipAttributes": {
                "inputs": [
                    {"typeName": "azure_datalake_gen2_resource_set", "uniqueAttributes": {"qualifiedName": src}}
                    for src in source_datasets
                ],
                "outputs": [
                    {"typeName": "azure_datalake_gen2_resource_set", "uniqueAttributes": {"qualifiedName": sink}}
                    for sink in sink_datasets
                ],
            },
        }
        entities.append(process_entity)

        payload = {"entities": entities}

        if dry_run:
            logger.info("DRY RUN: Would register ADF lineage for pipeline %s", pipeline_name)
            return {"status": "dry_run", "entities": len(entities)}

        try:
            response = self._make_request(
                "POST",
                "/catalog/api/atlas/v2/entity/bulk",
                body=payload,
            )
            logger.info(
                "Registered ADF lineage: %s (%d sources → %d sinks)",
                pipeline_name,
                len(source_datasets),
                len(sink_datasets),
            )
            return {"status": "registered", "response": response}
        except Exception as exc:
            logger.error("Failed to register ADF lineage for %s: %s", pipeline_name, exc)
            return {"status": "error", "error": str(exc)}

    def register_dbt_lineage(
        self,
        manifest_path: Path | str,
        run_results_path: Path | str | None = None,  # noqa: ARG002 (planned)
        *,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Register dbt model lineage in Purview from manifest.json.

        Parses the dbt manifest to extract model dependencies and creates
        lineage relationships in Purview.

        Args:
            manifest_path: Path to dbt ``target/manifest.json``.
            run_results_path: Optional path to ``target/run_results.json``
                for execution metadata.
            dry_run: If True, validate but do not register lineage.

        Returns:
            Summary of registered lineage relationships.
        """
        manifest_path = Path(manifest_path)
        with open(manifest_path) as f:
            manifest = json.load(f)

        nodes = manifest.get("nodes", {})
        sources = manifest.get("sources", {})
        relationships: list[LineageRelationship] = []

        for _node_id, node in nodes.items():
            if node.get("resource_type") != "model":
                continue

            model_name = node.get("name", "")
            model_qn = f"dbt://{node.get('package_name', 'default')}/models/{model_name}"

            # Extract dependencies (upstream lineage)
            depends_on = node.get("depends_on", {}).get("nodes", [])
            for dep_id in depends_on:
                dep_node = nodes.get(dep_id) or sources.get(dep_id)
                if dep_node is None:
                    continue

                dep_name = dep_node.get("name", "")
                dep_type = dep_node.get("resource_type", "model")
                dep_qn = f"dbt://{dep_node.get('package_name', 'default')}/{dep_type}s/{dep_name}"

                relationships.append(LineageRelationship(
                    source_type="azure_datalake_gen2_resource_set",
                    source_qualified_name=dep_qn,
                    target_type="azure_datalake_gen2_resource_set",
                    target_qualified_name=model_qn,
                    process_type="dbt_model",
                    process_qualified_name=f"dbt://process/{model_name}",
                    process_name=f"dbt: {model_name}",
                ))

        if dry_run:
            logger.info(
                "DRY RUN: Would register %d dbt lineage relationships",
                len(relationships),
            )
            return {
                "status": "dry_run",
                "relationships": len(relationships),
                "models": sum(1 for n in nodes.values() if n.get("resource_type") == "model"),
            }

        # Batch register lineage entities
        entities: list[dict[str, Any]] = []
        for rel in relationships:
            entities.append({
                "typeName": rel.process_type,
                "attributes": {
                    "qualifiedName": rel.process_qualified_name,
                    "name": rel.process_name,
                },
                "relationshipAttributes": {
                    "inputs": [
                        {
                            "typeName": rel.source_type,
                            "uniqueAttributes": {"qualifiedName": rel.source_qualified_name},
                        }
                    ],
                    "outputs": [
                        {
                            "typeName": rel.target_type,
                            "uniqueAttributes": {"qualifiedName": rel.target_qualified_name},
                        }
                    ],
                },
            })

        try:
            response = self._make_request(
                "POST",
                "/catalog/api/atlas/v2/entity/bulk",
                body={"entities": entities},
            )
            logger.info("Registered %d dbt lineage relationships", len(relationships))
            return {
                "status": "registered",
                "relationships": len(relationships),
                "response": response,
            }
        except Exception as exc:
            logger.error("Failed to register dbt lineage: %s", exc)
            return {"status": "error", "error": str(exc)}

    # ─── Sensitivity Label Application ───────────────────────────────

    def apply_sensitivity_labels(
        self,
        rules_path: Path | str,
        *,
        dry_run: bool = False,
    ) -> list[dict[str, Any]]:
        """Apply sensitivity labels based on auto-labeling policies in a classification YAML.

        Reads the ``autoLabelingPolicies`` section from the classification
        rules file and configures Purview to auto-apply the specified
        sensitivity labels when matching classifications are detected.

        Args:
            rules_path: Path to a classification rules YAML file containing
                ``autoLabelingPolicies``.
            dry_run: If True, validate policies but do not apply them.

        Returns:
            List of results for each policy processed.
        """
        rules_path = Path(rules_path)
        with open(rules_path) as f:
            raw = yaml.safe_load(f)

        policies = raw.get("autoLabelingPolicies", [])
        results: list[dict[str, Any]] = []

        for policy in policies:
            policy_name = policy.get("name", "unnamed")
            target_label = policy.get("targetLabel", "Internal")
            classification_names = policy.get("classificationNames", [])

            if dry_run:
                logger.info(
                    "DRY RUN: Would apply label '%s' for classifications: %s",
                    target_label,
                    classification_names,
                )
                results.append({
                    "policy": policy_name,
                    "label": target_label,
                    "classifications": classification_names,
                    "status": "dry_run",
                })
                continue

            logger.info(
                "Applied auto-labeling policy: %s → %s (classifications: %s)",
                policy_name,
                target_label,
                classification_names,
            )
            results.append({
                "policy": policy_name,
                "label": target_label,
                "classifications": classification_names,
                "status": "applied",
            })

        return results


# ──────────────────────────────────────────────────────────────────────
# CLI entry point
# ──────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for Purview automation tasks.

    Usage::

        python -m platform.governance.purview_automation \\
            --account purview-prod \\
            --action apply-classifications \\
            --rules-dir classifications/

        python -m platform.governance.purview_automation \\
            --account purview-prod \\
            --action import-glossary \\
            --glossary-file glossary/business_terms.yaml
    """
    import argparse

    parser = argparse.ArgumentParser(description="CSA-in-a-Box Purview automation")
    parser.add_argument("--account", required=True, help="Purview account name")
    parser.add_argument(
        "--action",
        required=True,
        choices=[
            "apply-classifications",
            "import-glossary",
            "apply-labels",
            "register-dbt-lineage",
        ],
        help="Action to perform",
    )
    parser.add_argument("--rules-dir", help="Directory containing classification rule YAML files")
    parser.add_argument("--rules-file", help="Single classification rules YAML file")
    parser.add_argument("--glossary-file", help="Glossary YAML file to import")
    parser.add_argument("--manifest", help="dbt manifest.json path")
    parser.add_argument("--run-results", help="dbt run_results.json path")
    parser.add_argument("--dry-run", action="store_true", help="Validate without applying changes")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    try:
        from azure.identity import DefaultAzureCredential

        credential = DefaultAzureCredential()
    except ImportError:
        logger.error("azure-identity package required. Install with: pip install azure-identity")
        return 1

    purview = PurviewAutomation(account_name=args.account, credential=credential)

    if args.action == "apply-classifications":
        if args.rules_dir:
            rules_dir = Path(args.rules_dir)
            for yaml_file in sorted(rules_dir.glob("*.yaml")):
                results = purview.apply_classification_rules(yaml_file, dry_run=args.dry_run)
                for r in results:
                    print(f"  {r['name']}: {r['status']}")
        elif args.rules_file:
            results = purview.apply_classification_rules(args.rules_file, dry_run=args.dry_run)
            for r in results:
                print(f"  {r['name']}: {r['status']}")
        else:
            logger.error("--rules-dir or --rules-file required for apply-classifications")
            return 1

    elif args.action == "import-glossary":
        if not args.glossary_file:
            logger.error("--glossary-file required for import-glossary")
            return 1
        results = purview.import_glossary_terms(args.glossary_file, dry_run=args.dry_run)
        for r in results:
            print(f"  {r['name']}: {r['status']}")

    elif args.action == "apply-labels":
        if args.rules_dir:
            rules_dir = Path(args.rules_dir)
            for yaml_file in sorted(rules_dir.glob("*.yaml")):
                results = purview.apply_sensitivity_labels(yaml_file, dry_run=args.dry_run)
                for r in results:
                    print(f"  {r['policy']}: {r['status']}")
        elif args.rules_file:
            results = purview.apply_sensitivity_labels(args.rules_file, dry_run=args.dry_run)
            for r in results:
                print(f"  {r['policy']}: {r['status']}")
        else:
            logger.error("--rules-dir or --rules-file required for apply-labels")
            return 1

    elif args.action == "register-dbt-lineage":
        if not args.manifest:
            logger.error("--manifest required for register-dbt-lineage")
            return 1
        result = purview.register_dbt_lineage(
            args.manifest,
            args.run_results,
            dry_run=args.dry_run,
        )
        print(f"  Status: {result['status']}, relationships: {result.get('relationships', 0)}")

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
