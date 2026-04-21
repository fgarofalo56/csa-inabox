"""Top-level ``apps`` package — application services built on top of the
CSA-in-a-Box platform (``csa_platform``).

Currently hosts :mod:`apps.copilot` (CSA-0008), the grounded answer service
that indexes repo documentation and answers natural-language questions with
citation-verified responses.

Future sub-packages may add further internal services (decision-tree walker,
skill catalog runner, gated execute broker — see the Copilot roadmap).
"""

from __future__ import annotations

__all__: list[str] = []
