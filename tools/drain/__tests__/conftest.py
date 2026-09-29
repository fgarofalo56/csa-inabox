"""Shared fixtures for the drain tests.

THIS FILE EXISTS SO THE `real_boundary` MARKER IS LOAD-BEARING. A module-level
autouse fixture reaches only its own module, so `_default_boundary` defined in
a test module would leave the marker decorative -- file separation would be
doing the work the marker is credited with, which is a weaker guarantee that
looks the same from the outside. From `conftest.py` the fixture reaches every
test in the package. `test_the_opt_out_marker_is_load_bearing` in
`test_boundary_scoped_receipts.py` asserts the location, and it is that test,
not this paragraph, that keeps it true.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick


@pytest.fixture(autouse=True)
def _default_boundary(monkeypatch, request):
    """Resolve every item's boundary unless a test opts out.

    #4709 made `record_receipt_from_evidence` ask GitHub for the item's labels.
    Without this, a test exercising that path shells out to `gh` -- against a
    repo that does not exist under a test's fake `repo` -- and then REFUSES.

    THE RISK THIS FIXTURE CREATES, STATED SO IT IS NOT FORGOTTEN: an autouse
    stub means the boundary check is invisible to every test that does not opt
    out. A mutation applied at the production call site
    `boundary = boundary_of_issue(...)`, and two further mutations of the
    guards inside `verify_run_backed_receipt`, are all hidden from a test that
    takes the stub.

    So the tests that witness it opt OUT via `@pytest.mark.real_boundary`, they
    live in `test_boundary_scoped_receipts.py`, and the SEAM tests there drive
    the real `record_receipt_from_evidence` -- because a mutation can be
    applied at either site and only a seam test sees both.

    If you are reading this because a boundary test is failing, do not reach
    for the stub. The marked tests are the point.
    """
    if "real_boundary" in request.keywords:
        return
    # RETURNS THE PAIR the real resolver returns -- (boundary, source).
    # The source string lands in a public comment, so the stub names
    # itself rather than impersonating a label or a policy default.
    monkeypatch.setattr(tick, "boundary_of_issue",
                        lambda *_a, **_k: ("Commercial", "stubbed by conftest"))
