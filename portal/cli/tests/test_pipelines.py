"""Tests for the ``pipelines`` command group."""

from __future__ import annotations

import json

import pytest
from click.testing import CliRunner

from portal.cli.__main__ import cli
from portal.cli.client import APIError

from .conftest import SAMPLE_PIPELINE, SAMPLE_RUN


class TestPipelinesList:
    def test_list_table_output(self, runner, mock_client):
        mock_client.list_pipelines.return_value = [SAMPLE_PIPELINE]
        result = runner.invoke(cli, ["pipelines", "list"])
        assert result.exit_code == 0
        assert "pl-001" in result.output
        assert "pl-hr-employees-batch" in result.output

    def test_list_json_output(self, runner, mock_client):
        mock_client.list_pipelines.return_value = [SAMPLE_PIPELINE]
        result = runner.invoke(cli, ["--format", "json", "pipelines", "list"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data[0]["id"] == "pl-001"

    def test_list_yaml_output(self, runner, mock_client):
        mock_client.list_pipelines.return_value = [SAMPLE_PIPELINE]
        result = runner.invoke(cli, ["--format", "yaml", "pipelines", "list"])
        assert result.exit_code == 0
        assert "pl-001" in result.output

    def test_list_no_results(self, runner, mock_client):
        mock_client.list_pipelines.return_value = []
        result = runner.invoke(cli, ["pipelines", "list"])
        assert result.exit_code == 0
        assert "No pipelines found" in result.output

    def test_list_with_source_filter(self, runner, mock_client):
        mock_client.list_pipelines.return_value = [SAMPLE_PIPELINE]
        result = runner.invoke(cli, ["pipelines", "list", "--source-id", "src-001"])
        assert result.exit_code == 0
        mock_client.list_pipelines.assert_called_once()

    def test_list_with_status_filter(self, runner, mock_client):
        mock_client.list_pipelines.return_value = [SAMPLE_PIPELINE]
        result = runner.invoke(cli, ["pipelines", "list", "--status", "running"])
        assert result.exit_code == 0

    def test_list_api_error(self, runner, mock_client):
        mock_client.list_pipelines.side_effect = APIError(500, "server error")
        result = runner.invoke(cli, ["pipelines", "list"])
        assert result.exit_code == 1
        assert "Error" in result.output


class TestPipelinesGet:
    def test_get_table_output(self, runner, mock_client):
        mock_client.get_pipeline.return_value = SAMPLE_PIPELINE
        result = runner.invoke(cli, ["pipelines", "get", "pl-001"])
        assert result.exit_code == 0
        assert "pl-hr-employees-batch" in result.output
        assert "batch_copy" in result.output

    def test_get_json_output(self, runner, mock_client):
        mock_client.get_pipeline.return_value = SAMPLE_PIPELINE
        result = runner.invoke(cli, ["--format", "json", "pipelines", "get", "pl-001"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["id"] == "pl-001"

    def test_get_not_found(self, runner, mock_client):
        mock_client.get_pipeline.side_effect = APIError(404, "Pipeline 'pl-999' not found.")
        result = runner.invoke(cli, ["pipelines", "get", "pl-999"])
        assert result.exit_code == 1
        assert "Error" in result.output


class TestPipelineRuns:
    def test_runs_table_output(self, runner, mock_client):
        mock_client.get_pipeline_runs.return_value = [SAMPLE_RUN]
        result = runner.invoke(cli, ["pipelines", "runs", "pl-001"])
        assert result.exit_code == 0
        assert "run-abc12345" in result.output
        assert "succeeded" in result.output

    def test_runs_json_output(self, runner, mock_client):
        mock_client.get_pipeline_runs.return_value = [SAMPLE_RUN]
        result = runner.invoke(cli, ["--format", "json", "pipelines", "runs", "pl-001"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data[0]["id"] == "run-abc12345"

    def test_runs_no_results(self, runner, mock_client):
        mock_client.get_pipeline_runs.return_value = []
        result = runner.invoke(cli, ["pipelines", "runs", "pl-001"])
        assert result.exit_code == 0
        assert "No runs found" in result.output

    def test_runs_api_error(self, runner, mock_client):
        mock_client.get_pipeline_runs.side_effect = APIError(404, "Pipeline not found.")
        result = runner.invoke(cli, ["pipelines", "runs", "pl-999"])
        assert result.exit_code == 1
        assert "Error" in result.output

    def test_runs_with_limit(self, runner, mock_client):
        mock_client.get_pipeline_runs.return_value = [SAMPLE_RUN]
        result = runner.invoke(cli, ["pipelines", "runs", "pl-001", "--limit", "5"])
        assert result.exit_code == 0
        mock_client.get_pipeline_runs.assert_called_once_with("pl-001", limit=5)


class TestPipelineTrigger:
    def test_trigger_with_yes_flag(self, runner, mock_client):
        mock_client.trigger_pipeline.return_value = {
            "id": "run-new001",
            "pipeline_id": "pl-001",
            "status": "running",
            "started_at": "2026-04-17T12:00:00",
        }
        result = runner.invoke(cli, ["pipelines", "trigger", "pl-001", "--yes"])
        assert result.exit_code == 0
        assert "run-new001" in result.output
        assert "running" in result.output

    def test_trigger_confirms_by_default(self, runner, mock_client):
        mock_client.trigger_pipeline.return_value = {
            "id": "run-new001",
            "status": "running",
            "started_at": "2026-04-17T12:00:00",
        }
        result = runner.invoke(cli, ["pipelines", "trigger", "pl-001"], input="y\n")
        assert result.exit_code == 0
        assert "running" in result.output

    def test_trigger_aborts_on_no(self, runner, mock_client):
        result = runner.invoke(cli, ["pipelines", "trigger", "pl-001"], input="n\n")
        assert result.exit_code != 0
        mock_client.trigger_pipeline.assert_not_called()

    def test_trigger_json_output(self, runner, mock_client):
        run = {"id": "run-xyz", "pipeline_id": "pl-001", "status": "running", "started_at": "2026-04-17T12:00:00"}
        mock_client.trigger_pipeline.return_value = run
        result = runner.invoke(cli, ["--format", "json", "pipelines", "trigger", "pl-001", "--yes"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["id"] == "run-xyz"

    def test_trigger_api_error(self, runner, mock_client):
        mock_client.trigger_pipeline.side_effect = APIError(404, "Pipeline not found")
        result = runner.invoke(cli, ["pipelines", "trigger", "pl-999", "--yes"])
        assert result.exit_code == 1
        assert "Error" in result.output
