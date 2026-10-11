"""Instruction contract for the two .NET worker runtime security updates.

This guards the Dockerfiles, not the resulting package versions or CVE status;
those require a built-image scan. Removing the runtime upgrade (the production
failure), moving it into the build stage, or dropping list cleanup turns RED.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _assert_runtime_updates_debian_packages_before_dropping_root(app: str) -> None:
    text = (REPO_ROOT / "apps" / app / "Dockerfile").read_text(encoding="utf-8")
    # Ignore comments and join Docker continuations so a comment cannot stand in
    # for an executable upgrade. A build-stage-only upgrade must not satisfy us.
    instructions = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#")).replace(
        "\\\n", " "
    )
    runtime = instructions.split("FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime\n")[1]
    root_instructions = " ".join(runtime.split("USER loom\n")[0].split())
    assert (
        "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y && rm -rf /var/lib/apt/lists/*"
    ) in root_instructions, f"{app}: missing fail-closed runtime upgrade and apt-list cleanup"


def test_activator_runtime_updates_debian_packages() -> None:
    _assert_runtime_updates_debian_packages_before_dropping_root("fiab-activator-engine")


def test_direct_lake_shim_runtime_updates_debian_packages() -> None:
    _assert_runtime_updates_debian_packages_before_dropping_root("fiab-direct-lake-shim")
