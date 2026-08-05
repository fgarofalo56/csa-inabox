"""Assert every pin in requirements-security.txt actually landed.

The security override deliberately conflicts with a declared dependency range,
so pip prints a "dependency conflicts" advisory and still exits 0 — which means
a typo in that file would fail SILENTLY and the image would ship the CVE-bearing
version anyway. This turns that back into a build failure.

Lives in a FILE rather than an inline heredoc because ACR Tasks' classic builder
does not support Dockerfile heredocs (they need BuildKit). A heredoc here builds
fine under a local `docker build` and then fails in CI with the opaque
`failed to run step ID: build: failed to scan dependencies: exit status 1`
after ~3 seconds, before any layer executes.
"""

import sys
from importlib.metadata import version


def main() -> int:
    expected: dict[str, str] = {}
    with open("requirements-security.txt", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip()
            if "==" in line:
                name, _, want = line.partition("==")
                expected[name.strip()] = want.strip()

    if not expected:
        print("no security overrides declared", file=sys.stderr)
        return 1

    bad = {n: (w, version(n)) for n, w in expected.items() if version(n) != w}
    if bad:
        print(f"security override did not apply: {bad}", file=sys.stderr)
        return 1

    print(f"security overrides applied: {expected}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
