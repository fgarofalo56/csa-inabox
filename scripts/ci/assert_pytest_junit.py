#!/usr/bin/env python
"""Assert a pytest run actually MEASURED something, and that nothing was skipped.

    python scripts/ci/assert_pytest_junit.py <junit.xml> [--min-tests N]

Why this exists: ``apps/fiab-setup-orchestrator/tests/test_orchestrator.py``
calls ``pytest.importorskip("azure.mgmt.resource")``. If the dependency the
Setup Orchestrator's deploy driver needs fails to resolve, those tests SKIP and
pytest still exits 0 -- the run reads green while measuring nothing, which is
exactly the failure the fresh-resolve leg exists to catch. Zero collected tests
is the same class of non-measurement. Both are failures here, not passes.

Exit 0 only when: the XML parsed, at least ``--min-tests`` tests ran, and
skipped == failures == errors == 0.
"""

from __future__ import annotations

import sys

# B405/B314 justification: the only input is the JUnit report pytest itself wrote
# in the immediately preceding step of the same CI job (.github/workflows/test.yml,
# job app-fresh-resolve). It is never attacker-supplied or fetched over a network,
# so the XML entity-expansion class those rules guard against does not apply.
# (Keep the nosec comments below to bare test IDs -- bandit parses trailing prose
# as further test names and emits a warning per word.)
import xml.etree.ElementTree as ET  # nosec B405
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    min_tests = 1
    if "--min-tests" in argv:
        min_tests = int(argv[argv.index("--min-tests") + 1])

    if not path.is_file():
        print(
            f"FAIL: {path} does not exist. pytest produced no JUnit report, so this "
            "check cannot establish that anything ran. Refusing to pass."
        )
        return 1

    try:
        root = ET.parse(path).getroot()  # nosec B314
    except ET.ParseError as exc:
        print(f"FAIL: could not parse {path}: {exc}")
        return 1

    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    if not suites:
        print(
            f"FAIL: {path} contains no <testsuite> element. This check cannot "
            "establish what ran. Refusing to pass."
        )
        return 1

    def total(attr: str) -> int:
        return sum(int(s.get(attr, "0") or 0) for s in suites)

    tests, skipped = total("tests"), total("skipped")
    failures, errors = total("failures"), total("errors")
    print(
        f"{path}: tests={tests} failures={failures} errors={errors} skipped={skipped}"
    )

    problems: list[str] = []
    if tests < min_tests:
        problems.append(
            f"collected {tests} test(s), expected at least {min_tests}. Zero (or a "
            "collapsed count) is a broken measurement, not a clean run."
        )
    if skipped:
        problems.append(
            f"{skipped} test(s) SKIPPED. test_orchestrator.py importorskips "
            "azure.mgmt.resource, so a skip here means the dependency the deploy "
            "driver imports did not resolve -- the exact condition this leg "
            "watches. A skip is not a pass."
        )
    if failures or errors:
        problems.append(f"{failures} failure(s) and {errors} error(s) reported.")

    if problems:
        print("FAIL:")
        for p in problems:
            print(f"  - {p}")
        return 1

    print("OK: the run measured real tests, none skipped, none failed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
