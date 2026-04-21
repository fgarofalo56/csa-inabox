"""Tests for the ``sources`` command group."""

from __future__ import annotations

import json

from cli.__main__ import cli
from cli.client import APIError

from .conftest import SAMPLE_SOURCE


class TestSourcesList:
    def test_list_table_output(self, runner, mock_client):
        mock_client.list_sources.return_value = [SAMPLE_SOURCE]
        result = runner.invoke(cli, ["sources", "list"])
        assert result.exit_code == 0
        assert "src-001" in result.output
        assert "HR Employee Records" in result.output
        assert "azure_sql" in result.output

    def test_list_json_output(self, runner, mock_client):
        mock_client.list_sources.return_value = [SAMPLE_SOURCE]
        result = runner.invoke(cli, ["--format", "json", "sources", "list"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert isinstance(data, list)
        assert data[0]["id"] == "src-001"

    def test_list_yaml_output(self, runner, mock_client):
        mock_client.list_sources.return_value = [SAMPLE_SOURCE]
        result = runner.invoke(cli, ["--format", "yaml", "sources", "list"])
        assert result.exit_code == 0
        assert "src-001" in result.output
        assert "id:" in result.output

    def test_list_no_results(self, runner, mock_client):
        mock_client.list_sources.return_value = []
        result = runner.invoke(cli, ["sources", "list"])
        assert result.exit_code == 0
        assert "No sources found" in result.output

    def test_list_with_domain_filter(self, runner, mock_client):
        mock_client.list_sources.return_value = [SAMPLE_SOURCE]
        result = runner.invoke(cli, ["sources", "list", "--domain", "human-resources"])
        assert result.exit_code == 0
        mock_client.list_sources.assert_called_once()
        call_kwargs = mock_client.list_sources.call_args
        assert call_kwargs.kwargs.get("domain") == "human-resources" or (
            call_kwargs.args and "human-resources" in call_kwargs.args
        )

    def test_list_with_status_filter(self, runner, mock_client):
        mock_client.list_sources.return_value = [SAMPLE_SOURCE]
        result = runner.invoke(cli, ["sources", "list", "--status", "active"])
        assert result.exit_code == 0

    def test_list_api_error(self, runner, mock_client):
        mock_client.list_sources.side_effect = APIError(500, "Internal server error")
        result = runner.invoke(cli, ["sources", "list"])
        assert result.exit_code == 1
        assert "Error" in result.output

    def test_list_connection_error(self, runner, mock_client):
        mock_client.list_sources.side_effect = APIError(0, "Connection error: [Errno 111]")
        result = runner.invoke(cli, ["sources", "list"])
        assert result.exit_code == 1
        assert "Connection error" in result.output


class TestSourcesGet:
    def test_get_table_output(self, runner, mock_client):
        mock_client.get_source.return_value = SAMPLE_SOURCE
        result = runner.invoke(cli, ["sources", "get", "src-001"])
        assert result.exit_code == 0
        assert "HR Employee Records" in result.output
        assert "Jane Smith" in result.output
        assert "human-resources" in result.output

    def test_get_json_output(self, runner, mock_client):
        mock_client.get_source.return_value = SAMPLE_SOURCE
        result = runner.invoke(cli, ["--format", "json", "sources", "get", "src-001"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["id"] == "src-001"
        assert data["name"] == "HR Employee Records"

    def test_get_not_found(self, runner, mock_client):
        mock_client.get_source.side_effect = APIError(404, "Source 'src-999' not found.")
        result = runner.invoke(cli, ["sources", "get", "src-999"])
        assert result.exit_code == 1
        assert "404" in result.output or "not found" in result.output.lower()


class TestSourcesRegister:
    def test_register_with_all_flags(self, runner, mock_client):
        registered = {**SAMPLE_SOURCE, "id": "src-new-001", "status": "draft"}
        mock_client.register_source.return_value = registered
        result = runner.invoke(
            cli,
            [
                "sources", "register",
                "--name", "New Source",
                "--domain", "finance",
                "--type", "azure_sql",
                "--classification", "internal",
                "--description", "Test source",
                "--owner-name", "Alice Park",
                "--owner-email", "alice@contoso.com",
            ],
        )
        assert result.exit_code == 0
        assert "src-new-001" in result.output
        mock_client.register_source.assert_called_once()

    def test_register_invalid_connection_json(self, runner, mock_client):
        result = runner.invoke(
            cli,
            [
                "sources", "register",
                "--name", "Bad JSON Source",
                "--domain", "finance",
                "--type", "azure_sql",
                "--connection-json", "{not valid json}",
            ],
        )
        assert result.exit_code == 1
        assert "not valid JSON" in result.output

    def test_register_invalid_ingestion_json(self, runner, mock_client):
        result = runner.invoke(
            cli,
            [
                "sources", "register",
                "--name", "Bad Ingestion",
                "--domain", "finance",
                "--type", "azure_sql",
                "--ingestion-json", "oops",
            ],
        )
        assert result.exit_code == 1
        assert "not valid JSON" in result.output

    def test_register_api_error(self, runner, mock_client):
        mock_client.register_source.side_effect = APIError(422, "Validation error")
        result = runner.invoke(
            cli,
            [
                "sources", "register",
                "--name", "X",
                "--domain", "finance",
                "--type", "azure_sql",
            ],
        )
        assert result.exit_code == 1
        assert "Error" in result.output


class TestSourcesDecommission:
    def test_decommission_with_yes_flag(self, runner, mock_client):
        mock_client.decommission_source.return_value = {**SAMPLE_SOURCE, "status": "decommissioned"}
        result = runner.invoke(cli, ["sources", "decommission", "src-001", "--yes"])
        assert result.exit_code == 0
        assert "decommissioned" in result.output

    def test_decommission_confirms_by_default(self, runner, mock_client):
        mock_client.decommission_source.return_value = {**SAMPLE_SOURCE, "status": "decommissioned"}
        # Provide 'y' as user input for the confirmation prompt.
        result = runner.invoke(cli, ["sources", "decommission", "src-001"], input="y\n")
        assert result.exit_code == 0
        assert "decommissioned" in result.output

    def test_decommission_aborts_on_no(self, runner, mock_client):
        result = runner.invoke(cli, ["sources", "decommission", "src-001"], input="n\n")
        assert result.exit_code != 0
        mock_client.decommission_source.assert_not_called()

    def test_decommission_api_error(self, runner, mock_client):
        mock_client.decommission_source.side_effect = APIError(404, "Source not found")
        result = runner.invoke(cli, ["sources", "decommission", "src-999", "--yes"])
        assert result.exit_code == 1
        assert "Error" in result.output


class TestSourcesProvision:
    def test_provision_success(self, runner, mock_client):
        mock_client.provision_source.return_value = {
            "status": "provisioning",
            "message": "Provisioning started",
        }
        result = runner.invoke(cli, ["sources", "provision", "src-001"])
        assert result.exit_code == 0
        assert "provisioning" in result.output.lower()

    def test_provision_json_output(self, runner, mock_client):
        payload = {"status": "provisioning", "message": "Started"}
        mock_client.provision_source.return_value = payload
        result = runner.invoke(cli, ["--format", "json", "sources", "provision", "src-001"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["status"] == "provisioning"

    def test_provision_api_error(self, runner, mock_client):
        mock_client.provision_source.side_effect = APIError(400, "Source must be in approved status")
        result = runner.invoke(cli, ["sources", "provision", "src-001"])
        assert result.exit_code == 1
        assert "Error" in result.output
