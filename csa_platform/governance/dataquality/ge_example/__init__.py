"""Great Expectations 1.x runnable example for CSA-in-a-Box.

Exposes :func:`ge_demo.run_demo` so the tutorial at
``docs/tutorials/great-expectations.md`` can be exercised both as a CLI
(``python -m csa_platform.governance.dataquality.ge_example.ge_demo``) and
from pytest.
"""

from csa_platform.governance.dataquality.ge_example.ge_demo import (
    DemoResult,
    run_demo,
    seed_dataframe,
)

__all__ = ["DemoResult", "run_demo", "seed_dataframe"]
