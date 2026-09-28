"""Shared fixtures for the drain tests.

THIS FILE EXISTS FOR ONE REASON AND IT IS WORTH STATING PLAINLY. The
`_default_boundary` fixture below lived in `test_tick.py` when #4709 first
shipped, and a module-level autouse fixture only ever reaches its own module.
So `@pytest.mark.real_boundary` -- which the boundary tests carry to OPT OUT of
the stub -- was decorative: the fixture never ran for that file, the opt-out
branch had never executed, and stripping all six markers left the suite
identical. The disclosure in that file credited the marker with keeping the
boundary check witnessed; FILE SEPARATION was doing it, which is a weaker
guarantee that happens to look the same from the outside.

Measured 2026-09-27 by an independent reviewer, and it is the reason the
fixture moved here: from `conftest.py` the fixture reaches every test in the
package, so the marker is now load-bearing and `test_the_opt_out_marker_is_
load_bearing` pins that it is.
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

    MEASURED AT THIS HEAD, by neutering the opt-out branch so no test gets the
    stub: **6 tests fail, all in `test_tick.py`**. The pass count moves with the sandbox and is deliberately not quoted here; the 6 is the measurement. An earlier
    revision of this docstring said 58, which was inherited from a different
    arrangement of this code and does not reproduce here -- most record-path
    tests use `ci-green`, which returns before the boundary call at all.

    THE RISK THIS FIXTURE CREATES, STATED SO IT IS NOT FORGOTTEN: an autouse
    stub means the boundary check is invisible to every test that does not opt
    out. That is not theoretical -- it was REAL. With the stub in place and the
    marker inert, replacing the production call site
    `boundary = boundary_of_issue(...)` with `boundary = "Commercial"` left 929
    of 929 tests green. The rejected design, at the production seam, witnessed
    by nothing. Two further guards inside `verify_run_backed_receipt` were
    defeated the same way at 936/936 before they got their own tests.

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
