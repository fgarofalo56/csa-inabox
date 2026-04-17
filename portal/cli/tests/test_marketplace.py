"""Tests for the ``marketplace`` command group."""

from __future__ import annotations

import json

import pytest

from portal.cli.__main__ import cli
from portal.cli.client import APIError

from .conftest import SAMPLE_PRODUCT, SAMPLE_QUALITY


class TestMarketplaceProducts:
    def test_products_table_output(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["marketplace", "products"])
        assert result.exit_code == 0
        assert "dp-001" in result.output
        assert "Employee Master Data" in result.output

    def test_products_json_output(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["--format", "json", "marketplace", "products"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data[0]["id"] == "dp-001"

    def test_products_yaml_output(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["--format", "yaml", "marketplace", "products"])
        assert result.exit_code == 0
        assert "dp-001" in result.output

    def test_products_no_results(self, runner, mock_client):
        mock_client.list_products.return_value = []
        result = runner.invoke(cli, ["marketplace", "products"])
        assert result.exit_code == 0
        assert "No products found" in result.output

    def test_products_domain_filter(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["marketplace", "products", "--domain", "human-resources"])
        assert result.exit_code == 0
        mock_client.list_products.assert_called_once()

    def test_products_min_quality_filter(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["marketplace", "products", "--min-quality", "90.0"])
        assert result.exit_code == 0

    def test_products_api_error(self, runner, mock_client):
        mock_client.list_products.side_effect = APIError(500, "Server error")
        result = runner.invoke(cli, ["marketplace", "products"])
        assert result.exit_code == 1
        assert "Error" in result.output


class TestMarketplaceGet:
    def test_get_table_output(self, runner, mock_client):
        mock_client.get_product.return_value = SAMPLE_PRODUCT
        result = runner.invoke(cli, ["marketplace", "get", "dp-001"])
        assert result.exit_code == 0
        assert "Employee Master Data" in result.output
        assert "human-resources" in result.output
        assert "94.5" in result.output

    def test_get_json_output(self, runner, mock_client):
        mock_client.get_product.return_value = SAMPLE_PRODUCT
        result = runner.invoke(cli, ["--format", "json", "marketplace", "get", "dp-001"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["id"] == "dp-001"

    def test_get_not_found(self, runner, mock_client):
        mock_client.get_product.side_effect = APIError(404, "Product 'dp-999' not found.")
        result = runner.invoke(cli, ["marketplace", "get", "dp-999"])
        assert result.exit_code == 1
        assert "Error" in result.output


class TestMarketplaceSearch:
    def test_search_found(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["marketplace", "search", "employee"])
        assert result.exit_code == 0
        assert "Employee Master Data" in result.output
        assert "Found 1 product" in result.output

    def test_search_no_results(self, runner, mock_client):
        mock_client.list_products.return_value = []
        result = runner.invoke(cli, ["marketplace", "search", "nonexistent"])
        assert result.exit_code == 0
        assert "No products match" in result.output

    def test_search_with_domain(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["marketplace", "search", "employee", "--domain", "human-resources"])
        assert result.exit_code == 0

    def test_search_json_output(self, runner, mock_client):
        mock_client.list_products.return_value = [SAMPLE_PRODUCT]
        result = runner.invoke(cli, ["--format", "json", "marketplace", "search", "sensor"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert isinstance(data, list)

    def test_search_api_error(self, runner, mock_client):
        mock_client.list_products.side_effect = APIError(500, "Error")
        result = runner.invoke(cli, ["marketplace", "search", "test"])
        assert result.exit_code == 1


class TestMarketplaceQuality:
    def test_quality_table_output(self, runner, mock_client):
        mock_client.get_product_quality.return_value = SAMPLE_QUALITY
        result = runner.invoke(cli, ["marketplace", "quality", "dp-001"])
        assert result.exit_code == 0
        assert "2026-04-17" in result.output
        assert "94.5" in result.output

    def test_quality_json_output(self, runner, mock_client):
        mock_client.get_product_quality.return_value = SAMPLE_QUALITY
        result = runner.invoke(cli, ["--format", "json", "marketplace", "quality", "dp-001"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data[0]["date"] == "2026-04-17"

    def test_quality_no_data(self, runner, mock_client):
        mock_client.get_product_quality.return_value = []
        result = runner.invoke(cli, ["marketplace", "quality", "dp-001"])
        assert result.exit_code == 0
        assert "No quality data" in result.output

    def test_quality_with_days_option(self, runner, mock_client):
        mock_client.get_product_quality.return_value = SAMPLE_QUALITY
        result = runner.invoke(cli, ["marketplace", "quality", "dp-001", "--days", "7"])
        assert result.exit_code == 0
        mock_client.get_product_quality.assert_called_once_with("dp-001", days=7)

    def test_quality_api_error(self, runner, mock_client):
        mock_client.get_product_quality.side_effect = APIError(404, "Product not found")
        result = runner.invoke(cli, ["marketplace", "quality", "dp-999"])
        assert result.exit_code == 1


class TestMarketplaceDomains:
    def test_domains_table(self, runner, mock_client):
        mock_client.list_marketplace_domains.return_value = [
            {"name": "finance", "product_count": 1},
            {"name": "hr", "product_count": 2},
        ]
        result = runner.invoke(cli, ["marketplace", "domains"])
        assert result.exit_code == 0
        assert "finance" in result.output
        assert "hr" in result.output

    def test_domains_json(self, runner, mock_client):
        mock_client.list_marketplace_domains.return_value = [{"name": "finance", "product_count": 1}]
        result = runner.invoke(cli, ["--format", "json", "marketplace", "domains"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data[0]["name"] == "finance"

    def test_domains_no_results(self, runner, mock_client):
        mock_client.list_marketplace_domains.return_value = []
        result = runner.invoke(cli, ["marketplace", "domains"])
        assert result.exit_code == 0
        assert "No domains found" in result.output

    def test_domains_api_error(self, runner, mock_client):
        mock_client.list_marketplace_domains.side_effect = APIError(500, "Server error")
        result = runner.invoke(cli, ["marketplace", "domains"])
        assert result.exit_code == 1


class TestMarketplaceStats:
    def test_stats_table(self, runner, mock_client):
        mock_client.marketplace_stats.return_value = {
            "total_products": 5,
            "total_domains": 4,
            "avg_quality_score": 92.8,
            "products_by_domain": {"finance": 1, "hr": 1},
        }
        result = runner.invoke(cli, ["marketplace", "stats"])
        assert result.exit_code == 0
        assert "5" in result.output
        assert "92.8" in result.output

    def test_stats_json(self, runner, mock_client):
        mock_client.marketplace_stats.return_value = {
            "total_products": 5,
            "total_domains": 4,
            "avg_quality_score": 92.8,
            "products_by_domain": {},
        }
        result = runner.invoke(cli, ["--format", "json", "marketplace", "stats"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["total_products"] == 5

    def test_stats_api_error(self, runner, mock_client):
        mock_client.marketplace_stats.side_effect = APIError(500, "Error")
        result = runner.invoke(cli, ["marketplace", "stats"])
        assert result.exit_code == 1
