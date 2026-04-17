"""Entry point for the CSA-in-a-Box CLI.

Usage::

    python -m portal.cli [OPTIONS] COMMAND [ARGS]...

Environment variables
---------------------
CSA_API_URL     Backend API base URL (default: http://localhost:8000/api/v1)
CSA_API_TOKEN   Bearer token for authenticated requests
CSA_FORMAT      Default output format: table | json | yaml
"""

from __future__ import annotations

import os
import sys

import click

from .commands import marketplace, pipelines, sources, stats
from . import __version__


@click.group()
@click.version_option(version=__version__, prog_name="csa")
@click.option(
    "--api-url",
    default=lambda: os.environ.get("CSA_API_URL", "http://localhost:8000/api/v1"),
    show_default="$CSA_API_URL or http://localhost:8000/api/v1",
    envvar="CSA_API_URL",
    help="Backend API base URL.",
)
@click.option(
    "--token",
    default=lambda: os.environ.get("CSA_API_TOKEN"),
    envvar="CSA_API_TOKEN",
    help="Bearer token for API authentication.",
)
@click.option(
    "--format",
    "output_format",
    default=lambda: os.environ.get("CSA_FORMAT", "table"),
    show_default="$CSA_FORMAT or table",
    type=click.Choice(["table", "json", "yaml"], case_sensitive=False),
    envvar="CSA_FORMAT",
    help="Output format.",
)
@click.pass_context
def cli(ctx: click.Context, api_url: str, token: str | None, output_format: str) -> None:
    """CSA-in-a-Box CLI — platform management from the command line.

    Manage data sources, pipelines, and marketplace products registered
    in the CSA-in-a-Box platform.

    \b
    Quick start:
        csa --api-url http://localhost:8000/api/v1 sources list
        csa --format json stats overview
        csa marketplace search "employee"

    \b
    Environment variables:
        CSA_API_URL    Backend URL  (default: http://localhost:8000/api/v1)
        CSA_API_TOKEN  Bearer token for authenticated endpoints
        CSA_FORMAT     Output format: table | json | yaml
    """
    ctx.ensure_object(dict)
    ctx.obj["api_url"] = api_url
    ctx.obj["token"] = token
    ctx.obj["format"] = output_format.lower()


# Register command groups.
cli.add_command(sources)
cli.add_command(pipelines)
cli.add_command(marketplace)
cli.add_command(stats)


if __name__ == "__main__":
    cli()
