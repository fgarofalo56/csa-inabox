"""Instruction contract for the Rust Direct Lake runtime security update.

Package versions and CVE status require a built-image scan, not this test.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_directlake_runtime_updates_before_install_and_cleanup() -> None:
    text = (REPO_ROOT / "apps/loom-directlake/Dockerfile").read_text(encoding="utf-8")
    # Concrete defect: update followed directly by install leaves perl-base at
    # 5.36.0-7+deb12u3. An upgrade only in the build stage or a comment must fail.
    instructions = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#")).replace(
        "\\\n", " "
    )
    runtime = instructions.split("FROM debian:bookworm-slim AS runtime\n")[1]
    root_instructions = " ".join(runtime.split("USER runner\n")[0].split())
    assert (
        "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y "
        "&& apt-get install -y --no-install-recommends ca-certificates "
        "&& rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 runner"
    ) in root_instructions, "loom-directlake: missing ordered runtime upgrade, install, cleanup, and non-root user"
    # A removed USER or a root UID would break these positive runtime contracts.
    assert "USER runner\n" in runtime, "loom-directlake: runtime must drop privileges to runner"
