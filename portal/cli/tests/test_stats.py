"""Tests for the ``stats`` command group."""

from __future__ import annotations

import json

import pytest

from portal.cli.__main__ import cli
from portal.cli.client import APIError

from .conftest import SAMPLE_DOMAINS, SAMPLE_STATS


class TestStatsOverview:
    def test_overview_table_output(self, runner, mock_client):
        mock_client.platform_stats.return_value = SAMPLE_STATS
        result = runner.invoke(cli, ["stats", "overview"])
        assert result.exit_code == 0
        assert "Platform Overview" in result.output
        assert "4" in result.output   # registered_sources
        # avg_quality_score is a 0.0-1.0 ratio (CSA-0003) but table format
        # displays it as a percentage for human readability.
        assert "92.8%" in result.output

    def test_overview_json_output(self, runner, mock_client):
        mock_client.platform_stats.return_value = SAMPLE_STATS
        result = runner.invoke(cli, ["--format", "json", "stats", "overview"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["registered_sources"] == 4
        assert data["avg_quality_score"] == 0.928

    def test_overview_yaml_output(self, runner, mock_client):
        mock_client.platform_stats.return_value = SAMPLE_STATS
        result = runner.invoke(cli, ["--format", "yaml", "stats", "overview"])
        assert result.exit_code == 0
        assert "registered_sources" in result.output
        assert "4" in result.output

    def test_overview_api_error(self, runner, mock_client):
        mock_client.platform_stats.side_effect = APIError(500, "Server error")
        result = runner.invoke(cli, ["stats", "overview"])
        assert result.exit_code == 1
        assert "Error" in result.output

    def test_overview_connection_error(self, runner, mock_client):
        mock_client.platform_stats.side_effect = APIError(0, "Connection error: [Errno 111]")
        result = runner.invoke(cli, ["stats", "overview"])
        assert result.exit_code == 1


class TestStatsDomains:
    def test_domains_table_output(self, runner, mock_client):
        mock_client.all_domains.return_value = SAMPLE_DOMAINS
        result = runner.invoke(cli, ["stats", "domains"])
        assert result.exit_code == 0
        assert "finance" in result.output
        assert "human-resources" in result.output
        assert "healthy" in result.output

    def test_domains_json_output(self, runner, mock_client):
        mock_client.all_domains.return_value = SAMPLE_DOMAINS
        result = runner.invoke(cli, ["--format", "json", "stats", "domains"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert isinstance(data, list)
        assert data[0]["name"] == "finance"

    def test_domains_no_results(self, runner, mock_client):
        mock_client.all_domains.return_value = []
        result = runner.invoke(cli, ["stats", "domains"])
        assert result.exit_code == 0
        assert "No domains found" in result.output

    def test_domains_api_error(self, runner, mock_client):
        mock_client.all_domains.side_effect = APIError(500, "Server error")
        result = runner.invoke(cli, ["stats", "domains"])
        assert result.exit_code == 1
        assert "Error" in result.output


class TestStatsDomain:
    def test_domain_table_output(self, runner, mock_client):
        mock_client.domain_overview.return_value = SAMPLE_DOMAINS[0]
        result = runner.invoke(cli, ["stats", "domain", "finance"])
        assert result.exit_code == 0
        assert "finance" in result.output
        assert "healthy" in result.output

    def test_domain_json_output(self, runner, mock_client):
        mock_client.domain_overview.return_value = SAMPLE_DOMAINS[0]
        result = runner.invoke(cli, ["--format", "json", "stats", "domain", "finance"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["name"] == "finance"

    def test_domain_not_found(self, runner, mock_client):
        mock_client.domain_overview.side_effect = APIError(404, "Domain 'xyz' not found.")
        result = runner.invoke(cli, ["stats", "domain", "xyz"])
        assert result.exit_code == 1
        assert "Error" in result.output

    def test_domain_correct_name_passed(self, runner, mock_client):
        mock_client.domain_overview.return_value = SAMPLE_DOMAINS[1]
        runner.invoke(cli, ["stats", "domain", "human-resources"])
        mock_client.domain_overview.assert_called_once_with("human-resources")
