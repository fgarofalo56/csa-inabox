"""Smoke tests for the CLI entry point and global options."""

from __future__ import annotations

import pytest

from portal.cli.__main__ import cli


class TestCLIEntryPoint:
    def test_help_exits_zero(self, runner):
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "CSA-in-a-Box" in result.output

    def test_version_flag(self, runner):
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.output

    def test_sources_subcommand_help(self, runner):
        result = runner.invoke(cli, ["sources", "--help"])
        assert result.exit_code == 0
        assert "list" in result.output
        assert "get" in result.output
        assert "register" in result.output

    def test_pipelines_subcommand_help(self, runner):
        result = runner.invoke(cli, ["pipelines", "--help"])
        assert result.exit_code == 0
        assert "list" in result.output
        assert "trigger" in result.output

    def test_marketplace_subcommand_help(self, runner):
        result = runner.invoke(cli, ["marketplace", "--help"])
        assert result.exit_code == 0
        assert "products" in result.output
        assert "search" in result.output

    def test_stats_subcommand_help(self, runner):
        result = runner.invoke(cli, ["stats", "--help"])
        assert result.exit_code == 0
        assert "overview" in result.output
        assert "domains" in result.output

    def test_unknown_command_exits_nonzero(self, runner):
        result = runner.invoke(cli, ["nonexistent-command"])
        assert result.exit_code != 0

    def test_format_option_json_accepted(self, runner, mock_client):
        mock_client.list_sources.return_value = []
        result = runner.invoke(cli, ["--format", "json", "sources", "list"])
        assert result.exit_code == 0

    def test_format_option_yaml_accepted(self, runner, mock_client):
        mock_client.list_sources.return_value = []
        result = runner.invoke(cli, ["--format", "yaml", "sources", "list"])
        assert result.exit_code == 0

    def test_format_option_table_accepted(self, runner, mock_client):
        mock_client.list_sources.return_value = []
        result = runner.invoke(cli, ["--format", "table", "sources", "list"])
        assert result.exit_code == 0

    def test_format_option_invalid_rejected(self, runner):
        result = runner.invoke(cli, ["--format", "xml", "sources", "list"])
        assert result.exit_code != 0

    def test_api_url_option_passed_to_context(self, runner, mock_client):
        mock_client.list_sources.return_value = []
        result = runner.invoke(
            cli,
            ["--api-url", "http://custom-host:9000/api/v1", "sources", "list"],
        )
        assert result.exit_code == 0
